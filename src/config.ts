/**
 * Config layer — Step 2
 *
 * Loads configuration from three sources in priority order:
 *   1. Built-in defaults (lowest priority)
 *   2. User config at ~/.config/terminal-agent/config.json
 *   3. Project config at ./.agent/config.json (highest priority)
 *
 * Missing files are silently ignored. The merged result is validated
 * with Zod before being returned, so callers always get a typed Config.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod/v4';

// ── Schema ────────────────────────────────────────────────────────────────────

/** One of the three tool-approval policies the harness permission system recognises. */
const PermissionPolicySchema = z.enum(['allow', 'ask', 'deny']);

/** A single MCP stdio server entry as it appears in config.json. */
const McpServerSchema = z.object({
  /** Executable to spawn (e.g. "npx", "/usr/local/bin/my-server"). */
  command: z.string(),
  /** Arguments forwarded to the command. */
  args: z.array(z.string()).default([]),
  /** Optional extra environment variables for the server process. */
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * Full validated config shape.
 * Every field has a sensible default so a completely empty config.json works fine.
 */
const ConfigSchema = z.object({
  /** Default model ID used when no per-mode override is set. */
  model: z.string().default('anthropic/claude-sonnet-4-20250514'),

  /** Per-mode model overrides — only the modes you want to customise need entries. */
  modeModels: z.object({
    chat: z.string().optional(),
    plan: z.string().optional(),
    build: z.string().optional(),
    create_environment: z.string().optional(),
  }).default({}),


  /** Named MCP servers available to agents that opt in. */
  mcpServers: z.record(z.string(), McpServerSchema).default({}),

  /**
   * Tool-category permission policies.
   * - read: file/dir reads, search — safe to allow
   * - edit: file writes/deletes — ask by default
   * - execute: shell commands — ask by default
   * - mcp: MCP server tool calls — ask by default
   */
  permissions: z.object({
    read: PermissionPolicySchema.default('allow'),
    edit: PermissionPolicySchema.default('ask'),
    execute: PermissionPolicySchema.default('ask'),
    mcp: PermissionPolicySchema.default('ask'),
  }),

  /** Root directory where user-authored extension agents/tools live. */
  extensionsDir: z.string().default(
    join(homedir(), '.config', 'terminal-agent', 'extensions'),
  ),

  /**
   * Model used by the dynamic reviewer.
   * Defaults to a small/fast model — the reviewer only needs to classify output,
   * not produce complex reasoning.
   */
  reviewerModel: z.string().default('anthropic/claude-haiku-4-5-20251001'),
});

// ── Exported types ────────────────────────────────────────────────────────────

export type Config = z.infer<typeof ConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reads a JSON file, returning an empty object if the file is missing or unparseable. */
function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Deep-merges two plain-object trees; override wins on scalar conflicts. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override ?? base;
  if (typeof override !== 'object' || override === null || Array.isArray(override)) return override ?? base;
  const result: Record<string, unknown> = { ...base as Record<string, unknown> };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    result[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Loads and validates the merged configuration.
 * Call this once at startup; the result is immutable for the process lifetime.
 */
export async function loadConfig(): Promise<Config> {
  const userConfigPath = join(homedir(), '.config', 'terminal-agent', 'config.json');
  const projectConfigPath = join(process.cwd(), '.agent', 'config.json');

  const userConfig = readJsonSafe(userConfigPath);
  const projectConfig = readJsonSafe(projectConfigPath);

  // Layer: defaults → user config → project config
  const merged = deepMerge(deepMerge({}, userConfig), projectConfig);
  return ConfigSchema.parse(merged);
}
