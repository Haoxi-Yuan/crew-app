import * as vscode from "vscode";
import { ServerManager } from "./server/manager.js";
import { CrewClient } from "./server/client.js";
import { CrewWebViewPanel } from "./views/webview-panel.js";
import { AgentTreeProvider, AgentTreeItem } from "./views/agent-tree.js";
import { ProjectTreeProvider } from "./views/project-tree.js";
import { SharedFilesTreeProvider } from "./views/shared-files-tree.js";
import { EventBridge } from "./server/event-bridge.js";

let serverManager: ServerManager;
let client: CrewClient | null = null;
let eventBridge: EventBridge;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Claude Crew");
  serverManager = new ServerManager(context, outputChannel);
  eventBridge = new EventBridge(outputChannel);

  // Tree view providers
  const agentTree = new AgentTreeProvider();
  const projectTree = new ProjectTreeProvider();
  const sharedFilesTree = new SharedFilesTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claude-crew-agents", agentTree),
    vscode.window.registerTreeDataProvider("claude-crew-projects", projectTree),
    vscode.window.registerTreeDataProvider("claude-crew-shared-files", sharedFilesTree),
  );

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "claude-crew.openPanel";
  updateStatusBar("stopped");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // React to server state changes
  serverManager.onDidChangeState((state) => {
    updateStatusBar(state);
    if (state === "running" && serverManager.port) {
      if (!client) {
        client = new CrewClient(serverManager.port);
      } else {
        client.updatePort(serverManager.port);
      }
      agentTree.setClient(client);
      projectTree.setClient(client);
      sharedFilesTree.setClient(client);
      eventBridge.connect(serverManager.port);
    } else if (state === "stopped") {
      agentTree.clearClient();
      projectTree.clearClient();
      sharedFilesTree.clearClient();
      eventBridge.disconnect();
    }
  });

  // Wire up event bridge to auto-refresh tree views and show notifications
  context.subscriptions.push(
    eventBridge.onEvent((event) => {
      switch (event.type) {
        case "agent:status":
          agentTree.refresh();
          refreshStatusBarCounts();
          break;
        case "project:created":
        case "project:updated":
        case "project:deleted":
        case "project:agent_changed":
          projectTree.refresh();
          break;
        case "file:updated":
          sharedFilesTree.refresh();
          break;
        case "approval:pending": {
          pendingApprovals++;
          refreshStatusBarCounts();
          const data = event.data as { agentName?: string };
          vscode.window.showWarningMessage(
            `Agent "${data.agentName || "unknown"}" needs approval`,
            "Open Panel",
          ).then((action) => {
            if (action === "Open Panel") {
              vscode.commands.executeCommand("claude-crew.openPanel");
            }
          });
          break;
        }
        case "approval:resolved":
          pendingApprovals = Math.max(0, pendingApprovals - 1);
          refreshStatusBarCounts();
          break;
        case "peak:pending": {
          const data = event.data as { title?: string };
          vscode.window.showInformationMessage(
            `New decision needed: ${data.title || "PEAK"}`,
            "Open Panel",
          ).then((action) => {
            if (action === "Open Panel") {
              vscode.commands.executeCommand("claude-crew.openPanel");
            }
          });
          break;
        }
        case "mention:pending": {
          const data = event.data as { agentName?: string };
          vscode.window.showInformationMessage(
            `Agent "${data.agentName || "unknown"}" was mentioned`,
            "Open Panel",
          ).then((action) => {
            if (action === "Open Panel") {
              vscode.commands.executeCommand("claude-crew.openPanel");
            }
          });
          break;
        }
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-crew.startServer", async () => {
      try {
        await serverManager.start();
        vscode.window.showInformationMessage("Claude Crew server started.");
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to start server: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.stopServer", async () => {
      await serverManager.stop();
      vscode.window.showInformationMessage("Claude Crew server stopped.");
    }),

    vscode.commands.registerCommand("claude-crew.restartServer", async () => {
      try {
        await serverManager.restart();
        vscode.window.showInformationMessage("Claude Crew server restarted.");
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to restart server: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.openPanel", () => {
      if (!serverManager.isRunning || !serverManager.port) {
        vscode.window.showWarningMessage("Server is not running. Start it first.");
        return;
      }
      CrewWebViewPanel.createOrShow(context.extensionUri, serverManager.port);
    }),

    vscode.commands.registerCommand("claude-crew.refreshAgents", () => {
      agentTree.refresh();
      projectTree.refresh();
      sharedFilesTree.refresh();
    }),

    vscode.commands.registerCommand("claude-crew.wakeAgent", async () => {
      if (!client) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      try {
        const agents = await client.getAgents();
        const offlineAgents = agents.filter((a) => a.status !== "online");
        if (offlineAgents.length === 0) {
          vscode.window.showInformationMessage("All agents are already online.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          offlineAgents.map((a) => ({
            label: a.name,
            description: `${a.role} [${a.provider}]`,
          })),
          { placeHolder: "Select agent to wake" },
        );
        if (picked) {
          await client.wakeAgent(picked.label);
          agentTree.refresh();
          vscode.window.showInformationMessage(`Agent "${picked.label}" waking up...`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to wake agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.stopAgent", async () => {
      if (!client) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      try {
        const agents = await client.getAgents();
        const onlineAgents = agents.filter((a) => a.status === "online");
        if (onlineAgents.length === 0) {
          vscode.window.showInformationMessage("No agents are currently online.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          onlineAgents.map((a) => ({
            label: a.name,
            description: `${a.role} [${a.provider}]`,
          })),
          { placeHolder: "Select agent to stop" },
        );
        if (picked) {
          await client.stopAgent(picked.label);
          agentTree.refresh();
          vscode.window.showInformationMessage(`Agent "${picked.label}" stopped.`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop agent: ${(err as Error).message}`);
      }
    }),

    // Tree item inline actions
    vscode.commands.registerCommand("claude-crew.wakeAgentFromTree", async (item: AgentTreeItem) => {
      if (!client || !item.agentName) return;
      try {
        await client.wakeAgent(item.agentName);
        vscode.window.showInformationMessage(`Agent "${item.agentName}" waking up...`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to wake agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.stopAgentFromTree", async (item: AgentTreeItem) => {
      if (!client || !item.agentName) return;
      try {
        await client.stopAgent(item.agentName);
        vscode.window.showInformationMessage(`Agent "${item.agentName}" stopped.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.openAgentChat", (item: AgentTreeItem) => {
      if (!serverManager.isRunning || !serverManager.port || !item.agentName) return;
      CrewWebViewPanel.createOrShow(context.extensionUri, serverManager.port);
    }),

    vscode.commands.registerCommand("claude-crew.refreshProjects", () => {
      projectTree.refresh();
      sharedFilesTree.refresh();
    }),

    vscode.commands.registerCommand("claude-crew.configureAgent", async (item?: AgentTreeItem) => {
      if (!client) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      try {
        let agentName: string | undefined;
        if (item?.agentName) {
          agentName = item.agentName;
        } else {
          const agents = await client.getAgents();
          if (agents.length === 0) {
            vscode.window.showInformationMessage("No agents registered.");
            return;
          }
          const picked = await vscode.window.showQuickPick(
            agents.map((a) => ({ label: a.name, description: `${a.role} [${a.provider}]` })),
            { placeHolder: "Select agent to configure" },
          );
          if (!picked) return;
          agentName = picked.label;
        }

        const status = await client.getAgentRuntimeStatus(agentName);
        const setting = await vscode.window.showQuickPick(
          [
            { label: "Model", description: status.config.model || "default", id: "model" },
            { label: "Effort", description: status.config.effort || "default", id: "effort" },
            { label: "Approval Policy", description: status.config.approvalPolicy || "default", id: "approval_policy" },
          ],
          { placeHolder: `Configure "${agentName}"` },
        );
        if (!setting) return;

        let value: string | undefined;
        if (setting.id === "model") {
          const models = ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"];
          const pick = await vscode.window.showQuickPick(
            models.map((m) => ({ label: m, picked: m === status.config.model })),
            { placeHolder: "Select model" },
          );
          value = pick?.label;
        } else if (setting.id === "effort") {
          const pick = await vscode.window.showQuickPick(
            ["low", "medium", "high"].map((e) => ({ label: e, picked: e === status.config.effort })),
            { placeHolder: "Select effort level" },
          );
          value = pick?.label;
        } else if (setting.id === "approval_policy") {
          const pick = await vscode.window.showQuickPick(
            ["auto-edit", "full-auto", "suggest"].map((p) => ({ label: p, picked: p === status.config.approvalPolicy })),
            { placeHolder: "Select approval policy" },
          );
          value = pick?.label;
        }

        if (!value) return;
        await client.configureAgent(agentName, { [setting.id]: value, restart: false });
        vscode.window.showInformationMessage(`Agent "${agentName}" ${setting.label} set to "${value}".`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to configure agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.attachTerminal", (item: AgentTreeItem) => {
      if (!item.agentName) return;
      const sessionName = `crew-${item.agentName}`;
      const terminal = vscode.window.createTerminal({
        name: `Agent: ${item.agentName}`,
        shellPath: "/usr/bin/env",
        shellArgs: ["tmux", "attach", "-t", sessionName],
      });
      terminal.show();
    }),
  );

  // Cleanup
  context.subscriptions.push({
    dispose: () => {
      serverManager.dispose();
      eventBridge.dispose();
      agentTree.dispose();
      projectTree.dispose();
      sharedFilesTree.dispose();
    },
  });

  // Auto-start
  const autoStart = vscode.workspace
    .getConfiguration("claude-crew")
    .get<boolean>("server.autoStart", true);

  if (autoStart) {
    try {
      await serverManager.start();
    } catch (err) {
      outputChannel.appendLine(`[claude-crew] Auto-start failed: ${(err as Error).message}`);
      vscode.window.showWarningMessage(
        `Claude Crew server auto-start failed: ${(err as Error).message}`,
      );
    }
  }
}

export function deactivate(): void {
  serverManager?.dispose();
}

let pendingApprovals = 0;

function updateStatusBar(state: "starting" | "running" | "stopped"): void {
  switch (state) {
    case "starting":
      statusBarItem.text = "$(loading~spin) Claude Crew";
      statusBarItem.tooltip = "Server starting...";
      break;
    case "running":
      refreshStatusBarCounts();
      break;
    case "stopped":
      statusBarItem.text = "$(circle-outline) Claude Crew";
      statusBarItem.tooltip = "Server stopped";
      pendingApprovals = 0;
      break;
  }
}

async function refreshStatusBarCounts(): Promise<void> {
  if (!client) {
    statusBarItem.text = "$(hubot) Claude Crew";
    statusBarItem.tooltip = `Server running on port ${serverManager.port}`;
    return;
  }
  try {
    const status = await client.getStatus();
    const approvalBadge = pendingApprovals > 0 ? ` $(bell-dot) ${pendingApprovals}` : "";
    statusBarItem.text = `$(hubot) Crew ${status.agents.online}/${status.agents.total}${approvalBadge}`;
    statusBarItem.tooltip = `Server on port ${serverManager.port} | ${status.agents.online} online, ${status.agents.total} total | ${status.messages} msgs`;
  } catch {
    statusBarItem.text = "$(hubot) Claude Crew";
    statusBarItem.tooltip = `Server running on port ${serverManager.port}`;
  }
}
