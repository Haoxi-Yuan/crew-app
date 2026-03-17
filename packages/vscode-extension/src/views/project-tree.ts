import * as vscode from "vscode";
import {
  CrewClient,
  type ProjectAgentInfo,
  type ProjectDetail,
  type ProjectInfo,
  type WorkplaceInfo,
} from "../server/client.js";

type ProjectNode = ProjectTreeItem | WorkplaceTreeItem | ProjectAgentTreeItem;

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectNode> {
  private readonly emitter = new vscode.EventEmitter<ProjectNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private client: CrewClient | null = null;
  private activeProjectId: string | null = null;
  private activeWorkplaceId: string | null = null;

  setClient(client: CrewClient): void {
    this.client = client;
    this.refresh();
  }

  clearClient(): void {
    this.client = null;
    this.refresh();
  }

  setActiveContext(projectId: string | null, workplaceId: string | null): void {
    this.activeProjectId = projectId;
    this.activeWorkplaceId = workplaceId;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
    if (!this.client) return [];

    if (!element) {
      const projects = await this.client.getProjects();
      return projects.map((project) => new ProjectTreeItem(project, project.id === this.activeProjectId));
    }

    if (element instanceof ProjectTreeItem) {
      const detail = await this.client.getProjectDetail(element.project.id);
      return detail.workplaces.map((workplace) => {
        const assignedCount = detail.agents.filter((agent) => agent.active_workplace_id === workplace.id).length;
        return new WorkplaceTreeItem(detail, workplace, assignedCount, workplace.id === this.activeWorkplaceId);
      });
    }

    if (element instanceof WorkplaceTreeItem) {
      const detail = await this.client.getProjectDetail(element.project.id);
      return detail.agents
        .filter((agent) => agent.active_workplace_id === element.workplace.id)
        .map((agent) => new ProjectAgentTreeItem(detail, element.workplace, agent));
    }

    return [];
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly project: ProjectInfo, isActive: boolean) {
    super(project.name, vscode.TreeItemCollapsibleState.Collapsed);
    const status = isActive ? "active context" : project.status;
    this.description = `${project.agent_count} agents · ${project.memory_count} mem · ${status}`;
    this.tooltip = `Project: ${project.name}\nDirectory: ${project.directory || "-"}`;
    this.iconPath = new vscode.ThemeIcon(isActive ? "target" : "project");
    this.contextValue = "project-item";
    this.command = {
      command: "claude-crew.setActiveProject",
      title: "Set Active Project",
      arguments: [project],
    };
  }
}

export class WorkplaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ProjectDetail,
    public readonly workplace: WorkplaceInfo,
    assignedCount: number,
    isActive: boolean,
  ) {
    super(workplace.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${workplace.kind} · ${assignedCount} agents${isActive ? " · active" : ""}`;
    this.tooltip = `Workplace: ${workplace.name}\n${workplace.directory}`;
    this.iconPath = new vscode.ThemeIcon(isActive ? "target" : "folder-library");
    this.contextValue = "workplace-item";
    this.command = {
      command: "claude-crew.setActiveWorkplace",
      title: "Set Active Workplace",
      arguments: [project, workplace],
    };
  }
}

export class ProjectAgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ProjectDetail,
    public readonly workplace: WorkplaceInfo,
    public readonly assignment: ProjectAgentInfo,
  ) {
    super(assignment.agent_name, vscode.TreeItemCollapsibleState.None);
    this.description = `${assignment.role_in_project || assignment.assignment_type}`;
    this.tooltip = `Project Agent: ${assignment.agent_name}\n${assignment.role_in_project || assignment.assignment_type}`;
    this.iconPath = new vscode.ThemeIcon("account");
    this.contextValue = "project-agent-item";
    this.command = {
      command: "claude-crew.openAgentChat",
      title: "Open Agent Chat",
      arguments: [{ agentName: assignment.agent_name }],
    };
  }
}
