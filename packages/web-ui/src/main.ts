import type { Agent, Message, Channel, SharedFile, ToolApproval, WsEvent } from "./types.js";
import {
  renderMessage, renderMessages, renderApprovalCard, removeApprovalCard,
  updateMessageStatus, setApprovalHandler, updateTypingIndicators,
  showTerminalPanel, hideTerminalPanel, updateTerminalContent,
  setPeakHandlers, renderPeakCard, updatePeakDecision,
  type PeakData,
} from "./chat.js";
import { initInput } from "./input.js";
import { initQuickJump } from "./quick-jump.js";
import { getAvatarColor, escapeHtml, contextBorderGradient, showConfirm } from "./utils.js";
import { initDashboard, handleProjectWsEvent } from "./dashboard.js";
import { getActiveProjectId, setActiveProject, onActiveProjectChange } from "./project-context.js";
import type { Project } from "./project-types.js";
import { api, ApiError, getWsClient } from "./transport.js";
import { getSavedState, saveChannel, saveProject, saveView, saveSidebarWidth } from "./state.js";

let agents: Agent[] = [];
let channels: Channel[] = [];
let currentChannelId = "general";
let showArchived = false;
let totalMessages = 0;

// Unread tracking
const unreadCounts = new Map<string, number>();

const statusEl = document.getElementById("server-status")!;
const agentCountEl = document.getElementById("agent-count")!;
const statusMsgsEl = document.getElementById("status-bar-msgs")!;
const channelListEl = document.getElementById("channel-list")!;
const agentListEl = document.getElementById("agent-list")!;
const fileListEl = document.getElementById("file-list")!;
const channelNameEl = document.getElementById("channel-name")!;
const channelDescEl = document.getElementById("channel-desc")!;
const modalOverlay = document.getElementById("modal-overlay")!;
const modalTitle = document.getElementById("modal-title")!;
const modalBody = document.getElementById("modal-body")!;
const modalCloseBtn = document.getElementById("modal-close-btn")!;
const modalBackdrop = modalOverlay.querySelector(".modal-backdrop")!;
const contextMenu = document.getElementById("context-menu")!;
const sidebar = document.getElementById("sidebar")!;

// --- Approval Handler ---
setApprovalHandler(async (agentName: string, key: string) => {
  try {
    await api.post(`/api/approvals/${encodeURIComponent(agentName)}/respond`, { key });
  } catch (err) {
    console.error("Approval response failed:", err);
  }
});

// --- Peak Handlers ---
setPeakHandlers({
  onDecide: async (peakId: string, optionIndex: number, note?: string) => {
    try {
      const body: Record<string, unknown> = { option_index: optionIndex, decided_by: "user" };
      if (note) body.note = note;
      await api.post(`/api/peaks/${encodeURIComponent(peakId)}/decide`, body);
    } catch (err) {
      console.error("Peak decide failed:", err);
    }
  },
  onLetAgentDecide: async (peakId: string) => {
    try {
      await api.post(`/api/peaks/${encodeURIComponent(peakId)}/let-agent-decide`);
    } catch (err) {
      console.error("Peak let-agent-decide failed:", err);
    }
  },
  onPause: async (peakId: string) => {
    try {
      await api.post(`/api/peaks/${encodeURIComponent(peakId)}/pause`);
    } catch (err) {
      console.error("Peak pause failed:", err);
    }
  },
});

// Load pending peaks on channel switch
async function loadPendingPeaks(): Promise<void> {
  try {
    const peaks = await api.get<PeakData[]>("/api/peaks/pending");
    for (const peak of peaks) {
      renderPeakCard(peak);
    }
  } catch { /* ignore */ }
}

// --- Modal ---
function openModal(title: string, bodyHtml: string): void {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOverlay.classList.remove("hidden");
}
function closeModal(): void { modalOverlay.classList.add("hidden"); }
modalCloseBtn.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", closeModal);

// --- Context Menu ---
let ctxTargetChannelId = "";
document.addEventListener("click", () => contextMenu.classList.add("hidden"));
contextMenu.addEventListener("click", async (e) => {
  const action = (e.target as HTMLElement).dataset.action;
  if (!action || !ctxTargetChannelId) return;
  if (action === "archive") {
    await api.put(`/api/channels/${ctxTargetChannelId}`, { status: "archived" });
  } else if (action === "unarchive") {
    await api.put(`/api/channels/${ctxTargetChannelId}`, { status: "active" });
  } else if (action === "delete") {
    if (await showConfirm("Delete this channel and all its messages?")) {
      await api.del(`/api/channels/${ctxTargetChannelId}`);
      if (currentChannelId === ctxTargetChannelId) switchChannel("general");
    }
  }
  await loadChannels();
});

