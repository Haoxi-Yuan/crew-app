import type { Project, ProjectAgent } from "./project-types.js";
import { setActiveProject } from "./project-context.js";
import { showConfirm } from "./utils.js";

let projects: Project[] = [];
let selectedProjectId: string | null = null;

const dashboardArea = document.getElementById("dashboard-area")!;

export function initDashboard(): void {
  renderDashboard();
  loadProjects();
}

export function handleProjectWsEvent(type: string, data: unknown): void {
  if (type === "project:created" || type === "project:updated" || type === "project:deleted" || type === "project:agent_changed") {
    loadProjects();
  }
}

async function loadProjects(): Promise<void> {
  try {
    projects = await (await fetch("/api/projects")).json();
    renderDashboard();
  } catch (err) {
    console.error("Failed to load projects:", err);
  }
}

function renderDashboard(): void {
  if (selectedProjectId) {
    renderProjectDetail(selectedProjectId);
    return;
  }

  const activeProjects = projects.filter((p) => p.status === "active");
  const pausedProjects = projects.filter((p) => p.status === "paused");
  const archivedProjects = projects.filter((p) => p.status === "archived");

  let html = `
    <div class="dash-header">
      <h2>Projects</h2>
      <button class="dash-btn primary" id="dash-new-project">+ New Project</button>
    </div>
  `;

  if (activeProjects.length > 0) {
    html += `<div class="dash-section-label">Active</div>`;
    html += `<div class="dash-grid">${activeProjects.map(projectCardHtml).join("")}</div>`;
  }

  if (pausedProjects.length > 0) {
    html += `<div class="dash-section-label">Paused</div>`;
    html += `<div class="dash-grid">${pausedProjects.map(projectCardHtml).join("")}</div>`;
  }

  if (archivedProjects.length > 0) {
    html += `<div class="dash-section-label">Archived</div>`;
    html += `<div class="dash-grid">${archivedProjects.map(projectCardHtml).join("")}</div>`;
  }

  if (projects.length === 0) {
    html += `<div class="dash-empty">No projects yet. Create your first project to get started.</div>`;
  }

  dashboardArea.innerHTML = html;

  // Bind events
  document.getElementById("dash-new-project")?.addEventListener("click", openCreateProjectModal);

  dashboardArea.querySelectorAll(".dash-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = (card as HTMLElement).dataset.projectId;
      if (id) {
        selectedProjectId = id;
        // Also set the active project context for sidebar filtering
        const project = projects.find(p => p.id === id) || null;
        setActiveProject(project);
        renderDashboard();
      }
    });
  });
}

function projectCardHtml(p: Project): string {
  const statusClass = p.status === "active" ? "status-active" : p.status === "paused" ? "status-paused" : "status-archived";
  const techTags = p.tech_stack.map((t) => `<span class="dash-tag">${esc(t)}</span>`).join("");
  const date = new Date(p.updated_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });

  return `
    <div class="dash-card" data-project-id="${p.id}">
      <div class="dash-card-header">
        <span class="dash-card-title">${esc(p.name)}</span>
        <span class="dash-status ${statusClass}">${p.status}</span>
      </div>
      <div class="dash-card-desc">${esc(p.description || "No description")}</div>
      <div class="dash-card-tags">${techTags}</div>
      <div class="dash-card-footer">
        <span>Agents: ${p.agent_count}</span>
        <span>Memory: ${p.memory_count}</span>
        <span>${date}</span>
      </div>
    </div>
  `;
}

