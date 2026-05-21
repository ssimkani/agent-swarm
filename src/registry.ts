/**
 * Extension registry — Step 5
 *
 * Scans the user's extensions directory for hand-authored agents and tools,
 * dynamically imports each file using tsx (so plain TypeScript files work
 * without a separate build step), validates the default export against the
 * expected shape, and returns a registry object consumed by the Harness.
 *
 * Directory layout the registry expects:
 *   <extensionsDir>/
 *     agents/   ← each .ts file default-exports an Agent
 *     tools/    ← each .ts file default-exports a Tool (createTool result)
 *
 * The registry exposes a `reload()` method so /create_environment can refresh
 * after writing a new file, without restarting the process.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Agent } from '@mastra/core/agent';
import type { ToolAction } from '@mastra/core/tools';
import type { Config } from './config.js';

// ── Public types ──────────────────────────────────────────────────────────────

/** A validated agent loaded from the extensions directory. */
export interface AgentDef {
  /** Derived from the filename, e.g. "my-agent" from my-agent.ts */
  id: string;
  /** The live Agent instance */
  agent: Agent;
}

/** A validated tool loaded from the extensions directory. */
export interface ToolDef {
  /** Derived from the filename */
  id: string;
  /** The live Tool instance */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: ToolAction<any, any>;
  /**
   * Category hint from the tool file's optional named export `category`.
   * Maps to the Harness ToolCategory for permission resolution.
   */
  category?: 'read' | 'edit' | 'execute' | 'mcp' | 'other';
}

/** The fully loaded registry returned to the Harness factory. */
export interface Registry {
  agents: AgentDef[];
  tools: ToolDef[];
  /** Re-scans the extensions directory and refreshes agents + tools in place. */
  reload(): Promise<void>;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Dynamically imports a single extension file using tsx's module loader.
 *
 * tsx is registered as a Node loader so TypeScript files are transpiled on
 * the fly. The cache-busting `?t=` query prevents Node from serving a stale
 * cached module after the file has been edited.
 */
async function importExtension(filePath: string): Promise<unknown> {
  const url = pathToFileURL(filePath).href + `?t=${Date.now()}`;
  try {
    return await import(url);
  } catch (err) {
    console.warn(`[registry] Failed to import ${filePath}:`, err);
    return null;
  }
}

/** Returns true when the value looks like a Mastra Agent instance. */
function isAgent(value: unknown): value is Agent {
  return (
    typeof value === 'object' &&
    value !== null &&
    // Mastra agents expose these methods
    typeof (value as Record<string, unknown>).generate === 'function'
  );
}

/** Returns true when the value looks like a Mastra Tool (createTool result). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTool(value: unknown): value is ToolAction<any, any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).description === 'string'
  );
}

/**
 * Scans a directory for .ts files and loads them as a typed list.
 * Files that fail to import or fail the type guard are skipped with a warning.
 */
async function scanDirectory<T>(
  dir: string,
  guard: (v: unknown) => v is T,
  label: string,
): Promise<Array<{ id: string; value: T; category?: string }>> {
  if (!existsSync(dir)) return [];

  const results: Array<{ id: string; value: T; category?: string }> = [];
  const files = readdirSync(dir).filter(f => extname(f) === '.ts');

  for (const file of files) {
    const filePath = join(dir, file);
    const mod = await importExtension(filePath);
    if (!mod) continue;

    const record = mod as Record<string, unknown>;
    const defaultExport = record['default'];

    if (!guard(defaultExport)) {
      console.warn(`[registry] ${label} ${file}: default export is not a valid ${label} — skipped`);
      continue;
    }

    results.push({
      id: basename(file, extname(file)),
      value: defaultExport,
      category: typeof record['category'] === 'string' ? record['category'] : undefined,
    });
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Loads the full extension registry from `config.extensionsDir`.
 *
 * Empty extensions directory → `{ agents: [], tools: [] }` (no error).
 * Call `registry.reload()` after writing new extension files to pick them up
 * without restarting the process.
 */
export async function loadRegistry(config: Config): Promise<Registry> {
  const agentsDir = join(config.extensionsDir, 'agents');
  const toolsDir = join(config.extensionsDir, 'tools');

  let agents: AgentDef[] = [];
  let tools: ToolDef[] = [];

  async function load() {
    const rawAgents = await scanDirectory(agentsDir, isAgent, 'agent');
    const rawTools = await scanDirectory(toolsDir, isTool, 'tool');

    agents = rawAgents.map(({ id, value }) => ({ id, agent: value }));
    tools = rawTools.map(({ id, value, category }) => ({
      id,
      tool: value,
      category: category as ToolDef['category'],
    }));
  }

  await load();

  return {
    get agents() { return agents; },
    get tools() { return tools; },
    async reload() { await load(); },
  };
}
