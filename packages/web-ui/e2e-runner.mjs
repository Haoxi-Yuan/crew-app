/**
 * Puppeteer E2E Runner
 *
 * Launches a real browser, opens the Claude Crew page,
 * injects e2e-test.js, and collects results from the console.
 *
 * Usage: node packages/web-ui/e2e-runner.mjs
 */
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_SCRIPT_PATH = path.join(__dirname, "e2e-test.js");
const PAGE_URL = "http://127.0.0.1:3140";
const TIMEOUT_MS = 120_000; // 2 min total timeout

async function run() {
  console.log("[runner] Launching browser...");
  const browser = await puppeteer.launch({
    headless: false, // Show the browser so user can see real-time feedback
    defaultViewport: { width: 1600, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Collect console.table output for final results
  const consoleResults = [];
  let testComplete = false;

  page.on("console", (msg) => {
    const text = msg.text();
    // Forward all console messages
    if (text.includes("[E2E]")) {
      console.log(`[browser] ${text}`);
      testComplete = true;
    } else if (msg.type() === "table") {
      // console.table is logged as 'table' type
      consoleResults.push(text);
    } else if (msg.type() === "log" || msg.type() === "error") {
      // Log errors and important messages
      if (text.includes("Error") || text.includes("FAIL") || text.includes("PASS")) {
        console.log(`[browser] ${text}`);
      }
    }
  });

  page.on("pageerror", (err) => {
    console.error(`[browser error] ${err.message}`);
  });

  console.log(`[runner] Navigating to ${PAGE_URL}...`);
  await page.goto(PAGE_URL, { waitUntil: "networkidle0", timeout: 30000 });

  // Wait for page to be fully loaded (check for key elements)
  await page.waitForSelector("#agent-list", { timeout: 10000 });
  await page.waitForSelector("#channel-list", { timeout: 10000 });
  console.log("[runner] Page loaded. Waiting 2s for WebSocket to connect...");
  await new Promise((r) => setTimeout(r, 2000));

  // Read and inject the e2e test script
  console.log("[runner] Injecting e2e-test.js...");
  const testScript = fs.readFileSync(E2E_SCRIPT_PATH, "utf-8");
  await page.evaluate(testScript);

  // Wait for test completion
  console.log("[runner] Tests running in browser. Watching for completion...");
  const startTime = Date.now();

  while (!testComplete && Date.now() - startTime < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 1000));

    // Check if the overlay summary is visible
    const summaryVisible = await page.evaluate(() => {
      const el = document.getElementById("e2e-summary");
      return el && el.style.display !== "none";
    });

    if (summaryVisible) {
      testComplete = true;
    }
  }

  if (!testComplete) {
    console.error("[runner] Timeout waiting for tests to complete!");
  }

  // Extract results from the page
  console.log("\n[runner] Extracting results from browser...\n");

  const results = await page.evaluate(() => {
    // The e2e-test.js IIFE stores results in closure, but we can scrape from DOM
    const logEl = document.getElementById("e2e-log");
    const summaryEl = document.getElementById("e2e-summary");
    const progressEl = document.getElementById("e2e-progress");

    const logLines = [];
    if (logEl) {
      for (const child of logEl.children) {
        logLines.push(child.textContent || "");
      }
    }

    return {
      progress: progressEl?.textContent || "",
      log: logLines,
      summary: summaryEl?.textContent || "",
    };
  });

  // Print results
  console.log("=".repeat(100));
  console.log("              CLAUDE CREW E2E TEST REPORT (Browser-based)");
  console.log("=".repeat(100));

  for (const line of results.log) {
    if (line.trim()) console.log("  " + line);
  }

  console.log("\n" + "=".repeat(100));
  console.log("RESULT: " + results.progress);
  console.log("=".repeat(100));

  if (results.summary) {
    console.log("\n" + results.summary);
  }

  // Take a screenshot
  const screenshotPath = path.join(__dirname, "e2e-result-screenshot.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`\n[runner] Screenshot saved to: ${screenshotPath}`);

  // Wait a bit so user can see the results in browser
  console.log("[runner] Keeping browser open for 10s for inspection...");
  await new Promise((r) => setTimeout(r, 10000));

  await browser.close();
  console.log("[runner] Done.");

  // Exit with appropriate code
  const allPassed = results.progress.includes("ALL TESTS PASSED");
  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error("[runner] Fatal:", err);
  process.exit(2);
});
