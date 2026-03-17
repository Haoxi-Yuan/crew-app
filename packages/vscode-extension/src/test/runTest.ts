/**
 * VSCode E2E Test Launcher
 *
 * Uses the official @vscode/test-electron harness with a system-installed
 * VSCode CLI to launch an Extension Development Host and run mocha tests.
 */
import * as path from "path";
import * as fs from "fs";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./index.js");
  const resultPath = path.resolve(__dirname, "../../e2e-results.json");
  const markerPath = "/tmp/claude-crew-vscode-e2e-markers.log";

  const executablePaths = [
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  ];

  let vscodeExecutablePath = "";
  for (const p of executablePaths) {
    if (fs.existsSync(p)) { vscodeExecutablePath = p; break; }
  }

  if (!vscodeExecutablePath) {
    console.error("Cannot find a local VSCode executable.");
    process.exit(1);
  }

  fs.rmSync(resultPath, { force: true });
  fs.rmSync(markerPath, { force: true });

  delete process.env.ELECTRON_RUN_AS_NODE;

  console.log("VSCode executable:", vscodeExecutablePath);
  console.log("Extension:", extensionDevelopmentPath);
  console.log("Tests:", extensionTestsPath);
  console.log("Launching Extension Development Host...\n");

  let exitCode = 1;
  try {
    exitCode = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        CLAUDE_CREW_E2E: "1",
        ELECTRON_RUN_AS_NODE: undefined,
      },
      launchArgs: ["--new-window"],
      reuseMachineInstall: false,
    });
  } catch (err) {
    console.error("Test harness error:", err);
    process.exit(1);
  }

  if (!fs.existsSync(resultPath)) {
    console.error(`Missing E2E result file: ${resultPath}`);
    process.exit(1);
  }

  const markerLog = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf-8") : "";
  if (!markerLog.includes("runner:complete")) {
    console.error(`Missing runner completion marker in ${markerPath}`);
    process.exit(1);
  }

  console.log(`\nExit code: ${exitCode}`);
  process.exit(exitCode);
}

main();
