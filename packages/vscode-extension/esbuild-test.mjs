import * as esbuild from "esbuild";

// runTest.ts is the launcher - needs @vscode/test-electron external (resolved from node_modules)
await esbuild.build({
  entryPoints: ["src/test/runTest.ts"],
  bundle: true,
  outdir: "dist/test",
  external: ["@vscode/test-electron"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
});

// index.ts and test files run inside VSCode - bundle everything except vscode
await esbuild.build({
  entryPoints: ["src/test/index.ts", "src/test/extension.test.ts"],
  bundle: true,
  outdir: "dist/test",
  external: ["vscode", "mocha"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
});

console.log("Test build complete.");
