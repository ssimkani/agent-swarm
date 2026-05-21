/**
 * /create_environment meta-tools — Step 11
 *
 * These tools are only available to the router in /create_environment mode.
 * They give the router agent the ability to read, write, and reload extension
 * files (agents and tools) at runtime without restarting the process.
 *
 * Tools defined here:
 *   create_agent      — writes a new agent file from the agent template
 *   edit_agent        — modifies a field in an existing agent file
 *   create_tool       — writes a new tool file from the tool template
 *   edit_tool         — modifies a field in an existing tool file
 *   list_agents       — returns the current registry agent list
 *   list_tools        — returns the current registry tool list
 *   show_registry     — returns a full text summary of the registry
 *   reload_ecosystem  — calls registry.reload() and optionally rebuilds the harness
 *
 * Each tool is created with `createTool` so it integrates with the Harness
 * permission system and shows up in tool-approval prompts.
 */

import { createTool } from '@mastra/core/tools';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { z } from 'zod/v4';
import { renderAgentTemplate } from './templates/agent.template.js';
import { renderToolTemplate } from './templates/tool.template.js';
import type { Registry } from '../registry.js';
import type { Config } from '../config.js';

// ── Helper ────────────────────────────────────────────────────────────────────

/** Ensures a directory exists, creating it recursively if needed. */
function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

