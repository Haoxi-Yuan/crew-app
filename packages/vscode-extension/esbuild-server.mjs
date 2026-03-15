import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(__dirname, "..", "server");
const mcpBridgeSrc = path.resolve(__dirname, "..", "mcp-bridge");

const commonBanner = 'import{createRequire as __cr}from"module";import{fileURLToPath as __fu}from"url";import{dirname as __dn}from"path";const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);';

// Server bundle: all deps except better-sqlite3 (native addon)
await esbuild.build({
  entryPoints: [path.join(serverSrc, "dist", "index.js")],
  bundle: true,
  outfile: path.join(__dirname, "server-dist", "server-bundle.mjs"),
  external: ["better-sqlite3"],
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: true,
  banner: { js: commonBanner },
});
console.log("Server bundle complete.");

// MCP bridge: standalone executable (launched as child process by agents)
await esbuild.build({
  entryPoints: [path.join(mcpBridgeSrc, "dist", "index.js")],
  bundle: true,
  outfile: path.join(__dirname, "server-dist", "mcp", "bridge.mjs"),
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: true,
  banner: { js: commonBanner },
});
console.log("MCP bridge bundle complete.");

// MCP tool-memory: standalone executable
await esbuild.build({
  entryPoints: [path.join(mcpBridgeSrc, "dist", "tool-memory.js")],
  bundle: true,
  outfile: path.join(__dirname, "server-dist", "mcp", "tool-memory.mjs"),
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: true,
  banner: { js: commonBanner },
});
console.log("MCP tool-memory bundle complete.");
