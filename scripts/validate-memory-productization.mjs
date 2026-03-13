#!/usr/bin/env node

import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "packages/server/dist/index.js");
const REPORT_DIR = path.join(REPO_ROOT, "validation-reports");
const requireFromServer = createRequire(path.join(REPO_ROOT, "packages/server/package.json"));
const BetterSqlite3 = requireFromServer("better-sqlite3");

fs.mkdirSync(REPORT_DIR, { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 3300 + Math.floor(Math.random() * 1000);
}

function encodeFilePath(filePath) {
  return filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function createRuntimeRoot(label) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  for (const dir of [
    "data",
    "agents",
    "packages/mcp-bridge/dist",
    "packages/web-ui/dist",
    "packages/web-ui",
  ]) {
    fs.mkdirSync(path.join(runtimeRoot, dir), { recursive: true });
  }
  return runtimeRoot;
}

function createReporter() {
  const tests = [];
  return {
    async test(suite, name, fn) {
      const startedAt = Date.now();
      try {
        const details = await fn();
        tests.push({ suite, name, status: "passed", duration_ms: Date.now() - startedAt, details: details || null });
      } catch (error) {
        tests.push({
          suite,
          name,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    },
    skip(suite, name, details) {
      tests.push({ suite, name, status: "skipped", duration_ms: 0, details });
    },
    build(runtimeSummaries) {
      const summary = {
        passed: tests.filter((t) => t.status === "passed").length,
        failed: tests.filter((t) => t.status === "failed").length,
        skipped: tests.filter((t) => t.status === "skipped").length,
      };
      return {
        generated_at: new Date().toISOString(),
        repo_root: REPO_ROOT,
        summary,
        runtimes: runtimeSummaries,
        tests,
      };
    },
  };
}

async function request(baseUrl, method, pathname, body, expectedStatuses = [200]) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = rawText;
  }
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${method} ${pathname} -> ${response.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return { status: response.status, data };
}

async function waitForServer(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n${logs.slice(-20).join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // keep trying
    }
    await sleep(200);
  }
  throw new Error(`server did not start in time\n${logs.slice(-20).join("")}`);
}

async function withCrewRuntime(label, envOverrides, fn) {
  const runtimeRoot = createRuntimeRoot(label);
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CREW_PROJECT_ROOT: runtimeRoot,
      CREW_PORT: String(port),
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForServer(baseUrl, child, logs);
    const dbPath = path.join(runtimeRoot, "data", "claude-crew.db");
    const db = new BetterSqlite3(dbPath);
    try {
      return await fn({ runtimeRoot, port, baseUrl, db, logs });
    } finally {
      db.close();
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(2000),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function startMockOllama() {
  const port = randomPort();
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }));
      return;
    }

    if (req.url === "/api/embed" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed = raw ? JSON.parse(raw) : {};
        const text = String(parsed.input || "");
        const seed = Array.from(text).reduce((sum, ch, index) => sum + ch.charCodeAt(0) * (index + 1), 17);
        const embedding = Array.from({ length: 768 }, (_, index) => ((seed + index * 31) % 997) / 997);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings: [embedding] }));
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function listProjectFiles(projectDir) {
  const output = [];
  const walk = (dir, prefix = "") => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        output.push(rel);
      }
    }
  };
  walk(projectDir);
  return output.sort();
}

function maybeStartTmuxCapture(agentName, runtimeRoot) {
  const outputPath = path.join(runtimeRoot, `${agentName}-tmux-capture.log`);
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", `crew-${agentName}`, `sh -lc 'cat >> "${outputPath}"'`]);
    return {
      outputPath,
      stop() {
        try {
          execFileSync("tmux", ["kill-session", "-t", `crew-${agentName}`]);
        } catch {
          // ignore cleanup failure
        }
      },
    };
  } catch {
    return null;
  }
}