/** Reads a file, returning null if it doesn't exist. */
function readFileSafe(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// ── Tool factories ────────────────────────────────────────────────────────────

/**
 * Builds the full set of meta-tools.
 *
 * Accepts the live `registry` and `config` so tools can interact with the
 * extension system state. The `onReload` callback is invoked by
 * `reload_ecosystem` so the harness can be rebuilt after new files are written.
 *
 * @param registry - The live registry (mutated by reload)
 * @param config   - App config (provides extensionsDir and default model)
 * @param onReload - Called after reload; the harness factory uses this to rebuild
 */
export function createEnvironmentTools(
  registry: Registry,
  config: Config,
  onReload: () => Promise<void>,
) {
  const agentsDir = join(config.extensionsDir, 'agents');
  const toolsDir = join(config.extensionsDir, 'tools');

  // ── create_agent ──────────────────────────────────────────────────────────

  const create_agent = createTool({
    id: 'create_agent',
    description: 'Write a new extension agent file to the agents/ directory.',
    inputSchema: z.object({
      /** Filename stem and agent ID, e.g. "summariser" → extensions/agents/summariser.ts */
      name: z.string().describe('Agent name/ID (no extension)'),
      description: z.string().describe('One-line description of what the agent does'),
      instructions: z.string().describe('Full system prompt for the agent'),
      /** Optional model override; falls back to config.model if omitted. */
      defaultModel: z.string().optional().describe('Model ID (uses harness default if omitted)'),
    }),
    execute: async (inputData) => {
      ensureDir(agentsDir);
      const filePath = join(agentsDir, `${inputData.name}.ts`);
      if (existsSync(filePath)) {
        return { success: false, message: `Agent "${inputData.name}" already exists. Use edit_agent to modify it.` };
      }
      const source = renderAgentTemplate(
        inputData.name,
        inputData.description,
        inputData.instructions,
        inputData.defaultModel ?? config.model,
      );
      writeFileSync(filePath, source, 'utf8');
      return { success: true, path: filePath, message: `Created agent "${inputData.name}". Call reload_ecosystem to activate it.` };
    },
  });

  // ── edit_agent ────────────────────────────────────────────────────────────

  const edit_agent = createTool({
    id: 'edit_agent',
    description: 'Modify a field in an existing extension agent file.',
    inputSchema: z.object({
      name: z.string().describe('Agent name (filename stem)'),
      /** The field to change: "instructions", "model", or "description". */
      field: z.enum(['instructions', 'model', 'description']).describe('Which field to update'),
      value: z.string().describe('New value for the field'),
    }),
    execute: async (inputData) => {
      const filePath = join(agentsDir, `${inputData.name}.ts`);
      const source = readFileSafe(filePath);
      if (!source) {
        return { success: false, message: `Agent "${inputData.name}" not found.` };
      }

      let updated = source;
      if (inputData.field === 'instructions') {
        // Replace the template-literal instructions block
        updated = source.replace(
          /instructions:\s*`[^`]*`/s,
          `instructions: \`${inputData.value.replace(/`/g, '\\`')}\``,
        );
      } else if (inputData.field === 'model') {
        updated = source.replace(/model:\s*'[^']*'/, `model: '${inputData.value}'`);
      } else if (inputData.field === 'description') {
        // Update the JSDoc comment at the top of the file
        updated = source.replace(
          /\/\/ .+\n \* .+/,
          `// Extension agent: ${inputData.name}\n * ${inputData.value}`,
        );
      }

      writeFileSync(filePath, updated, 'utf8');
      return { success: true, path: filePath, message: `Updated "${inputData.field}" on agent "${inputData.name}". Call reload_ecosystem to apply.` };
    },
  });

  // ── create_tool ───────────────────────────────────────────────────────────

  const create_tool = createTool({
    id: 'create_tool',
    description: 'Write a new extension tool file to the tools/ directory.',
    inputSchema: z.object({
      name: z.string().describe('Tool name/ID (no extension)'),
      description: z.string().describe('One-line description of what the tool does'),
      /**
       * The full z.object() expression — NOT just the fields inside it.
       * Examples:
       *   no inputs:  z.object({})
       *   one field:  z.object({ url: z.string() })
       *   multiple:   z.object({ query: z.string(), limit: z.number().default(10) })
       */
      inputSchema: z.string().describe('Full z.object() expression for the tool\'s inputs. For no inputs use z.object({}). For inputs: z.object({ fieldName: z.string() }).'),
      /**
       * The async function body inside execute: async (inputData) => { ... }.
       * Access input fields via inputData.fieldName.
       */
      implementation: z.string().describe('Async function body. Access input fields via inputData.fieldName. Must return a plain object or value.'),
      category: z.enum(['read', 'edit', 'execute', 'mcp', 'other'])
        .default('other')
        .describe('Permission category for the tool'),
    }),
    execute: async (inputData) => {
      ensureDir(toolsDir);
      const filePath = join(toolsDir, `${inputData.name}.ts`);
      if (existsSync(filePath)) {
        return { success: false, message: `Tool "${inputData.name}" already exists. Use edit_tool to modify it.` };
      }
      const source = renderToolTemplate(
        inputData.name,
        inputData.description,
        inputData.inputSchema,
        inputData.implementation,
        inputData.category ?? 'other',
      );
      writeFileSync(filePath, source, 'utf8');
      return { success: true, path: filePath, message: `Created tool "${inputData.name}". Call reload_ecosystem to activate it.` };
    },
  });

  // ── edit_tool ─────────────────────────────────────────────────────────────

  const edit_tool = createTool({
    id: 'edit_tool',
    description: 'Modify a field in an existing extension tool file.',
    inputSchema: z.object({
      name: z.string().describe('Tool name (filename stem)'),
      field: z.enum(['description', 'implementation', 'category']).describe('Which field to update'),
      value: z.string().describe('New value for the field'),
    }),
    execute: async (inputData) => {
      const filePath = join(toolsDir, `${inputData.name}.ts`);
      const source = readFileSafe(filePath);
      if (!source) {
        return { success: false, message: `Tool "${inputData.name}" not found.` };
      }

      let updated = source;
      if (inputData.field === 'description') {
        updated = source.replace(
          /description:\s*`[^`]*`/,
          `description: \`${inputData.value.replace(/`/g, '\\`')}\``,
        );
      } else if (inputData.field === 'implementation') {
        // Replace the entire execute body (matches both legacy { context } and current inputData signatures)
        updated = source.replace(
          /execute:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n  \},/,
          `execute: async (inputData) => {\n    ${inputData.value}\n  },`,
        );
      } else if (inputData.field === 'category') {
        updated = source.replace(
          /export const category = '[^']*' as const;/,
          `export const category = '${inputData.value}' as const;`,
        );
      }

      writeFileSync(filePath, updated, 'utf8');
      return { success: true, path: filePath, message: `Updated "${inputData.field}" on tool "${inputData.name}". Call reload_ecosystem to apply.` };
    },
  });

  // ── list_agents ───────────────────────────────────────────────────────────

  const list_agents = createTool({
    id: 'list_agents',
    description: 'List all currently registered extension agents.',
    inputSchema: z.object({}),
    execute: async () => {
      const agents = registry.agents.map(a => ({
        id: a.id,
        name: (a.agent as unknown as Record<string, unknown>).name ?? a.id,
      }));
      return { agents, count: agents.length };
    },
  });

  // ── list_tools ────────────────────────────────────────────────────────────

  const list_tools = createTool({
    id: 'list_tools',
    description: 'List all currently registered extension tools.',
    inputSchema: z.object({}),
    execute: async () => {
      const tools = registry.tools.map(t => ({
        id: t.id,
        description: t.tool.description,
        category: t.category ?? 'other',
      }));
      return { tools, count: tools.length };
    },
  });

  // ── show_registry ─────────────────────────────────────────────────────────

  const show_registry = createTool({
    id: 'show_registry',
    description: 'Return a full text summary of all registered extension agents and tools.',
    inputSchema: z.object({}),
    execute: async () => {
      const agentLines = registry.agents
        .map(a => `  ${a.id}: ${(a.agent as unknown as Record<string, unknown>).name ?? a.id}`)
        .join('\n') || '  (none)';

      const toolLines = registry.tools
        .map(t => `  ${t.id} [${t.category ?? 'other'}]: ${t.tool.description}`)
        .join('\n') || '  (none)';

      return {
        summary: `Agents:\n${agentLines}\n\nTools:\n${toolLines}`,
        agentCount: registry.agents.length,
        toolCount: registry.tools.length,
      };
    },
  });

  // ── reload_ecosystem ──────────────────────────────────────────────────────

  const reload_ecosystem = createTool({
    id: 'reload_ecosystem',
    description: 'Reload the extension registry after creating or editing files. Rebuilds the harness so new agents and tools are immediately available.',
    inputSchema: z.object({}),
    execute: async () => {
      // 1. Rescan the extensions directory
      await registry.reload();
      // 2. Signal the harness factory to rebuild with the updated registry
      await onReload();
      return {
        success: true,
        message: `Registry reloaded. ${registry.agents.length} agent(s), ${registry.tools.length} tool(s) now active.`,
      };
    },
  });

  // ── Exported toolset ──────────────────────────────────────────────────────

  return {
    create_agent,
    edit_agent,
    create_tool,
    edit_tool,
    list_agents,
    list_tools,
    show_registry,
    reload_ecosystem,
  } as const;
}

/** The extension files the registry scans — exported for reference by tests. */
export const EXTENSION_EXTENSIONS: readonly string[] = ['.ts'];

/** Checks whether a filename is a valid extension file. */
export function isExtensionFile(filename: string): boolean {
  return EXTENSION_EXTENSIONS.includes(extname(filename));
}
