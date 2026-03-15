#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUNTIME_FILE = process.env.CLAUDE_CREW_RUNTIME_FILE
  || path.join(os.homedir(), ".claude-crew", "runtime", "vscode-extension.json");

const helpText = `Claude Crew terminal control

Usage:
  crewctl help
  crewctl runtime
  crewctl status
  crewctl server status|start|stop|restart
  crewctl panel open
  crewctl events
  crewctl api METHOD PATH [JSON_BODY]

  crewctl agents list
  crewctl agents wake NAME
  crewctl agents stop NAME
  crewctl agents restart NAME
  crewctl agents runtime NAME
  crewctl agents terminal NAME
  crewctl agents send-terminal NAME INPUT [--type paste]
  crewctl agents config NAME key=value [key=value...]
  crewctl agents create NAME ROLE [--provider claude|codex] [--wake true|false]
  crewctl agents delete NAME
  crewctl agents update NAME --role ROLE

  crewctl channels list [--status active|archived] [--project-id ID]
  crewctl channels create NAME [--description TEXT] [--type public|group] [--members a,b] [--project-id ID]
  crewctl channels dm AGENT_NAME
  crewctl channels archive ID
  crewctl channels unarchive ID
  crewctl channels delete ID
  crewctl channels add-member ID AGENT_NAME
  crewctl channels remove-member ID AGENT_NAME

  crewctl messages list CHANNEL_ID [--limit 50]
  crewctl messages send CHANNEL_ID TEXT
  crewctl messages search QUERY [--channel-id ID] [--limit 20]

  crewctl approvals list [AGENT_NAME]
  crewctl approvals respond AGENT_NAME KEY

  crewctl peaks list
  crewctl peaks pending
  crewctl peaks get ID
  crewctl peaks decide ID OPTION_INDEX [--note TEXT] [--decided-by user]
  crewctl peaks let-agent-decide ID
  crewctl peaks pause ID [--seconds 3600]

  crewctl projects list
  crewctl projects get ID
  crewctl projects create --directory ABS_PATH [--name NAME] [--description TEXT] [--tech-stack a,b]
  crewctl projects update ID [--name NAME] [--description TEXT] [--tech-stack a,b]
  crewctl projects pause ID
  crewctl projects resume ID
  crewctl projects archive ID
  crewctl projects delete ID
  crewctl projects agents ID list
  crewctl projects agents ID assign AGENT_NAME ROLE [--assignment-type dedicated]
  crewctl projects agents ID remove AGENT_NAME
  crewctl projects agents ID move AGENT_NAME WORKPLACE_ID
  crewctl projects workplaces ID list
  crewctl projects workplaces ID create NAME [--kind derived]
  crewctl projects context ID

  crewctl files list [--project-id ID] [--scope-type TYPE] [--scope-id ID]
  crewctl files get PATH [--project-id ID] [--scope-type TYPE] [--scope-id ID]
  crewctl files put PATH --content TEXT|@FILE|-
      [--project-id ID] [--artifact-kind KIND] [--description TEXT] [--created-by user]
  crewctl files delete PATH [--project-id ID] [--scope-type TYPE] [--scope-id ID]

  crewctl import sessions
  crewctl import session SESSION_ID [--label NAME]

  crewctl mentions list AGENT_NAME
  crewctl mentions ack MENTION_ID

Global options:
  --port PORT         Connect directly to a running Crew API port.
  --runtime-file PATH Use a custom VS Code runtime registry file.

Notes:
  Frontend parity comes from reusing the same HTTP and WebSocket server that powers the VS Code panel.
  For unsupported flows, use: crewctl api METHOD /api/... '{...}'
`;

