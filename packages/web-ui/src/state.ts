/**
 * WebView state persistence.
 *
 * When running inside a VS Code WebView, uses acquireVsCodeApi().getState/setState.
 * When running in a standalone browser, uses sessionStorage as fallback.
 * This allows the UI to restore its last state after WebView disposal/recreation.
 */

interface AppState {
  channelId?: string;
  projectId?: string;
  view?: "chat" | "dashboard";
  sidebarWidth?: number;
}

// VS Code WebView API (only available when running inside a WebView)
interface VsCodeApi {
  getState(): AppState | undefined;
  setState(state: AppState): void;
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let vscodeApi: VsCodeApi | null = null;
let currentState: AppState = {};

function initApi(): void {
  try {
    if (typeof acquireVsCodeApi === "function") {
      vscodeApi = acquireVsCodeApi();
      const saved = vscodeApi.getState();
      if (saved) currentState = saved;
    }
  } catch {
    // Not in VS Code WebView
  }

  // Fallback: restore from sessionStorage
  if (!vscodeApi) {
    try {
      const raw = sessionStorage.getItem("crew-ui-state");
      if (raw) currentState = JSON.parse(raw);
    } catch { /* ignore */ }
  }
}

function persist(): void {
  if (vscodeApi) {
    vscodeApi.setState(currentState);
  } else {
    try {
      sessionStorage.setItem("crew-ui-state", JSON.stringify(currentState));
    } catch { /* ignore */ }
  }
}

// Initialize on module load
initApi();

export function getSavedState(): AppState {
  return { ...currentState };
}

export function saveChannel(channelId: string): void {
  currentState.channelId = channelId;
  persist();
}

export function saveProject(projectId: string | null): void {
  currentState.projectId = projectId || undefined;
  persist();
}

export function saveView(view: "chat" | "dashboard"): void {
  currentState.view = view;
  persist();
}

export function saveSidebarWidth(width: number): void {
  currentState.sidebarWidth = width;
  persist();
}