// --- Sidebar Collapse ---
sidebar.addEventListener("click", (e) => {
  const header = (e.target as HTMLElement).closest(".section-header");
  if (!header) return;
  const section = header.closest(".sidebar-section");
  if (section) section.classList.toggle("collapsed");
});

// --- Sidebar Drag Resize ---
const resizeHandle = document.getElementById("sidebar-resize-handle");
if (resizeHandle) {
  let dragging = false;
  let startX = 0;
  let startW = 0;

  resizeHandle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newW = Math.max(160, Math.min(400, startW + (e.clientX - startX)));
    sidebar.style.width = newW + "px";
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveSidebarWidth(sidebar.offsetWidth);
    }
  });
}

// --- Keyboard Shortcuts ---
document.addEventListener("keydown", (e) => {
  // Alt+ArrowUp/Down: switch channels
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const activeChannels = channels.filter(ch => ch.status === "active");
    if (activeChannels.length === 0) return;
    const idx = activeChannels.findIndex(ch => ch.id === currentChannelId);
    let next: number;
    if (e.key === "ArrowUp") {
      next = idx <= 0 ? activeChannels.length - 1 : idx - 1;
    } else {
      next = idx >= activeChannels.length - 1 ? 0 : idx + 1;
    }
    switchChannel(activeChannels[next].id);
  }
});

// --- Channels ---
async function loadChannels(): Promise<void> {
  const projectId = getActiveProjectId();
  const params = new URLSearchParams();
  if (!showArchived) params.set("status", "active");
  if (projectId) params.set("project_id", projectId);
  const qs = params.toString();
  channels = await api.get<Channel[]>(`/api/channels${qs ? "?" + qs : ""}`);
  renderChannels();
}

function renderChannels(): void {
  channelListEl.innerHTML = "";
  const publicChannels = channels.filter(ch => !ch.type || ch.type === "public");
  const dmChannels = channels.filter(ch => ch.type === "dm");
  const groupChannels = channels.filter(ch => ch.type === "group");

  for (const ch of publicChannels) {
    const badge = unreadBadgeHtml(ch.id);
    const unreadClass = (unreadCounts.get(ch.id) || 0) > 0 ? " unread" : "";
    channelListEl.appendChild(makeChannelLi(ch, `<span class="channel-hash">#</span><span class="channel-item-name${unreadClass}">${esc(ch.name)}</span>${badge}`));
  }

  if (groupChannels.length > 0) {
    const groupHeader = document.createElement("li");
    groupHeader.className = "channel-section-label";
    groupHeader.textContent = "Groups";
    channelListEl.appendChild(groupHeader);
    for (const ch of groupChannels) {
      const memberCount = ch.members ? ch.members.length : 0;
      const badge = unreadBadgeHtml(ch.id);
      const unreadClass = (unreadCounts.get(ch.id) || 0) > 0 ? " unread" : "";
      channelListEl.appendChild(makeChannelLi(ch, `<span class="channel-hash group-icon">G</span><span class="channel-item-name${unreadClass}">${esc(ch.name)}</span><span class="channel-member-count">${memberCount}</span>${badge}`));
    }
  }

  if (dmChannels.length > 0) {
    const dmHeader = document.createElement("li");
    dmHeader.className = "channel-section-label";
    dmHeader.textContent = "Direct Messages";
    channelListEl.appendChild(dmHeader);
    for (const ch of dmChannels) {
      const color = getAvatarColor(ch.name);
      const initial = ch.name.charAt(0).toUpperCase();
      const badge = unreadBadgeHtml(ch.id);
      const unreadClass = (unreadCounts.get(ch.id) || 0) > 0 ? " unread" : "";
      channelListEl.appendChild(makeChannelLi(ch, `<span class="dm-avatar-mini" style="background:${color}">${initial}</span><span class="channel-item-name${unreadClass}">${esc(ch.name)}</span>${badge}`));
    }
  }
}

function unreadBadgeHtml(channelId: string): string {
  const count = unreadCounts.get(channelId) || 0;
  if (count <= 0) return "";
  return `<span class="unread-badge">${count > 99 ? "99+" : count}</span>`;
}

function makeChannelLi(ch: Channel, innerHtml: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = ch.id === currentChannelId ? "active" : "";
  if (ch.status === "archived") li.classList.add("archived");
  li.innerHTML = innerHtml;
  li.addEventListener("click", () => switchChannel(ch.id));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctxTargetChannelId = ch.id;
    const archiveItem = contextMenu.querySelector('[data-action="archive"]') as HTMLElement;
    const unarchiveItem = contextMenu.querySelector('[data-action="unarchive"]') as HTMLElement;
    archiveItem.style.display = ch.status === "archived" ? "none" : "";
    unarchiveItem.style.display = ch.status === "archived" ? "" : "none";
    contextMenu.style.left = e.clientX + "px";
    contextMenu.style.top = e.clientY + "px";
    contextMenu.classList.remove("hidden");
  });
  return li;
}

