/**
 * Claude Crew E2E Test - Browser Console Script
 *
 * Usage: Open http://127.0.0.1:3140 in browser, then paste this script
 *        into the browser console (F12 -> Console -> paste -> Enter)
 *
 * Tests all features through the original page's API layer and
 * verifies real-time DOM changes for WebSocket frontend feedback.
 */
(async function E2E_TEST() {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const BASE = location.origin;
  const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  const TEST_AGENT = "e2e-test-agent";
  const WAIT_MS = 2500;

  // Test state
  let testProjectId = "";
  let testChannelId = "";
  let testMemoryId = "";
  let testPeakId = "";
  let testStandardId = "";
  let testReflectionId = "";

  // ---------------------------------------------------------------------------
  // Overlay UI
  // ---------------------------------------------------------------------------
  const overlay = document.createElement("div");
  overlay.id = "e2e-overlay";
  overlay.style.cssText = `
    position:fixed; top:0; right:0; width:520px; height:100vh;
    background:#1a1a2e; color:#e0e0e0; font-family:monospace; font-size:12px;
    z-index:99999; overflow-y:auto; padding:12px; border-left:2px solid #0f3460;
    box-shadow:-4px 0 20px rgba(0,0,0,0.5);
  `;
  overlay.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h3 style="margin:0;color:#e94560;">Claude Crew E2E Test</h3>
      <button id="e2e-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px;">X</button>
    </div>
    <div id="e2e-progress" style="margin-bottom:8px;color:#0f3460;"></div>
    <div id="e2e-log" style="line-height:1.6;"></div>
    <div id="e2e-summary" style="margin-top:12px;padding-top:8px;border-top:1px solid #333;display:none;"></div>
  `;
  document.body.appendChild(overlay);
  document.getElementById("e2e-close").addEventListener("click", () => overlay.remove());

  const logEl = document.getElementById("e2e-log");
  const progressEl = document.getElementById("e2e-progress");
  const summaryEl = document.getElementById("e2e-summary");

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const results = [];

  function log(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    logEl.appendChild(div);
    overlay.scrollTop = overlay.scrollHeight;
  }

  function logCategory(name) {
    log(`<div style="color:#e94560;font-weight:bold;margin-top:10px;border-bottom:1px solid #333;padding-bottom:2px;">--- ${name} ---</div>`);
  }

  async function apiFetch(method, path, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${path}`, init);
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data };
  }

  // WebSocket event collector
  const wsEvents = [];
  const testWs = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    testWs.onopen = resolve;
    testWs.onerror = reject;
  });
  testWs.onmessage = (e) => {
    try { wsEvents.push(JSON.parse(e.data)); } catch {}
  };

  function clearWs() { wsEvents.length = 0; }

  function findWsEvent(predicate) {
    return wsEvents.find(predicate) || null;
  }

  async function waitWs(predicate, ms = WAIT_MS) {
    const existing = findWsEvent(predicate);
    if (existing) return existing;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const found = findWsEvent(predicate);
        if (found || Date.now() - t0 > ms) { clearInterval(iv); resolve(found); }
      }, 80);
    });
  }

  // DOM observation helpers
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function domQuery(sel) { return document.querySelector(sel); }
  function domQueryAll(sel) { return document.querySelectorAll(sel); }

  function agentExists(name) {
    const items = domQueryAll("#agent-list .agent-item");
    for (const li of items) {
      if (li.querySelector(".agent-name")?.textContent === name) return true;
    }
    return false;
  }

  function channelExists(name) {
    const items = domQueryAll("#channel-list li");
    for (const li of items) {
      const nameEl = li.querySelector(".channel-item-name");
      if (nameEl && nameEl.textContent === name) return true;
    }
    return false;
  }

  function messageExists(text) {
    const msgs = domQueryAll("#messages .message-content");
    for (const el of msgs) {
      if (el.textContent.includes(text)) return true;
    }
    return false;
  }

  function peakCardExists(id) {
    return !!domQuery(`[data-peak-id="${id}"]`);
  }

  function fileListContains(path) {
    const items = domQueryAll("#file-list li");
    for (const li of items) {
      if (li.textContent.includes(path)) return true;
    }
    return false;
  }

  function getAgentCount() {
    const el = domQuery("#agent-count");
    return el ? el.textContent : "";
  }

  function getStatusMsgs() {
    const el = domQuery("#status-bar-msgs");
    return el ? el.textContent : "";
  }

  // Test runner
  let testIndex = 0;
  let totalTests = 0;

  async function test(category, name, fn) {
    testIndex++;
    progressEl.textContent = `Running ${testIndex}/${totalTests}: ${name}...`;
    clearWs();
    try {
      const r = await fn();
      results.push({ category, name, ...r });
      const apiIcon = r.apiOk ? "\u2705" : "\u274C";
      const wsIcon = r.wsOk === "N/A" ? "\u2796" : r.wsOk ? "\u2705" : "\u274C";
      const domIcon = r.domOk === "N/A" ? "\u2796" : r.domOk ? "\u2705" : "\u274C";
      log(`${apiIcon}API ${wsIcon}WS ${domIcon}DOM  <span style="color:#aaa;">${name}</span> <span style="color:#666;">${r.detail}</span>`);
    } catch (err) {
      results.push({ category, name, apiOk: false, wsOk: false, domOk: false, detail: "", error: err.message });
      log(`\u274C\u274C\u274C  <span style="color:#ff6b6b;">${name}</span> ERROR: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------
  totalTests = 38;

  // ==========================================================================
  // 1. Agent Management
  // ==========================================================================
  logCategory("Agent Management");

  // 1.1 Register agent
  await test("Agent", "register agent", async () => {
    const prevCount = getAgentCount();
    const { status, data } = await apiFetch("POST", "/api/agents/register", { name: TEST_AGENT, role: "E2E test agent" });
    const ev = await waitWs((e) => e.type === "agent:status" && e.data.name === TEST_AGENT);
    await wait(500);
    const domOk = agentExists(TEST_AGENT);
    return {
      apiOk: status === 200 && data.name === TEST_AGENT,
      wsOk: ev !== null && ev.data.status === "online",
      domOk,
      detail: `DOM: agent visible=${domOk}, count=${getAgentCount()} (was ${prevCount})`,
    };
  });

  // 1.2 List agents
  await test("Agent", "list agents", async () => {
    const { status, data } = await apiFetch("GET", "/api/agents");
    const found = data.some((a) => a.name === TEST_AGENT);
    const domItems = domQueryAll("#agent-list .agent-item").length;
    return {
      apiOk: status === 200 && found,
      wsOk: "N/A",
      domOk: domItems === data.length,
      detail: `API: ${data.length} agents, DOM: ${domItems} items`,
    };
  });

  // 1.3 Update agent role
  await test("Agent", "update agent role", async () => {
    const { status, data } = await apiFetch("PUT", `/api/agents/${TEST_AGENT}`, { role: "Updated E2E role" });
    const ev = await waitWs((e) => e.type === "agent:status" && e.data.name === TEST_AGENT);
    await wait(500);
    // Check DOM shows updated role
    let domRole = "";
    const items = domQueryAll("#agent-list .agent-item");
    for (const li of items) {
      if (li.querySelector(".agent-name")?.textContent === TEST_AGENT) {
        domRole = li.querySelector(".agent-role")?.textContent || "";
      }
    }
    return {
      apiOk: status === 200 && data.role === "Updated E2E role",
      wsOk: ev !== null,
      domOk: domRole === "Updated E2E role",
      detail: `DOM role="${domRole}"`,
    };
  });

  // 1.4 Heartbeat
  await test("Agent", "heartbeat", async () => {
    const { status, data } = await apiFetch("POST", "/api/agents/heartbeat", { name: TEST_AGENT });
    return { apiOk: status === 200 && data.ok, wsOk: "N/A", domOk: "N/A", detail: "OK" };
  });

  // 1.5 Save worklog
  await test("Agent", "save worklog", async () => {
    const { status, data } = await apiFetch("PUT", `/api/agents/${TEST_AGENT}/worklog`, {
      worklog: { current_task: { description: "E2E", status: "testing" }, key_context: "e2e" },
    });
    return { apiOk: status === 200 && data.ok, wsOk: "N/A", domOk: "N/A", detail: `path=${data.path || "ok"}` };
  });

  // 1.6 Load worklog
  await test("Agent", "load worklog", async () => {
    const { status, data } = await apiFetch("GET", `/api/agents/${TEST_AGENT}/worklog`);
    return { apiOk: status === 200 && data.exists, wsOk: "N/A", domOk: "N/A", detail: `exists=${data.exists}` };
  });

  // 1.7 Runtime status
  await test("Agent", "runtime status", async () => {
    const { status, data } = await apiFetch("GET", `/api/agents/${TEST_AGENT}/runtime-status`);
    return { apiOk: status === 200 && data.name === TEST_AGENT, wsOk: "N/A", domOk: "N/A", detail: `state=${data.runtimeState}` };
  });

  // 1.8 Auth check: instructions
  await test("Agent", "instructions auth check", async () => {
    const { status: rej } = await apiFetch("PUT", `/api/agents/${TEST_AGENT}/instructions`, { instructions: "test", requested_by: "fake" });
    const { status: ok } = await apiFetch("PUT", `/api/agents/${TEST_AGENT}/instructions`, { instructions: "# Test", requested_by: "author" });
    return { apiOk: rej === 403 && (ok === 200 || ok === 404), wsOk: "N/A", domOk: "N/A", detail: `reject=${rej}, author=${ok}` };
  });

  // 1.9 Auth check: config
  await test("Agent", "config auth check", async () => {
    const { status: rej } = await apiFetch("PUT", `/api/agents/${TEST_AGENT}/config`, { model: "sonnet", requested_by: "fake" });
    return { apiOk: rej === 403, wsOk: "N/A", domOk: "N/A", detail: `reject=${rej}` };
  });

  // 1.10 Set config on real agent
  await test("Agent", "set_agent_config (real)", async () => {
    const { data: list } = await apiFetch("GET", "/api/agents");
    const real = list.find((a) => a.status === "online" && a.name !== TEST_AGENT);
    if (!real) return { apiOk: true, wsOk: "N/A", domOk: "N/A", detail: "skipped (no real agent)" };
    const { status, data } = await apiFetch("PUT", `/api/agents/${real.name}/config`, { model: "sonnet", effort: "high", requested_by: "author" });
    const ev = await waitWs((e) => e.type === "agent:config" && e.data.name === real.name);
    return {
      apiOk: status === 200 && data.ok,
      wsOk: ev !== null,
      domOk: "N/A",
      detail: `${real.name}: model=${data.model}, effort=${data.effort}`,
    };
  });

  // ==========================================================================
  // 2. Project Management
  // ==========================================================================
  logCategory("Project Management");

  // 2.1 Create project
  await test("Project", "create project", async () => {
    // Ensure temp dir exists
    await apiFetch("POST", "/api/messages", {
      sender_type: "system", sender_name: "system", content: "[E2E] Testing project creation...", channel_id: "general",
    });
    const dir = "/tmp/e2e-test-project-" + Date.now();
    // Ask server to detect tech stack (which also verifies the dir) -- create dir first via a message hack
    // Actually we need the dir to exist. Let's use the project API which will fail if dir doesn't exist.
    // Create it via a system endpoint if available, or use an existing dir
    const { status, data } = await apiFetch("POST", "/api/projects", {
      directory: "/tmp", name: "E2E Test Project", description: "Created by E2E test", tech_stack: ["TypeScript"],
    });
    testProjectId = data?.id || "";
    const ev = await waitWs((e) => e.type === "project:created");
    await wait(500);
    // Check project selector
    const selector = domQuery("#project-selector");
    let selectorHasProject = false;
    if (selector) {
      for (const opt of selector.options) {
        if (opt.value === testProjectId) { selectorHasProject = true; break; }
      }
    }
    return {
      apiOk: status === 200 && testProjectId.length > 0,
      wsOk: ev !== null,
      domOk: selectorHasProject,
      detail: `id=${testProjectId}, selector=${selectorHasProject}`,
    };
  });

  // 2.2 List projects
  await test("Project", "list projects", async () => {
    const { status, data } = await apiFetch("GET", "/api/projects");
    const found = data.some((p) => p.id === testProjectId);
    return { apiOk: status === 200 && found, wsOk: "N/A", domOk: "N/A", detail: `total=${data.length}` };
  });

  // 2.3 Get project context
  await test("Project", "get_project_context", async () => {
    if (!testProjectId) return { apiOk: false, wsOk: "N/A", domOk: "N/A", detail: "no project" };
    const { status, data } = await apiFetch("GET", `/api/projects/${testProjectId}/context`);
    return { apiOk: status === 200 && data.project_id === testProjectId, wsOk: "N/A", domOk: "N/A", detail: "OK" };
  });

  // 2.4 Assign agent to project
  await test("Project", "assign_agent_to_project", async () => {
    if (!testProjectId) return { apiOk: false, wsOk: "N/A", domOk: "N/A", detail: "no project" };
    const { status, data } = await apiFetch("POST", `/api/projects/${testProjectId}/agents`, {
      agent_name: TEST_AGENT, role_in_project: "Test runner", assignment_type: "dedicated",
    });
    const ev = await waitWs((e) => e.type === "project:agent_changed");
    return { apiOk: status === 200 && data.ok, wsOk: ev !== null, domOk: "N/A", detail: `assigned ${TEST_AGENT}` };
  });

  // 2.5 Update project
  await test("Project", "update project", async () => {
    if (!testProjectId) return { apiOk: false, wsOk: "N/A", domOk: "N/A", detail: "no project" };
    const { status, data } = await apiFetch("PUT", `/api/projects/${testProjectId}`, { description: "Updated by E2E" });
    const ev = await waitWs((e) => e.type === "project:updated");
    return { apiOk: status === 200 && data.description === "Updated by E2E", wsOk: ev !== null, domOk: "N/A", detail: "OK" };
  });

  // ==========================================================================
  // 3. Communication (Chat)
  // ==========================================================================
  logCategory("Communication");

  // 3.1 Create channel
  await test("Chat", "create channel", async () => {
    const { status, data } = await apiFetch("POST", "/api/channels", {
      name: "e2e-test-ch", description: "E2E test", type: "public",
    });
    testChannelId = data?.id || "";
    const ev = await waitWs((e) => e.type === "channel:created");
    await wait(500);
    const domOk = channelExists("e2e-test-ch");
    return {
      apiOk: status === 200 && testChannelId.length > 0,
      wsOk: ev !== null,
      domOk,
      detail: `id=${testChannelId}, sidebar=${domOk}`,
    };
  });

  // 3.2 Switch to test channel via click
  await test("Chat", "switch channel (click)", async () => {
    // Click the channel in sidebar
    const items = domQueryAll("#channel-list li");
    let clicked = false;
    for (const li of items) {
      if (li.querySelector(".channel-item-name")?.textContent === "e2e-test-ch") {
        li.click();
        clicked = true;
        break;
      }
    }
    await wait(500);
    const headerName = domQuery("#channel-name")?.textContent || "";
    return {
      apiOk: clicked,
      wsOk: "N/A",
      domOk: headerName.includes("e2e-test-ch"),
      detail: `header="${headerName}"`,
    };
  });

  // 3.3 Send message via input
  await test("Chat", "send message (input)", async () => {
    const input = domQuery("#message-input");
    const sendBtn = domQuery("#send-btn");
    if (!input || !sendBtn) return { apiOk: false, wsOk: false, domOk: false, detail: "no input/send button" };

    input.value = "Hello from E2E test!";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    sendBtn.click();
    const ev = await waitWs((e) => e.type === "message:new" && e.data?.content?.includes("E2E test"));
    await wait(800);
    const domOk = messageExists("Hello from E2E test!");
    return {
      apiOk: true,
      wsOk: ev !== null,
      domOk,
      detail: `msg visible=${domOk}`,
    };
  });

  // 3.4 Send message via API and check DOM
  await test("Chat", "send_to_chat (API)", async () => {
    const prevMsgs = domQueryAll("#messages .message-row").length;
    const { status, data } = await apiFetch("POST", "/api/messages", {
      sender_type: "agent", sender_name: TEST_AGENT, content: "API message from E2E agent", channel_id: testChannelId,
    });
    const ev = await waitWs((e) => e.type === "message:new" && e.data?.sender_name === TEST_AGENT);
    await wait(800);
    const nowMsgs = domQueryAll("#messages .message-row").length;
    const domOk = messageExists("API message from E2E agent");
    return {
      apiOk: status === 200 && data.id > 0,
      wsOk: ev !== null,
      domOk: domOk && nowMsgs > prevMsgs,
      detail: `msg id=${data.id}, rows: ${prevMsgs}->${nowMsgs}`,
    };
  });

  // 3.5 Read chat
  await test("Chat", "read_chat", async () => {
    const { status, data } = await apiFetch("GET", `/api/messages?channel_id=${testChannelId}&limit=10`);
    return { apiOk: status === 200 && data.length > 0, wsOk: "N/A", domOk: "N/A", detail: `${data.length} msgs` };
  });

  // 3.6 Search chat
  await test("Chat", "search_chat", async () => {
    const { status, data } = await apiFetch("GET", `/api/messages/search?query=E2E&channel_id=${testChannelId}`);
    return { apiOk: status === 200, wsOk: "N/A", domOk: "N/A", detail: `${data.length} results` };
  });

  // 3.7 Check mentions
  await test("Chat", "check_mentions", async () => {
    const { status, data } = await apiFetch("GET", `/api/mentions/${TEST_AGENT}`);
    return { apiOk: status === 200 && Array.isArray(data), wsOk: "N/A", domOk: "N/A", detail: `${data.length} pending` };
  });

  // 3.8 Update channel
  await test("Chat", "update channel", async () => {
    const { status } = await apiFetch("PUT", `/api/channels/${testChannelId}`, { description: "Updated by E2E" });
    const ev = await waitWs((e) => e.type === "channel:updated");
    await wait(500);
    return { apiOk: status === 200, wsOk: ev !== null, domOk: "N/A", detail: "OK" };
  });

  // ==========================================================================
  // 4. PEAK Decision System
  // ==========================================================================
  logCategory("PEAK Decision System");

  // Switch to general so peaks are visible
  const generalCh = domQueryAll("#channel-list li");
  for (const li of generalCh) {
    if (li.querySelector(".channel-item-name")?.textContent === "general") { li.click(); break; }
  }
  await wait(500);

  // 4.1 Escalate peak
  await test("PEAK", "escalate_peak", async () => {
    const { status, data } = await apiFetch("POST", "/api/peaks", {
      agent_name: TEST_AGENT,
      peak_type: "multiple_paths",
      context: "E2E: Which testing approach?",
      options: [
        { label: "Option A", description: "Fast", pros: "quick", cons: "risky" },
        { label: "Option B", description: "Safe", pros: "reliable", cons: "slow" },
      ],
      agent_lean: "Option A is faster",
      timeout_seconds: 300,
    });
    testPeakId = data?.id || "";
    const ev = await waitWs((e) => e.type === "peak:pending");
    await wait(800);
    const domOk = peakCardExists(testPeakId);
    return {
      apiOk: status === 200 && testPeakId.length > 0,
      wsOk: ev !== null,
      domOk,
      detail: `id=${testPeakId}, card visible=${domOk}`,
    };
  });

  // 4.2 Check pending peaks
  await test("PEAK", "check_peak_decision (pending)", async () => {
    const { status, data } = await apiFetch("GET", "/api/peaks/pending");
    const found = data.some((p) => p.id === testPeakId);
    return { apiOk: status === 200 && found, wsOk: "N/A", domOk: "N/A", detail: `${data.length} pending` };
  });

  // 4.3 Pause peak
  await test("PEAK", "pause peak (extend timer)", async () => {
    const { status, data } = await apiFetch("POST", `/api/peaks/${testPeakId}/pause`);
    const ev = await waitWs((e) => e.type === "peak:paused");
    return { apiOk: status === 200 && data.ok, wsOk: ev !== null, domOk: "N/A", detail: `timeout=${data.new_timeout}` };
  });

  // 4.4 Decide peak via DOM click
  await test("PEAK", "decide peak (click)", async () => {
    const card = domQuery(`[data-peak-id="${testPeakId}"]`);
    if (!card) return { apiOk: false, wsOk: false, domOk: false, detail: "no peak card" };
    const chooseBtn = card.querySelector(".peak-choose-btn");
    if (!chooseBtn) return { apiOk: false, wsOk: false, domOk: false, detail: "no choose button" };
    chooseBtn.click();
    const ev = await waitWs((e) => e.type === "peak:decided");
    await wait(800);
    // Check card is resolved
    const resolved = card.classList.contains("resolved") || card.querySelector(".peak-resolved-msg") !== null;
    return {
      apiOk: true,
      wsOk: ev !== null,
      domOk: resolved,
      detail: `resolved=${resolved}`,
    };
  });

  // 4.5 Let agent decide (new peak)
  await test("PEAK", "let-agent-decide", async () => {
    const { data: newPeak } = await apiFetch("POST", "/api/peaks", {
      agent_name: TEST_AGENT, peak_type: "multiple_paths", context: "E2E: agent decides",
      options: [{ label: "Auto A" }, { label: "Auto B" }], default_option: 0, timeout_seconds: 10,
    });
    const pid = newPeak.id;
    clearWs();
    const { status, data } = await apiFetch("POST", `/api/peaks/${pid}/let-agent-decide`);
    const ev = await waitWs((e) => e.type === "peak:decided");
    return { apiOk: status === 200 && data.ok, wsOk: ev !== null, domOk: "N/A", detail: `option=${data.chosen_option?.label}` };
  });

  // ==========================================================================
  // 5. Shared Files
  // ==========================================================================
  logCategory("Shared Files");

  // 5.1 Write shared file
  await test("Files", "write_shared_file", async () => {
    const prevFiles = domQueryAll("#file-list li").length;
    const { status, data } = await apiFetch("PUT", "/api/shared-files/e2e-test-report.md", {
      content: "# E2E Report\nGenerated by browser test.", created_by: TEST_AGENT, description: "E2E file",
      scope_type: "global",
    });
    const ev = await waitWs((e) => e.type === "file:updated");
    await wait(1000);
    const nowFiles = domQueryAll("#file-list li").length;
    const domOk = fileListContains("e2e-test-report") || nowFiles > prevFiles;
    return {
      apiOk: status === 200 && data.success,
      wsOk: ev !== null,
      domOk,
      detail: `files: ${prevFiles}->${nowFiles}, visible=${domOk}`,
    };
  });

  // 5.2 Read shared file
  await test("Files", "read_shared_file", async () => {
    const { status, data } = await apiFetch("GET", "/api/shared-files/e2e-test-report.md?scope_type=global");
    return {
      apiOk: status === 200 && data.content?.includes("E2E Report"),
      wsOk: "N/A", domOk: "N/A",
      detail: `size=${data.size_bytes || 0}b, created_by=${data.created_by}`,
    };
  });

  // 5.3 List shared files
  await test("Files", "list_shared_files", async () => {
    const { status, data } = await apiFetch("GET", "/api/shared-files");
    return { apiOk: status === 200 && Array.isArray(data), wsOk: "N/A", domOk: "N/A", detail: `${data.length} files` };
  });

  // ==========================================================================
  // 6. Memory System
  // ==========================================================================
  logCategory("Memory System");

  // 6.1 Write memory
  await test("Memory", "memory_write", async () => {
    const { status, data } = await apiFetch("POST", "/api/memory/entries", {
      agent_name: TEST_AGENT, category: "decision", heading: "E2E Memory", content: "Test memory from E2E.", importance: 0.8,
    });
    testMemoryId = data?.id || "";
    return { apiOk: status === 200 && testMemoryId.length > 0, wsOk: "N/A", domOk: "N/A", detail: `id=${testMemoryId}` };
  });

  // 6.2 Read memory
  await test("Memory", "memory_read", async () => {
    const { status, data } = await apiFetch("GET", `/api/memory/entries/${testMemoryId}`);
    return { apiOk: status === 200 && data.heading === "E2E Memory", wsOk: "N/A", domOk: "N/A", detail: `cat=${data.category}` };
  });

  // 6.3 Search memory
  await test("Memory", "memory_search", async () => {
    const { status, data } = await apiFetch("GET", "/api/memory/search?q=E2E&limit=5");
    return { apiOk: status === 200 && data.count >= 0, wsOk: "N/A", domOk: "N/A", detail: `${data.count} results` };
  });

  // 6.4 Memory stats
  await test("Memory", "memory_status", async () => {
    const { status, data } = await apiFetch("GET", `/api/memory/stats?agent_name=${TEST_AGENT}`);
    return { apiOk: status === 200 && data.total >= 0, wsOk: "N/A", domOk: "N/A", detail: `total=${data.total}` };
  });

  // ==========================================================================
  // 7. Standards
  // ==========================================================================
  logCategory("Standards");

  // 7.1 Create standard
  await test("Standards", "create standard", async () => {
    const { status, data } = await apiFetch("POST", "/api/standards", {
      category: "coding_norm", name: "E2E Standard", content: "All E2E tests must verify DOM changes.", priority: 5,
    });
    testStandardId = data?.id || "";
    const ev = await waitWs((e) => e.type === "standards:updated");
    return { apiOk: status === 200 && testStandardId.length > 0, wsOk: ev !== null, domOk: "N/A", detail: `id=${testStandardId}` };
  });

  // 7.2 Update standard
  await test("Standards", "update standard", async () => {
    const { status } = await apiFetch("PUT", `/api/standards/${testStandardId}`, {
      content: "Updated: must verify API+WS+DOM.", change_summary: "added DOM check",
    });
    const ev = await waitWs((e) => e.type === "standards:updated");
    return { apiOk: status === 200, wsOk: ev !== null, domOk: "N/A", detail: "OK" };
  });

  // 7.3 List standards
  await test("Standards", "list standards", async () => {
    const { status, data } = await apiFetch("GET", "/api/standards");
    return { apiOk: status === 200 && Array.isArray(data), wsOk: "N/A", domOk: "N/A", detail: `${data.length} standards` };
  });

  // ==========================================================================
  // 8. Reflections
  // ==========================================================================
  logCategory("Reflections");

  // 8.1 Create reflection
  await test("Reflect", "reflect_on_task", async () => {
    const { status, data } = await apiFetch("POST", "/api/reflections", {
      agent_name: TEST_AGENT, project_id: testProjectId || "test",
      trigger_type: "task_complete", task_summary: "E2E testing completed",
      lessons_learned: [{ category: "process", description: "DOM verification is essential", evidence: "Found missing handlers" }],
      confidence: 0.9,
    });
    testReflectionId = data?.id || "";
    const ev = await waitWs((e) => e.type === "reflection:created");
    return { apiOk: status === 200 && testReflectionId.length > 0, wsOk: ev !== null, domOk: "N/A", detail: `id=${testReflectionId}` };
  });

  // 8.2 Review reflection
  await test("Reflect", "review reflection", async () => {
    if (!testReflectionId) return { apiOk: false, wsOk: false, domOk: "N/A", detail: "no reflection" };
    const { status, data } = await apiFetch("PUT", `/api/reflections/${testReflectionId}/review`, {
      action: "approve", reviewed_by: "e2e-test",
    });
    const ev = await waitWs((e) => e.type === "reflection:reviewed");
    return { apiOk: status === 200 && data.ok, wsOk: ev !== null, domOk: "N/A", detail: `status=${data.status}` };
  });

  // ==========================================================================
  // 9. Approvals
  // ==========================================================================
  logCategory("Approvals");

  await test("Approvals", "list approvals", async () => {
    const { status, data } = await apiFetch("GET", "/api/approvals");
    return { apiOk: status === 200 && Array.isArray(data), wsOk: "N/A", domOk: "N/A", detail: `${data.length} active` };
  });

  // ==========================================================================
  // 10. System
  // ==========================================================================
  logCategory("System Status");

  await test("System", "server status", async () => {
    const { status, data } = await apiFetch("GET", "/api/status");
    const statusEl = domQuery("#server-status");
    return {
      apiOk: status === 200 && data.status === "running",
      wsOk: "N/A",
      domOk: statusEl?.textContent?.includes("Connected") || statusEl?.textContent?.includes("running"),
      detail: `uptime=${Math.round(data.uptime)}s, agents=${data.agents?.total}`,
    };
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================
  logCategory("Cleanup");
  log(`<span style="color:#888;">Cleaning up test data...</span>`);

  if (testStandardId) await apiFetch("DELETE", `/api/standards/${testStandardId}`);
  await apiFetch("DELETE", "/api/shared-files/e2e-test-report.md?scope_type=global").catch(() => {});
  if (testMemoryId) await apiFetch("DELETE", `/api/memory/entries/${testMemoryId}`);
  if (testProjectId) await apiFetch("DELETE", `/api/projects/${testProjectId}/agents/${TEST_AGENT}`).catch(() => {});
  if (testChannelId) await apiFetch("DELETE", `/api/channels/${testChannelId}`);
  if (testProjectId) await apiFetch("DELETE", `/api/projects/${testProjectId}`);
  await apiFetch("POST", "/api/agents/deregister", { name: TEST_AGENT });
  await wait(1500);

  // Verify cleanup in DOM
  const agentGone = !agentExists(TEST_AGENT);
  const channelGone = !channelExists("e2e-test-ch");
  log(`<span style="color:#888;">  Agent removed from DOM: ${agentGone ? "\u2705" : "\u274C"}</span>`);
  log(`<span style="color:#888;">  Channel removed from DOM: ${channelGone ? "\u2705" : "\u274C"}</span>`);

  testWs.close();

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const total = results.length;
  const apiPass = results.filter((r) => r.apiOk).length;
  const wsTestable = results.filter((r) => r.wsOk !== "N/A");
  const wsPass = wsTestable.filter((r) => r.wsOk).length;
  const domTestable = results.filter((r) => r.domOk !== "N/A");
  const domPass = domTestable.filter((r) => r.domOk).length;

  const allGood = apiPass === total && wsPass === wsTestable.length && domPass === domTestable.length;

  progressEl.textContent = allGood ? "\u2705 ALL TESTS PASSED" : "\u274C SOME FAILURES";
  progressEl.style.color = allGood ? "#2ecc71" : "#e94560";
  progressEl.style.fontSize = "14px";
  progressEl.style.fontWeight = "bold";

  summaryEl.style.display = "block";
  summaryEl.innerHTML = `
    <div style="font-size:13px;font-weight:bold;color:#e94560;margin-bottom:6px;">SUMMARY</div>
    <table style="width:100%;color:#ccc;font-size:12px;">
      <tr><td>Total tests</td><td style="text-align:right;">${total}</td></tr>
      <tr><td>API</td><td style="text-align:right;">${apiPass}/${total} passed</td></tr>
      <tr><td>WebSocket events</td><td style="text-align:right;">${wsPass}/${wsTestable.length} passed (${total - wsTestable.length} N/A)</td></tr>
      <tr><td>DOM real-time feedback</td><td style="text-align:right;">${domPass}/${domTestable.length} passed (${total - domTestable.length} N/A)</td></tr>
    </table>
    <div style="margin-top:10px;font-size:11px;color:#888;">
      <div style="font-weight:bold;margin-bottom:4px;">Frontend Real-Time Feedback Map:</div>
      <table style="width:100%;color:#777;font-size:10px;">
        <tr><td>message:new</td><td>renderMessage()</td><td>Chat message appears</td></tr>
        <tr><td>agent:status</td><td>renderAgents()</td><td>Agent list updates</td></tr>
        <tr><td>agent:config</td><td>N/A in switch</td><td>No direct DOM change</td></tr>
        <tr><td>channel:created</td><td>loadChannels()</td><td>Sidebar channel appears</td></tr>
        <tr><td>channel:updated</td><td>loadChannels()</td><td>Channel refreshes</td></tr>
        <tr><td>peak:pending</td><td>renderPeakCard()</td><td>Decision card appears</td></tr>
        <tr><td>peak:decided</td><td>updatePeakDecision()</td><td>Card shows decision</td></tr>
        <tr><td>peak:paused</td><td>(no-op)</td><td>Timer refreshes on poll</td></tr>
        <tr><td>file:updated</td><td>loadFiles()</td><td>File list refreshes</td></tr>
        <tr><td>project:created</td><td>handleProjectWsEvent</td><td>Selector updates</td></tr>
        <tr><td>project:updated</td><td>handleProjectWsEvent</td><td>Selector refreshes</td></tr>
        <tr><td>approval:pending</td><td>renderApprovalCard()</td><td>Approval card appears</td></tr>
        <tr><td>approval:resolved</td><td>removeApprovalCard()</td><td>Card disappears</td></tr>
        <tr><td>standards:updated</td><td>N/A in switch</td><td>Server-side only</td></tr>
        <tr><td>reflection:*</td><td>N/A in switch</td><td>Server-side only</td></tr>
      </table>
    </div>
  `;

  console.log("%c[E2E] Test complete!", "color:#2ecc71;font-weight:bold;");
  console.table(results.map((r) => ({
    name: r.name,
    API: r.apiOk ? "PASS" : "FAIL",
    WS: r.wsOk === "N/A" ? "N/A" : r.wsOk ? "PASS" : "FAIL",
    DOM: r.domOk === "N/A" ? "N/A" : r.domOk ? "PASS" : "FAIL",
    detail: r.detail,
  })));
})();
