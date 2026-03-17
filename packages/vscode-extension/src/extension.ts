import * as vscode from "vscode";
import { ControlBridge } from "./control/bridge.js";
import { WorkspaceContextStore } from "./control/workspace-context.js";
import {
  buildMemoryUri,
  buildReflectionUri,
  buildStandardUri,
  MemoryDocumentProvider,
  ReflectionDocumentProvider,
  StandardFileSystemProvider,
} from "./providers/knowledge-documents.js";
import {
  buildSharedFileUri,
  SHARED_FILES_SCHEME,
  SharedFilesFileSystemProvider,
} from "./providers/shared-files-fs.js";
import { CrewClient, type ApprovalInfo, type CrewPanelTarget, type PeakInfo, type ProjectDetail, type ProjectInfo, type ReflectionInfo, type SharedStandard, type WorkplaceInfo } from "./server/client.js";
import { EventBridge } from "./server/event-bridge.js";
import { ServerManager } from "./server/manager.js";
import { AgentTreeItem, AgentTreeProvider } from "./views/agent-tree.js";
import { ApprovalTreeItem, InboxTreeProvider, PeakTreeItem } from "./views/inbox-tree.js";
import { KnowledgeTreeProvider } from "./views/knowledge-tree.js";
import { ProjectTreeProvider, ProjectTreeItem, WorkplaceTreeItem } from "./views/project-tree.js";
import { SharedFileTreeItem, SharedFilesTreeProvider } from "./views/shared-files-tree.js";
import { CrewWebViewPanel } from "./views/webview-panel.js";

let serverManager: ServerManager;
let client: CrewClient | null = null;
let eventBridge: EventBridge;
let controlBridge: ControlBridge | null = null;
let statusBarItem: vscode.StatusBarItem;
let contextStatusBarItem: vscode.StatusBarItem;
let pendingApprovals = 0;
let pendingPeaks = 0;
let nativeDocumentDebugState: (() => boolean) | null = null;
let nativeDocumentDebugLog: ((message: string) => void) | null = null;

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

function ensureClient(): CrewClient {
  if (!client) {
    throw new Error("Claude Crew server is not running.");
  }
  return client;
}

async function openDocument(uri: vscode.Uri): Promise<void> {
  debugNativeDocument(`openDocument start ${uri.toString(true)}`);
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    debugNativeDocument(`openDocument complete ${uri.toString(true)}`);
  } catch (error) {
    debugNativeDocument(`openDocument error ${uri.toString(true)} error=${(error as Error).message}`);
    throw error;
  }
}

async function focusView(viewId: string): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.claude-crew");
  await vscode.commands.executeCommand(`${viewId}.focus`).then(undefined, () => undefined);
}

function toPanelTarget(base?: CrewPanelTarget, fallbackProjectId?: string | null): CrewPanelTarget {
  return {
    ...base,
    ...(base?.projectId ? {} : fallbackProjectId ? { projectId: fallbackProjectId } : {}),
  };
}

function isNativeDocumentDebugEnabled(): boolean {
  return nativeDocumentDebugState?.() ?? false;
}

function debugNativeDocument(message: string): void {
  if (!isNativeDocumentDebugEnabled()) return;
  nativeDocumentDebugLog?.(`[native-docs] ${message}`);
}