async function switchChannel(id: string): Promise<void> {
  currentChannelId = id;
  saveChannel(id);
  // Clear unread for this channel
  unreadCounts.delete(id);

  const ch = channels.find((c) => c.id === id);
  if (ch) {
    if (ch.type === "dm") {
      channelNameEl.textContent = `@ ${ch.name}`;
    } else if (ch.type === "group") {
      channelNameEl.textContent = `G ${ch.name}`;
    } else {
      channelNameEl.textContent = `# ${ch.name}`;
    }
  } else {
    channelNameEl.textContent = `# ${id}`;
  }
  channelDescEl.textContent = "";
  // Show description or member info
  if (ch?.type === "group" && ch.members) {
    channelDescEl.innerHTML = `<span class="header-members">${ch.members.map(m => esc(m)).join(", ")}</span> <button class="header-manage-btn" id="manage-members-btn">manage</button>`;
    document.getElementById("manage-members-btn")?.addEventListener("click", () => openGroupMemberModal(ch));
  } else if (ch?.type === "dm") {
    channelDescEl.textContent = "Private message";
  } else {
    channelDescEl.textContent = ch?.description || "";
  }

  // Terminal panel: show for DM channels, hide otherwise
  if (ch?.type === "dm") {
    showTerminalPanel(ch.name);
    // Fetch initial terminal content
    fetchTerminalContent(ch.name);
  } else {
    hideTerminalPanel();
  }

  renderChannels();
  const msgs = await api.get<Message[]>(`/api/messages?channel_id=${id}&limit=50`);
  renderMessages(msgs);
  loadPendingApprovals();
  loadPendingPeaks();
}

async function fetchTerminalContent(agentName: string): Promise<void> {
  try {
    const data = await api.get<{ content?: string }>(`/api/agents/${encodeURIComponent(agentName)}/terminal`);
    if (data.content) {
      updateTerminalContent(data.content);
    }
  } catch { /* ignore */ }
}

// --- DM Channel ---
async function openDmChannel(agentName: string): Promise<void> {
  try {
    const ch = await api.post<Channel>(`/api/channels/dm/${encodeURIComponent(agentName)}`);
    if (!channels.find(c => c.id === ch.id)) {
      channels.push(ch);
    }
    await switchChannel(ch.id);
  } catch (err) {
    console.error("Failed to open DM:", err);
  }
}

// --- Group Member Management ---
function openGroupMemberModal(ch: Channel): void {
  const currentMembers = ch.members || [];
  let html = `<div class="group-member-list" id="group-member-list">`;
  for (const m of currentMembers) {
    const color = getAvatarColor(m);
    html += `<div class="group-member-item" data-name="${esc(m)}">
      <span class="dm-avatar-mini" style="background:${color}">${m.charAt(0).toUpperCase()}</span>
      <span>${esc(m)}</span>
      <button class="remove-member-btn" data-name="${esc(m)}" title="Remove">x</button>
    </div>`;
  }
  html += `</div>`;
  html += `<div class="form-group" style="margin-top:12px;">
    <label>Add agent</label>
    <select id="f-add-member">
      <option value="">-- select --</option>
      ${agents.filter(a => !currentMembers.includes(a.name)).map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}
    </select>
  </div>
  <button class="modal-action-btn" id="f-add-member-btn">Add</button>`;

  openModal(`Manage: ${ch.name}`, html);

  // Remove member handlers
  document.querySelectorAll(".remove-member-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = (btn as HTMLElement).dataset.name!;
      if (!await showConfirm(`Remove ${name} from the group?`)) return;
      await api.del(`/api/channels/${ch.id}/members/${encodeURIComponent(name)}`);
      await loadChannels();
      const updated = channels.find(c => c.id === ch.id);
      if (updated) openGroupMemberModal(updated);
      else closeModal();
    });
  });

  // Add member handler
  document.getElementById("f-add-member-btn")!.addEventListener("click", async () => {
    const sel = document.getElementById("f-add-member") as HTMLSelectElement;
    const name = sel.value;
    if (!name) return;
    await api.post(`/api/channels/${ch.id}/members`, { name });
    await loadChannels();
    const updated = channels.find(c => c.id === ch.id);
    if (updated) openGroupMemberModal(updated);
    else closeModal();
  });
}

