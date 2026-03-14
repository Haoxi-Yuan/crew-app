import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildToolHandbook,
  buildToolPreflight,
  computePreflightRequirement,
  defineTool,
  type ToolDefinition,
} from "./tool-memory.js";

function makeTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "core_tool",
      description: "Core tool",
      schema: { query: z.string().describe("query") },
      handbook: {
        audience: ["core"],
        priority: "high",
        when_to_use: ["Use for shared work"],
      },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
    defineTool({
      name: "author_tool",
      description: "Author only tool",
      schema: { agent_name: z.string() },
      handbook: {
        audience: ["author"],
        priority: "high",
        when_to_use: ["Use for author workflows"],
      },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
    defineTool({
      name: "integrator_tool",
      description: "Integrator only tool",
      schema: { report: z.string() },
      handbook: {
        audience: ["integrator"],
        priority: "medium",
        when_to_use: ["Use for audit workflows"],
      },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
  ];
}

test("tool handbook filters results by agent profile", () => {
  const tools = makeTools();

  const authorHandbook = buildToolHandbook("author", tools);
  assert.match(authorHandbook.results, /core_tool/);
  assert.match(authorHandbook.results, /author_tool/);
  assert.doesNotMatch(authorHandbook.results, /integrator_tool/);

  const integratorHandbook = buildToolHandbook("integrator", tools);
  assert.match(integratorHandbook.results, /core_tool/);
  assert.match(integratorHandbook.results, /integrator_tool/);
  assert.doesNotMatch(integratorHandbook.results, /author_tool/);

  const coreHandbook = buildToolHandbook("coder", tools);
  assert.match(coreHandbook.results, /core_tool/);
  assert.doesNotMatch(coreHandbook.results, /author_tool/);
  assert.doesNotMatch(coreHandbook.results, /integrator_tool/);
});

test("catalog changes surface changed tools and require a fresh preflight", () => {
  const tools = makeTools();
  const initial = buildToolPreflight("author", tools, null);

  const changedTools = makeTools();
  changedTools[1] = defineTool({
    ...changedTools[1],
    schema: {
      agent_name: z.string(),
      role: z.string().optional(),
    },
  });

  const changed = buildToolPreflight("author", changedTools, initial.state);
  assert.deepEqual(changed.changed_tools, ["author_tool"]);

  const requirement = computePreflightRequirement("author", changedTools, initial.state);
  assert.equal(requirement.required, true);
});

test("valid acknowledged state suppresses preflight until the catalog changes", () => {
  const tools = makeTools();
  const initial = buildToolPreflight("integrator", tools, null);

  const requirement = computePreflightRequirement("integrator", tools, initial.state);
  assert.equal(requirement.required, false);
});
