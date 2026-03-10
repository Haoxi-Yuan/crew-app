import type { Agent, Channel } from "./types.js";
import { getAvatarColor } from "./utils.js";

const overlay = document.getElementById("quick-jump")!;
const backdrop = overlay.querySelector(".qj-backdrop")!;
const input = overlay.querySelector(".qj-input") as HTMLInputElement;
const resultsList = overlay.querySelector(".qj-results")!;

let items: { label: string; type: "channel" | "dm" | "agent"; id: string }[] = [];
let filtered: typeof items = [];
let activeIndex = 0;
let onSelect: ((type: string, id: string) => void) | null = null;

export function initQuickJump(
  getChannels: () => Channel[],
  getAgents: () => Agent[],
  selectCallback: (type: string, id: string) => void,
): void {
  onSelect = selectCallback;

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      open(getChannels(), getAgents());
    }
  });

  backdrop.addEventListener("click", close);

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    filtered = q
      ? items.filter((it) => it.label.toLowerCase().includes(q))
      : items;
    activeIndex = 0;
    render();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % Math.max(filtered.length, 1);
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex =
        (activeIndex - 1 + Math.max(filtered.length, 1)) %
        Math.max(filtered.length, 1);
      render();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIndex]) {
        pick(filtered[activeIndex]);
      }
    }
  });
}

function open(channels: Channel[], agents: Agent[]): void {
  items = [];
  for (const ch of channels) {
    const prefix = ch.type === "dm" ? "@" : ch.type === "group" ? "G" : "#";
    items.push({
      label: `${prefix} ${ch.name}`,
      type: ch.type === "dm" ? "dm" : "channel",
      id: ch.id,
    });
  }
  for (const ag of agents) {
    items.push({ label: ag.name, type: "agent", id: ag.name });
  }
  filtered = items;
  activeIndex = 0;

  overlay.classList.remove("hidden");
  input.value = "";
  input.focus();
  render();
}

function close(): void {
  overlay.classList.add("hidden");
}

function pick(item: (typeof items)[0]): void {
  close();
  if (onSelect) onSelect(item.type, item.id);
}

function render(): void {
  resultsList.innerHTML = "";
  for (let i = 0; i < Math.min(filtered.length, 12); i++) {
    const it = filtered[i];
    const li = document.createElement("li");
    li.className = "qj-item" + (i === activeIndex ? " active" : "");

    if (it.type === "agent") {
      const color = getAvatarColor(it.label);
      li.innerHTML =
        `<span class="qj-icon" style="background:${color}">${it.label.charAt(0).toUpperCase()}</span>` +
        `<span>${esc(it.label)}</span>` +
        `<span class="qj-type">Agent</span>`;
    } else {
      const icon = it.label.startsWith("@")
        ? "@"
        : it.label.startsWith("G")
          ? "G"
          : "#";
      li.innerHTML =
        `<span class="qj-icon">${icon}</span>` +
        `<span>${esc(it.label)}</span>` +
        `<span class="qj-type">${it.type === "dm" ? "DM" : "Channel"}</span>`;
    }

    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(it);
    });
    resultsList.appendChild(li);
  }
}

function esc(text: string): string {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}
