/**
 * Router agents — Step 8
 *
 * Four Agent variants sharing a common base prompt, one per harness mode.
 * Each variant receives different instructions that constrain what it can do
 * and which built-in tools it may use.
 *
 * Mode overview:
 *   /chat               — Conversational Q&A, read-only subagents only
 *   /plan               — Produces a structured plan, submits for approval
 *   /build              — Full implementation, edit + execute subagents available
 *   /create_environment — Meta-programming: creates/edits extension agents and tools
 *
 * The registry summary (agents and tools available in extensions/) is injected
 * into each agent's instructions at construction time via `buildInstructions()`.
 * This means the router always knows which user-authored subagents and tools exist.
 *
 * Subagent definitions (HarnessSubagent[]) are declared here so the Harness
 * factory in harness.ts can register them. Each subagent's `allowedHarnessTools`
 * controls which built-in tools it may call, and its tool set determines whether
 * it is classified as edit-access (and therefore subject to dynamic review).
 */

import { Agent } from '@mastra/core/agent';
import type { HarnessSubagent } from '@mastra/core/harness';
import type { Registry } from '../registry.js';

// ── Registry summary builder ──────────────────────────────────────────────────

/**
 * Builds a compact text summary of all registered extension agents and tools.
 * This is injected into every router's system prompt so it knows what to delegate.
 */
function buildRegistrySummary(registry: Registry): string {
  const agentLines = registry.agents.length
    ? registry.agents.map(a => `  - ${a.id}: ${(a.agent as unknown as Record<string, unknown>).name ?? a.id}`).join('\n')
    : '  (none — use /create_environment to add agents)';

  const toolLines = registry.tools.length
    ? registry.tools.map(t => `  - ${t.id} [${t.category ?? 'other'}]: ${t.tool.description}`).join('\n')
    : '  (none — use /create_environment to add tools)';

  return `
Available extension agents:
${agentLines}

Available extension tools:
${toolLines}
`.trim();
}

// ── Shared base instructions ───────────────────────────────────────────────────

/**
 * The base instructions shared across all four router variants.
 * Describes the delegation model and how to interact with subagents.
 */
const BASE_INSTRUCTIONS = `
You are a routing agent that orchestrates a swarm of specialized subagents.
Your role is to understand the user's goal and coordinate the right subagents
to accomplish it — you do not perform implementation work yourself.

When delegating:
- Use the subagent tool to spawn a specialized subagent for each discrete unit of work.
- Give each subagent a clear, self-contained task description.
- Subagent outputs pass through a reviewer before reaching you; the reviewer's
  notes (if any) are appended to the output — act on them if present.

When to answer directly vs delegate:
- Simple questions about your capabilities or the current mode → answer directly.
- Anything requiring file access, code generation, or research → delegate.
`.trim();

// ── Mode-specific instruction builders ───────────────────────────────────────

function chatInstructions(registry: Registry): string {
  return `
${BASE_INSTRUCTIONS}

MODE: /chat — Conversational, read-only
You are in chat mode. You may delegate to read-only subagents (explore, research)
but you must NOT instruct any subagent to create, edit, or delete files.
If the user asks for file changes, explain that they should switch to /build mode.

${buildRegistrySummary(registry)}
`.trim();
}

function planInstructions(registry: Registry): string {
  return `
${BASE_INSTRUCTIONS}

MODE: /plan — Research and planning
You gather information (read-only subagents) and produce a structured implementation plan.
When your plan is complete, call submit_plan so the user can review and approve it.
Do not make any file changes — that happens in /build after the plan is approved.

${buildRegistrySummary(registry)}
`.trim();
}

function buildInstructions(registry: Registry): string {
  return `
${BASE_INSTRUCTIONS}

MODE: /build — Full implementation
You have access to all subagent types: explore (read), edit (write files), and
execute (run commands). Use task_write to track progress on multi-step work.

Work methodically:
1. Use an explore subagent to understand the codebase before editing.
2. Delegate edits and command execution to the appropriate subagents.
3. Verify the result after each significant change.

${buildRegistrySummary(registry)}
`.trim();
}

function createEnvInstructions(registry: Registry): string {
  return `
${BASE_INSTRUCTIONS}

MODE: /create_environment — Extension authoring
You help the user design and create new agents and tools for the extensions system.
You have access to meta-tools for reading, writing, and reloading extension files.

Process:
1. Ask clarifying questions about the desired agent/tool's purpose and interface.
2. Use list_agents / list_tools to check what already exists.
3. Use create_agent or create_tool to write the file.
4. Confirm the result and call reload_ecosystem so changes take effect immediately.

Always confirm the intended behaviour with the user before writing files.

${buildRegistrySummary(registry)}
`.trim();
}