document.getElementById("add-channel-btn")!.addEventListener("click", () => {
  const agentCheckboxes = agents.map(a => `<label class="toggle-label" style="margin:2px 0"><input type="checkbox" class="f-ch-member" value="${esc(a.name)}"> ${esc(a.name)}</label>`).join("");
  openModal("New Channel", `
    <div class="form-group"><label>Name</label><input id="f-ch-name" type="text" placeholder="channel-name"></div>
    <div class="form-group"><label>Description</label><input id="f-ch-desc" type="text" placeholder="Optional"></div>
    <div class="form-group">
      <label>Type</label>
      <select id="f-ch-type"><option value="public">Public</option><option value="group">Group</option></select>
    </div>
    <div class="form-group hidden" id="f-ch-members-section">
      <label>Members</label>
      <div class="member-checkbox-list">${agentCheckboxes}</div>
    </div>
    <button class="modal-action-btn" id="f-ch-submit">Create</button>
  `);
  const typeSelect = document.getElementById("f-ch-type") as HTMLSelectElement;
  const membersSection = document.getElementById("f-ch-members-section")!;
  typeSelect.addEventListener("change", () => {
    membersSection.classList.toggle("hidden", typeSelect.value !== "group");
  });
  document.getElementById("f-ch-submit")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-ch-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const desc = (document.getElementById("f-ch-desc") as HTMLInputElement).value.trim();
    const type = typeSelect.value;
    const members: string[] = [];
    if (type === "group") {
      document.querySelectorAll<HTMLInputElement>(".f-ch-member:checked").forEach(cb => members.push(cb.value));
    }
    await api.post("/api/channels", { name, description: desc, type, members: members.length > 0 ? members : undefined, project_id: getActiveProjectId() || undefined });
    closeModal();
    await loadChannels();
  });
});

document.getElementById("show-archived")!.addEventListener("change", (e) => {
  showArchived = (e.target as HTMLInputElement).checked;
  loadChannels();
});

// --- Agents ---
async function loadAgents(): Promise<void> {
  const projectId = getActiveProjectId();
  const url = projectId ? `/api/agents?project_id=${encodeURIComponent(projectId)}` : "/api/agents";
  agents = await api.get<Agent[]>(url);
  renderAgents();
}