async function runBaselineSuite(reporter) {
  const runtimeSummary = { label: "baseline", runtime_root: null, notes: [] };
  await withCrewRuntime("claude-crew-validation-baseline", { OLLAMA_BASE_URL: "http://127.0.0.1:9" }, async ({ runtimeRoot, baseUrl, db }) => {
    runtimeSummary.runtime_root = runtimeRoot;
    const project = (await request(baseUrl, "POST", "/api/projects", {
      name: "Validation Baseline Project",
      description: "Baseline suite",
      tech_stack: ["ts"],
    })).data;

    await reporter.test("baseline", "project root starts canonical-only", async () => {
      const sharedDir = path.join(project.directory, "shared");
      assert(fs.existsSync(project.directory), "project directory missing");
      assert(!fs.existsSync(sharedDir), "legacy shared directory should not be pre-created");
      const workplaces = (await request(baseUrl, "GET", `/api/projects/${project.id}/workplaces`)).data;
      assert(Array.isArray(workplaces) && workplaces.length === 0, "project should start without workplaces");
      return { project_directory: project.directory };
    });

    const derivedWrite = (await request(baseUrl, "PUT", `/api/shared-files/${encodeFilePath("outputs/run-1.json")}`, {
      content: "{\"status\":\"ok\"}\n",
      created_by: "user",
      project_id: project.id,
      artifact_kind: "derived",
      description: "derived output",
    })).data;
    const workplacesAfterDerived = (await request(baseUrl, "GET", `/api/projects/${project.id}/workplaces`)).data;
    const defaultWorkplace = workplacesAfterDerived.find((workplace) => workplace.slug === "default");

    await reporter.test("baseline", "first derived file auto-creates default workplace", async () => {
      assert(derivedWrite.scope_type === "workplace", "derived write should resolve to workplace scope");
      assert(defaultWorkplace, "default workplace was not created");
      const storedPath = path.join(defaultWorkplace.directory, "outputs/run-1.json");
      assert(fs.existsSync(storedPath), "derived file not stored in workplace directory");
      return { workplace_directory: defaultWorkplace.directory, file: storedPath };
    });

    const canonicalWrite = (await request(baseUrl, "PUT", `/api/shared-files/${encodeFilePath("docs/decision.md")}`, {
      content: "# Decision\ncanonical\n",
      created_by: "user",
      project_id: project.id,
      artifact_kind: "canonical",
      description: "canonical doc",
    })).data;

    await reporter.test("baseline", "canonical file stays in project root", async () => {
      assert(canonicalWrite.scope_type === "project", "canonical write should resolve to project scope");
      const storedPath = path.join(project.directory, "docs/decision.md");
      assert(fs.existsSync(storedPath), "canonical file not stored in project root");
      return { file: storedPath };
    });

    await reporter.test("baseline", "project aggregate file listing returns project and workplace assets", async () => {
      const files = (await request(baseUrl, "GET", `/api/shared-files?project_id=${encodeURIComponent(project.id)}`)).data;
      assert(files.length === 2, `expected 2 files, got ${files.length}`);
      const scopes = new Set(files.map((file) => file.scope_type));
      assert(scopes.has("project") && scopes.has("workplace"), "aggregate listing must include both scopes");
      return files.map((file) => ({ path: file.path, scope: file.scope_type }));
    });

    await reporter.test("baseline", "default workplace gets a channel immediately", async () => {
      const channels = (await request(baseUrl, "GET", `/api/channels?project_id=${encodeURIComponent(project.id)}`)).data;
      const workplaceChannel = channels.find((channel) => channel.workplace_id === defaultWorkplace.id);
      assert(workplaceChannel, "default workplace channel missing");
      return channels.map((channel) => ({ id: channel.id, workplace_id: channel.workplace_id || null }));
    });

    const decisionMemory = (await request(baseUrl, "POST", "/api/memory/entries", {
      agent_name: "author",
      category: "decision",
      heading: "Canonical peak memory",
      content: "Choose canonical design",
      project_id: project.id,
    })).data;
    const dailyMemory = (await request(baseUrl, "POST", "/api/memory/entries", {
      agent_name: "author",
      category: "daily",
      heading: "Derived note",
      content: "Temporary execution note",
      project_id: project.id,
    })).data;

    await reporter.test("baseline", "legacy project_id bridge routes memories by intent", async () => {
      assert(decisionMemory.scope_type === "project", "decision memory should resolve to project scope");
      assert(dailyMemory.scope_type === "workplace", "daily memory should resolve to workplace scope");
      return {
        decision_scope: decisionMemory.scope_type,
        daily_scope: dailyMemory.scope_type,
      };
    });

    await reporter.test("baseline", "duplicate memory is blocked only within same scope", async () => {
      const duplicate = await request(baseUrl, "POST", "/api/memory/entries", {
        agent_name: "author",
        category: "decision",
        heading: "Canonical peak memory",
        content: "Choose canonical design",
        project_id: project.id,
      }, [409]);
      assert(duplicate.status === 409, "same-scope duplicate should be rejected");
      const crossScope = await request(baseUrl, "POST", "/api/memory/entries", {
        agent_name: "author",
        category: "decision",
        heading: "Explicit workplace duplicate",
        content: "Choose canonical design",
        scope_type: "workplace",
        scope_id: defaultWorkplace.id,
      });
      assert(crossScope.data.scope_type === "workplace", "cross-scope duplicate should be allowed");
      return { duplicate_status: duplicate.status, cross_scope_id: crossScope.data.id };
    });

    await reporter.test("baseline", "project stats aggregate project and workplace scopes", async () => {
      const stats = (await request(baseUrl, "GET", `/api/memory/stats?agent_name=author&project_id=${encodeURIComponent(project.id)}`)).data;
      assert(stats.total >= 3, `expected aggregated stats across scopes, got ${stats.total}`);
      return stats;
    });

    await reporter.test("baseline", "reindex without Ollama fails loudly instead of pretending success", async () => {
      const response = await request(baseUrl, "POST", "/api/memory/reindex", {
        agent_name: "author",
        project_id: project.id,
      }, [503]);
      assert(response.status === 503, "reindex should fail with 503 when Ollama is unavailable");
      return response.data;
    });

    runtimeSummary.notes.push(`project files: ${listProjectFiles(project.directory).join(", ")}`);
    db.pragma("wal_checkpoint(FULL)");
  });
  return runtimeSummary;
}