async function main() {
  const { options, args } = parseGlobalOptions(process.argv.slice(2));
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${helpText}\n`);
    return;
  }

  switch (command) {
    case "runtime":
      print(await getRuntime(options));
      return;
    case "status":
      print(await apiRequest(options, "GET", "/api/status"));
      return;
    case "server":
      await handleServerCommand(options, rest);
      return;
    case "panel":
      await handlePanelCommand(options, rest);
      return;
    case "events":
      await watchEvents(options);
      return;
    case "api":
      await handleApiCommand(options, rest);
      return;
    case "agents":
      await handleAgentsCommand(options, rest);
      return;
    case "channels":
      await handleChannelsCommand(options, rest);
      return;
    case "messages":
      await handleMessagesCommand(options, rest);
      return;
    case "approvals":
      await handleApprovalsCommand(options, rest);
      return;
    case "peaks":
      await handlePeaksCommand(options, rest);
      return;
    case "projects":
      await handleProjectsCommand(options, rest);
      return;
    case "files":
      await handleFilesCommand(options, rest);
      return;
    case "import":
      await handleImportCommand(options, rest);
      return;
    case "mentions":
      await handleMentionsCommand(options, rest);
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

function parseGlobalOptions(argv) {
  const options = {
    port: process.env.CLAUDE_CREW_PORT || null,
    runtimeFile: RUNTIME_FILE,
  };
  const args = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      options.port = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--runtime-file") {
      options.runtimeFile = argv[i + 1] || options.runtimeFile;
      i += 1;
      continue;
    }
    if (arg.startsWith("--runtime-file=")) {
      options.runtimeFile = arg.slice("--runtime-file=".length);
      continue;
    }
    args.push(arg);
  }

  return { options, args };
}

function parseFlags(args) {
  const flags = new Map();
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) {
      flags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(arg.slice(2), "true");
      continue;
    }

    flags.set(arg.slice(2), next);
    i += 1;
  }

  return { flags, positionals };
}

function expectArg(value, label) {
  if (!value) {
    fail(`Missing ${label}`);
  }
  return value;
}

function getFlag(flags, name, fallback = undefined) {
  return flags.has(name) ? flags.get(name) : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return value === true || value === "true" || value === "1" || value === "yes";
}

function splitCsv(value) {
  if (!value) {
    return undefined;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function getRuntime(options) {
  if (options.port) {
    return {
      source: "direct-port",
      server: {
        state: "running",
        port: Number(options.port),
      },
    };
  }

  const runtime = await readRuntimeFile(options.runtimeFile);
  return controlRequest(runtime, "GET", "/runtime");
}

async function ensureApiBase(options, { autoStart = true } = {}) {
  if (options.port) {
    return { baseUrl: `http://127.0.0.1:${options.port}` };
  }

  const runtime = await readRuntimeFile(options.runtimeFile);
  let record = await controlRequest(runtime, "GET", "/runtime");

  if (record.server?.state !== "running" || !record.server?.port) {
    if (!autoStart) {
      fail("Claude Crew server is not running in VS Code.");
    }
    record = await controlRequest(runtime, "POST", "/server/start");
  }

  if (!record.server?.port) {
    fail("Claude Crew server did not return a port.");
  }

  return { baseUrl: `http://127.0.0.1:${record.server.port}` };
}

