/**
 * Dynamic review agent — Step 7
 *
 * A lightweight agent whose sole job is to review the output of subagents that
 * have **edit access** (i.e. can write or modify files). Read-only subagents
 * bypass this step entirely.
 *
 * The reviewer receives:
 *   - The user's original prompt / task description
 *   - The subagent's raw output text
 *   - Optional conversation history for context
 *
 * It returns a structured ReviewResult:
 *   - verdict: 'approve'  → output is acceptable; router sees it as-is
 *   - verdict: 'refine'   → output has issues; notes explain what needs fixing
 *
 * The router then either passes the approved result to the user or asks the
 * subagent to refine based on the reviewer's notes.
 *
 * The reviewer intentionally uses a small/fast model (haiku-class) because
 * its task is classification, not complex reasoning. The model ID is
 * configurable via `config.reviewerModel`.
 */

import { Agent } from '@mastra/core/agent';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Input to the review function, capturing everything the reviewer needs
 * to assess whether the subagent's output satisfies the original intent.
 */
export interface ReviewInput {
  /** The task the subagent was asked to complete (from the router). */
  task: string;
  /** The raw text the subagent returned. */
  subagentOutput: string;
  /** Optional: the subagent type that produced the output, for context. */
  agentType?: string;
}

/**
 * Structured result the reviewer always returns.
 * The router uses the verdict to decide whether to pass output upstream
 * or send it back for revision.
 */
export interface ReviewResult {
  /** 'approve' = output is good; 'refine' = output needs revision. */
  verdict: 'approve' | 'refine';
  /** Human-readable explanation of the verdict. Forwarded to the subagent if 'refine'. */
  notes: string;
  /** The (possibly annotated) output the router should surface to the user. */
  reviewedOutput: string;
}

// ── Agent definition ──────────────────────────────────────────────────────────

/**
 * The dynamic reviewer agent.
 *
 * It is constructed without tools — it only reads and produces text.
 * The model ID is set to a haiku-class default that can be overridden
 * at Harness construction time via `config.reviewerModel`.
 *
 * This agent is exported so the Harness can inject the correct model
 * before first use (see `createDynamicReviewer` below).
 */
export function createDynamicReviewer(modelId: string): Agent {
  return new Agent({
    id: 'dynamic-reviewer',
    name: 'Output Reviewer',
    model: modelId,
    instructions: `
You are an output reviewer for an AI coding agent system.

Your job is to assess whether a subagent's output adequately fulfills the
user's original task. The subagent you are reviewing has edit access — it can
write, modify, or delete files — so correctness and completeness matter.

Respond ONLY with a JSON object (no markdown fences, no explanation outside the JSON):
{
  "verdict": "approve" | "refine",
  "notes": "<one or two sentences explaining your verdict>"
}

Guidelines:
- Approve if the output clearly addresses the task, even if imperfect in minor ways.
- Choose 'refine' only when there is a clear gap: missing files, wrong logic,
  incomplete implementation, or output that contradicts the task requirements.
- Do NOT nitpick style, naming conventions, or personal preferences.
- If you cannot tell from the output alone (e.g. the subagent returned only a plan),
  default to 'approve' with a note that execution hasn't started yet.
`.trim(),
  });
}

// ── Review function ───────────────────────────────────────────────────────────

/**
 * Asks the dynamic reviewer to assess a subagent's output.
 *
 * Parses the structured JSON response from the reviewer and falls back to
 * an 'approve' verdict if the model returns something unparseable (rather
 * than blocking the user on a reviewer failure).
 *
 * @param reviewer - A dynamicReviewer Agent instance (from `createDynamicReviewer`)
 * @param input    - Task + subagent output to review
 * @returns        - Structured ReviewResult with verdict, notes, and reviewed output
 */
export async function reviewOutput(
  reviewer: Agent,
  input: ReviewInput,
): Promise<ReviewResult> {
  const prompt = [
    `Task: ${input.task}`,
    input.agentType ? `Subagent type: ${input.agentType}` : '',
    '',
    `Subagent output:`,
    input.subagentOutput,
  ].filter(Boolean).join('\n');

  let verdict: 'approve' | 'refine' = 'approve';
  let notes = 'Output approved.';

  try {
    const response = await reviewer.generate(prompt);
    const text = response.text.trim();

    // Strip markdown fences if the model wrapped the JSON
    const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonText) as { verdict: string; notes: string };

    if (parsed.verdict === 'approve' || parsed.verdict === 'refine') {
      verdict = parsed.verdict;
    }
    notes = parsed.notes ?? notes;
  } catch {
    // Reviewer failure should not block the user — default to approve
    notes = 'Reviewer could not parse output; defaulting to approve.';
  }

  // Build the reviewed output: if approved, pass through as-is;
  // if refine, annotate with the reviewer's notes so the router can act on them.
  const reviewedOutput =
    verdict === 'approve'
      ? input.subagentOutput
      : `${input.subagentOutput}\n\n[Reviewer notes — needs refinement]: ${notes}`;

  return { verdict, notes, reviewedOutput };
}