async function renderProjectDetail(projectId: string): Promise<void> {
  let project: (Project & { agents: ProjectAgent[] }) | null = null;

  try {
    project = await (await fetch(`/api/projects/${projectId}`)).json();
  } catch {
    dashboardArea.innerHTML = `<div class="dash-empty">Failed to load project.</div>`;
    return;
  }

  if (!project) return;

  const agentRows = (project.agents || [])
    .map((a) => `
      <tr>
        <td>${esc(a.agent_name)}</td>
        <td>${esc(a.role_in_project || "-")}</td>
        <td><span class="dash-tag">${a.assignment_type}</span></td>
        <td><button class="dash-btn-sm danger" data-remove-agent="${esc(a.agent_name)}">Remove</button></td>
      </tr>
    `)
    .join("");

  const techTags = (project.tech_stack || []).map((t) => `<span class="dash-tag">${esc(String(t))}</span>`).join("");
  const statusClass = project.status === "active" ? "status-active" : project.status === "paused" ? "status-paused" : "status-archived";

  dashboardArea.innerHTML = `
    <div class="dash-detail">
      <div class="dash-detail-header">
        <button class="dash-btn" id="dash-back">Back</button>
        <h2>${esc(project.name)}</h2>
        <span class="dash-status ${statusClass}">${project.status}</span>
        <div class="dash-detail-actions">
          <button class="dash-btn" id="dash-edit">Edit</button>
          ${project.status === "active" ? `<button class="dash-btn" id="dash-pause">Pause</button>` : ""}
          ${project.status === "paused" ? `<button class="dash-btn primary" id="dash-resume">Resume</button>` : ""}
          ${project.status !== "archived" ? `<button class="dash-btn" id="dash-archive">Archive</button>` : ""}
          <button class="dash-btn danger" id="dash-delete">Delete</button>
        </div>
      </div>

      <div class="dash-detail-body">
        <div class="dash-detail-section">
          <h3>Description</h3>
          <p>${esc(project.description || "No description")}</p>
        </div>

        <div class="dash-detail-section">
          <h3>Tech Stack</h3>
          <div class="dash-card-tags">${techTags || "<span class='text-secondary'>None</span>"}</div>
        </div>

        <div class="dash-detail-section">
          <div class="dash-detail-section-header">
            <h3>Agents (${project.agents?.length || 0})</h3>
            <button class="dash-btn-sm primary" id="dash-assign-agent">+ Assign</button>
          </div>
          ${(project.agents?.length || 0) > 0 ? `
            <table class="dash-table">
              <thead><tr><th>Name</th><th>Role</th><th>Type</th><th></th></tr></thead>
              <tbody>${agentRows}</tbody>
            </table>
          ` : `<div class="text-secondary">No agents assigned</div>`}
        </div>

        <div class="dash-detail-section">
          <h3>Memory</h3>
          <div class="text-secondary">${project.memory_count} entries</div>
        </div>
      </div>
    </div>
  `;

  // Bind events
  document.getElementById("dash-back")?.addEventListener("click", () => {
    selectedProjectId = null;
    renderDashboard();
  });

  document.getElementById("dash-edit")?.addEventListener("click", () => {
    if (project) openEditProjectModal(project);
  });

  document.getElementById("dash-pause")?.addEventListener("click", async () => {
    await fetch(`/api/projects/${projectId}/pause`, { method: "POST" });
    await loadProjects();
    renderProjectDetail(projectId);
  });

  document.getElementById("dash-resume")?.addEventListener("click", async () => {
    await fetch(`/api/projects/${projectId}/resume`, { method: "POST" });
    await loadProjects();
    renderProjectDetail(projectId);
  });

  document.getElementById("dash-archive")?.addEventListener("click", async () => {
    await fetch(`/api/projects/${projectId}/archive`, { method: "POST" });
    await loadProjects();
    renderProjectDetail(projectId);
  });

  document.getElementById("dash-delete")?.addEventListener("click", async () => {
    if (!await showConfirm("Delete this project? This cannot be undone.")) return;
    await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    selectedProjectId = null;
    setActiveProject(null);
    await loadProjects();
  });

  document.getElementById("dash-assign-agent")?.addEventListener("click", () => {
    openAssignAgentModal(projectId);
  });

  dashboardArea.querySelectorAll("[data-remove-agent]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const agentName = (btn as HTMLElement).dataset.removeAgent!;
      if (!await showConfirm(`Remove ${agentName} from this project?`)) return;
      await fetch(`/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`, { method: "DELETE" });
      await loadProjects();
      renderProjectDetail(projectId);
    });
  });
}

