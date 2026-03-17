import * as vscode from "vscode";
import {
  CrewClient,
  type MemoryStats,
  type ReflectionInfo,
  type ScopeFilter,
  type SharedStandard,
} from "../server/client.js";

type KnowledgeNode =
  | KnowledgeGroupItem
  | MemoryActionItem
  | MemoryTreeItem
  | StandardTreeItem
  | ReflectionTreeItem;

export class KnowledgeTreeProvider implements vscode.TreeDataProvider<KnowledgeNode> {
  private readonly emitter = new vscode.EventEmitter<KnowledgeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private client: CrewClient | null = null;
  private scope: ScopeFilter = {};
  private memoryStats: MemoryStats | null = null;
  private standards: SharedStandard[] = [];
  private reflections: ReflectionInfo[] = [];
  private searchResults: Array<{ id: string; heading: string; category: string }> = [];

  setClient(client: CrewClient): void {
    this.client = client;
    this.refresh();
  }

  clearClient(): void {
    this.client = null;
    this.memoryStats = null;
    this.standards = [];
    this.reflections = [];
    this.searchResults = [];
    this.refresh();
  }

  setScope(scope: ScopeFilter): void {
    this.scope = scope;
    this.refresh();
  }

  setSearchResults(results: Array<{ id: string; heading: string; category: string }>): void {
    this.searchResults = results;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: KnowledgeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: KnowledgeNode): Promise<KnowledgeNode[]> {
    if (!this.client) {
      return element ? [] : [
        new KnowledgeGroupItem("Memory", "Server not running", "memory"),
        new KnowledgeGroupItem("Standards", "Server not running", "standards"),
        new KnowledgeGroupItem("Reflections", "Server not running", "reflections"),
      ];
    }

    if (!element) {
      await this.load();
      return [
        new KnowledgeGroupItem("Memory", `${this.memoryStats?.total || 0} entries`, "memory"),
        new KnowledgeGroupItem("Standards", `${this.standards.length} active`, "standards"),
        new KnowledgeGroupItem("Reflections", `${this.reflections.length} recent`, "reflections"),
      ];
    }

    if (element instanceof KnowledgeGroupItem && element.groupId === "memory") {
      const items: KnowledgeNode[] = [new MemoryActionItem()];
      if (this.searchResults.length > 0) {
        items.push(...this.searchResults.map((entry) => new MemoryTreeItem(entry.id, entry.heading, entry.category, "search result")));
      }
      if (this.memoryStats) {
        items.push(...this.memoryStats.recently_accessed.map((entry) => new MemoryTreeItem(entry.id, entry.heading, entry.category, `${entry.access_count} accesses`)));
      }
      return items;
    }

    if (element instanceof KnowledgeGroupItem && element.groupId === "standards") {
      return this.standards.map((standard) => new StandardTreeItem(standard));
    }

    if (element instanceof KnowledgeGroupItem && element.groupId === "reflections") {
      return this.reflections.map((reflection) => new ReflectionTreeItem(reflection));
    }

    return [];
  }

  private async load(): Promise<void> {
    if (!this.client) return;
    const [memoryStats, standards, reflections] = await Promise.all([
      this.client.getMemoryStats({ projectId: this.scope.projectId || undefined }).catch(() => null),
      this.client.getStandards("active").catch(() => []),
      this.client.getReflections({ projectId: this.scope.projectId || undefined, limit: 10 }).catch(() => []),
    ]);
    this.memoryStats = memoryStats;
    this.standards = standards;
    this.reflections = [
      ...reflections.filter((reflection) => reflection.status === "pending"),
      ...reflections.filter((reflection) => reflection.status !== "pending"),
    ];
  }
}

class KnowledgeGroupItem extends vscode.TreeItem {
  constructor(label: string, description: string, public readonly groupId: "memory" | "standards" | "reflections") {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = description;
    const iconName = groupId === "memory" ? "history" : groupId === "standards" ? "book" : "note";
    this.iconPath = new vscode.ThemeIcon(iconName);
  }
}

class MemoryActionItem extends vscode.TreeItem {
  constructor() {
    super("Search Memory…", vscode.TreeItemCollapsibleState.None);
    this.command = { command: "claude-crew.searchMemory", title: "Search Memory" };
    this.iconPath = new vscode.ThemeIcon("search");
    this.contextValue = "memory-search";
  }
}

class MemoryTreeItem extends vscode.TreeItem {
  constructor(memoryId: string, heading: string, category: string, description: string) {
    super(heading, vscode.TreeItemCollapsibleState.None);
    this.description = `${category} · ${description}`;
    this.iconPath = new vscode.ThemeIcon("history");
    this.command = {
      command: "claude-crew.openMemoryEntry",
      title: "Open Memory Entry",
      arguments: [memoryId],
    };
  }
}

class StandardTreeItem extends vscode.TreeItem {
  constructor(public readonly standard: SharedStandard) {
    super(standard.name, vscode.TreeItemCollapsibleState.None);
    this.description = standard.category;
    this.iconPath = new vscode.ThemeIcon("book");
    this.contextValue = "standard-item";
    this.command = {
      command: "claude-crew.openStandard",
      title: "Open Standard",
      arguments: [standard],
    };
  }
}

class ReflectionTreeItem extends vscode.TreeItem {
  constructor(public readonly reflection: ReflectionInfo) {
    super(reflection.task_summary, vscode.TreeItemCollapsibleState.None);
    this.description = `${reflection.agent_name} · ${reflection.status}`;
    this.iconPath = new vscode.ThemeIcon(reflection.status === "pending" ? "warning" : "note");
    this.contextValue = "reflection-item";
    this.command = {
      command: "claude-crew.reviewReflection",
      title: "Review Reflection",
      arguments: [reflection],
    };
  }
}
