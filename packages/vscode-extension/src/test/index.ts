/**
 * Mocha test runner for VSCode extension tests.
 */
import * as path from "path";
import Mocha from "mocha";
import * as fs from "fs";

export async function run(): Promise<void> {
  const resultPath = path.resolve(__dirname, "../../e2e-results.json");
  const markerPath = "/tmp/claude-crew-vscode-e2e-markers.log";
  const appendMarker = (message: string): void => {
    fs.appendFileSync(markerPath, `${new Date().toISOString()} ${message}\n`, "utf-8");
  };

  console.log("[test-runner] Starting mocha test runner...");
  console.log("[test-runner] __dirname:", __dirname);
  appendMarker("runner:start");

  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 60000,
    slow: 5000,
    reporter: "spec",
  });

  const testsRoot = path.resolve(__dirname, ".");
  console.log("[test-runner] testsRoot:", testsRoot);

  // Find test files
  const files = fs.readdirSync(testsRoot).filter((f) => f.endsWith(".test.js"));
  console.log("[test-runner] Found test files:", files);

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise((resolve, reject) => {
    try {
      const runner = mocha.run((failures) => {
        console.log(`[test-runner] Completed with ${failures} failures`);

        const results: any[] = [];
        runner.suite.eachTest((t: any) => {
          results.push({
            title: t.fullTitle(),
            state: t.state || "pending",
            duration: t.duration || 0,
            err: t.err?.message || null,
          });
        });
        const summary = {
          total: runner.stats?.tests || 0,
          passes: runner.stats?.passes || 0,
          failures: runner.stats?.failures || 0,
          duration: runner.stats?.duration || 0,
          results,
        };
        fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2));
        console.log(`[test-runner] Results written to ${resultPath}`);
        appendMarker(`runner:complete failures=${failures}`);

        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error("[test-runner] Error:", err);
      appendMarker(`runner:error ${(err as Error).message}`);
      reject(err);
    }
  });
}