function openCreateProjectModal(): void {
  const overlay = document.getElementById("modal-overlay")!;
  const title = document.getElementById("modal-title")!;
  const body = document.getElementById("modal-body")!;

  title.textContent = "New Project";
  body.innerHTML = `
    <div class="form-group"><label>Name</label><input id="f-proj-name" type="text" placeholder="My Project"></div>
    <div class="form-group"><label>Description</label><textarea id="f-proj-desc" rows="3" placeholder="What is this project about?"></textarea></div>
    <div class="form-group"><label>Tech Stack (comma separated)</label><input id="f-proj-tech" type="text" placeholder="TypeScript, React, PostgreSQL"></div>
    <button class="modal-action-btn" id="f-proj-create">Create Project</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("f-proj-create")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-proj-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const description = (document.getElementById("f-proj-desc") as HTMLTextAreaElement).value.trim();
    const techStr = (document.getElementById("f-proj-tech") as HTMLInputElement).value.trim();
    const tech_stack = techStr ? techStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const btn = document.getElementById("f-proj-create") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Creating...";

    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, tech_stack }),
      });
      if (!r.ok) {
        const data = await r.json();
        alert(data.error || "Failed to create project");
        btn.disabled = false;
        btn.textContent = "Create Project";
        return;
      }
      const newProject = await r.json() as Project;

      overlay.classList.add("hidden");
      await loadProjects();

      // Auto-navigate: set active project -> sidebar will filter & switch to project channel
      const fullProject = projects.find(p => p.id === newProject.id) || {
        ...newProject,
        agent_count: 0,
        memory_count: 0,
      };
      selectedProjectId = newProject.id;
      setActiveProject(fullProject);
      renderDashboard();
    } catch (err) {
      alert("Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Create Project";
    }
  });
}

function openEditProjectModal(project: Project): void {
  const overlay = document.getElementById("modal-overlay")!;
  const title = document.getElementById("modal-title")!;
  const body = document.getElementById("modal-body")!;

  title.textContent = "Edit Project";
  body.innerHTML = `
    <div class="form-group"><label>Name</label><input id="f-proj-edit-name" type="text" value="${esc(project.name)}"></div>
    <div class="form-group"><label>Description</label><textarea id="f-proj-edit-desc" rows="3">${esc(project.description)}</textarea></div>
    <div class="form-group"><label>Tech Stack (comma separated)</label><input id="f-proj-edit-tech" type="text" value="${esc(project.tech_stack.join(", "))}"></div>
    <button class="modal-action-btn" id="f-proj-edit-save">Save Changes</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("f-proj-edit-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("f-proj-edit-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const description = (document.getElementById("f-proj-edit-desc") as HTMLTextAreaElement).value.trim();
    const techStr = (document.getElementById("f-proj-edit-tech") as HTMLInputElement).value.trim();
    const tech_stack = techStr ? techStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const btn = document.getElementById("f-proj-edit-save") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      const r = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, tech_stack }),
      });
      if (!r.ok) {
        const data = await r.json();
        alert(data.error || "Failed to update project");
        btn.disabled = false;
        btn.textContent = "Save Changes";
        return;
      }
    } catch (err) {
      alert("Failed: " + (err as Error).message);
      btn.disabled = false;
      btn.textContent = "Save Changes";
      return;
    }

    overlay.classList.add("hidden");
    await loadProjects();
    renderProjectDetail(project.id);
  });
}

function openAssignAgentModal(projectId: string): void {
  const overlay = document.getElementById("modal-overlay")!;
  const title = document.getElementById("modal-title")!;
  const body = document.getElementById("modal-body")!;

  title.textContent = "Assign Agent";
  body.innerHTML = `
    <div class="form-group"><label>Agent Name</label><input id="f-assign-name" type="text" placeholder="coder"></div>
    <div class="form-group"><label>Role in Project</label><input id="f-assign-role" type="text" placeholder="Backend developer"></div>
    <div class="form-group">
      <label>Assignment Type</label>
      <select id="f-assign-type">
        <option value="dedicated">Dedicated</option>
        <option value="shared">Shared</option>
      </select>
    </div>
    <button class="modal-action-btn" id="f-assign-submit">Assign</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("f-assign-submit")!.addEventListener("click", async () => {
    const agent_name = (document.getElementById("f-assign-name") as HTMLInputElement).value.trim();
    if (!agent_name) return;
    const role_in_project = (document.getElementById("f-assign-role") as HTMLInputElement).value.trim();
    const assignment_type = (document.getElementById("f-assign-type") as HTMLSelectElement).value;

    try {
      const r = await fetch(`/api/projects/${projectId}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name, role_in_project, assignment_type }),
      });
      if (!r.ok) {
        const data = await r.json();
        alert(data.error || "Failed to assign agent");
        return;
      }
    } catch (err) {
      alert("Failed: " + (err as Error).message);
      return;
    }

    overlay.classList.add("hidden");
    await loadProjects();
    renderProjectDetail(projectId);
  });
}

function esc(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
