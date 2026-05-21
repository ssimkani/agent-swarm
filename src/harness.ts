/**
 * Harness factory — Steps 9 + 8 (subagent review wrapper)
 *
 * This is the central assembly point. It takes config, registry, and MCP
 * toolsets, then constructs and returns a fully configured Harness instance.
 *
 * Key responsibilities:
 *
 *   1. Build four Harness modes (chat / plan / build / create_environment),
 *      each backed by the matching router agent variant.
 *
 *   2. Register all four subagent types (explore, edit, execute, plan) and
 *      wrap the subagent tool so that edit-access subagents (edit, execute)
 *      have their output reviewed by the dynamic agent before the router sees it.
 *
 *   3. Wire permission policies from config into the Harness.
 *
 *   4. Expose the create_environment meta-tools only in that mode via the
 *      `tools` config (DynamicArgument keyed on mode ID).
 *
 * Dynamic review interception:
 *   The Harness's built-in `subagent` tool is disabled via `disableBuiltinTools`.
 *   A custom replacement is provided in `tools` that:
 *     a) calls `createSubagentTool` (Mastra's official factory) to get the
 *        standard subagent spawning logic, including all display-state events;
 *     b) wraps that tool's execute function so that, after an edit-access
 *        subagent completes, the raw output is piped through `reviewOutput`
 *        before being returned to the router.
 */

import { Harness } from '@mastra/core/harness';
import { createSubagentTool } from '@mastra/core/harness';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v4';
import type { Config } from './config.js';
import type { Registry } from './registry.js';
import type { McpToolsets } from './mcp.js';
import { resolveModel } from './models.js';
import { createStorage, createMemory } from './workspace.js';
import { createRouterAgents, subagentDefinitions, EDIT_ACCESS_SUBAGENT_IDS } from './agents/router.js';
import { createDynamicReviewer, reviewOutput } from './agents/dynamic.js';
import { createEnvironmentTools } from './tools/create-environment.js';
import type { ToolCategory, PermissionPolicy, HarnessSubagent } from '@mastra/core/harness';
import type { ToolAction } from '@mastra/core/tools';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Everything createHarness needs to initialise the system. */
export interface HarnessFactoryInput {
  config: Config;
  registry: Registry;
  mcp: McpToolsets;
}

// ── Permission policy bridging ────────────────────────────────────────────────

/**
 * Maps the config permission policy strings to the Harness PermissionPolicy type.
 * They share the same string values, but this explicit cast makes the dependency clear.
 */
function toPermissionPolicy(p: string): PermissionPolicy {
  return p as PermissionPolicy;
}

// ── Tool category resolver ────────────────────────────────────────────────────

/**
 * Tells the Harness which permission bucket each tool name belongs to.
 *
 * The Harness uses this to:
 *   - Apply category-level permission policies (allow / ask / deny)
 *   - Show the right label in tool-approval prompts
 *
 * Naming conventions:
 *   - MCP tools are namespaced as "<server>__<tool>", so we check for "__"
 *   - Extension tools carry a `category` field in the registry
 *   - Built-in harness tools (ask_user, submit_plan, task_*) fall through to null
 *     (the Harness handles those itself)
 */
function buildToolCategoryResolver(registry: Registry) {
  // Pre-build a lookup map from tool ID → category for O(1) resolution
  const toolCategoryMap = new Map<string, ToolCategory>(
    registry.tools
      .filter(t => t.category)
      .map(t => [t.id, t.category as ToolCategory]),
  );

  return (toolName: string): ToolCategory | null => {
    // MCP tools are always in the 'mcp' category
    if (toolName.includes('__')) return 'mcp';
    // Extension tool with an explicit category
    if (toolCategoryMap.has(toolName)) return toolCategoryMap.get(toolName)!;
    // Workspace tools by convention
    if (toolName.startsWith('fs_') || toolName.startsWith('read_')) return 'read';
    if (toolName.startsWith('write_') || toolName.startsWith('edit_') || toolName.startsWith('delete_')) return 'edit';
    if (toolName.startsWith('exec_') || toolName.startsWith('run_') || toolName.startsWith('shell_')) return 'execute';
    return null;
  };
}