async function runTargetSuite(reporter) {
  const runtimeSummary = { label: "target", runtime_root: null, notes: [] };
  const mockOllama = await startMockOllama();
  try {
    await withCrewRuntime("claude-crew-validation-target", { OLLAMA_BASE_URL: mockOllama.baseUrl }, async ({ runtimeRoot, baseUrl, db }) => {
      runtimeSummary.runtime_root = runtimeRoot;
      process.env.CREW_PROJECT_ROOT = runtimeRoot;
      process.env.OLLAMA_BASE_URL = mockOllama.baseUrl;
      const peaksModule = await import(pathToFileURL(path.join(REPO_ROOT, "packages/server/dist/api/peaks.js")).href);

      await request(baseUrl, "POST", "/api/agents/register", { name: "analyst-a", role: "analyst" });
      await request(baseUrl, "POST", "/api/agents/register", { name: "builder-b", role: "builder" });
      await request(baseUrl, "POST", "/api/agents/register", { name: "reviewer-c", role: "reviewer" });

      const project = (await request(baseUrl, "POST", "/api/projects", {
        name: "Validation Target Project",
        description: "Target model suite",
        tech_stack: ["ts", "sqlite"],
      })).data;

      const derivedWrite = (await request(baseUrl, "PUT", `/api/shared-files/${encodeFilePath("artifacts/build.log")}`, {
        content: "build ok\n",
        created_by: "user",
        project_id: project.id,
        artifact_kind: "derived",
      })).data;
      const workplaces = (await request(baseUrl, "GET", `/api/projects/${project.id}/workplaces`)).data;
      const defaultWorkplace = workplaces.find((workplace) => workplace.slug === "default");
      await request(baseUrl, "POST", `/api/projects/${project.id}/agents`, { agent_name: "analyst-a", role_in_project: "lead" });
      await request(baseUrl, "POST", `/api/projects/${project.id}/agents`, { agent_name: "builder-b", role_in_project: "builder" });

      const experimentsWorkplace = (await request(baseUrl, "POST", `/api/projects/${project.id}/workplaces`, {
        name: "Experiments",
        kind: "derived",
      })).data;
      await request(baseUrl, "PUT", `/api/projects/${project.id}/agents/analyst-a/workplace`, {
        workplace_id: experimentsWorkplace.id,
      });

      await reporter.test("target", "workplace switching updates active execution context", async () => {
        const agents = (await request(baseUrl, "GET", `/api/projects/${project.id}/agents`)).data;
        const analyst = agents.find((agent) => agent.agent_name === "analyst-a");
        assert(analyst?.active_workplace_id === experimentsWorkplace.id, "active workplace was not updated");
        return analyst;
      });

      await reporter.test("target", "project and workplace context endpoints describe the split clearly", async () => {
        const projectContext = (await request(baseUrl, "GET", `/api/projects/${project.id}/context`)).data;
        const workplaceContext = (await request(baseUrl, "GET", `/api/projects/${project.id}/workplaces/${experimentsWorkplace.id}/context`)).data;
        assert(projectContext.context.includes("Canonical Project Root"), "project context missing canonical root");
        assert(workplaceContext.context.includes("Use this workplace for derived artifacts"), "workplace context missing derived guidance");
        return {
          project_context_excerpt: projectContext.context.split("\n").slice(0, 4),
          workplace_context_excerpt: workplaceContext.context.split("\n").slice(0, 4),
        };
      });

      await reporter.test("target", "project channel listing includes workplace channels", async () => {
        const channels = (await request(baseUrl, "GET", `/api/channels?project_id=${encodeURIComponent(project.id)}`)).data;
        const workplaceChannelIds = channels.filter((channel) => channel.workplace_id).map((channel) => channel.id);
        assert(workplaceChannelIds.length >= 2, "expected default and experiments workplace channels");
        return workplaceChannelIds;
      });

      const categoryScopes = {};
      for (const category of ["contact", "preference", "decision", "project", "pattern", "feedback", "daily"]) {
        const created = (await request(baseUrl, "POST", "/api/memory/entries", {
          agent_name: "author",
          category,
          heading: `${category} heading`,
          content: `${category} content ${Math.random().toString(36).slice(2)}`,
          project_id: project.id,
        })).data;
        categoryScopes[category] = created.scope_type;
      }

      await reporter.test("target", "memory CRUD works across all categories", async () => {
        const entry = (await request(baseUrl, "POST", "/api/memory/entries", {
          agent_name: "author",
          category: "feedback",
          heading: "CRUD probe",
          content: "before update",
          project_id: project.id,
        })).data;
        const readBefore = (await request(baseUrl, "GET", `/api/memory/entries/${entry.id}`)).data;
        await request(baseUrl, "PUT", `/api/memory/entries/${entry.id}`, { content: "after update", heading: "CRUD probe updated" });
        const readAfter = (await request(baseUrl, "GET", `/api/memory/entries/${entry.id}`)).data;
        await request(baseUrl, "DELETE", `/api/memory/entries/${entry.id}`);
        const missing = await request(baseUrl, "GET", `/api/memory/entries/${entry.id}`, undefined, [404]);
        assert(readBefore.access_count >= 1, "memory read should increment access count");
        assert(readAfter.content === "after update", "memory update did not persist");
        assert(missing.status === 404, "memory delete did not remove entry");
        assert(Object.keys(categoryScopes).length === 7, "not all categories were created");
        return { category_scopes: categoryScopes };
      });

      await reporter.test("target", "search ranking changes after direct memory access", async () => {
        const a = (await request(baseUrl, "POST", "/api/memory/entries", {
          agent_name: "author",
          category: "daily",
          heading: "ranking probe shared",
          content: "ranking probe alpha",
          scope_type: "workplace",
          scope_id: defaultWorkplace.id,
        })).data;
        const b = (await request(baseUrl, "POST", "/api/memory/entries", {
          agent_name: "author",
          category: "daily",
          heading: "ranking probe shared",
          content: "ranking probe beta",
          scope_type: "workplace",
          scope_id: defaultWorkplace.id,
        })).data;
        const seedTime = Date.now() - 2 * 86400000;
        db.prepare("UPDATE memory_entries SET created_at = ?, last_accessed_at = ?, access_count = 0, access_timestamps = '[]', stability = 1.0, activation = 0.0, retrievability = 1.0 WHERE id IN (?, ?)")
          .run(seedTime, seedTime, a.id, b.id);
        await request(baseUrl, "GET", `/api/memory/entries/${a.id}`);
        const search = (await request(baseUrl, "GET", `/api/memory/search?q=${encodeURIComponent("ranking probe")}&agent_name=author&scope_type=workplace&scope_id=${encodeURIComponent(defaultWorkplace.id)}`)).data;
        assert(search.entries[0]?.id === a.id, "recently accessed memory should rank first");
        return search.entries.slice(0, 2).map((entry) => ({ id: entry.id, score: entry.score }));
      });

      await reporter.test("target", "memory consolidate and stats work for project+workplace scope", async () => {
        const promote = (await request(baseUrl, "POST", "/api/memory/entries", {
          agent_name: "author",
          category: "daily",
          heading: "promote me",
          content: "promote me",
          scope_type: "workplace",
          scope_id: defaultWorkplace.id,
        })).data;
        const archive = (await request(baseUrl, "POST", "/api/memory/entries", {
          agent_name: "author",
          category: "daily",
          heading: "archive me",
          content: "archive me",
          scope_type: "workplace",
          scope_id: defaultWorkplace.id,
        })).data;
        const now = Date.now();
        const ts1 = now - 3 * 86400000;
        const ts2 = now - 2 * 86400000;
        const ts3 = now - 1 * 86400000;
        db.prepare(`
          UPDATE memory_entries
          SET access_count = 3, access_timestamps = ?, created_at = ?, last_accessed_at = ?, importance = 4
          WHERE id = ?
        `).run(JSON.stringify([ts1, ts2, ts3]), ts1, ts3, promote.id);
        db.prepare(`
          UPDATE memory_entries
          SET access_count = 0, access_timestamps = '[]', created_at = ?, last_accessed_at = ?
          WHERE id = ?
        `).run(now - 120 * 86400000, now - 120 * 86400000, archive.id);

        const consolidation = (await request(baseUrl, "POST", "/api/memory/consolidate", {
          agent_name: "author",
          project_id: project.id,
        })).data;
        const stats = (await request(baseUrl, "GET", `/api/memory/stats?agent_name=author&project_id=${encodeURIComponent(project.id)}`)).data;
        assert(consolidation.promoted_ids.includes(promote.id), "promoted memory missing from consolidate result");
        assert(consolidation.archived_ids.includes(archive.id), "archived memory missing from consolidate result");
        assert(stats.total >= 8, "project stats should include project and workplace memories");
        return { consolidation, stats };
      });

      await reporter.test("target", "reindex succeeds with a mock Ollama service", async () => {
        db.prepare(`
          UPDATE memory_entries
          SET embedding = NULL
          WHERE agent_name = ? AND category IN ('decision', 'feedback', 'daily')
        `).run("author");
        const response = (await request(baseUrl, "POST", "/api/memory/reindex", {
          agent_name: "author",
          project_id: project.id,
        })).data;
        assert(response.indexed > 0, "reindex should populate missing embeddings");
        const embedded = db.prepare("SELECT COUNT(*) as count FROM memory_entries WHERE embedding IS NOT NULL").get();
        assert(embedded.count > 0, "embeddings were not stored");
        return { reindex: response, embedded_count: embedded.count };
      });

      const tmuxCapture = maybeStartTmuxCapture("analyst-a", runtimeRoot);
      try {
        if (!tmuxCapture) {
          reporter.skip("target", "peak decision reaches waiting tmux runtime", "tmux unavailable in validation environment; fallback delivery still validated");
        }

        await reporter.test("target", "peak invalid payload is rejected", async () => {
          const invalid = await request(baseUrl, "POST", "/api/peaks", {
            agent_name: "analyst-a",
            peak_type: "multiple_paths",
            context: "",
            options: [{ label: "A", pros: "", cons: "" }],
          }, [400]);
          assert(invalid.status === 400, "invalid peak should be rejected");
          return invalid.data;
        });
  
        const peak = (await request(baseUrl, "POST", "/api/peaks", {
          agent_name: "analyst-a",
          project_id: project.id,
          peak_type: "multiple_paths",
          context: "Need to choose rollout strategy",
          options: [
            { label: "safe", pros: "stable", cons: "slower" },
            { label: "fast", pros: "faster", cons: "riskier" },
          ],
          default_option: 0,
          timeout_seconds: 30,
        })).data;
        const decision = (await request(baseUrl, "POST", `/api/peaks/${peak.id}/decide`, {
          option_index: 1,
          note: "Prefer speed for this validation",
          decided_by: "user",
        })).data;

        await reporter.test("target", "peak decide persists durable memory and durable resume message", async () => {
          const decisionMemory = db.prepare(`
            SELECT status, category, scope_type, scope_id
            FROM memory_entries
            WHERE id = ?
          `).get(decision.settlement.memory_id);
          const message = db.prepare(`
            SELECT channel_id, sender_name, content, message_type
            FROM messages
            WHERE id = ?
          `).get(decision.settlement.message_id);
          const pending = db.prepare(`
            SELECT delivery_status
            FROM pending_mentions
            WHERE message_id = ? AND agent_name = 'analyst-a'
          `).get(decision.settlement.message_id);
          assert(decisionMemory?.status === "permanent", "peak decision memory must be permanent");
          assert(decisionMemory?.scope_type === "project" && decisionMemory?.scope_id === project.id, "peak decisions should persist to project scope");
          assert(message?.message_type === "peak_settlement", "settlement message missing");
          assert(typeof pending?.delivery_status === "string", "pending mention for resume was not created");
          return { decision_memory: decisionMemory, settlement_message: message, delivery_status: pending.delivery_status };
        });

        if (tmuxCapture) {
          await reporter.test("target", "peak decision reaches waiting tmux runtime", async () => {
            for (let attempt = 0; attempt < 20; attempt += 1) {
              if (
                fs.existsSync(tmuxCapture.outputPath)
                && fs.readFileSync(tmuxCapture.outputPath, "utf-8").toLowerCase().includes("peak resolved")
              ) {
                return { tmux_capture: tmuxCapture.outputPath };
              }
              await sleep(150);
            }
            throw new Error("tmux capture did not receive the resume message");
          });
        }

        await reporter.test("target", "let-agent-decide writes a durable decision memory", async () => {
          const autoPeak = (await request(baseUrl, "POST", "/api/peaks", {
            agent_name: "analyst-a",
            project_id: project.id,
          peak_type: "multiple_paths",
          context: "Need default behavior",
          options: [
            { label: "conservative", pros: "", cons: "" },
            { label: "aggressive", pros: "", cons: "" },
          ],
          default_option: 1,
          timeout_seconds: 30,
        })).data;
        const settled = (await request(baseUrl, "POST", `/api/peaks/${autoPeak.id}/let-agent-decide`, {})).data;
        const persisted = db.prepare("SELECT COUNT(*) as count FROM memory_entries WHERE heading = ?")
          .get(`Peak decision: ${settled.chosen_option.label}`);
        assert(persisted.count >= 1, "agent-decide path did not persist a memory");
        return settled;
        });

        await reporter.test("target", "timeout processing writes a durable decision memory", async () => {
          const timeoutPeak = (await request(baseUrl, "POST", "/api/peaks", {
            agent_name: "analyst-a",
            project_id: project.id,
          peak_type: "multiple_paths",
          context: "Timeout me",
          options: [
            { label: "fallback-a", pros: "", cons: "" },
            { label: "fallback-b", pros: "", cons: "" },
          ],
          default_option: 0,
          timeout_seconds: 30,
        })).data;
        db.prepare("UPDATE peaks SET created_at = ? WHERE id = ?").run(Date.now() - 120000, timeoutPeak.id);
        const processed = peaksModule.processExpiredPeaks();
        const expired = db.prepare("SELECT status, decision_index FROM peaks WHERE id = ?").get(timeoutPeak.id);
        const timeoutMemory = db.prepare("SELECT COUNT(*) as count FROM memory_entries WHERE content LIKE '%Auto-decided on timeout%'").get();
        assert(processed.expired >= 1, "timeout processor did not pick up expired peak");
        assert(expired.status === "expired", "expired peak status did not update");
        assert(timeoutMemory.count >= 1, "timeout path did not persist decision memory");
        return { processed, expired };
        });

        await reporter.test("target", "repeated peak decisions do not auto-extract SOPs below consensus threshold", async () => {
          for (let index = 0; index < 3; index += 1) {
            const repeatedPeak = (await request(baseUrl, "POST", "/api/peaks", {
              agent_name: "analyst-a",
            project_id: project.id,
            peak_type: "multiple_paths",
            context: `Repeat ${index}`,
            options: [
              { label: "same-choice", pros: "", cons: "" },
              { label: "other-choice", pros: "", cons: "" },
            ],
            default_option: 0,
            timeout_seconds: 30,
          })).data;
          await request(baseUrl, "POST", `/api/peaks/${repeatedPeak.id}/decide`, { option_index: 0, decided_by: "user" });
        }
        const sopCount = db.prepare("SELECT COUNT(*) as count FROM shared_standards WHERE name LIKE 'Peak pattern:%'").get();
        assert(sopCount.count === 0, "peak extraction should not auto-apply without reflection consensus");
        return { peak_pattern_standards: sopCount.count };
        });
      } finally {
        if (tmuxCapture) {
          tmuxCapture.stop();
        }
      }

      await reporter.test("target", "reflection with no proposed updates stays pending and empty", async () => {
        const reflection = (await request(baseUrl, "POST", "/api/reflections", {
          agent_name: "analyst-a",
          project_id: project.id,
          trigger_type: "manual",
          task_summary: "No-op reflection",
          lessons_learned: ["noop"],
          proposed_updates: [],
          confidence: 0.9,
        })).data;
        assert(reflection.status === "pending", "empty reflection should remain pending");
        assert(Array.isArray(reflection.auto_results) && reflection.auto_results.length === 0, "auto_results should be empty");
        return reflection;
      });

      await reporter.test("target", "reflection auto-apply requires consensus, budget, and no contradiction", async () => {
        const update = {
          action: "add",
          section: "API Naming",
          proposed_text: "Use action-oriented endpoint names for mutation routes.",
          rationale: "Consistency",
          confidence: 0.95,
        };
        const first = (await request(baseUrl, "POST", "/api/reflections", {
          agent_name: "analyst-a",
          project_id: project.id,
          trigger_type: "manual",
          task_summary: "First consensus vote",
          proposed_updates: [update],
          confidence: 0.95,
        })).data;
        const second = (await request(baseUrl, "POST", "/api/reflections", {
          agent_name: "builder-b",
          project_id: project.id,
          trigger_type: "manual",
          task_summary: "Second consensus vote",
          proposed_updates: [update],
          confidence: 0.95,
        })).data;
        assert(first.status === "pending", "single-agent reflection should not auto-apply");
        assert(second.status === "auto_applied", "second reflection should auto-apply on consensus");

        const standard = db.prepare("SELECT name FROM shared_standards WHERE name = ?").get(update.section);
        assert(standard?.name === update.section, "consensus standard missing");

        const directStandard = (await request(baseUrl, "POST", "/api/standards", {
          category: "coding_norm",
          name: "Explicit Imports",
          content: "Always use explicit imports for service modules.",
          priority: 1,
        })).data;
        const contradiction = (await request(baseUrl, "POST", "/api/reflections", {
          agent_name: "reviewer-c",
          project_id: project.id,
          trigger_type: "manual",
          task_summary: "Contradiction test",
          proposed_updates: [{
            action: "add",
            section: "Imports",
            proposed_text: "Never use explicit imports for service modules.",
            rationale: "Counter-signal",
            confidence: 0.95,
          }],
          confidence: 0.95,
        })).data;
        const contradictionReason = contradiction.auto_results?.[0]?.reason || "";
        assert(contradiction.status === "pending", "contradictory reflection should not auto-apply");
        assert(contradictionReason.includes("contradiction"), "contradiction reason missing");

        const oversized = await request(baseUrl, "POST", "/api/standards", {
          category: "coding_norm",
          name: "Too Large",
          content: "x".repeat(5000),
          priority: 0,
        }, [400]);
        assert(oversized.status === 400, "budget overflow standard should be rejected");
        return { consensus_standard: standard.name, contradiction_reason: contradictionReason, direct_standard: directStandard.id };
      });

      await reporter.test("target", "manual reflection review applies pending updates", async () => {
        const pending = (await request(baseUrl, "POST", "/api/reflections", {
          agent_name: "reviewer-c",
          project_id: project.id,
          trigger_type: "manual",
          task_summary: "Manual apply",
          proposed_updates: [{
            action: "add",
            section: "Manual SOP",
            proposed_text: "Document exception handling choices in project notes.",
            rationale: "Manual review test",
            confidence: 0.4,
          }],
          confidence: 0.4,
        })).data;
        const reviewed = (await request(baseUrl, "PUT", `/api/reflections/${pending.id}/review`, {
          action: "approve",
          reviewed_by: "user",
        })).data;
        const standard = db.prepare("SELECT name FROM shared_standards WHERE name = 'Manual SOP'").get();
        assert(reviewed.status === "manually_approved", "manual approval status missing");
        assert(standard?.name === "Manual SOP", "manual approval did not apply standard");
        return reviewed;
      });

      await reporter.test("target", "standards history and rollback remain intact", async () => {
        const standard = (await request(baseUrl, "POST", "/api/standards", {
          category: "workflow",
          name: "Rollback Probe",
          content: "Version one",
          priority: 2,
        })).data;
        await request(baseUrl, "PUT", `/api/standards/${standard.id}`, {
          content: "Version two",
          change_summary: "Update for rollback",
        });
        const history = (await request(baseUrl, "GET", `/api/standards/${standard.id}/history`)).data;
        assert(history.length >= 2, "history should contain initial and updated versions");
        const rollback = (await request(baseUrl, "POST", `/api/standards/${standard.id}/rollback`, { version: 1 })).data;
        const restored = db.prepare("SELECT content FROM shared_standards WHERE id = ?").get(standard.id);
        assert(restored.content === "Version one", "rollback did not restore v1 content");
        return rollback;
      });

      await reporter.test("target", "project aggregate file list keeps scope metadata for UX diagnostics", async () => {
        const files = (await request(baseUrl, "GET", `/api/shared-files?project_id=${encodeURIComponent(project.id)}`)).data;
        assert(files.some((file) => file.scope_name), "scope labels should be present for UX diagnostics");
        return files.map((file) => ({ path: file.path, scope: `${file.scope_type}:${file.scope_name}` }));
      });

      runtimeSummary.notes.push(`project files: ${listProjectFiles(project.directory).join(", ")}`);
      runtimeSummary.notes.push(`derived scope example: ${derivedWrite.scope_type}`);
      db.pragma("wal_checkpoint(FULL)");
    });
  } finally {
    await mockOllama.stop();
  }
  return runtimeSummary;
}

function buildHumanSummary(report) {
  const failed = report.tests.filter((test) => test.status === "failed");
  const skipped = report.tests.filter((test) => test.status === "skipped");
  const lines = [
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`,
  ];
  if (failed.length > 0) {
    lines.push("Failures:");
    for (const test of failed) {
      lines.push(`- [${test.suite}] ${test.name}: ${test.details}`);
    }
  } else {
    lines.push("Failures: none.");
  }
  if (skipped.length > 0) {
    lines.push("Skipped:");
    for (const test of skipped) {
      lines.push(`- [${test.suite}] ${test.name}: ${test.details}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const reporter = createReporter();
  const runtimeSummaries = [];

  runtimeSummaries.push(await runBaselineSuite(reporter));
  runtimeSummaries.push(await runTargetSuite(reporter));

  const report = reporter.build(runtimeSummaries);
  const jsonPath = path.join(REPORT_DIR, "memory-productization-report.json");
  const summaryPath = path.join(REPORT_DIR, "memory-productization-summary.txt");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  fs.writeFileSync(summaryPath, buildHumanSummary(report) + "\n", "utf-8");

  console.log(buildHumanSummary(report));
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Summary report: ${summaryPath}`);

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