function renderAgents(): void {
  agentListEl.innerHTML = "";
  let online = 0;
  const sorted = [...agents].sort((a, b) => {
    if (a.status === "online" && b.status !== "online") return -1;
    if (a.status !== "online" && b.status === "online") return 1;
    return a.name.localeCompare(b.name);
  });
  for (const ag of sorted) {
    if (ag.status === "online") online++;
    const li = document.createElement("li");
    li.className = "agent-item";
    const tmuxState = ag.tmuxState;
    let dotClass: string = ag.status;
    let stateLabel = "";
    if (ag.status === "online" && tmuxState) {
      if (tmuxState === "no_session") { dotClass = "warning"; stateLabel = "no terminal"; }
      else if (tmuxState === "approval_pending") { dotClass = "warning"; stateLabel = "needs approval"; }
      else if (tmuxState === "busy") { dotClass = "busy"; stateLabel = "working"; }
      else if (tmuxState === "idle") { stateLabel = "ready"; }
    }
    const color = getAvatarColor(ag.name);
    const initial = ag.name.charAt(0).toUpperCase();

    // Context border gradient (avatar frame shows progress)
    const ctxPercent = ag.contextPercent ?? 0;
    const borderBg = contextBorderGradient(ctxPercent, color);
    const ctxTitle = ctxPercent > 0 ? ` (context: ${ctxPercent}%)` : "";
    const providerBadge = ag.provider === "codex" ? "codex" : "";

    li.innerHTML = `
      <div class="agent-avatar-wrap" style="background:${borderBg}" title="${esc(ag.name)}${ctxTitle}">
        <div class="agent-avatar" style="background:${color}">
          <span>${initial}</span>
          <span class="agent-status-dot ${dotClass}"></span>
        </div>
      </div>
      <div class="agent-info">
        <div class="agent-name-row">
          <span class="agent-name">${esc(ag.name)}</span>
          ${providerBadge ? `<span class="agent-state">${providerBadge}</span>` : ""}
          ${stateLabel ? `<span class="agent-state">${esc(stateLabel)}</span>` : ""}
        </div>
        ${ag.role ? `<div class="agent-role" title="${esc(ag.role)}">${esc(ag.role)}</div>` : ""}
      </div>
      ${ag.status !== "online" ? `<span class="wake-icon" title="Wake">&#9654;</span>` : ""}
      <span class="edit-icon" title="Edit">...</span>
    `;
    li.querySelector(".agent-avatar-wrap")!.addEventListener("click", (e) => { e.stopPropagation(); openDmChannel(ag.name); });
    li.querySelector(".agent-name")!.addEventListener("click", () => insertMention(ag.name));
    li.querySelector(".edit-icon")!.addEventListener("click", (e) => { e.stopPropagation(); openAgentEdit(ag); });
    const wakeIcon = li.querySelector(".wake-icon");
    if (wakeIcon) {
      wakeIcon.addEventListener("click", (e) => { e.stopPropagation(); wakeAgent(ag.name); });
    }
    agentListEl.appendChild(li);
  }
  agentCountEl.textContent = `Agents: ${online}/${agents.length}`;

  // Update typing indicators
  updateTypingIndicators(agents);
}

function openAgentEdit(ag: Agent): void {
  const encodedName = encodeURIComponent(ag.name);
  openModal(`Edit Agent: ${ag.name}`, `
    <div class="form-group"><label>Role</label><input id="f-ag-role" type="text" value="${esc(ag.role)}"></div>
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="modal-action-btn" id="f-ag-save">Save</button>
      <button class="modal-action-btn danger" id="f-ag-del">Delete</button>
    </div>
  `);
  document.getElementById("f-ag-save")!.addEventListener("click", async () => {
    const role = (document.getElementById("f-ag-role") as HTMLInputElement).value.trim();
    try {
      await api.put(`/api/agents/${encodedName}`, { role });
    } catch (err) {
      alert("Save failed: " + (err instanceof ApiError ? err.errorMessage : (err as Error).message));
      return;
    }
    closeModal();
    await loadAgents();
  });
  document.getElementById("f-ag-del")!.addEventListener("click", async () => {
    if (!await showConfirm(`Delete agent "${ag.name}"? This will stop its tmux session, kill bridge processes, and delete its workspace.`)) return;
    try {
      await api.del(`/api/agents/${encodedName}`);
    } catch (err) {
      alert("Delete failed: " + (err instanceof ApiError ? err.errorMessage : (err as Error).message));
      return;
    }
    closeModal();
    await loadAgents();
  });
}

document.getElementById("add-agent-btn")!.addEventListener("click", () => {
  const activeProjectId = getActiveProjectId();
  const projectOptions = sidebarProjects.map(p =>
    `<option value="${esc(p.id)}"${p.id === activeProjectId ? " selected" : ""}>${esc(p.name)}</option>`
  ).join("");

  openModal("Create Agent", `
    <div class="form-group"><label>Name</label><input id="f-ag-name" type="text" placeholder="agent-name"></div>
    <div class="form-group">
      <label>Provider</label>
      <select id="f-ag-provider">
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
    </div>
    <div class="form-group"><label>Role</label><input id="f-ag-role2" type="text" placeholder="e.g. Backend developer"></div>
    <div class="form-group">
      <label>Assign to Project</label>
      <select id="f-ag-project">
        <option value="">None</option>
        ${projectOptions}
      </select>
    </div>
    <label class="toggle-label" style="margin-bottom:10px"><input type="checkbox" id="f-ag-wake" checked> Start immediately after creation</label>
    <button class="modal-action-btn" id="f-ag-create">Create</button>
  `);
  document.getElementById("f-ag-create")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-ag-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const provider = (document.getElementById("f-ag-provider") as HTMLSelectElement).value;
    const role = (document.getElementById("f-ag-role2") as HTMLInputElement).value.trim();
    const wake = (document.getElementById("f-ag-wake") as HTMLInputElement).checked;
    const projectId = (document.getElementById("f-ag-project") as HTMLSelectElement).value;
    const btn = document.getElementById("f-ag-create") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Creating...";
    try {
      const data = await api.post<{ wakeError?: string }>("/api/agents/create", { name, provider, role, wake });
      if (data.wakeError) {
        alert(`Agent created but failed to start: ${data.wakeError}`);
      }
      if (projectId) {
        try {
          await api.post(`/api/projects/${projectId}/agents`, { agent_name: name, role_in_project: role, assignment_type: "dedicated" });
        } catch { /* ignore assignment failure */ }
      }
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Create";
      return;
    }
    closeModal();
    await loadAgents();
  });
});

// --- Wake Agents ---
async function wakeAgent(name: string): Promise<void> {
  try {
    await api.post("/api/wake", { name });
  } catch (err) {
    alert("Failed to wake agent: " + (err instanceof ApiError ? err.errorMessage : (err as Error).message));
  }
}

document.getElementById("wake-all-btn")!.addEventListener("click", async () => {
  if (!await showConfirm("Wake all agents? This will open Terminal tabs for each agent.")) return;
  try {
    const data = await api.post<{ launched: number }>("/api/wake-all");
    alert(`Launched ${data.launched} agent(s)`);
  } catch (err) {
    alert("Failed: " + (err instanceof ApiError ? err.errorMessage : (err as Error).message));
  }
});

// --- Pending Approvals ---
async function loadPendingApprovals(): Promise<void> {
  try {
    const approvals = await api.get<ToolApproval[]>("/api/approvals");
    for (const approval of approvals) {
      renderApprovalCard(approval);
    }
  } catch { /* ignore */ }
}

// --- Shared Files ---
async function loadFiles(): Promise<void> {
  const projectId = getActiveProjectId();
  const url = projectId ? `/api/shared-files?project_id=${encodeURIComponent(projectId)}` : "/api/shared-files";
  const files = await api.get<SharedFile[]>(url);
  renderFiles(files);
}

function renderFiles(files: SharedFile[]): void {
  fileListEl.innerHTML = "";
  if (files.length === 0) {
    const projectId = getActiveProjectId();
    const li = document.createElement("li");
    li.className = "file-empty-state";
    li.textContent = projectId
      ? "No project assets yet. Derived files will appear in the workplace automatically."
      : "No shared files yet.";
    fileListEl.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    const scopeBadge = f.scope_type ? `<span class="file-scope-badge">${esc(f.scope_type)}${f.scope_name ? `:${esc(f.scope_name)}` : ""}</span>` : "";
    li.innerHTML = `${scopeBadge}<span class="file-item-name">${esc(f.path)}</span>`;
    li.addEventListener("click", () => openFileEditor(f));
    fileListEl.appendChild(li);
  }
}

async function openFileEditor(file: SharedFile): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (file.scope_type) params.set("scope_type", file.scope_type);
    if (file.scope_id) params.set("scope_id", file.scope_id);
    if (file.project_id) params.set("project_id", file.project_id);
    const qs = params.toString();
    const data = await api.get<{ content: string; scope_type?: string; scope_name?: string }>(`/api/shared-files/${encodeURIComponent(file.path)}${qs ? `?${qs}` : ""}`);
    openModal(file.path, `
      <textarea id="f-file-content" class="file-editor">${esc(data.content)}</textarea>
      <div class="file-meta-line">Scope: ${esc(data.scope_type || "global")}${data.scope_name ? ` / ${esc(data.scope_name)}` : ""}</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="modal-action-btn" id="f-file-save">Save</button>
        <button class="modal-action-btn danger" id="f-file-del">Delete</button>
      </div>
    `);
    document.getElementById("f-file-save")!.addEventListener("click", async () => {
      const content = (document.getElementById("f-file-content") as HTMLTextAreaElement).value;
      await api.put(`/api/shared-files/${encodeURIComponent(file.path)}`, {
        content,
        created_by: "user",
        project_id: file.project_id,
        scope_type: file.scope_type,
        scope_id: file.scope_id,
      });
      closeModal();
      await loadFiles();
    });
    document.getElementById("f-file-del")!.addEventListener("click", async () => {
      if (!await showConfirm(`Delete file "${file.path}"?`)) return;
      await api.del(`/api/shared-files/${encodeURIComponent(file.path)}${qs ? `?${qs}` : ""}`);
      closeModal();
      await loadFiles();
    });
  } catch { /* ignore */ }
}

// New file
document.getElementById("new-file-btn")!.addEventListener("click", () => {
  const projectId = getActiveProjectId();
  openModal("New Shared File", `
    <div class="form-group"><label>Filename</label><input id="f-newfile-name" type="text" placeholder="e.g. notes.md"></div>
    ${projectId ? `
      <div class="form-group">
        <label>Store In</label>
        <select id="f-newfile-kind">
          <option value="derived">Workplace (default)</option>
          <option value="canonical">Project root</option>
        </select>
      </div>
    ` : ""}
    <textarea id="f-newfile-content" class="file-editor" placeholder="File content..."></textarea>
    <button class="modal-action-btn" id="f-newfile-save" style="margin-top:8px;">Create</button>
  `);
  document.getElementById("f-newfile-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-newfile-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const content = (document.getElementById("f-newfile-content") as HTMLTextAreaElement).value;
    const artifactKind = projectId ? (document.getElementById("f-newfile-kind") as HTMLSelectElement).value : undefined;
    await api.put(`/api/shared-files/${encodeURIComponent(name)}`, { content, created_by: "user", project_id: projectId, artifact_kind: artifactKind });
    closeModal();
    await loadFiles();
  });
});

// Upload file
const fileUploadInput = document.getElementById("file-upload-input") as HTMLInputElement;
document.getElementById("upload-file-btn")!.addEventListener("click", () => fileUploadInput.click());
fileUploadInput.addEventListener("change", async () => {
  const file = fileUploadInput.files?.[0];
  if (!file) return;
  const content = await file.text();
  await api.put(`/api/shared-files/${encodeURIComponent(file.name)}`, {
    content,
    created_by: "user",
    description: `Uploaded: ${file.name}`,
    project_id: getActiveProjectId(),
    artifact_kind: getActiveProjectId() ? "derived" : undefined,
  });
  fileUploadInput.value = "";
  await loadFiles();
});

// --- Import ---
document.getElementById("import-btn")!.addEventListener("click", async () => {
  openModal("Import Conversation History", "<p style='color:var(--text-secondary)'>Loading sessions...</p>");
  try {
    const sessions = await api.get<{ sessionId: string; preview: string; lastTimestamp: number; messageCount: number; project: string }[]>("/api/import/sessions");
    if (sessions.length === 0) { modalBody.innerHTML = "<p style='color:var(--text-secondary)'>No sessions found.</p>"; return; }
    let html = "";
    for (const s of sessions) {
      const date = new Date(s.lastTimestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      html += `<div class="import-session">
        <div class="import-session-info">
          <div class="import-session-preview">${esc(s.preview)}</div>
          <div class="import-session-meta">${date} | ${s.messageCount} msgs | ${s.project}</div>
        </div>
        <button data-sid="${s.sessionId}">Import</button>
      </div>`;
    }
    modalBody.innerHTML = html;
    modalBody.querySelectorAll("button[data-sid]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const b = btn as HTMLButtonElement;
        b.disabled = true; b.textContent = "...";
        const r = await api.post<{ imported: number }>("/api/import/session", { sessionId: b.dataset.sid });
        b.textContent = `Done (${r.imported})`;
      });
    });
  } catch { modalBody.innerHTML = "<p style='color:var(--red)'>Failed to load.</p>"; }
});

// --- Messages ---
async function sendMessage(text: string): Promise<void> {
  try {
    await api.post("/api/messages", { sender_type: "user", sender_name: "user", content: text, channel_id: currentChannelId });
  } catch (err) { console.error("Send failed:", err); }
}

function insertMention(name: string): void {
  const input = document.getElementById("message-input") as HTMLTextAreaElement;
  const pos = input.selectionStart || input.value.length;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  const sp = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
  input.value = before + sp + "@" + name + " " + after;
  input.focus();
}

// --- WebSocket ---
function connectWebSocket(): void {
  const wsClient = getWsClient();
  wsClient.onStatus((status) => {
    if (status === "connected") {
      statusEl.textContent = "Connected";
      statusEl.className = "connected";
    } else {
      statusEl.textContent = status === "error" ? "Error" : "Disconnected";
      statusEl.className = "disconnected";
    }
  });
  wsClient.onEvent(handleWsEvent);
}

function handleWsEvent(event: WsEvent): void {
  switch (event.type) {
    case "message:new": {
      const msg = event.data as Message;
      if (msg.channel_id === currentChannelId || !msg.channel_id) {
        renderMessage(msg);
      } else if (msg.channel_id) {
        // Increment unread count for other channels
        unreadCounts.set(msg.channel_id, (unreadCounts.get(msg.channel_id) || 0) + 1);
        renderChannels();
      }
      totalMessages++;
      statusMsgsEl.textContent = `${totalMessages} msgs`;
      break;
    }
    case "message:update": {
      const msg = event.data as Message;
      const el = document.querySelector(`[data-id="${msg.id}"]`) as HTMLElement | null;
      if (el) {
        el.textContent = msg.content;
      }
      break;
    }
    case "agent:status": {
      const data = event.data as { name: string; status: string; role?: string; provider?: Agent["provider"] };
      if (data.status === "removed") {
        agents = agents.filter((a) => a.name !== data.name);
      } else {
        const existing = agents.find((a) => a.name === data.name);
        if (existing) {
          existing.status = data.status as Agent["status"];
          if (data.role !== undefined) existing.role = data.role;
          if (data.provider !== undefined) existing.provider = data.provider;
        } else {
          agents.push({
            id: "",
            name: data.name,
            provider: data.provider,
            role: data.role || "",
            status: data.status as Agent["status"],
            last_heartbeat: Date.now(),
            registered_at: Date.now(),
          });
        }
      }
      renderAgents();
      break;
    }
    case "agent:tmux_state": {
      const data = event.data as { name: string; tmuxState: string; contextPercent?: number };
      const ag = agents.find((a) => a.name === data.name);
      if (ag) {
        ag.tmuxState = data.tmuxState as Agent["tmuxState"];
        if (data.contextPercent !== undefined) {
          ag.contextPercent = data.contextPercent;
        }
        renderAgents();
      }
      break;
    }
    case "agent:terminal": {
      const data = event.data as { name: string; content: string };
      // Update terminal panel if we're in the DM channel for this agent
      const ch = channels.find(c => c.id === currentChannelId);
      if (ch?.type === "dm" && ch.name === data.name) {
        updateTerminalContent(data.content);
      }
      break;
    }
    case "agent:context": {
      const data = event.data as { name: string; contextPercent: number };
      const ag = agents.find((a) => a.name === data.name);
      if (ag) {
        ag.contextPercent = data.contextPercent;
        renderAgents();
      }
      break;
    }
    case "approval:pending": {
      const approval = event.data as ToolApproval;
      renderApprovalCard(approval);
      const ag = agents.find((a) => a.name === approval.agentName);
      if (ag) {
        ag.tmuxState = "approval_pending";
        renderAgents();
      }
      break;
    }
    case "approval:resolved": {
      const data = event.data as { agentName: string; approvalId: string };
      removeApprovalCard(data.agentName);
      break;
    }
    case "message:status": {
      const data = event.data as { messageId: number; agentName: string; status: string };
      updateMessageStatus(data.messageId, data.agentName, data.status);
      break;
    }
    case "channel:created":
    case "channel:updated":
    case "channel:deleted":
      loadChannels();
      break;
    case "peak:pending": {
      const peak = event.data as PeakData;
      renderPeakCard(peak);
      break;
    }
    case "peak:decided": {
      const data = event.data as { peak_id: string; chosen_option: { label: string }; decided_by: string };
      updatePeakDecision(data.peak_id, data.chosen_option?.label || "unknown", data.decided_by || "system");
      break;
    }
    case "peak:paused":
      // Timer will be refreshed on next poll; no immediate UI change needed
      break;
    case "file:updated":
      loadFiles();
      break;
    case "project:created":
    case "project:updated":
    case "project:deleted":
    case "project:agent_changed":
      handleProjectWsEvent(event.type, event.data);
      loadSidebarProjects();
      break;
  }
}

// --- Utils ---
function esc(text: string): string {
  return escapeHtml(text);
}

// --- Quick Jump ---
initQuickJump(
  () => channels,
  () => agents,
  (type, id) => {
    if (type === "agent") {
      openDmChannel(id);
    } else {
      switchChannel(id);
    }
  },
);

// --- Project Selector ---
const projectSelectorEl = document.getElementById("project-selector") as HTMLSelectElement;
let sidebarProjects: Project[] = [];

async function loadSidebarProjects(): Promise<void> {
  try {
    sidebarProjects = await api.get<Project[]>("/api/projects?status=active");
    renderProjectSelector();
  } catch { /* ignore */ }
}

function renderProjectSelector(): void {
  const currentVal = projectSelectorEl.value;
  projectSelectorEl.innerHTML = `<option value="">All Projects</option>`;
  for (const p of sidebarProjects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    projectSelectorEl.appendChild(opt);
  }
  // Restore selection if still valid
  const activeId = getActiveProjectId();
  if (activeId && sidebarProjects.find(p => p.id === activeId)) {
    projectSelectorEl.value = activeId;
  } else if (currentVal && sidebarProjects.find(p => p.id === currentVal)) {
    projectSelectorEl.value = currentVal;
  } else {
    projectSelectorEl.value = "";
  }
}

projectSelectorEl.addEventListener("change", () => {
  const selectedId = projectSelectorEl.value;
  const project = selectedId ? sidebarProjects.find(p => p.id === selectedId) || null : null;
  setActiveProject(project);
});

// When active project changes (from selector or from dashboard), refresh sidebar
onActiveProjectChange((project) => {
  saveProject(project?.id ?? null);
  // Sync selector dropdown
  projectSelectorEl.value = project?.id || "";
  // Reload sidebar data filtered by project
  loadChannels();
  loadAgents();
  loadFiles();
  // Auto-switch to project channel if available
  if (project) {
    const projectChannelId = `project-${project.slug}`;
    // Wait for channels to load, then switch
    setTimeout(() => {
      const ch = channels.find(c => c.id === projectChannelId);
      if (ch) {
        switchChannel(projectChannelId);
        switchView("chat");
      }
    }, 300);
  }
});

// --- View Switching ---
type ViewType = "chat" | "dashboard";
let currentView: ViewType = "chat";

function switchView(view: ViewType): void {
  currentView = view;
  saveView(view);
  const chatArea = document.getElementById("chat-area")!;
  const dashArea = document.getElementById("dashboard-area")!;
  chatArea.style.display = view === "chat" ? "" : "none";
  dashArea.style.display = view === "dashboard" ? "flex" : "none";
  document.querySelectorAll(".view-tab").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.view === view);
  });
}

document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = (tab as HTMLElement).dataset.view as ViewType;
    if (view) switchView(view);
  });
});

// --- Init ---
const savedState = getSavedState();

// Restore sidebar width
if (savedState.sidebarWidth) {
  sidebar.style.width = savedState.sidebarWidth + "px";
}

initInput(sendMessage, () => agents, () => getActiveProjectId());
initDashboard();
loadSidebarProjects();
loadChannels();
loadAgents();
loadFiles();

// Restore saved state or default to "general" channel / "chat" view
switchChannel(savedState.channelId || "general");
if (savedState.view === "dashboard") switchView("dashboard");
connectWebSocket();
