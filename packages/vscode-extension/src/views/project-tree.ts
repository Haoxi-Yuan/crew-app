import * as vscode from "vscode";
import { CrewClient, type ProjectInfo } from "../server/client.js";

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectTreeItem | undefined>();
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

  getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ProjectTreeItem[]> {
    if (!this.client) return [];

    try {
      const projects = await this.client.getProjects();
      return projects.map(
        (p) => new ProjectTreeItem(p.name, p.slug, p.status),
      );
    } catch {
      return [];
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

class ProjectTreeItem extends vscode.TreeItem {
  constructor(name: string, slug: string, status: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = status;
    this.tooltip = `Project: ${name} (${slug})`;
    this.iconPath = new vscode.ThemeIcon("project");
  }
}
