import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type ToolProfile = "core" | "author" | "integrator";
export type ToolPriority = "high" | "medium" | "low";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface HandbookExample {
  title: string;
  invocation: string;
  notes?: string;
}

export interface ToolHandbookMeta {
  audience: ToolProfile[];
  priority: ToolPriority;
  when_to_use: string[];
  when_not_to_use?: string[];
  examples?: HandbookExample[];
  pitfalls?: string[];
  related_tools?: string[];
  recovery_notes?: string[];
  keywords?: string[];
}

export interface ToolDefinition<TSchema extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: TSchema;
  handbook: ToolHandbookMeta;
  handler: (args: any) => Promise<ToolResult>;
}

export interface ToolMemoryState {
  agent_name: string;
  profile: ToolProfile;
  handbook_version: string;
  catalog_hash: string;
  last_preflight_at: string;
  last_preflight_summary_hash: string;
  changed_tools_seen: string[];
  tool_hashes: Record<string, string>;
}

export interface ToolPreflightPayload {
  profile: ToolProfile;
  handbook_version: string;
  changed_tools: string[];
  summary: string;
  state: ToolMemoryState;
}

export interface ToolHandbookPayload {
  handbook_version: string;
  results: string;
}

interface ToolCatalogEntry {
  name: string;
  description: string;
  params: Array<{ name: string; type: string; required: boolean; description?: string }>;
  handbook: ToolHandbookMeta;
  fingerprint: string;
}

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BRIDGE_DIR, "../../..");

export const TOOL_HANDBOOK_VERSION = "2026-03-14.1";
export const TOOL_BOOTSTRAP_ALLOWLIST = new Set([
  "check_mentions",
  "read_chat",
  "load_worklog",
  "tool_preflight",
  "tool_handbook",
]);

export function defineTool<TSchema extends z.ZodRawShape>(definition: ToolDefinition<TSchema>): ToolDefinition<TSchema> {
  return definition;
}

export function getToolProfile(agentName: string): ToolProfile {
  if (agentName === "author") return "author";
  if (agentName === "integrator") return "integrator";
  return "core";
}

export function preflightRequiredForAgent(agentName: string): boolean {
  return agentName === "author" || agentName === "integrator";
}

export function loadToolMemoryState(agentName: string): ToolMemoryState | null {
  const statePath = getToolMemoryStatePath(agentName);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as ToolMemoryState;
  } catch {
    return null;
  }
}

