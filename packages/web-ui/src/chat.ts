import type { Agent, Message, ToolApproval } from "./types.js";
import { escapeHtml, getAvatarColor } from "./utils.js";

const messagesEl = document.getElementById("messages")!;
let autoScroll = true;
let onApprovalRespond: ((agentName: string, key: string) => void) | null = null;

// Track last rendered message for grouping in real-time
let lastRenderedSender = "";
let lastRenderedTime = 0;

const GROUP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

messagesEl.addEventListener("scroll", () => {
  const { scrollTop, scrollHeight, clientHeight } = messagesEl;
  autoScroll = scrollHeight - scrollTop - clientHeight < 80;
});

// Copy button event delegation
messagesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".code-copy-btn");
  if (!btn) return;
  const block = btn.closest(".code-block");
  if (!block) return;
  const code = block.querySelector("code");
  if (code) {
    navigator.clipboard.writeText(code.textContent || "");
    (btn as HTMLElement).textContent = "Copied";
    setTimeout(() => { (btn as HTMLElement).textContent = "Copy"; }, 1500);
  }
});

// Hover toolbar copy delegation
messagesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".hover-copy-btn");
  if (!btn) return;
  const row = btn.closest(".message-row");
  if (!row) return;
  const content = row.querySelector(".message-content");
  if (content) {
    navigator.clipboard.writeText(content.textContent || "");
  }
});

export function setApprovalHandler(handler: (agentName: string, key: string) => void): void {
  onApprovalRespond = handler;
}

function shouldGroup(msg: Message): boolean {
  if (msg.message_type === "system") return false;
  if (msg.sender_name === lastRenderedSender &&
      msg.sender_type !== "system" &&
      msg.created_at - lastRenderedTime < GROUP_THRESHOLD_MS) {
    return true;
  }
  return false;
}

export function renderMessage(msg: Message, forceGrouped?: boolean): void {
  if (msg.message_type === "system") {
    const el = document.createElement("div");
    el.className = "message-system";
    el.dataset.id = String(msg.id);
    el.textContent = msg.content;
    messagesEl.appendChild(el);
    lastRenderedSender = "";
    lastRenderedTime = 0;
    scrollIfNeeded();
    return;
  }

  const isGrouped = forceGrouped !== undefined ? forceGrouped : shouldGroup(msg);

  const row = document.createElement("div");
  row.className = `message-row${isGrouped ? " grouped" : ""}`;
  row.dataset.id = String(msg.id);

  // Avatar
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (msg.sender_type === "user") {
    avatar.classList.add("user-avatar");
    avatar.textContent = "U";
  } else {
    const color = getAvatarColor(msg.sender_name);
    avatar.style.background = color;
    avatar.textContent = msg.sender_name.charAt(0).toUpperCase();
  }
  row.appendChild(avatar);

  // Body
  const body = document.createElement("div");
  body.className = "msg-body";

  if (!isGrouped) {
    const header = document.createElement("div");
    header.className = "message-header";
    const sender = document.createElement("span");
    sender.className = "message-sender";
    sender.textContent = msg.sender_name;
    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(msg.created_at);
    header.appendChild(sender);
    header.appendChild(time);
    body.appendChild(header);
  }

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = formatContent(msg.content);
  body.appendChild(content);

  // Delivery status
  if (msg.sender_type === "user" && msg.mentions && msg.mentions.length > 0) {
    const statusEl = document.createElement("div");
    statusEl.className = "message-delivery";
    statusEl.dataset.msgId = String(msg.id);
    statusEl.innerHTML = renderDeliveryStatus(msg.delivery_status, msg.mentions);
    body.appendChild(statusEl);
  }

  row.appendChild(body);

  // Hover toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "message-hover-toolbar";
  toolbar.innerHTML = `<button class="hover-btn hover-copy-btn" title="Copy">C</button>`;
  row.appendChild(toolbar);

  messagesEl.appendChild(row);
  lastRenderedSender = msg.sender_name;
  lastRenderedTime = msg.created_at;
  scrollIfNeeded();
}

export function renderMessages(messages: Message[]): void {
  messagesEl.innerHTML = "";
  lastRenderedSender = "";
  lastRenderedTime = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.message_type === "system") {
      renderMessage(msg);
      continue;
    }
    // Determine grouping by looking at previous message
    let grouped = false;
    if (i > 0) {
      const prev = messages[i - 1];
      if (prev.message_type !== "system" &&
          prev.sender_name === msg.sender_name &&
          msg.created_at - prev.created_at < GROUP_THRESHOLD_MS) {
        grouped = true;
      }
    }
    renderMessage(msg, grouped);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

