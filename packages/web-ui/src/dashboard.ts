import type { Project, ProjectAgent } from "./project-types.js";
import { setActiveProject } from "./project-context.js";
import { showConfirm } from "./utils.js";
import { api, ApiError } from "./transport.js";

let projects: Project[] = [];
let selectedProjectId: string | null = null;

const dashboardArea = document.getElementById("dashboard-area")!;

export function initDashboard(): void {
  renderDashboard();
  loadProjects();
}

export function handleProjectWsEvent(type: string, data: unknown): void {
  if (type === "project:created" || type === "project:updated" || type === "project:deleted" || type === "project:agent_changed") {
    loadProjects();
  }
}

async function loadProjects(): Promise<void> {
  try {
    projects = await api.get<Project[]>("/api/projects");
    renderDashboard();
  } catch (err) {
    console.error("Failed to load projects:", err);
  }
}

function renderDashboard(): void {
  if (selectedProjectId) {
    renderProjectDetail(selectedProjectId);
    return;
  }

  const activeProjects = projects.filter((p) => p.status === "active");
  const pausedProjects = projects.filter((p) => p.status === "paused");
  const archivedProjects = projects.filter((p) => p.status === "archived");

  let html = `
    <div class="dash-header">
      <h2>Projects</h2>
      <button class="dash-btn primary" id="dash-new-project">+ New Project</button>
    </div>
  `;

  if (activeProjects.length > 0) {
    html += `<div class="dash-section-label">Active</div>`;
    html += `<div class="dash-grid">${activeProjects.map(projectCardHtml).join("")}</div>`;
  }

  if (pausedProjects.length > 0) {
    html += `<div class="dash-section-label">Paused</div>`;
    html += `<div class="dash-grid">${pausedProjects.map(projectCardHtml).join("")}</div>`;
  }

  if (archivedProjects.length > 0) {
    html += `<div class="dash-section-label">Archived</div>`;
    html += `<div class="dash-grid">${archivedProjects.map(projectCardHtml).join("")}</div>`;
  }

  if (projects.length === 0) {
    html += `<div class="dash-empty">No projects yet. Create your first project to get started.</div>`;
  }

  dashboardArea.innerHTML = html;

  // Bind events
  document.getElementById("dash-new-project")?.addEventListener("click", openCreateProjectModal);

  dashboardArea.querySelectorAll(".dash-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = (card as HTMLElement).dataset.projectId;
      if (id) {
        selectedProjectId = id;
        // Also set the active project context for sidebar filtering
        const project = projects.find(p => p.id === id) || null;
        setActiveProject(project);
        renderDashboard();
      }
    });
  });
}

function projectCardHtml(p: Project): string {
  const statusClass = p.status === "active" ? "status-active" : p.status === "paused" ? "status-paused" : "status-archived";
  const techTags = p.tech_stack.map((t) => `<span class="dash-tag">${esc(t)}</span>`).join("");
  const date = new Date(p.updated_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });

  return `
    <div class="dash-card" data-project-id="${p.id}">
      <div class="dash-card-header">
        <span class="dash-card-title">${esc(p.name)}</span>
        <span class="dash-status ${statusClass}">${p.status}</span>
      </div>
      <div class="dash-card-desc">${esc(p.description || "No description")}</div>
      <div class="dash-card-tags">${techTags}</div>
      <div class="dash-card-footer">
        <span>Agents: ${p.agent_count}</span>
        <span>Memory: ${p.memory_count}</span>
        <span>${date}</span>
      </div>
    </div>
  `;
}

