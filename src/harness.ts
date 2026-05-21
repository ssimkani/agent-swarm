/**
 * Harness factory — Step 9
 *
 * Central assembly point. Takes config, registry, and MCP toolsets and returns
 * a fully configured Harness instance ready for `init()`.
 *
 * Responsibilities:
 *   1. Build four modes (chat / plan / build / create_environment), each
 *      backed by the matching router agent variant.
 *   2. Register all four subagent types with the Harness's built-in subagent tool.
 *   3. Wire permission policies from config.
 *   4. Expose /create_environment meta-tools to all agents (the router's
 *      instructions gate which mode may actually call them).
 *   5. On reload_ecosystem, build a fresh Harness and call `onHarnessRebuilt`
 *      so the CLI can swap its `activeHarness` reference without restarting.
 *
 * Dynamic review:
 *   The dynamic reviewer agent (src/agents/dynamic.ts) is intentionally not
 *   wired here yet. It will be connected when re-enabled.
 */

import { Harness } from '@mastra/core/harness';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v4';
import type { ToolCategory, PermissionPolicy } from '@mastra/core/harness';
import type { ToolAction } from '@mastra/core/tools';
import type { Config } from './config.js';
import type { Registry } from './registry.js';
import type { McpToolsets } from './mcp.js';
import { resolveModel } from './models.js';
import { createStorage, createMemory } from './workspace.js';
import { createRouterAgents, subagentDefinitions } from './agents/router.js';
import { createEnvironmentTools } from './tools/create-environment.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Everything createHarness needs to initialise the system. */
export interface HarnessFactoryInput {
  config: Config;
  registry: Registry;
  mcp: McpToolsets;
  /**
   * Called after reload_ecosystem builds and initialises a fresh Harness.
   * The CLI uses this to swap its `activeHarness` reference in-place so the
   * TUI continues working with the new agents/tools without a full restart.
   */
  onHarnessRebuilt?: (newHarness: Harness) => Promise<void>;
}

// ── Permission policy bridging ────────────────────────────────────────────────

/**
 * Maps the config permission strings to the Harness PermissionPolicy type.
 * Both use the same string literals; this cast makes the dependency explicit.
 */
function toPermissionPolicy(p: string): PermissionPolicy {
  return p as PermissionPolicy;
}

// ── Tool category resolver ────────────────────────────────────────────────────

/**
 * Tells the Harness which permission bucket each tool name belongs to.
 *
 * Resolution order:
 *   1. MCP tools — name contains "__" (e.g. "github__create_issue")
 *   2. Extension tools — explicit `category` export from the tool file
 *   3. Workspace tools — conventional prefixes (fs_, read_, write_, exec_, …)
 *   4. Everything else — null (Harness treats as 'other')
 */
