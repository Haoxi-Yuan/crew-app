export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  tech_stack: string[];
  status: "active" | "paused" | "archived";
  config: Record<string, unknown>;
  directory: string;
  created_at: number;
  updated_at: number;
  paused_at: number | null;
  archived_at: number | null;
  agent_count: number;
  memory_count: number;
  workplace_count?: number;
  workplaces?: Workplace[];
}

export interface ProjectAgent {
  id: number;
  project_id: string;
  agent_name: string;
  role_in_project: string;
  assignment_type: "dedicated" | "shared";
  status: string;
  active_workplace_id?: string | null;
  assigned_at: number;
}

export interface Workplace {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  status: string;
  directory: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export interface SharedStandard {
  id: string;
  category: "coding_norm" | "tool_preference" | "workflow" | "naming";
  name: string;
  content: string;
  priority: number;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
}

export interface Reflection {
  id: string;
  agent_name: string;
  project_id: string;
  trigger_type: "task_complete" | "project_milestone" | "manual" | "session_cycle";
  task_summary: string;
  lessons_learned: Lesson[];
  proposed_updates: StandardUpdate[];
  confidence: number;
  status: "pending" | "auto_applied" | "manually_approved" | "rejected";
  reviewed_by: string | null;
  created_at: number;
  reviewed_at: number | null;
}

export interface Lesson {
  category: "process" | "quality" | "communication" | "tooling" | "domain";
  description: string;
  evidence: string;
}

export interface StandardUpdate {
  action: "add" | "modify" | "remove" | "consolidate";
  section: string;
  current_text?: string;
  proposed_text: string;
  rationale: string;
  confidence: number;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  tech_stack: string[];
  agent_roles: string[];
  claude_md_template: string;
  skills_config: string[];
  directory_structure: string[];
  created_at: number;
}