async function renderProjectDetail(projectId: string): Promise<void> {
  let project: (Project & { agents: ProjectAgent[] }) | null = null;

  try {
    project = await api.get(`/api/projects/${projectId}`);
  } catch {
    dashboardArea.innerHTML = `<div class="dash-empty">Failed to load project.</div>`;
    return;
  }

  if (!project) return;

  const agentRows = (project.agents || [])
    .map((a) => `
      <tr>
        <td>${esc(a.agent_name)}</td>
        <td>${esc(a.role_in_project || "-")}</td>
        <td><span class="dash-tag">${a.assignment_type}</span></td>
        <td><button class="dash-btn-sm danger" data-remove-agent="${esc(a.agent_name)}">Remove</button></td>
      </tr>
    `)
    .join("");

  const techTags = (project.tech_stack || []).map((t) => `<span class="dash-tag">${esc(String(t))}</span>`).join("");
  const statusClass = project.status === "active" ? "status-active" : project.status === "paused" ? "status-paused" : "status-archived";

  dashboardArea.innerHTML = `
    <div class="dash-detail">
      <div class="dash-detail-header">
        <button class="dash-btn" id="dash-back">Back</button>
        <h2>${esc(project.name)}</h2>
        <span class="dash-status ${statusClass}">${project.status}</span>
        <div class="dash-detail-actions">
          <button class="dash-btn" id="dash-edit">Edit</button>
          ${project.status === "active" ? `<button class="dash-btn" id="dash-pause">Pause</button>` : ""}
          ${project.status === "paused" ? `<button class="dash-btn primary" id="dash-resume">Resume</button>` : ""}
          ${project.status !== "archived" ? `<button class="dash-btn" id="dash-archive">Archive</button>` : ""}
          <button class="dash-btn danger" id="dash-delete">Delete</button>
        </div>
      </div>

      <div class="dash-detail-body">
        <div class="dash-detail-section">
          <h3>Description</h3>
          <p>${esc(project.description || "No description")}</p>
        </div>

        <div class="dash-detail-section">
          <h3>Tech Stack</h3>
          <div class="dash-card-tags">${techTags || "<span class='text-secondary'>None</span>"}</div>
        </div>

        <div class="dash-detail-section">
          <div class="dash-detail-section-header">
            <h3>Agents (${project.agents?.length || 0})</h3>
            <button class="dash-btn-sm primary" id="dash-assign-agent">+ Assign</button>
          </div>
          ${(project.agents?.length || 0) > 0 ? `
            <table class="dash-table">
              <thead><tr><th>Name</th><th>Role</th><th>Type</th><th></th></tr></thead>
              <tbody>${agentRows}</tbody>
            </table>
          ` : `<div class="text-secondary">No agents assigned</div>`}
        </div>

        <div class="dash-detail-section">
          <h3>Memory</h3>
          <div class="text-secondary">${project.memory_count} entries</div>
        </div>
      </div>
    </div>
  `;

  // Bind events
  document.getElementById("dash-back")?.addEventListener("click", () => {
    selectedProjectId = null;
    renderDashboard();
  });

  document.getElementById("dash-edit")?.addEventListener("click", () => {
    if (project) openEditProjectModal(project);
  });

  document.getElementById("dash-pause")?.addEventListener("click", async () => {
    await api.post(`/api/projects/${projectId}/pause`);
    await loadProjects();
    renderProjectDetail(projectId);
  });

  document.getElementById("dash-resume")?.addEventListener("click", async () => {
    await api.post(`/api/projects/${projectId}/resume`);
    await loadProjects();
    renderProjectDetail(projectId);
  });

  document.getElementById("dash-archive")?.addEventListener("click", async () => {
    await api.post(`/api/projects/${projectId}/archive`);
    await loadProjects();
    renderProjectDetail(projectId);
  });

  document.getElementById("dash-delete")?.addEventListener("click", async () => {
    if (!await showConfirm("Delete this project? This cannot be undone.")) return;
    await api.del(`/api/projects/${projectId}`);
    selectedProjectId = null;
    setActiveProject(null);
    await loadProjects();
  });

  document.getElementById("dash-assign-agent")?.addEventListener("click", () => {
    openAssignAgentModal(projectId);
  });

  dashboardArea.querySelectorAll("[data-remove-agent]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const agentName = (btn as HTMLElement).dataset.removeAgent!;
      if (!await showConfirm(`Remove ${agentName} from this project?`)) return;
      await api.del(`/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`);
      await loadProjects();
      renderProjectDetail(projectId);
    });
  });
}