function isTrackedNativeDocument(uri: vscode.Uri): boolean {
  return uri.scheme === SHARED_FILES_SCHEME
    || uri.scheme === "claude-crew-standard"
    || uri.scheme === "claude-crew-memory"
    || uri.scheme === "claude-crew-reflection";
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Claude Crew");
  nativeDocumentDebugState = () => process.env.CLAUDE_CREW_E2E === "1"
    || vscode.workspace.getConfiguration("claude-crew").get<boolean>("debug.nativeSaves", false);
  nativeDocumentDebugLog = (message: string) => outputChannel.appendLine(message);
  const workspaceContext = new WorkspaceContextStore(context);

  serverManager = new ServerManager(context, outputChannel);
  eventBridge = new EventBridge(outputChannel);
  try {
    controlBridge = new ControlBridge(context, serverManager, outputChannel);
    await controlBridge.start();
  } catch (err) {
    controlBridge = null;
    outputChannel.appendLine(`[claude-crew] Control bridge failed to start: ${(err as Error).message}`);
  }

  const agentTree = new AgentTreeProvider();
  const projectTree = new ProjectTreeProvider();
  const inboxTree = new InboxTreeProvider();
  const knowledgeTree = new KnowledgeTreeProvider();
  const sharedFilesTree = new SharedFilesTreeProvider();

  const sharedFilesFs = new SharedFilesFileSystemProvider(() => client, {
    isEnabled: isNativeDocumentDebugEnabled,
    log: debugNativeDocument,
    showError: (message) => vscode.window.showErrorMessage(message),
  });
  const standardFs = new StandardFileSystemProvider(() => client, {
    isEnabled: isNativeDocumentDebugEnabled,
    log: debugNativeDocument,
    showError: (message) => vscode.window.showErrorMessage(message),
  });
  const memoryDocs = new MemoryDocumentProvider(() => client);
  const reflectionDocs = new ReflectionDocumentProvider(() => client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claude-crew-agents", agentTree),
    vscode.window.registerTreeDataProvider("claude-crew-projects", projectTree),
    vscode.window.registerTreeDataProvider("claude-crew-inbox", inboxTree),
    vscode.window.registerTreeDataProvider("claude-crew-knowledge", knowledgeTree),
    vscode.window.registerTreeDataProvider("claude-crew-shared-files", sharedFilesTree),
    vscode.workspace.registerFileSystemProvider(SHARED_FILES_SCHEME, sharedFilesFs, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider("claude-crew-standard", standardFs, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider("claude-crew-memory", memoryDocs),
    vscode.workspace.registerTextDocumentContentProvider("claude-crew-reflection", reflectionDocs),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isTrackedNativeDocument(document.uri)) return;
      debugNativeDocument(`editor open ${document.uri.toString(true)}`);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isTrackedNativeDocument(event.document.uri)) return;
      debugNativeDocument(`editor change ${event.document.uri.toString(true)} dirty=${event.document.isDirty} changes=${event.contentChanges.length}`);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isTrackedNativeDocument(document.uri)) return;
      debugNativeDocument(`editor save ${document.uri.toString(true)} dirty=${document.isDirty}`);
    }),
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "claude-crew.openPanel";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  contextStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  contextStatusBarItem.command = "claude-crew.setActiveProject";
  contextStatusBarItem.show();
  context.subscriptions.push(contextStatusBarItem);

  const applyWorkspaceContext = (): void => {
    const active = workspaceContext.value;
    projectTree.setActiveContext(active.projectId, active.workplaceId);
    sharedFilesTree.setScope({
      projectId: active.projectId || undefined,
      workplaceId: active.workplaceId || undefined,
    });
    knowledgeTree.setScope({
      projectId: active.projectId || undefined,
      workplaceId: active.workplaceId || undefined,
    });

    if (active.projectName) {
      contextStatusBarItem.text = active.workplaceName
        ? `$(project) ${active.projectName} / ${active.workplaceName}`
        : `$(project) ${active.projectName}`;
      contextStatusBarItem.tooltip = active.workplaceName
        ? `Active project: ${active.projectName}\nActive workplace: ${active.workplaceName}`
        : `Active project: ${active.projectName}`;
    } else {
      contextStatusBarItem.text = "$(globe) Global Context";
      contextStatusBarItem.tooltip = "No active Claude Crew project selected.";
    }
  };
  applyWorkspaceContext();
  context.subscriptions.push(workspaceContext.onDidChange(applyWorkspaceContext));

  const refreshAllViews = (): void => {
    agentTree.refresh();
    projectTree.refresh();
    inboxTree.refresh();
    knowledgeTree.refresh();
    sharedFilesTree.refresh();
  };

  const syncInboxCounts = async (): Promise<void> => {
    if (!client) {
      pendingApprovals = 0;
      pendingPeaks = 0;
      refreshStatusBar("stopped");
      return;
    }
    try {
      const [approvals, peaks] = await Promise.all([
        client.getApprovals(),
        client.getPendingPeaks(),
      ]);
      pendingApprovals = approvals.length;
      pendingPeaks = peaks.length;
    } catch {
      pendingApprovals = 0;
      pendingPeaks = 0;
    }
    refreshStatusBar("running");
  };

  serverManager.onDidChangeState((state) => {
    refreshStatusBar(state);
    controlBridge?.updateServerState(state);

    if (state === "running" && serverManager.port) {
      if (!client) {
        client = new CrewClient(serverManager.port);
      } else {
        client.updatePort(serverManager.port);
      }
      agentTree.setClient(client);
      projectTree.setClient(client);
      inboxTree.setClient(client);
      knowledgeTree.setClient(client);
      sharedFilesTree.setClient(client);
      eventBridge.connect(serverManager.port);
      void syncInboxCounts();
      CrewWebViewPanel.notifyServerState("running");
    } else if (state === "stopped") {
      client = null;
      agentTree.clearClient();
      projectTree.clearClient();
      inboxTree.clearClient();
      knowledgeTree.clearClient();
      sharedFilesTree.clearClient();
      eventBridge.disconnect();
      pendingApprovals = 0;
      pendingPeaks = 0;
      CrewWebViewPanel.notifyServerState("stopped");
    }
  });

  const debouncedProjectRefresh = debounce(() => projectTree.refresh(), 250);
  const debouncedSharedFilesRefresh = debounce(() => sharedFilesTree.refresh(), 250);
  const debouncedKnowledgeRefresh = debounce(() => knowledgeTree.refresh(), 250);
  const debouncedInboxRefresh = debounce(() => inboxTree.refresh(), 150);

  context.subscriptions.push(eventBridge.onEvent((event) => {
    switch (event.type) {
      case "agent:status":
      case "agent:tmux_state":
      case "agent:context":
        agentTree.refresh();
        void refreshStatusBarCounts();
        break;
      case "project:created":
      case "project:updated":
      case "project:deleted":
      case "project:agent_changed":
        debouncedProjectRefresh();
        debouncedKnowledgeRefresh();
        debouncedSharedFilesRefresh();
        break;
      case "file:updated":
        debouncedSharedFilesRefresh();
        sharedFilesFs.notifyUpdated(event.data as { path: string; scope_type: "global" | "project" | "workplace"; scope_id: string; project_id?: string | null; workplace_id?: string | null; updated_at: number });
        break;
      case "approval:pending": {
        debouncedInboxRefresh();
        void syncInboxCounts();
        const data = event.data as { agentName?: string };
        void vscode.window.showWarningMessage(
          `Agent "${data.agentName || "unknown"}" needs approval`,
          "Open Inbox",
          "Open Panel",
        ).then((action) => {
          if (action === "Open Inbox") {
            return vscode.commands.executeCommand("claude-crew.openInbox");
          }
          if (action === "Open Panel") {
            return vscode.commands.executeCommand("claude-crew.openPanel");
          }
          return undefined;
        });
        break;
      }
      case "approval:resolved":
        debouncedInboxRefresh();
        void syncInboxCounts();
        break;
      case "peak:pending": {
        debouncedInboxRefresh();
        void syncInboxCounts();
        const data = event.data as PeakInfo;
        void vscode.window.showInformationMessage(
          `New decision needed: ${data.agent_name}`,
          "Open Inbox",
          "Open Panel",
        ).then((action) => {
          if (action === "Open Inbox") {
            return vscode.commands.executeCommand("claude-crew.openInbox");
          }
          if (action === "Open Panel") {
            return vscode.commands.executeCommand("claude-crew.openPanel", toPanelTarget({ view: "chat", peakId: data.id }, workspaceContext.value.projectId));
          }
          return undefined;
        });
        break;
      }
      case "peak:decided":
      case "peak:paused":
        debouncedInboxRefresh();
        debouncedKnowledgeRefresh();
        void syncInboxCounts();
        break;
      case "standards:updated": {
        debouncedKnowledgeRefresh();
        const payload = event.data as { id?: string; standard?: { id?: string } };
        const standardId = payload.standard?.id || payload.id;
        if (standardId) {
          standardFs.notifyStandardChanged(standardId);
        }
        break;
      }
      case "reflection:created":
      case "reflection:reviewed":
        debouncedKnowledgeRefresh();
        break;
      case "mention:pending": {
        const data = event.data as { agentName?: string };
        void vscode.window.showInformationMessage(
          `Agent "${data.agentName || "unknown"}" was mentioned`,
          "Open Panel",
        ).then((action) => {
          if (action === "Open Panel") {
            return vscode.commands.executeCommand("claude-crew.openPanel");
          }
          return undefined;
        });
        break;
      }
      default:
        break;
    }
  }));

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

    vscode.commands.registerCommand("claude-crew.openPanel", async (target?: CrewPanelTarget) => {
      if (!serverManager.isRunning || !serverManager.port) {
        vscode.window.showWarningMessage("Server is not running. Start it first.");
        return;
      }
      const active = workspaceContext.value;
      CrewWebViewPanel.createOrShow(context.extensionUri, serverManager.port, toPanelTarget(target, active.projectId));
    }),

    vscode.commands.registerCommand("claude-crew.openInbox", async () => {
      await focusView("claude-crew-inbox");
    }),

    vscode.commands.registerCommand("claude-crew.refreshAgents", refreshAllViews),
    vscode.commands.registerCommand("claude-crew.refreshProjects", refreshAllViews),

    vscode.commands.registerCommand("claude-crew.setActiveProject", async (project?: ProjectInfo | ProjectTreeItem) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }

      let resolvedProject: ProjectInfo | null = null;
      if (project instanceof ProjectTreeItem) {
        resolvedProject = project.project;
      } else if (project && "id" in project) {
        resolvedProject = project;
      } else {
        const projects = await currentClient.getProjects("active");
        const picked = await vscode.window.showQuickPick(
          [{ label: "Global Context", description: "Clear active project", project: null as ProjectInfo | null }].concat(
            projects.map((item) => ({
              label: item.name,
              description: `${item.agent_count} agents · ${item.memory_count} mem`,
              project: item,
            })),
          ),
          { placeHolder: "Select the active Claude Crew project" },
        );
        if (!picked) return;
        resolvedProject = picked.project;
      }

      await workspaceContext.setProject(resolvedProject);
      knowledgeTree.setSearchResults([]);
      refreshAllViews();
      vscode.window.showInformationMessage(
        resolvedProject ? `Active project set to "${resolvedProject.name}".` : "Cleared active Claude Crew project context.",
      );
    }),

    vscode.commands.registerCommand("claude-crew.setActiveWorkplace", async (projectArg?: ProjectDetail | ProjectTreeItem | ProjectInfo, workplaceArg?: WorkplaceInfo | WorkplaceTreeItem) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }

      let projectId = workspaceContext.value.projectId;
      let projectName = workspaceContext.value.projectName;
      let workplace: WorkplaceInfo | null = null;

      if (projectArg instanceof WorkplaceTreeItem) {
        projectId = projectArg.project.id;
        projectName = projectArg.project.name;
        workplace = projectArg.workplace;
      } else if (projectArg instanceof ProjectTreeItem) {
        projectId = projectArg.project.id;
        projectName = projectArg.project.name;
      } else if (projectArg && "id" in projectArg) {
        projectId = projectArg.id;
        projectName = projectArg.name;
      }

      if (workplaceArg instanceof WorkplaceTreeItem) {
        projectId = workplaceArg.project.id;
        projectName = workplaceArg.project.name;
        workplace = workplaceArg.workplace;
      } else if (workplaceArg && "id" in workplaceArg) {
        workplace = workplaceArg;
      }

      if (!projectId) {
        const projects = await currentClient.getProjects("active");
        const pickedProject = await vscode.window.showQuickPick(
          projects.map((item) => ({ label: item.name, description: item.status, project: item })),
          { placeHolder: "Select a project first" },
        );
        if (!pickedProject) return;
        projectId = pickedProject.project.id;
        projectName = pickedProject.project.name;
      }

      const detail = await currentClient.getProjectDetail(projectId);
      if (!workplace) {
        const pickedWorkplace = await vscode.window.showQuickPick(
          detail.workplaces.map((item) => ({ label: item.name, description: `${item.kind} · ${item.slug}`, workplace: item })),
          { placeHolder: `Select the active workplace for "${detail.name}"` },
        );
        if (!pickedWorkplace) return;
        workplace = pickedWorkplace.workplace;
      }

      await workspaceContext.setProject({ id: detail.id, name: detail.name });
      await workspaceContext.setWorkplace(workplace);
      refreshAllViews();
      vscode.window.showInformationMessage(`Active workplace set to "${workplace.name}".`);
    }),

    vscode.commands.registerCommand("claude-crew.wakeAgent", async () => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      try {
        const agents = await currentClient.getAgents();
        const offlineAgents = agents.filter((agent) => agent.status !== "online");
        if (offlineAgents.length === 0) {
          vscode.window.showInformationMessage("All agents are already online.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          offlineAgents.map((agent) => ({ label: agent.name, description: `${agent.role} [${agent.provider}]` })),
          { placeHolder: "Select agent to wake" },
        );
        if (!picked) return;
        await currentClient.wakeAgent(picked.label);
        agentTree.refresh();
        vscode.window.showInformationMessage(`Agent "${picked.label}" waking up...`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to wake agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.stopAgent", async () => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      try {
        const agents = await currentClient.getAgents();
        const onlineAgents = agents.filter((agent) => agent.status === "online");
        if (onlineAgents.length === 0) {
          vscode.window.showInformationMessage("No agents are currently online.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          onlineAgents.map((agent) => ({ label: agent.name, description: `${agent.role} [${agent.provider}]` })),
          { placeHolder: "Select agent to stop" },
        );
        if (!picked) return;
        await currentClient.stopAgent(picked.label);
        agentTree.refresh();
        vscode.window.showInformationMessage(`Agent "${picked.label}" stopped.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.wakeAgentFromTree", async (item: AgentTreeItem) => {
      if (!item?.agentName) return;
      try {
        await ensureClient().wakeAgent(item.agentName);
        vscode.window.showInformationMessage(`Agent "${item.agentName}" waking up...`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to wake agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.stopAgentFromTree", async (item: AgentTreeItem) => {
      if (!item?.agentName) return;
      try {
        await ensureClient().stopAgent(item.agentName);
        vscode.window.showInformationMessage(`Agent "${item.agentName}" stopped.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.openAgentChat", async (item?: AgentTreeItem | { agentName?: string }) => {
      const agentName = item?.agentName;
      if (!agentName) return;
      const active = workspaceContext.value;
      await vscode.commands.executeCommand("claude-crew.openPanel", toPanelTarget({
        view: "chat",
        channelId: `dm-${agentName}`,
      }, active.projectId));
    }),

    vscode.commands.registerCommand("claude-crew.configureAgent", async (item?: AgentTreeItem) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      try {
        let agentName = item?.agentName;
        if (!agentName) {
          const agents = await currentClient.getAgents();
          const picked = await vscode.window.showQuickPick(
            agents.map((agent) => ({ label: agent.name, description: `${agent.role} [${agent.provider}]` })),
            { placeHolder: "Select agent to configure" },
          );
          if (!picked) return;
          agentName = picked.label;
        }

        const status = await currentClient.getAgentRuntimeStatus(agentName);
        const pickedSetting = await vscode.window.showQuickPick(
          [
            { label: "Model", description: status.config.model || "default", id: "model" },
            { label: "Effort", description: status.config.effort || "default", id: "effort" },
            { label: "Approval Policy", description: status.config.approvalPolicy || "default", id: "approval_policy" },
          ],
          { placeHolder: `Configure "${agentName}"` },
        );
        if (!pickedSetting) return;

        const options = pickedSetting.id === "approval_policy"
          ? ["auto-edit", "full-auto", "suggest"]
          : pickedSetting.id === "effort"
            ? ["low", "medium", "high"]
            : ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"];
        const pickedValue = await vscode.window.showQuickPick(
          options.map((label) => ({ label, picked: label === pickedSetting.description })),
          { placeHolder: `Select ${pickedSetting.label}` },
        );
        if (!pickedValue) return;
        await currentClient.configureAgent(agentName, { [pickedSetting.id]: pickedValue.label, restart: false });
        vscode.window.showInformationMessage(`Agent "${agentName}" ${pickedSetting.label} set to "${pickedValue.label}".`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to configure agent: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claude-crew.attachTerminal", (item: AgentTreeItem) => {
      if (!item?.agentName) return;
      const terminal = vscode.window.createTerminal({
        name: `Agent: ${item.agentName}`,
        shellPath: "/usr/bin/env",
        shellArgs: ["tmux", "attach", "-t", `crew-${item.agentName}`],
      });
      terminal.show();
    }),

    vscode.commands.registerCommand("claude-crew.respondApproval", async (input?: ApprovalInfo | ApprovalTreeItem) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      await focusView("claude-crew-inbox");
      let approval = input instanceof ApprovalTreeItem ? input.approval : input;
      if (!approval) {
        const approvals = await currentClient.getApprovals();
        const pickedApproval = await vscode.window.showQuickPick(
          approvals.map((item) => ({ label: item.agentName, description: `${item.toolServer} · ${item.toolName}`, approval: item })),
          { placeHolder: "Select a pending approval" },
        );
        if (!pickedApproval) return;
        approval = pickedApproval.approval;
      }

      const pickedOption = await vscode.window.showQuickPick(
        approval.options.map((option) => ({ label: option.label, description: option.key, option })),
        { placeHolder: `Respond to ${approval.agentName}` },
      );
      if (!pickedOption) return;

      await currentClient.respondApproval(approval.agentName, pickedOption.option.key);
      await syncInboxCounts();
      inboxTree.refresh();
      vscode.window.showInformationMessage(`Responded to ${approval.agentName}: ${pickedOption.option.label}`);
    }),

    vscode.commands.registerCommand("claude-crew.resolvePeak", async (input?: PeakInfo | PeakTreeItem) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      await focusView("claude-crew-inbox");
      let peak = input instanceof PeakTreeItem ? input.peak : input;
      if (!peak) {
        const peaks = await currentClient.getPendingPeaks();
        const pickedPeak = await vscode.window.showQuickPick(
          peaks.map((item) => ({ label: item.agent_name, description: item.context.slice(0, 80), peak: item })),
          { placeHolder: "Select a pending peak" },
        );
        if (!pickedPeak) return;
        peak = pickedPeak.peak;
      }

      const action = await vscode.window.showQuickPick(
        [
          ...peak.options.map((option, index) => ({ label: option.label, description: `${option.pros} / ${option.cons}`, actionKind: "choose" as const, optionIndex: index })),
          { label: "Let Agent Decide", description: "Use the default option", actionKind: "agent" as const, optionIndex: -1 },
          { label: "Let Me Think (+10m)", description: "Extend the timeout", actionKind: "pause" as const, optionIndex: -1 },
          { label: "Open Panel", description: "Handle this in the Crew panel", actionKind: "panel" as const, optionIndex: -1 },
        ],
        { placeHolder: `${peak.agent_name} needs a decision` },
      );
      if (!action) return;

      if (action.actionKind === "panel") {
        await vscode.commands.executeCommand("claude-crew.openPanel", {
          view: "chat",
          peakId: peak.id,
          projectId: peak.project_id || undefined,
        });
        return;
      }
      if (action.actionKind === "agent") {
        await currentClient.letAgentDecide(peak.id);
      } else if (action.actionKind === "pause") {
        await currentClient.pausePeak(peak.id);
      } else {
        const note = await vscode.window.showInputBox({
          prompt: "Optional note for this PEAK decision",
          placeHolder: "Add context for the agent",
        });
        await currentClient.decidePeak(peak.id, action.optionIndex, note);
      }

      inboxTree.refresh();
      knowledgeTree.refresh();
      await syncInboxCounts();
    }),

    vscode.commands.registerCommand("claude-crew.deferPeakToAgent", async (input?: PeakInfo | PeakTreeItem) => {
      const peak = input instanceof PeakTreeItem ? input.peak : input;
      if (!peak) return;
      await ensureClient().letAgentDecide(peak.id);
      inboxTree.refresh();
      void syncInboxCounts();
    }),

    vscode.commands.registerCommand("claude-crew.pausePeak", async (input?: PeakInfo | PeakTreeItem) => {
      const peak = input instanceof PeakTreeItem ? input.peak : input;
      if (!peak) return;
      await ensureClient().pausePeak(peak.id);
      inboxTree.refresh();
      void syncInboxCounts();
    }),

    vscode.commands.registerCommand("claude-crew.searchMemory", async () => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      await focusView("claude-crew-knowledge");
      const query = await vscode.window.showInputBox({
        prompt: "Search Claude Crew memory",
        placeHolder: "decision, preference, architecture, ...",
      });
      if (!query) return;
      const active = workspaceContext.value;
      const results = await currentClient.searchMemory(query, {
        projectId: active.projectId || undefined,
        limit: 10,
        summaryOnly: true,
      });
      knowledgeTree.setSearchResults(results.entries.map((entry) => ({
        id: entry.id,
        heading: entry.heading,
        category: entry.category,
      })));
      if (results.entries.length === 0) {
        vscode.window.showInformationMessage(`No memory entries matched "${query}".`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        results.entries.map((entry) => ({
          label: entry.heading,
          description: `${entry.category} · ${entry.scope_type}`,
          memoryId: entry.id,
        })),
        { placeHolder: `Memory results for "${query}"` },
      );
      if (!picked) return;
      await vscode.commands.executeCommand("claude-crew.openMemoryEntry", picked.memoryId);
    }),

    vscode.commands.registerCommand("claude-crew.openMemoryEntry", async (input: string | { id: string }) => {
      const id = typeof input === "string" ? input : input.id;
      await openDocument(buildMemoryUri(id));
    }),

    vscode.commands.registerCommand("claude-crew.openStandard", async (input?: SharedStandard) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      let standard = input;
      if (!standard) {
        const standards = await currentClient.getStandards("active");
        const picked = await vscode.window.showQuickPick(
          standards.map((item) => ({ label: item.name, description: item.category, standard: item })),
          { placeHolder: "Select a standard to open" },
        );
        if (!picked) return;
        standard = picked.standard;
      }
      await openDocument(buildStandardUri(standard.id));
    }),

    vscode.commands.registerCommand("claude-crew.editStandard", async (input?: SharedStandard) => {
      await vscode.commands.executeCommand("claude-crew.openStandard", input);
    }),

    vscode.commands.registerCommand("claude-crew.reviewReflection", async (input?: ReflectionInfo) => {
      const currentClient = client;
      if (!currentClient) {
        vscode.window.showWarningMessage("Server is not running.");
        return;
      }
      let reflection = input;
      if (!reflection) {
        const reflections = await currentClient.getReflections({ projectId: workspaceContext.value.projectId || undefined, limit: 10 });
        const picked = await vscode.window.showQuickPick(
          reflections.map((item) => ({ label: item.task_summary, description: `${item.agent_name} · ${item.status}`, reflection: item })),
          { placeHolder: "Select a reflection to review" },
        );
        if (!picked) return;
        reflection = picked.reflection;
      }

      await openDocument(buildReflectionUri(reflection.id));
      if (reflection.status !== "pending") return;

      const action = await vscode.window.showQuickPick(
        [
          { label: "Approve Reflection", action: "approve" as const },
          { label: "Reject Reflection", action: "reject" as const },
          { label: "Keep Open", action: "keep" as const },
        ],
        { placeHolder: `Review reflection from ${reflection.agent_name}` },
      );
      if (!action || action.action === "keep") return;

      await currentClient.reviewReflection(reflection.id, action.action);
      reflectionDocs.refresh(buildReflectionUri(reflection.id));
      knowledgeTree.refresh();
      vscode.window.showInformationMessage(`Reflection ${action.action === "approve" ? "approved" : "rejected"}.`);
    }),

    vscode.commands.registerCommand("claude-crew.openSharedFile", async (input?: vscode.Uri | SharedFileTreeItem) => {
      const uri = input instanceof SharedFileTreeItem ? buildSharedFileUri(input.file) : input;
      if (!uri) return;
      await openDocument(uri);
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      serverManager.dispose();
      eventBridge.dispose();
      controlBridge?.dispose();
    },
  });

  const autoStart = vscode.workspace.getConfiguration("claude-crew").get<boolean>("server.autoStart", true);
  if (autoStart) {
    try {
      await serverManager.start();
    } catch (err) {
      outputChannel.appendLine(`[claude-crew] Auto-start failed: ${(err as Error).message}`);
      vscode.window.showWarningMessage(`Claude Crew server auto-start failed: ${(err as Error).message}`);
    }
  } else {
    refreshStatusBar("stopped");
  }
}