function buildToolCategoryResolver(registry: Registry) {
  const toolCategoryMap = new Map<string, ToolCategory>(
    registry.tools
      .filter(t => t.category)
      .map(t => [t.id, t.category as ToolCategory]),
  );

  return (toolName: string): ToolCategory | null => {
    if (toolName.includes('__')) return 'mcp';
    if (toolCategoryMap.has(toolName)) return toolCategoryMap.get(toolName)!;
    if (toolName.startsWith('fs_') || toolName.startsWith('read_')) return 'read';
    if (toolName.startsWith('write_') || toolName.startsWith('edit_') || toolName.startsWith('delete_')) return 'edit';
    if (toolName.startsWith('exec_') || toolName.startsWith('run_') || toolName.startsWith('shell_')) return 'execute';
    return null;
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assembles and returns a fully configured Harness instance plus a `rebuild`
 * helper that re-creates the harness after the registry changes.
 *
 * The returned harness is NOT yet initialised — call `harness.init()` and
 * `harness.selectOrCreateThread()` before sending messages.
 *
 * @param input - Config, registry, MCP toolsets, and optional rebuilt callback
 */
export async function createHarness(input: HarnessFactoryInput): Promise<{
  harness: Harness;
  /**
   * Re-scans the extensions directory, builds a fresh Harness with the
   * updated registry, initialises it, and returns it.
   * Also calls `input.onHarnessRebuilt` if provided.
   */
  rebuild: () => Promise<{ harness: Harness }>;
}> {
  const { config, registry, mcp } = input;

  const storage = createStorage();
  const memory = createMemory(storage);

  // Build the four router agents with the current registry summary baked in
  const { chatAgent, planAgent, buildAgent, createEnvAgent } = createRouterAgents(
    registry,
    config.model,
  );

  // Flatten MCP toolsets into a single namespaced tools record
  const mcpTools: Record<string, ToolAction<unknown, unknown>> = {};
  for (const serverTools of Object.values(mcp)) {
    for (const tool of Object.values(serverTools)) {
      mcpTools[tool.id] = createTool({
        id: tool.id,
        description: tool.description,
        inputSchema: tool.inputSchema ?? z.object({}),
        execute: async (inputData) => tool.execute(inputData),
      }) as unknown as ToolAction<unknown, unknown>;
    }
  }

  // Flatten extension registry tools
  const extensionTools: Record<string, ToolAction<unknown, unknown>> = {};
  for (const { id, tool } of registry.tools) {
    extensionTools[id] = tool as unknown as ToolAction<unknown, unknown>;
  }

  // /create_environment meta-tools — placeholder until build() is defined below
  let envTools = createEnvironmentTools(registry, config, async () => { /* rewired below */ });

  /**
   * Inner factory that creates a Harness from the current closed-over values.
   * Called once at startup and again by reload_ecosystem / rebuild().
   */
  function build(): Harness {
    const harness = new Harness({
      id: 'agent-swarm',
      storage,
      memory,

      modes: [
        {
          id: 'chat',
          name: 'Chat',
          default: true,
          agent: chatAgent,
          defaultModelId: config.modeModels.chat ?? config.model,
          color: '#6366f1',
        },
        {
          id: 'plan',
          name: 'Plan',
          agent: planAgent,
          defaultModelId: config.modeModels.plan ?? config.model,
          color: '#f59e0b',
        },
        {
          id: 'build',
          name: 'Build',
          agent: buildAgent,
          defaultModelId: config.modeModels.build ?? config.model,
          color: '#10b981',
        },
        {
          id: 'create_environment',
          name: 'Create Environment',
          agent: createEnvAgent,
          defaultModelId: config.modeModels.create_environment ?? config.model,
          color: '#8b5cf6',
        },
      ],

      // Subagent definitions drive the built-in `subagent` tool's description
      // and the display-state events (subagent_start / subagent_end).
      subagents: subagentDefinitions,

      // All tools merged: extension, MCP, and create_environment meta-tools.
      // The router agents' instructions determine which tools each mode uses.
      tools: {
        ...extensionTools,
        ...mcpTools,
        create_agent:     envTools.create_agent     as unknown as ToolAction<unknown, unknown>,
        edit_agent:       envTools.edit_agent       as unknown as ToolAction<unknown, unknown>,
        create_tool:      envTools.create_tool      as unknown as ToolAction<unknown, unknown>,
        edit_tool:        envTools.edit_tool        as unknown as ToolAction<unknown, unknown>,
        list_agents:      envTools.list_agents      as unknown as ToolAction<unknown, unknown>,
        list_tools:       envTools.list_tools       as unknown as ToolAction<unknown, unknown>,
        show_registry:    envTools.show_registry    as unknown as ToolAction<unknown, unknown>,
        reload_ecosystem: envTools.reload_ecosystem as unknown as ToolAction<unknown, unknown>,
      } as Record<string, ToolAction<unknown, unknown>>,

      resolveModel,
      toolCategoryResolver: buildToolCategoryResolver(registry),
    });

    // Apply per-category permission policies from config
    harness.setPermissionForCategory({ category: 'read',    policy: toPermissionPolicy(config.permissions.read) });
    harness.setPermissionForCategory({ category: 'edit',    policy: toPermissionPolicy(config.permissions.edit) });
    harness.setPermissionForCategory({ category: 'execute', policy: toPermissionPolicy(config.permissions.execute) });
    harness.setPermissionForCategory({ category: 'mcp',     policy: toPermissionPolicy(config.permissions.mcp) });

    return harness;
  }

  // ── Wire the real reload callback now that build() is in scope ────────────
  // Re-assign envTools with an onReload that:
  //   1. Builds a fresh Harness with the updated registry
  //   2. Initialises it (connects to storage)
  //   3. Notifies the CLI via input.onHarnessRebuilt so it can swap activeHarness
  envTools = createEnvironmentTools(registry, config, async () => {
    const newHarness = build();
    await newHarness.init();
    // Restore the active thread so the conversation continues after reload
    await newHarness.selectOrCreateThread();
    await input.onHarnessRebuilt?.(newHarness);
  });

  const harness = build();

  return {
    harness,
    rebuild: async () => {
      await registry.reload();
      const newHarness = build();
      await newHarness.init();
      await newHarness.selectOrCreateThread();
      await input.onHarnessRebuilt?.(newHarness);
      return { harness: newHarness };
    },
  };
}
