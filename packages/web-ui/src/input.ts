import type { Agent } from "./types.js";

const inputEl = document.getElementById("message-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn")!;
const dropdownEl = document.getElementById("mention-dropdown")!;

let agents: Agent[] = [];
let dropdownItems: string[] = [];
let activeIndex = 0;
let mentionStart = -1;
let onSend: ((text: string) => void) | null = null;
let isComposing = false;
let getActiveProject: (() => string | null) | null = null;

export function initInput(sendCallback: (text: string) => void, getAgents: () => Agent[], getProjectId?: () => string | null): void {
  onSend = sendCallback;
  getActiveProject = getProjectId || null;

  inputEl.addEventListener("compositionstart", () => { isComposing = true; });
  inputEl.addEventListener("compositionend", () => { isComposing = false; });

  inputEl.addEventListener("input", () => {
    autoResize();
    agents = getAgents();
    handleMentionInput();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!dropdownEl.classList.contains("hidden")) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % dropdownItems.length;
        updateDropdownHighlight();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + dropdownItems.length) % dropdownItems.length;
        updateDropdownHighlight();
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        selectMention(dropdownItems[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        hideDropdown();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !isComposing) {
      e.preventDefault();
      doSend();
    }
  });

  sendBtn.addEventListener("click", doSend);
}

function doSend(): void {
  const text = inputEl.value.trim();
  if (!text || !onSend) return;
  onSend(text);
  inputEl.value = "";
  autoResize();
  hideDropdown();
}

function autoResize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

function handleMentionInput(): void {
  const pos = inputEl.selectionStart || 0;
  const text = inputEl.value;

  // Find the @ before cursor
  let atPos = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === "@") {
      atPos = i;
      break;
    }
    if (text[i] === " " || text[i] === "\n") break;
  }

  if (atPos === -1) {
    hideDropdown();
    return;
  }

  mentionStart = atPos;
  const query = text.slice(atPos + 1, pos).toLowerCase();

  const baseOptions = getActiveProject?.() ? ["all", "project", ...agents.map((a) => a.name)] : ["all", ...agents.map((a) => a.name)];
  dropdownItems = baseOptions.filter((name) => name.toLowerCase().includes(query));

  if (dropdownItems.length === 0) {
    hideDropdown();
    return;
  }

  activeIndex = 0;
  showDropdown();
}

function showDropdown(): void {
  dropdownEl.innerHTML = "";
  dropdownEl.classList.remove("hidden");

  for (let i = 0; i < dropdownItems.length; i++) {
    const item = document.createElement("div");
    item.className = "mention-item" + (i === activeIndex ? " active" : "");
    const name = dropdownItems[i];

    if (name === "all") {
      item.innerHTML = '<span class="agent-dot online"></span>@all (global broadcast)';
    } else if (name === "project") {
      item.innerHTML = '<span class="agent-dot online"></span>@project (project agents)';
    } else {
      const agent = agents.find((a) => a.name === name);
      const status = agent?.status || "offline";
      item.innerHTML = `<span class="agent-dot ${status}"></span>@${name}`;
    }

    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectMention(name);
    });

    dropdownEl.appendChild(item);
  }
}

function hideDropdown(): void {
  dropdownEl.classList.add("hidden");
  mentionStart = -1;
}

function updateDropdownHighlight(): void {
  const items = dropdownEl.querySelectorAll(".mention-item");
  items.forEach((el, i) => {
    el.classList.toggle("active", i === activeIndex);
  });
}

function selectMention(name: string): void {
  const text = inputEl.value;
  const pos = inputEl.selectionStart || 0;
  const before = text.slice(0, mentionStart);
  const after = text.slice(pos);
  inputEl.value = before + "@" + name + " " + after;
  const newPos = mentionStart + name.length + 2;
  inputEl.setSelectionRange(newPos, newPos);
  inputEl.focus();
  hideDropdown();
}