export function deactivate(): void {
  controlBridge?.dispose();
  serverManager?.dispose();
}

function refreshStatusBar(state: "starting" | "running" | "stopped"): void {
  switch (state) {
    case "starting":
      statusBarItem.text = "$(loading~spin) Claude Crew";
      statusBarItem.tooltip = "Server starting...";
      break;
    case "running":
      void refreshStatusBarCounts();
      break;
    case "stopped":
      statusBarItem.text = "$(circle-outline) Claude Crew";
      statusBarItem.tooltip = "Server stopped";
      break;
  }
}

async function refreshStatusBarCounts(): Promise<void> {
  if (!client) {
    statusBarItem.text = "$(circle-outline) Claude Crew";
    statusBarItem.tooltip = "Server stopped";
    return;
  }
  try {
    const status = await client.getStatus();
    const inboxCount = pendingApprovals + pendingPeaks;
    const inboxBadge = inboxCount > 0 ? ` $(bell-dot) ${inboxCount}` : "";
    statusBarItem.text = `$(hubot) Crew ${status.agents.online}/${status.agents.total}${inboxBadge}`;
    statusBarItem.tooltip = `Server on port ${serverManager.port} | ${status.agents.online}/${status.agents.total} agents online | ${pendingApprovals} approvals | ${pendingPeaks} peaks`;
  } catch {
    statusBarItem.text = "$(hubot) Claude Crew";
    statusBarItem.tooltip = `Server running on port ${serverManager.port}`;
  }
}