export function saveToolMemoryState(agentName: string, state: ToolMemoryState): void {
  const statePath = getToolMemoryStatePath(agentName);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function buildToolPreflight(
  agentName: string,
  tools: ToolDefinition[],
  previousState?: ToolMemoryState | null,
): ToolPreflightPayload {
  const profile = getToolProfile(agentName);
  const catalog = getCatalogForProfile(tools, profile);
  const toolHashes = Object.fromEntries(catalog.map((entry) => [entry.name, entry.fingerprint]));
  const changedTools = diffToolCatalog(previousState?.tool_hashes || {}, toolHashes);
  const summary = formatPreflightSummary(profile, catalog, changedTools);
  const state: ToolMemoryState = {
    agent_name: agentName,
    profile,
    handbook_version: TOOL_HANDBOOK_VERSION,
    catalog_hash: computeCatalogHash(catalog),
    last_preflight_at: new Date().toISOString(),
    last_preflight_summary_hash: hashText(summary),
    changed_tools_seen: changedTools,
    tool_hashes: toolHashes,
  };
  return {
    profile,
    handbook_version: TOOL_HANDBOOK_VERSION,
    changed_tools: changedTools,
    summary,
    state,
  };
}

export function buildToolHandbook(
  agentName: string,
  tools: ToolDefinition[],
  options?: { query?: string; tool_names?: string[]; include_examples?: boolean },
): ToolHandbookPayload {
  const profile = getToolProfile(agentName);
  const catalog = getCatalogForProfile(tools, profile);
  const requestedNames = new Set((options?.tool_names || []).map((name) => name.trim()).filter(Boolean));

  let selected = catalog;
  if (requestedNames.size > 0) {
    selected = catalog.filter((entry) => requestedNames.has(entry.name));
  } else if (options?.query) {
    const tokens = tokenize(options.query);
    selected = catalog
      .map((entry) => ({ entry, score: scoreToolEntry(entry, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || priorityWeight(b.entry.handbook.priority) - priorityWeight(a.entry.handbook.priority))
      .map((item) => item.entry)
      .slice(0, 6);
  } else {
    selected = catalog
      .slice()
      .sort((a, b) => priorityWeight(b.handbook.priority) - priorityWeight(a.handbook.priority) || a.name.localeCompare(b.name))
      .slice(0, 10);
  }

  if (selected.length === 0) {
    const fallback = requestedNames.size > 0
      ? `No handbook entries found for: ${Array.from(requestedNames).join(", ")}.`
      : options?.query
        ? `No handbook entries matched "${options.query}".`
        : "No handbook entries available.";
    return { handbook_version: TOOL_HANDBOOK_VERSION, results: fallback };
  }

  const lines = selected.flatMap((entry) => formatHandbookEntry(entry, options?.include_examples ?? false));
  return {
    handbook_version: TOOL_HANDBOOK_VERSION,
    results: lines.join("\n"),
  };
}

export function computePreflightRequirement(
  agentName: string,
  tools: ToolDefinition[],
  previousState?: ToolMemoryState | null,
): { required: boolean; profile: ToolProfile; catalogHash: string } {
  const profile = getToolProfile(agentName);
  if (!preflightRequiredForAgent(agentName)) {
    return { required: false, profile, catalogHash: computeCatalogHash(getCatalogForProfile(tools, profile)) };
  }
  const catalogHash = computeCatalogHash(getCatalogForProfile(tools, profile));
  if (!previousState) return { required: true, profile, catalogHash };
  if (previousState.profile !== profile) return { required: true, profile, catalogHash };
  if (previousState.handbook_version !== TOOL_HANDBOOK_VERSION) return { required: true, profile, catalogHash };
  if (previousState.catalog_hash !== catalogHash) return { required: true, profile, catalogHash };
  return { required: false, profile, catalogHash };
}

function getToolMemoryStatePath(agentName: string): string {
  const agentDir = process.env.CLAUDE_CREW_AGENT_DIR || path.join(REPO_ROOT, "agents", agentName);
  return path.join(agentDir, ".crew", "tool-memory-state.json");
}

function getCatalogForProfile(tools: ToolDefinition[], profile: ToolProfile): ToolCatalogEntry[] {
  return tools
    .filter((tool) => tool.handbook.audience.includes("core") || tool.handbook.audience.includes(profile))
    .map((tool) => {
      const params = summarizeSchema(tool.schema);
      const fingerprint = hashText(JSON.stringify({
        name: tool.name,
        description: tool.description,
        params,
        handbook: tool.handbook,
        handbook_version: TOOL_HANDBOOK_VERSION,
      }));
      return {
        name: tool.name,
        description: tool.description,
        params,
        handbook: tool.handbook,
        fingerprint,
      };
    });
}

function summarizeSchema(schema: z.ZodRawShape): Array<{ name: string; type: string; required: boolean; description?: string }> {
  return Object.entries(schema).map(([name, value]) => ({
    name,
    type: describeZodType(value),
    required: !value.isOptional(),
    description: value.description,
  }));
}

function describeZodType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    const inner = (schema._def as { innerType?: z.ZodTypeAny }).innerType;
    return inner ? describeZodType(inner) : "unknown";
  }
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return `enum(${schema.options.join(" | ")})`;
  if (schema instanceof z.ZodArray) return `array<${describeZodType(schema.element)}>`;
  if (schema instanceof z.ZodObject) return "object";
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  return schema._def.typeName || "unknown";
}

function formatPreflightSummary(profile: ToolProfile, catalog: ToolCatalogEntry[], changedTools: string[]): string {
  const focus = catalog
    .slice()
    .sort((a, b) => priorityWeight(b.handbook.priority) - priorityWeight(a.handbook.priority) || a.name.localeCompare(b.name))
    .slice(0, 8);
  const lines = [
    `Profile: ${profile}`,
    `Handbook version: ${TOOL_HANDBOOK_VERSION}`,
    changedTools.length > 0 ? `Changed tools since last acknowledged version: ${changedTools.join(", ")}` : "Changed tools since last acknowledged version: none",
    "",
    "Priority tool briefing:",
  ];
  for (const entry of focus) {
    const params = entry.params.length > 0
      ? entry.params.map((param) => `${param.name}: ${param.type}${param.required ? "" : "?"}`).join(", ")
      : "no parameters";
    lines.push(`- ${entry.name}(${params})`);
    if (entry.handbook.when_to_use[0]) lines.push(`  Use: ${entry.handbook.when_to_use[0]}`);
    if (entry.handbook.pitfalls?.[0]) lines.push(`  Watch: ${entry.handbook.pitfalls[0]}`);
    if (entry.handbook.recovery_notes?.[0]) lines.push(`  Recovery: ${entry.handbook.recovery_notes[0]}`);
  }
  lines.push("", "If any tool usage is unclear, call tool_handbook(query or tool_names) before retrying.");
  return lines.join("\n");
}

function formatHandbookEntry(entry: ToolCatalogEntry, includeExamples: boolean): string[] {
  const lines = [
    `## ${entry.name}`,
    entry.description,
    `Priority: ${entry.handbook.priority}`,
    `Parameters: ${entry.params.length > 0 ? entry.params.map((param) => `${param.name}: ${param.type}${param.required ? "" : "?"}${param.description ? ` (${param.description})` : ""}`).join("; ") : "none"}`,
    `When to use: ${entry.handbook.when_to_use.join(" | ")}`,
  ];
  if (entry.handbook.when_not_to_use?.length) {
    lines.push(`When not to use: ${entry.handbook.when_not_to_use.join(" | ")}`);
  }
  if (entry.handbook.pitfalls?.length) {
    lines.push(`Pitfalls: ${entry.handbook.pitfalls.join(" | ")}`);
  }
  if (entry.handbook.related_tools?.length) {
    lines.push(`Related tools: ${entry.handbook.related_tools.join(", ")}`);
  }
  if (entry.handbook.recovery_notes?.length) {
    lines.push(`Recovery notes: ${entry.handbook.recovery_notes.join(" | ")}`);
  }
  if (includeExamples && entry.handbook.examples?.length) {
    for (const example of entry.handbook.examples) {
      lines.push(`Example - ${example.title}: ${example.invocation}${example.notes ? ` | ${example.notes}` : ""}`);
    }
  }
  lines.push("");
  return lines;
}

function diffToolCatalog(previous: Record<string, string>, current: Record<string, string>): string[] {
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return Array.from(names)
    .filter((name) => previous[name] !== current[name])
    .sort((a, b) => a.localeCompare(b));
}

function computeCatalogHash(catalog: ToolCatalogEntry[]): string {
  return hashText(JSON.stringify(catalog.map((entry) => ({
    name: entry.name,
    description: entry.description,
    params: entry.params,
    handbook: entry.handbook,
    fingerprint: entry.fingerprint,
  }))));
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_:-]+/).filter(Boolean);
}

function scoreToolEntry(entry: ToolCatalogEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = [
    entry.name,
    entry.description,
    ...entry.handbook.when_to_use,
    ...(entry.handbook.when_not_to_use || []),
    ...(entry.handbook.pitfalls || []),
    ...(entry.handbook.related_tools || []),
    ...(entry.handbook.keywords || []),
  ].join(" ").toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function priorityWeight(priority: ToolPriority): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}
