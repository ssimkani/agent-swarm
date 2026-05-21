/**
 * TUI (Terminal User Interface) — Step 10
 *
 * A readline-based interactive REPL that drives the Harness.
 *
 * Features:
 *   - Subscribes to all Harness events and renders streaming responses
 *   - Spinner animation during subagent execution and dynamic review
 *   - Status line showing current mode, model, and thread title
 *   - Slash commands: /chat, /plan, /build, /create_environment,
 *                     /model, /threads, /new, /help, /quit
 *   - Tool approval prompts with y/n/always input
 *   - Question prompts forwarded from ask_user
 *   - Plan approval for submit_plan
 *   - Color via picocolors (dim text, cyan for assistant, yellow for status)
 *
 * The TUI is intentionally stateless with respect to business logic — it only
 * renders events emitted by the Harness and calls Harness methods in response
 * to user input.
 */

import * as readline from 'node:readline';
import pc from 'picocolors';
import type { Harness, HarnessEvent } from '@mastra/core/harness';

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private label = '';

  start(label: string) {
    this.label = label;
    this.frame = 0;
    if (this.timer) return; // already running
    this.timer = setInterval(() => {
      process.stdout.write(`\r${pc.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length])} ${this.label}  `);
      this.frame++;
    }, 80);
  }

  update(label: string) {
    this.label = label;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clear the spinner line
    process.stdout.write('\r' + ' '.repeat(process.stdout.columns ?? 80) + '\r');
  }
}

// ── Status line ───────────────────────────────────────────────────────────────

/**
 * Renders a one-line status bar at the top of each prompt showing the current
 * mode, model name, and thread ID.
 */
function renderStatus(harness: Harness): string {
  const mode = harness.getCurrentModeId();
  const model = harness.getModelName();
  const thread = harness.getCurrentThreadId();
  const threadLabel = thread ? thread.slice(-8) : 'no thread';
  return pc.dim(`[${pc.bold(mode)}] ${model} · ${threadLabel}`);
}

// ── Slash command registry ────────────────────────────────────────────────────

const HELP_TEXT = `
Available slash commands:
  /chat               Switch to conversational (read-only) mode
  /plan               Switch to planning mode
  /build              Switch to full build mode
  /create_environment Switch to extension authoring mode
  /model <id>         Switch the active model (e.g. /model anthropic/claude-opus-4-7)
  /threads            List conversation threads
  /new                Start a new thread
  /help               Show this help message
  /quit               Exit the agent
`.trim();

// ── Core TUI loop ─────────────────────────────────────────────────────────────

/**
 * Starts the interactive REPL.
 *
 * Subscribes to Harness events to update the display, then opens a readline
 * interface for user input. Returns when the user types /quit or presses Ctrl-C.
 *
 * Harness rebuilds (triggered by reload_ecosystem) are handled via the
 * `onHarnessRebuilt` callback passed to `createHarness`, not through the TUI.
 *
 * @param harness - The initialised Harness instance
 */
