import * as vscode from "vscode";
import { CrewClient, type AgentInfo } from "../server/client.js";

export class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private client: CrewClient | null = null;

  setClient(client: CrewClient): void {
    this.client = client;
    this.refresh();
  }

  clearClient(): void {
    this.client = null;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<AgentTreeItem[]> {
    if (!this.client) {
      return [new AgentTreeItem("Server not running", "", "offline", "")];
    }

    try {
      const agents = await this.client.getAgents();
      if (agents.length === 0) {
        return [new AgentTreeItem("No agents", "", "offline", "")];
      }
      return agents.map(
        (a) => new AgentTreeItem(a.name, a.role, a.status, a.provider),
      );
    } catch {
      return [new AgentTreeItem("Failed to load agents", "", "offline", "")];
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export class AgentTreeItem extends vscode.TreeItem {
  /** The agent name, used by tree item commands. */
  public readonly agentName: string;

  constructor(
    name: string,
    public readonly role: string,
    public readonly status: string,
    public readonly provider: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.agentName = name;

    if (role) {
      this.description = `${role} [${provider}]`;
    }

    if (status === "online") {
      this.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
    } else if (status === "offline" && role) {
      this.iconPath = new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("testing.iconSkipped"));
    }

    if (role) {
      this.contextValue = `agent-${status}-${provider}`;
    }
  }
}