function openCreateProjectModal(): void {
  const overlay = document.getElementById("modal-overlay")!;
  const title = document.getElementById("modal-title")!;
  const body = document.getElementById("modal-body")!;

  title.textContent = "New Project";
  body.innerHTML = `
    <div class="form-group">
      <label>Directory</label>
      <div style="display:flex;gap:6px">
        <input id="f-proj-dir" type="text" placeholder="/path/to/your/project" style="flex:1">
        <button type="button" id="f-proj-browse" class="modal-action-btn" style="white-space:nowrap;padding:6px 12px">Browse</button>
      </div>
    </div>
    <div class="form-group"><label>Name</label><input id="f-proj-name" type="text" placeholder="Auto-filled from directory name"></div>
    <div class="form-group"><label>Description</label><textarea id="f-proj-desc" rows="3" placeholder="What is this project about?"></textarea></div>
    <div class="form-group">
      <label>Tech Stack (comma separated)</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="f-proj-tech" type="text" placeholder="Auto-detected from project files" style="flex:1">
        <span id="f-proj-tech-status" style="font-size:11px;color:var(--text-secondary,#969696)"></span>
      </div>
    </div>
    <button class="modal-action-btn" id="f-proj-create">Create Project</button>
  `;
  overlay.classList.remove("hidden");

  const dirInput = document.getElementById("f-proj-dir") as HTMLInputElement;
  const nameInput = document.getElementById("f-proj-name") as HTMLInputElement;
  const techInput = document.getElementById("f-proj-tech") as HTMLInputElement;
  const techStatus = document.getElementById("f-proj-tech-status")!;

  // Auto-fill name and detect tech stack when directory changes
  async function onDirectoryChanged(dir: string): Promise<void> {
    if (!dir) return;
    // Auto-fill name from directory basename
    const basename = dir.split("/").pop() || dir.split("\\").pop() || "";
    if (basename && !nameInput.value.trim()) {
      nameInput.value = basename;
    }
    // Auto-detect tech stack
    techStatus.textContent = "Detecting...";
    try {
      const data = await api.post<{ tech_stack: string[] }>("/api/system/detect-tech-stack", { directory: dir });
      if (data.tech_stack.length > 0) {
        techInput.value = data.tech_stack.join(", ");
        techStatus.textContent = `${data.tech_stack.length} detected`;
      } else {
        techStatus.textContent = "No frameworks detected";
      }
    } catch {
      techStatus.textContent = "";
    }
  }

  // Browse button: open native folder picker
  document.getElementById("f-proj-browse")!.addEventListener("click", async () => {
    try {
      const data = await api.get<{ directory: string | null }>("/api/system/pick-directory");
      if (data.directory) {
        dirInput.value = data.directory;
        await onDirectoryChanged(data.directory);
      }
    } catch {
      alert("Failed to open folder picker");
    }
  });

  // Also detect when user manually types/pastes a path
  let dirDebounce: ReturnType<typeof setTimeout>;
  dirInput.addEventListener("input", () => {
    clearTimeout(dirDebounce);
    dirDebounce = setTimeout(() => {
      const dir = dirInput.value.trim();
      if (dir && dir.startsWith("/")) {
        onDirectoryChanged(dir);
      }
    }, 500);
  });

  document.getElementById("f-proj-create")!.addEventListener("click", async () => {
    const directory = dirInput.value.trim();
    if (!directory) {
      alert("Please select a project directory");
      return;
    }
    const name = nameInput.value.trim();
    const description = (document.getElementById("f-proj-desc") as HTMLTextAreaElement).value.trim();
    const techStr = techInput.value.trim();
    const tech_stack = techStr ? techStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const btn = document.getElementById("f-proj-create") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Creating...";

    try {
      const newProject = await api.post<Project>("/api/projects", { directory, name: name || undefined, description, tech_stack });

      overlay.classList.add("hidden");
      await loadProjects();

      // Auto-navigate: set active project -> sidebar will filter & switch to project channel
      const fullProject = projects.find(p => p.id === newProject.id) || {
        ...newProject,
        agent_count: 0,
        memory_count: 0,
      };
      selectedProjectId = newProject.id;
      setActiveProject(fullProject);
      renderDashboard();
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Create Project";
    }
  });
}