// ── Reviewed subagent tool wrapper ────────────────────────────────────────────

/**
 * Builds a custom `subagent` tool that wraps Mastra's official subagent factory.
 *
 * The wrapper intercepts results from subagents whose IDs appear in
 * `EDIT_ACCESS_SUBAGENT_IDS` and routes them through the dynamic reviewer
 * before returning them to the router agent. Read-only subagents (explore, plan)
 * are passed through without review.
 *
 * Why disable the built-in and replace it:
 *   The Harness's built-in subagent tool uses `createSubagentTool` internally.
 *   By disabling it and re-providing our own, we can intercept the result
 *   at the tool boundary — the point where the subagent's text is about to be
 *   inserted back into the router's message history.
 *
 * @param subagents   - Subagent definitions the tool may spawn
 * @param reviewerModelId - Model ID for the dynamic reviewer
 */
function buildReviewedSubagentTool(
  subagents: HarnessSubagent[],
  reviewerModelId: string,
): ToolAction<unknown, unknown> {
  // The dynamic reviewer agent — created once, reused for every subagent call
  const reviewer = createDynamicReviewer(reviewerModelId);

  // Set of subagent IDs whose output must pass through the reviewer
  const editAccessIds = new Set<string>(EDIT_ACCESS_SUBAGENT_IDS);

  // Create the official Mastra subagent tool which handles all the internal
  // wiring: thread forking, display-state events (subagent_start / subagent_end),
  // model resolution, streaming, etc.
  const baseTool = createSubagentTool({
    subagents,
    resolveModel,
  });

  // Build a thin wrapper that intercepts the result for edit-access subagents
  return createTool({
    id: 'subagent',
    // Preserve the description so the router's auto-generated prompt is unchanged
    description: baseTool.description,
    // Preserve the exact input schema (agentType, task, modelId?, forked?)
    inputSchema: baseTool.inputSchema as Parameters<typeof createTool>[0]['inputSchema'],
    execute: async (inputData: unknown, context) => {
      // Delegate to the standard subagent tool — this spawns the subagent,
      // streams its output, emits subagent_start/end events, etc.
      const rawResult = await baseTool.execute?.(inputData as Parameters<typeof baseTool.execute>[0], context as Parameters<typeof baseTool.execute>[1]);

      const input = inputData as { agentType: string; task: string };

      // Only review subagents that have edit access
      if (editAccessIds.has(input.agentType)) {
        const rawText = typeof rawResult === 'string'
          ? rawResult
          : JSON.stringify(rawResult);

        const reviewed = await reviewOutput(reviewer, {
          task: input.task,
          subagentOutput: rawText,
          agentType: input.agentType,
        });

        // Return the reviewed output (approved as-is, or annotated for refinement)
        return reviewed.reviewedOutput;
      }

      // Read-only subagents bypass review entirely
      return rawResult;
    },
  }) as unknown as ToolAction<unknown, unknown>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assembles and returns a fully configured Harness instance.
 *
 * The harness is not yet initialised when this function returns — call
 * `harness.init()` before using it.
 *
 * @param input - Config, registry, and MCP toolsets
 * @returns     - Configured Harness + a `rebuild()` helper for /create_environment
 */
export async function createHarness(input: HarnessFactoryInput): Promise<{
  harness: Harness;
  /** Re-creates the harness after registry.reload() — returns the new instance. */
  rebuild: () => Promise<{ harness: Harness }>;
}> {
  const { config, registry, mcp } = input;

  const storage = createStorage();
  const memory = createMemory(storage);

  // Build the four router agents, each with the current registry summary baked in
  const { chatAgent, planAgent, buildAgent, createEnvAgent } = createRouterAgents(
    registry,
    config.model,
  );

  // Flatten MCP toolsets into a single tools record namespaced by server
  const mcpTools: Record<string, ToolAction<unknown, unknown>> = {};
  for (const serverTools of Object.values(mcp)) {
    for (const [id, tool] of Object.entries(serverTools)) {
      mcpTools[id] = createTool({
        id: tool.id,
        description: tool.description,
        inputSchema: tool.inputSchema ?? z.object({}),
        execute: async ({ context }) => tool.execute(context),
      }) as unknown as ToolAction<unknown, unknown>;
    }
  }

  // Flatten extension registry tools into the same record
  const extensionTools: Record<string, ToolAction<unknown, unknown>> = {};
  for (const { id, tool } of registry.tools) {
    extensionTools[id] = tool as unknown as ToolAction<unknown, unknown>;
  }

  // The reviewed subagent tool that intercepts edit-access subagent output
  const reviewedSubagentTool = buildReviewedSubagentTool(
    subagentDefinitions,
    config.reviewerModel,
  );

  // /create_environment meta-tools — only provided in that mode
  let envTools = createEnvironmentTools(registry, config, async () => {
    // Called by reload_ecosystem — we return the new harness instance
    // via a closure so the TUI can swap it out
  });

  function build() {
    const harness = new Harness({
      id: 'agent-swarm',
      storage,
      memory,

      // Four harness modes
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

      // Subagent definitions (the reviewed subagent tool replaces the built-in)
      subagents: subagentDefinitions,

      // Disable the built-in subagent tool; we provide our reviewed wrapper below
      disableBuiltinTools: ['subagent'],

      /**
       * Tools available to agents.
       * Uses DynamicArgument so /create_environment gets its meta-tools while
       * other modes only see extension + MCP tools.
       */
      tools: (requestContext) => {
        const modeId = requestContext?.get?.('harness')?.modeId ?? 'chat';
        const base = {
          ...extensionTools,
          ...mcpTools,
          // Inject our reviewed subagent tool in place of the built-in
          subagent: reviewedSubagentTool,
        };

        if (modeId === 'create_environment') {
          // Add the meta-tools only in this mode
          return {
            ...base,
            create_agent: envTools.create_agent as unknown as ToolAction<unknown, unknown>,
            edit_agent: envTools.edit_agent as unknown as ToolAction<unknown, unknown>,
            create_tool: envTools.create_tool as unknown as ToolAction<unknown, unknown>,
            edit_tool: envTools.edit_tool as unknown as ToolAction<unknown, unknown>,
            list_agents: envTools.list_agents as unknown as ToolAction<unknown, unknown>,
            list_tools: envTools.list_tools as unknown as ToolAction<unknown, unknown>,
            show_registry: envTools.show_registry as unknown as ToolAction<unknown, unknown>,
            reload_ecosystem: envTools.reload_ecosystem as unknown as ToolAction<unknown, unknown>,
          };
        }

        return base;
      },

      // Model resolver used by subagents and OM
      resolveModel,

      // Maps tool names to permission categories for the approval system
      toolCategoryResolver: buildToolCategoryResolver(registry),
    });

    // Apply permission policies from config
    harness.setPermissionForCategory({ category: 'read', policy: toPermissionPolicy(config.permissions.read) });
    harness.setPermissionForCategory({ category: 'edit', policy: toPermissionPolicy(config.permissions.edit) });
    harness.setPermissionForCategory({ category: 'execute', policy: toPermissionPolicy(config.permissions.execute) });
    harness.setPermissionForCategory({ category: 'mcp', policy: toPermissionPolicy(config.permissions.mcp) });

    return harness;
  }

  // Wire up the reload callback now that build() is defined
  envTools = createEnvironmentTools(registry, config, async () => {
    // After reload_ecosystem, rebuild the harness so new agents/tools are live
    const newHarness = build();
    await newHarness.init();
    // The TUI holds a reference via `rebuild()` (see CLI entrypoint)
  });

  const harness = build();

  return {
    harness,
    rebuild: async () => {
      await registry.reload();
      const newHarness = build();
      return { harness: newHarness };
    },
  };
}
