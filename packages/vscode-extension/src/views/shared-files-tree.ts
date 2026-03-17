import * as vscode from "vscode";
import { CrewClient, type ScopeFilter, type SharedFileInfo } from "../server/client.js";
import { buildSharedFileUri } from "../providers/shared-files-fs.js";

type SharedFilesNode = SharedScopeTreeItem | SharedFolderTreeItem | SharedFileTreeItem;

interface FileNode {
  kind: "scope" | "folder" | "file";
  key: string;
  label: string;
  file?: SharedFileInfo;
  children?: Map<string, FileNode>;
}

export class SharedFilesTreeProvider implements vscode.TreeDataProvider<SharedFilesNode> {
  private readonly emitter = new vscode.EventEmitter<SharedFilesNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private client: CrewClient | null = null;
  private scope: ScopeFilter = {};

  setClient(client: CrewClient): void {
    this.client = client;
    this.refresh();
  }

  clearClient(): void {
    this.client = null;
    this.refresh();
  }

  setScope(scope: ScopeFilter): void {
    this.scope = scope;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: SharedFilesNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SharedFilesNode): Promise<SharedFilesNode[]> {
    if (!this.client) return [];
    const root = await this.buildTree();

    if (!element) {
      return [...(root.children?.values() || [])].map((node) => new SharedScopeTreeItem(node));
    }

    const children = [...element.node.children?.values() || []];
    return children.map((node) => {
      if (node.kind === "folder") return new SharedFolderTreeItem(node);
      if (node.kind === "file" && node.file) return new SharedFileTreeItem(node, node.file);
      return new SharedScopeTreeItem(node);
    });
  }

  private async buildTree(): Promise<FileNode> {
    const files = await this.client?.getSharedFiles(this.scope).catch(() => []) || [];
    const root: FileNode = { kind: "folder", key: "root", label: "root", children: new Map() };

    for (const file of files) {
      const scopeKey = `${file.scope_type}:${file.scope_id || "global"}`;
      const scopeLabel = file.scope_name ? `${file.scope_type} · ${file.scope_name}` : file.scope_type;
      let scopeNode = root.children!.get(scopeKey);
      if (!scopeNode) {
        scopeNode = { kind: "scope", key: scopeKey, label: scopeLabel, children: new Map() };
        root.children!.set(scopeKey, scopeNode);
      }
      const parts = file.path.split("/");
      let parent = scopeNode;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLeaf = i === parts.length - 1;
        const key = `${parent.key}/${part}`;
        if (isLeaf) {
          parent.children!.set(key, { kind: "file", key, label: part, file });
        } else {
          let folder = parent.children!.get(key);
          if (!folder) {
            folder = { kind: "folder", key, label: part, children: new Map() };
            parent.children!.set(key, folder);
          }
          parent = folder;
        }
      }
    }

    return root;
  }
}

export class SharedScopeTreeItem extends vscode.TreeItem {
  constructor(public readonly node: FileNode) {
    super(node.label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("folder-library");
    this.contextValue = "shared-scope-item";
  }
}

export class SharedFolderTreeItem extends vscode.TreeItem {
  constructor(public readonly node: FileNode) {
    super(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = "shared-folder-item";
  }
}

export class SharedFileTreeItem extends vscode.TreeItem {
  constructor(public readonly node: FileNode, public readonly file: SharedFileInfo) {
    super(node.label, vscode.TreeItemCollapsibleState.None);
    this.resourceUri = buildSharedFileUri(file);
    this.description = file.scope_name || file.scope_type;
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = "shared-file-item";
    this.command = {
      command: "claude-crew.openSharedFile",
      title: "Open Shared File",
      arguments: [this.resourceUri],
    };
  }
}