export function updateMessageStatus(messageId: number, agentName: string, status: string): void {
  const msgEl = messagesEl.querySelector(`[data-id="${messageId}"]`);
  if (!msgEl) return;
  const deliveryEl = msgEl.querySelector(".message-delivery") as HTMLElement;
  if (!deliveryEl) return;
  const agentStatusEl = deliveryEl.querySelector(`[data-agent="${agentName}"]`) as HTMLElement;
  if (agentStatusEl) {
    agentStatusEl.className = `delivery-agent ${status}`;
    agentStatusEl.title = `${agentName}: ${statusLabel(status)}`;
    agentStatusEl.innerHTML = statusIcon(status);
  }
}

// --- Approval Cards ---

export function renderApprovalCard(approval: ToolApproval): void {
  removeApprovalCard(approval.agentName);
  const el = document.createElement("div");
  el.className = "approval-card";
  el.dataset.approvalAgent = approval.agentName;

  const header = document.createElement("div");
  header.className = "approval-header";
  header.innerHTML = `<span class="approval-icon">!</span> <span class="approval-title">${escapeHtml(approval.agentName)} needs approval</span>`;

  const toolInfo = document.createElement("div");
  toolInfo.className = "approval-tool";
  toolInfo.innerHTML = `<span class="approval-tool-name">${escapeHtml(approval.toolServer)} - ${escapeHtml(approval.toolName)}</span>`;

  const params = document.createElement("div");
  params.className = "approval-params";
  params.textContent = approval.params;

  el.appendChild(header);
  el.appendChild(toolInfo);
  el.appendChild(params);

  if (approval.description) {
    const desc = document.createElement("div");
    desc.className = "approval-desc";
    desc.textContent = approval.description;
    el.appendChild(desc);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  for (const opt of approval.options) {
    const btn = document.createElement("button");
    const lowered = `${opt.key} ${opt.label}`.toLowerCase();
    const tone = lowered.includes("accept") || lowered.includes("approve")
      ? "approve"
      : lowered.includes("decline") || lowered.includes("reject") || lowered.includes("cancel")
        ? "reject"
        : "other";
    btn.className = `approval-btn ${tone}`;
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      if (onApprovalRespond) onApprovalRespond(approval.agentName, opt.key);
      el.classList.add("responded");
      actions.innerHTML = `<span class="approval-responded">Responded: ${escapeHtml(opt.label)}</span>`;
    });
    actions.appendChild(btn);
  }
  el.appendChild(actions);
  messagesEl.appendChild(el);
  scrollIfNeeded();
}

export function removeApprovalCard(agentName: string): void {
  const existing = messagesEl.querySelector(`[data-approval-agent="${agentName}"]`);
  if (existing) {
    existing.classList.add("responded");
    const actions = existing.querySelector(".approval-actions");
    if (actions && !actions.querySelector(".approval-responded")) {
      actions.innerHTML = `<span class="approval-responded">Resolved</span>`;
    }
  }
}

// --- Typing Indicators ---

let typingContainer: HTMLDivElement | null = null;

export function updateTypingIndicators(agents: Agent[]): void {
  const busyAgents = agents.filter(a => a.status === "online" && a.tmuxState === "busy");

  if (busyAgents.length === 0) {
    if (typingContainer) {
      typingContainer.innerHTML = "";
    }
    return;
  }

  if (!typingContainer) {
    typingContainer = document.createElement("div");
    typingContainer.className = "typing-indicators";
  }

  // Insert before input area if not already in DOM
  const chatArea = document.getElementById("chat-area")!;
  const inputArea = document.getElementById("input-area")!;
  if (!typingContainer.parentElement) {
    chatArea.insertBefore(typingContainer, inputArea);
  }

  typingContainer.innerHTML = busyAgents.map(ag => {
    const color = getAvatarColor(ag.name);
    return `<div class="typing-indicator">` +
      `<span class="typing-avatar" style="background:${color}">${ag.name.charAt(0).toUpperCase()}</span>` +
      `<span class="typing-text">${escapeHtml(ag.name)} is working</span>` +
      `<span class="typing-dots"><span></span><span></span><span></span></span>` +
      `</div>`;
  }).join("");
}

// --- Terminal Panel (for DM channels) ---

let terminalPanel: HTMLDivElement | null = null;
let terminalCollapsed = false;
let currentTerminalAgent = "";