export async function runTui(harness: Harness): Promise<void> {
  // Track the active harness reference; reload_ecosystem may swap it
  let activeHarness = harness;

  const spinner = new Spinner();
  // Buffer for the streaming assistant message so we can print it incrementally
  let currentMessageText = '';
  let isStreaming = false;

  // ── Event subscription ──────────────────────────────────────────────────

  function subscribe(h: Harness) {
    return h.subscribe((event: HarnessEvent) => {
      switch (event.type) {
        // ── Message streaming ──────────────────────────────────────────────
        case 'message_start':
          if (event.message.role === 'assistant') {
            // Stop any spinner that was running (subagent, thinking, etc.)
            spinner.stop();
            isStreaming = true;
            currentMessageText = '';
            process.stdout.write(pc.cyan('\nAssistant: '));
          }
          break;

        case 'message_update':
          if (event.message.role === 'assistant' && isStreaming) {
            // Compute and print only the delta since last update
            for (const part of event.message.content) {
              if (part.type === 'text') {
                const delta = part.text.slice(currentMessageText.length);
                if (delta) {
                  process.stdout.write(delta);
                  currentMessageText = part.text;
                }
              }
            }
          }
          break;

        case 'message_end':
          if (isStreaming) {
            process.stdout.write('\n');
            isStreaming = false;
            currentMessageText = '';
          }
          break;

        // ── Subagent lifecycle ─────────────────────────────────────────────
        case 'subagent_start':
          spinner.start(`${event.agentType} subagent running…`);
          break;

        case 'subagent_end':
          // Subagent finished. The spinner keeps running until the next
          // message_start (which signals the router's response has begun).
          spinner.update('thinking…');
          break;

        // ── Tool approval ──────────────────────────────────────────────────
        case 'tool_approval_required':
          spinner.stop();
          handleToolApproval(activeHarness, event.toolName, event.args);
          break;

        // ── User question ──────────────────────────────────────────────────
        case 'ask_question':
          spinner.stop();
          handleQuestion(activeHarness, event.questionId, event.question, event.options);
          break;

        // ── Plan approval ──────────────────────────────────────────────────
        case 'plan_approval_required':
          spinner.stop();
          handlePlanApproval(activeHarness, event.planId, event.plan);
          break;

        // ── Mode / model changes ───────────────────────────────────────────
        case 'mode_changed':
          console.log(pc.yellow(`\nMode switched → ${event.modeId}`));
          break;

        case 'model_changed':
          console.log(pc.yellow(`\nModel switched → ${event.modelId}`));
          break;

        // ── Errors ────────────────────────────────────────────────────────
        case 'error':
          spinner.stop();
          console.error(pc.red(`\nError: ${event.error.message}`));
          break;

        // ── Agent end (idle signal) ────────────────────────────────────────
        case 'agent_end':
          spinner.stop();
          break;
      }
    });
  }

  let unsubscribe = subscribe(activeHarness);

  // ── Readline interface ──────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Prompt helper — called after each response to re-display the status line
  function prompt() {
    rl.setPrompt(`${renderStatus(activeHarness)}\n${pc.bold('You:')} `);
    rl.prompt();
  }

  console.log(pc.bold('\nAgent Swarm — multi-mode AI agent harness'));
  console.log(pc.dim('Type /help for commands, /quit to exit.\n'));
  prompt();

  // ── Input handler ────────────────────────────────────────────────────────

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    // ── Slash commands ─────────────────────────────────────────────────────
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);

      switch (cmd) {
        case 'chat':
        case 'plan':
        case 'build':
        case 'create_environment':
          await activeHarness.switchMode({ modeId: cmd });
          break;

        case 'model':
          if (!args[0]) {
            console.log(pc.dim('Usage: /model <model-id>'));
          } else {
            await activeHarness.switchModel({ modelId: args[0] });
          }
          break;

        case 'threads': {
          const threads = await activeHarness.memory.listThreads();
          if (!threads.length) {
            console.log(pc.dim('No threads yet.'));
          } else {
            for (const t of threads) {
              const marker = t.id === activeHarness.getCurrentThreadId() ? pc.cyan('▶ ') : '  ';
              console.log(`${marker}${t.id.slice(-8)}  ${pc.dim(t.title ?? '(untitled)')}`);
            }
          }
          break;
        }

        case 'new': {
          const thread = await activeHarness.memory.createThread();
          await activeHarness.memory.switchThread({ threadId: thread.id });
          console.log(pc.dim(`New thread: ${thread.id.slice(-8)}`));
          break;
        }

        case 'help':
          console.log(HELP_TEXT);
          break;

        case 'quit':
        case 'exit':
          rl.close();
          return;

        default:
          console.log(pc.dim(`Unknown command: /${cmd} — try /help`));
      }

      prompt();
      return;
    }

    // ── Regular message ────────────────────────────────────────────────────
    try {
      await activeHarness.sendMessage({ content: input });
    } catch (err) {
      spinner.stop();
      console.error(pc.red(`\nSend error: ${(err as Error).message}`));
    }

    prompt();
  });

  // ── Tool approval handler ─────────────────────────────────────────────────

  function handleToolApproval(
    h: Harness,
    toolName: string,
    args: unknown,
  ) {
    const argsPreview = JSON.stringify(args, null, 2).slice(0, 200);
    console.log(pc.yellow(`\nTool approval required: ${pc.bold(toolName)}`));
    console.log(pc.dim(argsPreview));

    // Temporarily pause readline to get a clean y/n prompt
    rl.question(pc.bold('Allow? [y/n/always] '), (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === 'always') {
        h.respondToToolApproval({ decision: 'always_allow_category' });
      } else if (a === 'y' || a === 'yes') {
        h.respondToToolApproval({ decision: 'approve' });
      } else {
        h.respondToToolApproval({ decision: 'decline' });
      }
    });
  }

  // ── Question handler ──────────────────────────────────────────────────────

  function handleQuestion(
    h: Harness,
    questionId: string,
    question: string,
    options?: Array<{ label: string; description?: string }>,
  ) {
    console.log(pc.cyan(`\nQuestion: ${question}`));
    if (options?.length) {
      for (const [i, opt] of options.entries()) {
        console.log(`  ${pc.bold(String(i + 1))}. ${opt.label}${opt.description ? pc.dim(` — ${opt.description}`) : ''}`);
      }
    }

    rl.question(pc.bold('Answer: '), (answer) => {
      h.respondToQuestion({ questionId, answer: answer.trim() });
    });
  }

  // ── Plan approval handler ─────────────────────────────────────────────────

  function handlePlanApproval(h: Harness, planId: string, plan: string) {
    console.log(pc.yellow('\n── Plan for approval ──────────────────────'));
    console.log(plan);
    console.log(pc.yellow('──────────────────────────────────────────'));

    rl.question(pc.bold('Approve plan? [y/n/feedback] '), (answer) => {
      const a = answer.trim();
      if (a.toLowerCase() === 'y' || a.toLowerCase() === 'yes') {
        h.respondToPlanApproval({ planId, response: { action: 'approved' } });
      } else {
        h.respondToPlanApproval({
          planId,
          response: { action: 'rejected', feedback: a === 'n' || a === 'no' ? undefined : a },
        });
      }
    });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      spinner.stop();
      unsubscribe();
      resolve();
    });
  });
}