function openEditProjectModal(project: Project): void {
  const overlay = document.getElementById("modal-overlay")!;
  const title = document.getElementById("modal-title")!;
  const body = document.getElementById("modal-body")!;

  title.textContent = "Edit Project";
  body.innerHTML = `
    <div class="form-group"><label>Name</label><input id="f-proj-edit-name" type="text" value="${esc(project.name)}"></div>
    <div class="form-group"><label>Description</label><textarea id="f-proj-edit-desc" rows="3">${esc(project.description)}</textarea></div>
    <div class="form-group"><label>Tech Stack (comma separated)</label><input id="f-proj-edit-tech" type="text" value="${esc(project.tech_stack.join(", "))}"></div>
    <button class="modal-action-btn" id="f-proj-edit-save">Save Changes</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("f-proj-edit-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-proj-edit-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const description = (document.getElementById("f-proj-edit-desc") as HTMLTextAreaElement).value.trim();
    const techStr = (document.getElementById("f-proj-edit-tech") as HTMLInputElement).value.trim();
    const tech_stack = techStr ? techStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const btn = document.getElementById("f-proj-edit-save") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      await api.put(`/api/projects/${project.id}`, { name, description, tech_stack });
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Save Changes";
      return;
    }

    overlay.classList.add("hidden");
    await loadProjects();
    renderProjectDetail(project.id);
  });
}

interface AgentWorkspace {
  name: string;
  role: string;
  provider: string;
}

async function openAssignAgentModal(projectId: string): Promise<void> {
  const overlay = document.getElementById("modal-overlay")!;
  const title = document.getElementById("modal-title")!;
  const body = document.getElementById("modal-body")!;

  title.textContent = "Assign Agent";
  body.innerHTML = `<div class="text-secondary">Loading agents...</div>`;
  overlay.classList.remove("hidden");

  let allAgents: AgentWorkspace[] = [];
  let assignedNames: string[] = [];
  try {
    allAgents = await api.get<AgentWorkspace[]>("/api/workspaces");
    const projectDetail = await api.get<{ agents?: ProjectAgent[] }>(`/api/projects/${projectId}`);
    assignedNames = (projectDetail.agents || []).map((a: ProjectAgent) => a.agent_name);
  } catch {
    body.innerHTML = `<div class="text-secondary">Failed to load agents.</div>`;
    return;
  }

  const availableAgents = allAgents.filter((a) => !assignedNames.includes(a.name));

  const agentListHtml = availableAgents.length > 0
    ? availableAgents.map((a) => `
        <div class="assign-agent-item" data-agent-name="${esc(a.name)}" data-agent-role="${esc(a.role)}">
          <div class="assign-agent-name">${esc(a.name)}</div>
          <div class="assign-agent-role">${esc(a.role || "No role defined")}</div>
          <div class="assign-agent-provider">${esc(a.provider)}</div>
        </div>
      `).join("")
    : `<div class="text-secondary">All agents are already assigned to this project.</div>`;

  body.innerHTML = `
    <div class="assign-tabs">
      <button class="assign-tab active" data-tab="existing">Add Existing</button>
      <button class="assign-tab" data-tab="new">Create New</button>
    </div>

    <div id="assign-tab-existing" class="assign-tab-content">
      <div class="assign-agent-list">${agentListHtml}</div>
      <div id="assign-existing-form" class="hidden">
        <div class="assign-selected-info">
          Selected: <strong id="assign-selected-name"></strong>
        </div>
        <div class="form-group"><label>Role in Project</label><input id="f-assign-role" type="text" placeholder="Override role for this project (optional)"></div>
        <div class="form-group">
          <label>Assignment Type</label>
          <select id="f-assign-type">
            <option value="dedicated">Dedicated</option>
            <option value="shared">Shared</option>
          </select>
        </div>
        <button class="modal-action-btn" id="f-assign-submit">Assign to Project</button>
      </div>
    </div>

    <div id="assign-tab-new" class="assign-tab-content hidden">
      <div class="form-group"><label>Agent Name</label><input id="f-new-name" type="text" placeholder="my-agent"></div>
      <div class="form-group"><label>Role</label><input id="f-new-role" type="text" placeholder="Backend developer"></div>
      <div class="form-group">
        <label>Assignment Type</label>
        <select id="f-new-type">
          <option value="dedicated">Dedicated</option>
          <option value="shared">Shared</option>
        </select>
      </div>
      <label class="toggle-label"><input type="checkbox" id="f-new-wake" checked> Wake agent after creation</label>
      <button class="modal-action-btn" id="f-new-submit">Create & Assign</button>
    </div>
  `;

  // Tab switching
  body.querySelectorAll(".assign-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      body.querySelectorAll(".assign-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const tabName = (tab as HTMLElement).dataset.tab!;
      document.getElementById("assign-tab-existing")!.classList.toggle("hidden", tabName !== "existing");
      document.getElementById("assign-tab-new")!.classList.toggle("hidden", tabName !== "new");
    });
  });

  // Existing agent selection
  let selectedAgent: string | null = null;
  body.querySelectorAll(".assign-agent-item").forEach((item) => {
    item.addEventListener("click", () => {
      body.querySelectorAll(".assign-agent-item").forEach((i) => i.classList.remove("selected"));
      item.classList.add("selected");
      selectedAgent = (item as HTMLElement).dataset.agentName!;
      const agentRole = (item as HTMLElement).dataset.agentRole || "";

      document.getElementById("assign-existing-form")!.classList.remove("hidden");
      document.getElementById("assign-selected-name")!.textContent = selectedAgent;
      (document.getElementById("f-assign-role") as HTMLInputElement).value = agentRole;
      (document.getElementById("f-assign-role") as HTMLInputElement).placeholder = agentRole || "Role in this project";
    });
  });

  // Submit: assign existing agent
  document.getElementById("f-assign-submit")!.addEventListener("click", async () => {
    if (!selectedAgent) return;
    const role_in_project = (document.getElementById("f-assign-role") as HTMLInputElement).value.trim();
    const assignment_type = (document.getElementById("f-assign-type") as HTMLSelectElement).value;

    const btn = document.getElementById("f-assign-submit") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Assigning...";

    try {
      await api.post(`/api/projects/${projectId}/agents`, { agent_name: selectedAgent, role_in_project, assignment_type });
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Assign to Project";
      return;
    }

    overlay.classList.add("hidden");
    await loadProjects();
    renderProjectDetail(projectId);
  });

  // Submit: create new agent and assign
  document.getElementById("f-new-submit")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-new-name") as HTMLInputElement).value.trim();
    if (!name) { alert("Agent name is required"); return; }
    const role = (document.getElementById("f-new-role") as HTMLInputElement).value.trim();
    const assignment_type = (document.getElementById("f-new-type") as HTMLSelectElement).value;
    const wake = (document.getElementById("f-new-wake") as HTMLInputElement).checked;

    const btn = document.getElementById("f-new-submit") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Creating...";

    try {
      await api.post("/api/agents/create", { name, role, wake });
      await api.post(`/api/projects/${projectId}/agents`, { agent_name: name, role_in_project: role, assignment_type });
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Create & Assign";
      return;
    }

    overlay.classList.add("hidden");
    await loadProjects();
    renderProjectDetail(projectId);
  });
}

function esc(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
