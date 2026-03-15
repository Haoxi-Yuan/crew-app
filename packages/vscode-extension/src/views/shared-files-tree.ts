import * as vscode from "vscode";
import { CrewClient, type SharedFileInfo } from "../server/client.js";

export class SharedFilesTreeProvider implements vscode.TreeDataProvider<SharedFileTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SharedFileTreeItem | undefined>();
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

  getTreeItem(element: SharedFileTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SharedFileTreeItem[]> {
    if (!this.client) return [];

    try {
      const files = await this.client.getSharedFiles();
      return files.map(
        (f) => new SharedFileTreeItem(f.path, f.scope_type),
      );
    } catch {
      return [];
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

class SharedFileTreeItem extends vscode.TreeItem {
  constructor(filePath: string, scopeType: string) {
    super(filePath, vscode.TreeItemCollapsibleState.None);
    this.description = scopeType;
    this.iconPath = new vscode.ThemeIcon("file");
  }
}