async function sendTerminalInput(input: string, type?: string): Promise<void> {
  if (!currentTerminalAgent) return;
  try {
    await fetch(`/api/agents/${encodeURIComponent(currentTerminalAgent)}/terminal/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, type }),
    });
  } catch { /* ignore */ }
}

export function showTerminalPanel(agentName: string): void {
  currentTerminalAgent = agentName;

  if (!terminalPanel) {
    terminalPanel = document.createElement("div");
    terminalPanel.className = "terminal-panel";
    terminalPanel.innerHTML = `
      <div class="terminal-header">
        <span class="terminal-toggle-arrow"></span>
        <span>Terminal: ${escapeHtml(agentName)}</span>
      </div>
      <div class="terminal-content"><span class="terminal-placeholder">Waiting for terminal output...</span></div>
      <div class="terminal-input-bar">
        <input type="text" class="terminal-input" placeholder="Type here to send input to agent terminal..." />
        <div class="terminal-quick-keys">
          <button class="terminal-key-btn" data-key="Enter" title="Enter">Enter</button>
          <button class="terminal-key-btn" data-key="Escape" title="Esc">Esc</button>
          <button class="terminal-key-btn" data-key="y" title="y">y</button>
          <button class="terminal-key-btn" data-key="n" title="n">n</button>
          <button class="terminal-key-btn" data-key="1" title="1">1</button>
          <button class="terminal-key-btn" data-key="2" title="2">2</button>
          <button class="terminal-key-btn" data-key="3" title="3">3</button>
        </div>
      </div>
    `;
    // Header collapse toggle
    terminalPanel.querySelector(".terminal-header")!.addEventListener("click", () => {
      terminalCollapsed = !terminalCollapsed;
      terminalPanel!.classList.toggle("collapsed", terminalCollapsed);
    });

    // Text input: send on Enter
    const inputEl = terminalPanel.querySelector(".terminal-input") as HTMLInputElement;
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && inputEl.value) {
        sendTerminalInput(inputEl.value);
        inputEl.value = "";
      }
      e.stopPropagation(); // Prevent global shortcuts from firing
    });

    // Quick key buttons
    terminalPanel.querySelectorAll(".terminal-key-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = (btn as HTMLElement).dataset.key!;
        sendTerminalInput(key, "key");
      });
    });
  } else {
    // Update agent name in header
    const header = terminalPanel.querySelector(".terminal-header span:last-child")!;
    header.textContent = `Terminal: ${agentName}`;
    // Reset content with placeholder
    const contentEl = terminalPanel.querySelector(".terminal-content");
    if (contentEl) {
      contentEl.innerHTML = `<span class="terminal-placeholder">Waiting for terminal output...</span>`;
    }
  }

  const chatArea = document.getElementById("chat-area")!;
  const channelHeader = document.getElementById("channel-header")!;
  // Insert after channel header
  if (!terminalPanel.parentElement) {
    chatArea.insertBefore(terminalPanel, channelHeader.nextSibling);
  }
}

export function hideTerminalPanel(): void {
  if (terminalPanel && terminalPanel.parentElement) {
    terminalPanel.remove();
  }
  currentTerminalAgent = "";
}

export function updateTerminalContent(content: string): void {
  if (!terminalPanel) return;
  const contentEl = terminalPanel.querySelector(".terminal-content");
  if (contentEl) {
    contentEl.innerHTML = ansiToHtml(content);
    contentEl.scrollTop = contentEl.scrollHeight;
  }
}

// --- ANSI to HTML converter ---

interface AnsiState {
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function emptyState(): AnsiState {
  return { fg: "", bg: "", bold: false, dim: false, italic: false, underline: false };
}

function stateToStyle(s: AnsiState): string {
  const parts: string[] = [];
  if (s.fg) parts.push(`color:${s.fg}`);
  if (s.bg) parts.push(`background:${s.bg}`);
  if (s.bold) parts.push("font-weight:bold");
  if (s.dim) parts.push("opacity:0.6");
  if (s.italic) parts.push("font-style:italic");
  if (s.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

// Standard ANSI 256-color palette (first 16 colors)
const ANSI_16_COLORS = [
  "#000","#aa0000","#00aa00","#aa5500","#0000aa","#aa00aa","#00aaaa","#aaaaaa",
  "#555555","#ff5555","#55ff55","#ffff55","#5555ff","#ff55ff","#55ffff","#ffffff",
];

function ansi256ToHex(n: number): string {
  if (n < 16) return ANSI_16_COLORS[n];
  if (n < 232) {
    // 6x6x6 color cube
    const idx = n - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  // Grayscale 232-255
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function applySgrCodes(codes: number[], state: AnsiState): void {
  let i = 0;
  while (i < codes.length) {
    const c = codes[i];
    if (c === 0) {
      // Reset
      state.fg = ""; state.bg = "";
      state.bold = false; state.dim = false;
      state.italic = false; state.underline = false;
    } else if (c === 1) { state.bold = true; }
    else if (c === 2) { state.dim = true; }
    else if (c === 3) { state.italic = true; }
    else if (c === 4) { state.underline = true; }
    else if (c === 22) { state.bold = false; state.dim = false; }
    else if (c === 23) { state.italic = false; }
    else if (c === 24) { state.underline = false; }
    else if (c === 39) { state.fg = ""; }
    else if (c === 49) { state.bg = ""; }
    else if (c >= 30 && c <= 37) {
      state.fg = ANSI_16_COLORS[c - 30];
    } else if (c >= 90 && c <= 97) {
      state.fg = ANSI_16_COLORS[c - 90 + 8];
    } else if (c >= 40 && c <= 47) {
      state.bg = ANSI_16_COLORS[c - 40];
    } else if (c >= 100 && c <= 107) {
      state.bg = ANSI_16_COLORS[c - 100 + 8];
    } else if (c === 38 && i + 1 < codes.length) {
      // Extended foreground: 38;5;n (256-color) or 38;2;r;g;b (RGB)
      if (codes[i + 1] === 5 && i + 2 < codes.length) {
        state.fg = ansi256ToHex(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
        state.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    } else if (c === 48 && i + 1 < codes.length) {
      // Extended background
      if (codes[i + 1] === 5 && i + 2 < codes.length) {
        state.bg = ansi256ToHex(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
        state.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
    i++;
  }
}

function ansiToHtml(text: string): string {
  // Process ANSI BEFORE HTML-escaping (browser strips \x1b from innerHTML)
  const result: string[] = [];
  const state = emptyState();
  let spanOpen = false;

  // Split on ANSI escape sequences: \x1b[ ... letter
  // Match SGR (m) and strip all other CSI sequences
  const parts = text.split(/(\x1b\[[0-9;]*[A-Za-z])/);

  for (const part of parts) {
    const m = part.match(/^\x1b\[([0-9;]*)([A-Za-z])$/);
    if (m) {
      const codesStr = m[1];
      const cmd = m[2];
      if (cmd !== "m") continue; // Strip non-SGR sequences (cursor moves, etc.)

      const codes = codesStr ? codesStr.split(";").map(Number) : [0];
      applySgrCodes(codes, state);

      if (spanOpen) {
        result.push("</span>");
        spanOpen = false;
      }
      const style = stateToStyle(state);
      if (style) {
        result.push(`<span style="${style}">`);
        spanOpen = true;
      }
    } else if (part) {
      // Plain text - HTML escape it
      result.push(escapeHtml(part));
    }
  }

  if (spanOpen) result.push("</span>");
  return result.join("");
}

// --- Helpers ---

function scrollIfNeeded(): void {
  if (autoScroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function renderDeliveryStatus(
  deliveryStatus: Record<string, string> | undefined,
  mentions: string[]
): string {
  if (!deliveryStatus || mentions.length === 0) {
    return mentions
      .map(name => `<span class="delivery-agent sent" data-agent="${escapeHtml(name)}" title="${escapeHtml(name)}: ${statusLabel("sent")}">${statusIcon("sent")}</span>`)
      .join("");
  }
  return mentions
    .map(name => {
      const st = deliveryStatus[name] || "sent";
      return `<span class="delivery-agent ${st}" data-agent="${escapeHtml(name)}" title="${escapeHtml(name)}: ${statusLabel(st)}">${statusIcon(st)}</span>`;
    })
    .join("");
}

function statusIcon(status: string): string {
  switch (status) {
    case "read": return "&#10003;&#10003;";
    case "delivered": return "&#10003;&#10003;";
    case "sent": default: return "&#10003;";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "read": return "Read";
    case "delivered": return "Delivered";
    case "sent": default: return "Sent";
  }
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function formatContent(text: string): string {
  let html = escapeHtml(text);

  // Code blocks first (before inline code)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : "";
    return `<div class="code-block">` +
      `<div class="code-block-header">${langLabel}<button class="code-copy-btn">Copy</button></div>` +
      `<pre><code>${code}</code></pre></div>`;
  });

  // Inline code (but not inside code blocks which are now divs)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic (single * but not **)
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Blockquotes (lines starting with >)
  html = html.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  // Merge consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Unordered lists
  html = html.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // @mentions
  html = html.replace(/@([\w][\w-]*)/g, '<span class="mention">@$1</span>');

  return html;
}