async function readRuntimeFile(runtimeFile) {
  try {
    const raw = await fs.readFile(runtimeFile, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    fail(`Unable to read VS Code runtime file at ${runtimeFile}: ${(error).message}`);
  }
}

async function controlRequest(runtime, method, requestPath, body) {
  const response = await fetch(`http://127.0.0.1:${runtime.controlPort}${requestPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-claude-crew-token": runtime.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return parseResponse(response);
}

async function apiRequest(options, method, requestPath, body, { autoStart = true } = {}) {
  const { baseUrl } = await ensureApiBase(options, { autoStart });
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return parseResponse(response);
}

async function parseResponse(response) {
  const text = await response.text();
  let parsed = null;

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const detail = typeof parsed === "string" ? parsed : parsed?.error || JSON.stringify(parsed);
    fail(`Request failed (${response.status}): ${detail}`);
  }

  return parsed;
}

async function handleServerCommand(options, args) {
  const action = expectArg(args[0], "server action");

  switch (action) {
    case "status":
      print(await getRuntime(options));
      return;
    case "start":
      print(await controlCommand(options, "/server/start"));
      return;
    case "stop":
      print(await controlCommand(options, "/server/stop"));
      return;
    case "restart":
      print(await controlCommand(options, "/server/restart"));
      return;
    default:
      fail(`Unknown server action: ${action}`);
  }
}

async function handlePanelCommand(options, args) {
  const action = expectArg(args[0], "panel action");
  if (action !== "open") {
    fail(`Unknown panel action: ${action}`);
  }

  print(await commandRequest(options, "claude-crew.openPanel"));
}

async function handleApiCommand(options, args) {
  const method = expectArg(args[0], "HTTP method").toUpperCase();
  const requestPath = expectArg(args[1], "request path");
  const rawBody = args[2];
  const body = rawBody ? JSON.parse(rawBody) : undefined;
  print(await apiRequest(options, method, requestPath, body));
}

async function handleAgentsCommand(options, args) {
  const action = expectArg(args[0], "agents action");
  const { flags, positionals } = parseFlags(args.slice(1));

  switch (action) {
    case "list":
      print(await apiRequest(options, "GET", "/api/agents"));
      return;
    case "wake":
      print(await apiRequest(options, "POST", "/api/wake", { name: expectArg(positionals[0], "agent name") }));
      return;
    case "stop":
      print(await apiRequest(options, "POST", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}/system-stop`, {}));
      return;
    case "restart":
      print(await apiRequest(options, "POST", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}/system-restart`, {}));
      return;
    case "runtime":
      print(await apiRequest(options, "GET", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}/runtime-status`));
      return;
    case "terminal":
      print(await apiRequest(options, "GET", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}/terminal`));
      return;
    case "send-terminal":
      print(await apiRequest(options, "POST", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}/terminal/input`, {
        input: expectArg(positionals[1], "terminal input"),
        type: getFlag(flags, "type"),
      }));
      return;
    case "config": {
      const name = expectArg(positionals[0], "agent name");
      const updates = {};
      for (const pair of positionals.slice(1)) {
        const [key, value] = pair.split("=", 2);
        if (!key || value === undefined) {
          fail(`Invalid config pair: ${pair}`);
        }
        updates[key] = value;
      }
      updates.requested_by = "author";
      if (!("restart" in updates)) {
        updates.restart = false;
      }
      print(await apiRequest(options, "PUT", `/api/agents/${encodeURIComponent(name)}/config`, updates));
      return;
    }
    case "create":
      print(await apiRequest(options, "POST", "/api/agents/create", {
        name: expectArg(positionals[0], "agent name"),
        role: expectArg(positionals[1], "agent role"),
        provider: getFlag(flags, "provider"),
        wake: toBool(getFlag(flags, "wake"), false),
      }));
      return;
    case "delete":
      print(await apiRequest(options, "DELETE", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}`));
      return;
    case "update":
      print(await apiRequest(options, "PUT", `/api/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}`, {
        role: expectArg(getFlag(flags, "role"), "--role"),
      }));
      return;
    default:
      fail(`Unknown agents action: ${action}`);
  }
}

async function handleChannelsCommand(options, args) {
  const action = expectArg(args[0], "channels action");
  const { flags, positionals } = parseFlags(args.slice(1));

  switch (action) {
    case "list": {
      const params = new URLSearchParams();
      if (getFlag(flags, "status")) {
        params.set("status", getFlag(flags, "status"));
      }
      if (getFlag(flags, "project-id")) {
        params.set("project_id", getFlag(flags, "project-id"));
      }
      const suffix = params.toString();
      print(await apiRequest(options, "GET", `/api/channels${suffix ? `?${suffix}` : ""}`));
      return;
    }
    case "create":
      print(await apiRequest(options, "POST", "/api/channels", {
        name: expectArg(positionals[0], "channel name"),
        description: getFlag(flags, "description") || "",
        type: getFlag(flags, "type") || "public",
        members: splitCsv(getFlag(flags, "members")),
        project_id: getFlag(flags, "project-id"),
      }));
      return;
    case "dm":
      print(await apiRequest(options, "POST", `/api/channels/dm/${encodeURIComponent(expectArg(positionals[0], "agent name"))}`));
      return;
    case "archive":
      print(await apiRequest(options, "PUT", `/api/channels/${expectArg(positionals[0], "channel id")}`, { status: "archived" }));
      return;
    case "unarchive":
      print(await apiRequest(options, "PUT", `/api/channels/${expectArg(positionals[0], "channel id")}`, { status: "active" }));
      return;
    case "delete":
      print(await apiRequest(options, "DELETE", `/api/channels/${expectArg(positionals[0], "channel id")}`));
      return;
    case "add-member":
      print(await apiRequest(options, "POST", `/api/channels/${expectArg(positionals[0], "channel id")}/members`, {
        name: expectArg(positionals[1], "agent name"),
      }));
      return;
    case "remove-member":
      print(await apiRequest(options, "DELETE", `/api/channels/${expectArg(positionals[0], "channel id")}/members/${encodeURIComponent(expectArg(positionals[1], "agent name"))}`));
      return;
    default:
      fail(`Unknown channels action: ${action}`);
  }
}

async function handleMessagesCommand(options, args) {
  const action = expectArg(args[0], "messages action");
  const { flags, positionals } = parseFlags(args.slice(1));

  switch (action) {
    case "list": {
      const channelId = expectArg(positionals[0], "channel id");
      const params = new URLSearchParams({
        channel_id: channelId,
        limit: getFlag(flags, "limit", "50"),
      });
      print(await apiRequest(options, "GET", `/api/messages?${params.toString()}`));
      return;
    }
    case "send":
      print(await apiRequest(options, "POST", "/api/messages", {
        sender_type: "user",
        sender_name: "user",
        content: expectArg(positionals[1], "message text"),
        channel_id: expectArg(positionals[0], "channel id"),
      }));
      return;
    case "search": {
      const params = new URLSearchParams({
        q: expectArg(positionals[0], "search query"),
        limit: getFlag(flags, "limit", "20"),
      });
      if (getFlag(flags, "channel-id")) {
        params.set("channel_id", getFlag(flags, "channel-id"));
      }
      print(await apiRequest(options, "GET", `/api/messages/search?${params.toString()}`));
      return;
    }
    default:
      fail(`Unknown messages action: ${action}`);
  }
}

async function handleApprovalsCommand(options, args) {
  const action = expectArg(args[0], "approvals action");

  switch (action) {
    case "list":
      if (args[1]) {
        print(await apiRequest(options, "GET", `/api/approvals/${encodeURIComponent(args[1])}`));
      } else {
        print(await apiRequest(options, "GET", "/api/approvals"));
      }
      return;
    case "respond":
      print(await apiRequest(options, "POST", `/api/approvals/${encodeURIComponent(expectArg(args[1], "agent name"))}/respond`, {
        key: expectArg(args[2], "approval key"),
      }));
      return;
    default:
      fail(`Unknown approvals action: ${action}`);
  }
}

async function handlePeaksCommand(options, args) {
  const action = expectArg(args[0], "peaks action");
  const { flags, positionals } = parseFlags(args.slice(1));

  switch (action) {
    case "list":
      print(await apiRequest(options, "GET", "/api/peaks"));
      return;
    case "pending":
      print(await apiRequest(options, "GET", "/api/peaks/pending"));
      return;
    case "get":
      print(await apiRequest(options, "GET", `/api/peaks/${encodeURIComponent(expectArg(positionals[0], "peak id"))}`));
      return;
    case "decide":
      print(await apiRequest(options, "POST", `/api/peaks/${encodeURIComponent(expectArg(positionals[0], "peak id"))}/decide`, {
        option_index: Number(expectArg(positionals[1], "option index")),
        note: getFlag(flags, "note"),
        decided_by: getFlag(flags, "decided-by", "user"),
      }));
      return;
    case "let-agent-decide":
      print(await apiRequest(options, "POST", `/api/peaks/${encodeURIComponent(expectArg(positionals[0], "peak id"))}/let-agent-decide`));
      return;
    case "pause":
      print(await apiRequest(options, "POST", `/api/peaks/${encodeURIComponent(expectArg(positionals[0], "peak id"))}/pause`, {
        extra_seconds: Number(getFlag(flags, "seconds", "3600")),
      }));
      return;
    default:
      fail(`Unknown peaks action: ${action}`);
  }
}

async function handleProjectsCommand(options, args) {
  const action = expectArg(args[0], "projects action");

  switch (action) {
    case "list":
      print(await apiRequest(options, "GET", "/api/projects"));
      return;
    case "get":
      print(await apiRequest(options, "GET", `/api/projects/${encodeURIComponent(expectArg(args[1], "project id"))}`));
      return;
    case "create": {
      const { flags } = parseFlags(args.slice(1));
      print(await apiRequest(options, "POST", "/api/projects", {
        directory: expectArg(getFlag(flags, "directory"), "--directory"),
        name: getFlag(flags, "name"),
        description: getFlag(flags, "description"),
        tech_stack: splitCsv(getFlag(flags, "tech-stack")) || [],
      }));
      return;
    }
    case "update": {
      const id = expectArg(args[1], "project id");
      const { flags } = parseFlags(args.slice(2));
      print(await apiRequest(options, "PUT", `/api/projects/${encodeURIComponent(id)}`, {
        name: getFlag(flags, "name"),
        description: getFlag(flags, "description"),
        tech_stack: splitCsv(getFlag(flags, "tech-stack")),
      }));
      return;
    }
    case "pause":
    case "resume":
    case "archive":
      print(await apiRequest(options, "POST", `/api/projects/${encodeURIComponent(expectArg(args[1], "project id"))}/${action}`));
      return;
    case "delete":
      print(await apiRequest(options, "DELETE", `/api/projects/${encodeURIComponent(expectArg(args[1], "project id"))}`));
      return;
    case "agents":
      await handleProjectAgentsCommand(options, args.slice(1));
      return;
    case "workplaces":
      await handleProjectWorkplacesCommand(options, args.slice(1));
      return;
    case "context":
      print(await apiRequest(options, "GET", `/api/projects/${encodeURIComponent(expectArg(args[1], "project id"))}/context`));
      return;
    default:
      fail(`Unknown projects action: ${action}`);
  }
}

async function handleProjectAgentsCommand(options, args) {
  const projectId = expectArg(args[0], "project id");
  const action = expectArg(args[1], "project agents action");
  const { flags, positionals } = parseFlags(args.slice(2));

  switch (action) {
    case "list":
      print(await apiRequest(options, "GET", `/api/projects/${encodeURIComponent(projectId)}/agents`));
      return;
    case "assign":
      print(await apiRequest(options, "POST", `/api/projects/${encodeURIComponent(projectId)}/agents`, {
        agent_name: expectArg(positionals[0], "agent name"),
        role_in_project: expectArg(positionals[1], "project role"),
        assignment_type: getFlag(flags, "assignment-type", "dedicated"),
      }));
      return;
    case "remove":
      print(await apiRequest(options, "DELETE", `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}`));
      return;
    case "move":
      print(await apiRequest(options, "PUT", `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(expectArg(positionals[0], "agent name"))}/workplace`, {
        workplace_id: expectArg(positionals[1], "workplace id"),
      }));
      return;
    default:
      fail(`Unknown project agents action: ${action}`);
  }
}

async function handleProjectWorkplacesCommand(options, args) {
  const projectId = expectArg(args[0], "project id");
  const action = expectArg(args[1], "project workplaces action");
  const { flags, positionals } = parseFlags(args.slice(2));

  switch (action) {
    case "list":
      print(await apiRequest(options, "GET", `/api/projects/${encodeURIComponent(projectId)}/workplaces`));
      return;
    case "create":
      print(await apiRequest(options, "POST", `/api/projects/${encodeURIComponent(projectId)}/workplaces`, {
        name: expectArg(positionals[0], "workplace name"),
        kind: getFlag(flags, "kind", "derived"),
      }));
      return;
    default:
      fail(`Unknown project workplaces action: ${action}`);
  }
}

async function handleFilesCommand(options, args) {
  const action = expectArg(args[0], "files action");
  const { flags, positionals } = parseFlags(args.slice(1));

  switch (action) {
    case "list": {
      const params = buildScopeParams(flags);
      print(await apiRequest(options, "GET", `/api/shared-files${params ? `?${params}` : ""}`));
      return;
    }
    case "get": {
      const filePath = encodeURIComponent(expectArg(positionals[0], "file path"));
      const params = buildScopeParams(flags);
      print(await apiRequest(options, "GET", `/api/shared-files/${filePath}${params ? `?${params}` : ""}`));
      return;
    }
    case "put": {
      const filePath = encodeURIComponent(expectArg(positionals[0], "file path"));
      const content = await resolveContentInput(expectArg(getFlag(flags, "content"), "--content"));
      print(await apiRequest(options, "PUT", `/api/shared-files/${filePath}`, {
        content,
        created_by: getFlag(flags, "created-by", "user"),
        description: getFlag(flags, "description"),
        project_id: getFlag(flags, "project-id"),
        scope_type: getFlag(flags, "scope-type"),
        scope_id: getFlag(flags, "scope-id"),
        artifact_kind: getFlag(flags, "artifact-kind"),
      }));
      return;
    }
    case "delete": {
      const filePath = encodeURIComponent(expectArg(positionals[0], "file path"));
      const params = buildScopeParams(flags);
      print(await apiRequest(options, "DELETE", `/api/shared-files/${filePath}${params ? `?${params}` : ""}`));
      return;
    }
    default:
      fail(`Unknown files action: ${action}`);
  }
}

async function handleImportCommand(options, args) {
  const action = expectArg(args[0], "import action");
  const { flags, positionals } = parseFlags(args.slice(1));

  switch (action) {
    case "sessions":
      print(await apiRequest(options, "GET", "/api/import/sessions"));
      return;
    case "session":
      print(await apiRequest(options, "POST", "/api/import/session", {
        sessionId: expectArg(positionals[0], "session id"),
        label: getFlag(flags, "label"),
      }));
      return;
    default:
      fail(`Unknown import action: ${action}`);
  }
}

async function handleMentionsCommand(options, args) {
  const action = expectArg(args[0], "mentions action");

  switch (action) {
    case "list":
      print(await apiRequest(options, "GET", `/api/mentions/${encodeURIComponent(expectArg(args[1], "agent name"))}`));
      return;
    case "ack":
      print(await apiRequest(options, "POST", `/api/mentions/${encodeURIComponent(expectArg(args[1], "mention id"))}/ack`, {}));
      return;
    default:
      fail(`Unknown mentions action: ${action}`);
  }
}

async function controlCommand(options, requestPath) {
  const runtime = await readRuntimeFile(options.runtimeFile);
  return controlRequest(runtime, "POST", requestPath);
}

async function commandRequest(options, command, args = []) {
  const runtime = await readRuntimeFile(options.runtimeFile);
  return controlRequest(runtime, "POST", "/command", { command, args });
}

async function watchEvents(options) {
  const { baseUrl } = await ensureApiBase(options, { autoStart: true });
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

  if (typeof WebSocket !== "function") {
    fail("This Node.js build does not provide a WebSocket client.");
  }

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      process.stderr.write(`Watching ${wsUrl}\n`);
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        process.stdout.write(`${JSON.stringify(data)}\n`);
      } catch {
        process.stdout.write(`${String(event.data)}\n`);
      }
    });

    ws.addEventListener("error", (event) => {
      reject(new Error(`WebSocket error: ${event.type}`));
    });

    ws.addEventListener("close", (event) => {
      if (event.wasClean) {
        resolve();
        return;
      }
      reject(new Error(`WebSocket closed: ${event.code}`));
    });

    process.on("SIGINT", () => {
      ws.close(1000, "terminated");
      resolve();
    });
  });
}

function buildScopeParams(flags) {
  const params = new URLSearchParams();
  if (getFlag(flags, "project-id")) {
    params.set("project_id", getFlag(flags, "project-id"));
  }
  if (getFlag(flags, "scope-type")) {
    params.set("scope_type", getFlag(flags, "scope-type"));
  }
  if (getFlag(flags, "scope-id")) {
    params.set("scope_id", getFlag(flags, "scope-id"));
  }
  return params.toString();
}

async function resolveContentInput(value) {
  if (value === "-") {
    return readStdin();
  }
  if (value.startsWith("@")) {
    return fs.readFile(value.slice(1), "utf-8");
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function print(value) {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  await main();
} catch (error) {
  const cause = error?.cause?.message ? `: ${error.cause.message}` : "";
  fail(`${error.message || String(error)}${cause}`);
}
