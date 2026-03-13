import type { Project } from "./project-types.js";

let activeProject: Project | null = null;

type Listener = (project: Project | null) => void;
const listeners: Listener[] = [];

export function getActiveProject(): Project | null {
  return activeProject;
}

export function getActiveProjectId(): string | null {
  return activeProject?.id ?? null;
}

export function setActiveProject(project: Project | null): void {
  const prev = activeProject;
  activeProject = project;
  if (prev?.id !== project?.id) {
    for (const fn of listeners) fn(project);
  }
}

export function onActiveProjectChange(fn: Listener): void {
  listeners.push(fn);
}
