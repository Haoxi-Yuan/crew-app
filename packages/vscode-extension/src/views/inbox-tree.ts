import * as vscode from "vscode";
import { CrewClient, type ApprovalInfo, type PeakInfo, type ProjectInfo } from "../server/client.js";

type InboxNode =
  | InboxGroupItem
  | ApprovalTreeItem
  | PeakTreeItem;

export class InboxTreeProvider implements vscode.TreeDataProvider<InboxNode> {
  private readonly emitter = new vscode.EventEmitter<InboxNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private client: CrewClient | null = null;
  private approvals: ApprovalInfo[] = [];
  private peaks: PeakInfo[] = [];
  private projects = new Map<string, ProjectInfo>();

  setClient(client: CrewClient): void {
    this.client = client;
    this.refresh();
  }

  clearClient(): void {
    this.client = null;
    this.approvals = [];
    this.peaks = [];
    this.projects.clear();
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: InboxNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: InboxNode): Promise<InboxNode[]> {
    if (!this.client) {
      return element ? [] : [new InboxGroupItem("Approvals", "Server not running"), new InboxGroupItem("Peaks", "Server not running")];
    }

    if (!element) {
      await this.load();
      return [
        new InboxGroupItem("Approvals", `${this.approvals.length} pending`, "approvals"),
        new InboxGroupItem("Peaks", `${this.peaks.length} pending`, "peaks"),
      ];
    }

    if (element instanceof InboxGroupItem && element.groupId === "approvals") {
      return this.approvals.map((approval) => new ApprovalTreeItem(approval));
    }
    if (element instanceof InboxGroupItem && element.groupId === "peaks") {
      return this.peaks.map((peak) => new PeakTreeItem(peak, this.projects.get(peak.project_id || "")));
    }
    return [];
  }

  private async load(): Promise<void> {
    if (!this.client) return;
    const [approvals, peaks, projects] = await Promise.all([
      this.client.getApprovals().catch(() => []),
      this.client.getPendingPeaks().catch(() => []),
      this.client.getProjects().catch(() => []),
    ]);
    this.approvals = approvals;
    this.peaks = peaks;
    this.projects = new Map(projects.map((project) => [project.id, project]));
  }
}

class InboxGroupItem extends vscode.TreeItem {
  constructor(label: string, description: string, public readonly groupId?: "approvals" | "peaks") {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(groupId === "approvals" ? "checklist" : "pulse");
  }
}

export class ApprovalTreeItem extends vscode.TreeItem {
  constructor(public readonly approval: ApprovalInfo) {
    super(approval.agentName, vscode.TreeItemCollapsibleState.None);
    this.description = `${approval.toolServer} · ${approval.toolName}`;
    this.tooltip = approval.description || approval.params;
    this.contextValue = "approval-item";
    this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    this.command = {
      command: "claude-crew.respondApproval",
      title: "Respond Approval",
      arguments: [approval],
    };
  }
}

export class PeakTreeItem extends vscode.TreeItem {
  constructor(public readonly peak: PeakInfo, project?: ProjectInfo) {
    super(peak.agent_name, vscode.TreeItemCollapsibleState.None);
    const remainingSeconds = Math.max(0, Math.round((peak.expires_at - Date.now()) / 1000));
    const remainingLabel = `${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s`;
    this.description = `${peak.peak_type} · ${remainingLabel}`;
    this.tooltip = `${project?.name || "Global"}\n${peak.context}`;
    this.contextValue = "peak-item";
    this.iconPath = new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.orange"));
    this.command = {
      command: "claude-crew.resolvePeak",
      title: "Resolve Peak",
      arguments: [peak],
    };
  }
}
