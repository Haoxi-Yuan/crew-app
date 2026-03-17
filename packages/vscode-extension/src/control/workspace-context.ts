import * as vscode from "vscode";
import type { ProjectInfo, WorkplaceInfo } from "../server/client.js";

const PROJECT_ID_KEY = "claude-crew.activeProjectId";
const PROJECT_NAME_KEY = "claude-crew.activeProjectName";
const WORKPLACE_ID_KEY = "claude-crew.activeWorkplaceId";
const WORKPLACE_NAME_KEY = "claude-crew.activeWorkplaceName";

export interface ActiveWorkspaceContext {
  projectId: string | null;
  projectName: string | null;
  workplaceId: string | null;
  workplaceName: string | null;
}

export class WorkspaceContextStore {
  private readonly _onDidChange = new vscode.EventEmitter<ActiveWorkspaceContext>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get value(): ActiveWorkspaceContext {
    return {
      projectId: this.context.workspaceState.get<string | null>(PROJECT_ID_KEY, null),
      projectName: this.context.workspaceState.get<string | null>(PROJECT_NAME_KEY, null),
      workplaceId: this.context.workspaceState.get<string | null>(WORKPLACE_ID_KEY, null),
      workplaceName: this.context.workspaceState.get<string | null>(WORKPLACE_NAME_KEY, null),
    };
  }

  async setProject(project: ProjectInfo | { id: string; name: string } | null): Promise<void> {
    await this.context.workspaceState.update(PROJECT_ID_KEY, project?.id ?? null);
    await this.context.workspaceState.update(PROJECT_NAME_KEY, project?.name ?? null);
    if (!project) {
      await this.context.workspaceState.update(WORKPLACE_ID_KEY, null);
      await this.context.workspaceState.update(WORKPLACE_NAME_KEY, null);
    }
    this._onDidChange.fire(this.value);
  }

  async setWorkplace(workplace: WorkplaceInfo | { id: string; name: string } | null): Promise<void> {
    await this.context.workspaceState.update(WORKPLACE_ID_KEY, workplace?.id ?? null);
    await this.context.workspaceState.update(WORKPLACE_NAME_KEY, workplace?.name ?? null);
    this._onDidChange.fire(this.value);
  }
}