// ── Subagent definitions ──────────────────────────────────────────────────────

/**
 * The four subagent types the router can spawn via the built-in `subagent` tool.
 *
 * `explore`  — read-only research/search subagent (not reviewed)
 * `edit`     — file creation/modification subagent (REVIEWED by dynamic agent)
 * `execute`  — shell command execution (REVIEWED by dynamic agent)
 * `plan`     — structured planning subagent, produces an outline (not reviewed)
 *
 * Edit-access classification:
 *   The harness factory uses the subagent ID to decide whether to pass output
 *   through the dynamic reviewer. IDs in EDIT_ACCESS_SUBAGENT_IDS are reviewed.
 */
export const EDIT_ACCESS_SUBAGENT_IDS = ['edit', 'execute'] as const;

export const subagentDefinitions: HarnessSubagent[] = [
  {
    id: 'explore',
    name: 'Explorer',
    description: 'Searches and reads files, directories, and code. Read-only — makes no changes.',
    instructions: `
You are a read-only research subagent. Your job is to find and return information.
- Search files, read code, list directories, look up documentation.
- Summarise findings clearly with file paths and relevant excerpts.
- Do NOT create, edit, or delete any files.
- Return your findings as concise, structured text.
    `.trim(),
    allowedHarnessTools: ['ask_user'],
    // allowedWorkspaceTools is omitted — read-only tools will be filtered
    // in the harness config by only providing read-category tools
  },
  {
    id: 'edit',
    name: 'Editor',
    description: 'Creates and modifies files. Output is reviewed before the router sees it.',
    instructions: `
You are a file-editing subagent. Your job is to implement the task by writing,
modifying, or deleting files as instructed.
- Read existing files before editing to understand context.
- Make the minimal change needed to complete the task.
- Return a summary of every file you created or modified, with a one-line description of each change.
    `.trim(),
    allowedHarnessTools: ['ask_user'],
  },
  {
    id: 'execute',
    name: 'Executor',
    description: 'Runs shell commands. Output is reviewed before the router sees it.',
    instructions: `
You are a command-execution subagent. You run shell commands to accomplish your task.
- Explain what each command does before running it.
- Capture and return both stdout and stderr.
- If a command fails, diagnose the error and try to recover before giving up.
- Return a concise summary of what ran and what the outcome was.
    `.trim(),
    allowedHarnessTools: ['ask_user'],
  },
  {
    id: 'plan',
    name: 'Planner',
    description: 'Researches and produces a structured implementation plan. Read-only.',
    instructions: `
You are a planning subagent. Research the codebase and produce a numbered,
step-by-step implementation plan for the given task.
- Each step should be concrete and actionable.
- Include file paths and function names where relevant.
- Do NOT make any changes; your output is purely a plan.
    `.trim(),
    allowedHarnessTools: ['ask_user'],
  },
];

// ── Agent factory ─────────────────────────────────────────────────────────────

/**
 * Creates all four router agent variants.
 *
 * Call this once with the loaded registry so each agent's instructions
 * include the current list of extension agents and tools.
 *
 * @param registry - The loaded extension registry
 * @param modelId  - Default model ID for all four routers (overridable per-mode in config)
 */
export function createRouterAgents(
  registry: Registry,
  modelId: string,
): {
  chatAgent: Agent;
  planAgent: Agent;
  buildAgent: Agent;
  createEnvAgent: Agent;
} {
  const shared = { model: modelId } as const;

  const chatAgent = new Agent({
    ...shared,
    id: 'router-chat',
    name: 'Chat Router',
    instructions: chatInstructions(registry),
  });

  const planAgent = new Agent({
    ...shared,
    id: 'router-plan',
    name: 'Plan Router',
    instructions: planInstructions(registry),
  });

  const buildAgent = new Agent({
    ...shared,
    id: 'router-build',
    name: 'Build Router',
    instructions: buildInstructions(registry),
  });

  const createEnvAgent = new Agent({
    ...shared,
    id: 'router-create-env',
    name: 'Create Environment Router',
    instructions: createEnvInstructions(registry),
  });

  return { chatAgent, planAgent, buildAgent, createEnvAgent };
}

/** Re-export so harness.ts can reference the index file instead of this module directly. */
export type { HarnessSubagent };
