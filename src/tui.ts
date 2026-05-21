/**
 * TUI (Terminal User Interface)
 *
 * A readline-based interactive REPL that drives the Harness.
 *
 * Features:
 *   - Subscribes to all Harness events and renders streaming responses
 *   - Spinner animation during subagent execution
 *   - Status line showing current mode, model, and thread
 *   - Slash commands: /chat, /plan, /build, /create_environment,
 *                     /model, /threads, /switch <n>, /new,
 *                     /save-env, /load-env, /list-envs,
 *                     /help, /quit
 *   - Tool approval, question, and plan-approval prompts
 *   - Harness-change callback so ecosystem reloads update the active reference
 */

import * as readline from 'node:readline';
import pc from 'picocolors';
import type { Harness, HarnessEvent } from '@mastra/core/harness';
import type { Config } from './config.js';
import { saveEnvironment, loadEnvironment, listEnvironments } from './environments.js';

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private label = '';

  start(label: string) {
    this.label = label;
    this.frame = 0;
    if (this.timer) return;
    this.timer = setInterval(() => {
      process.stdout.write(`\r${pc.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length])} ${pc.dim(this.label)}  `);
      this.frame++;
    }, 80);
  }

  update(label: string) { this.label = label; }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    process.stdout.write('\r' + ' '.repeat(process.stdout.columns ?? 80) + '\r');
  }
}

// ── Status line ───────────────────────────────────────────────────────────────

/** Trims a long provider/model string to just the final segment for display. */
function shortModel(modelId: string): string {
  const parts = modelId.split('/');
  return parts[parts.length - 1];
}

/** One-line status bar rendered above each prompt. */
function renderStatus(harness: Harness): string {
  const mode   = harness.getCurrentModeId();
  const model  = shortModel(harness.getModelName());
  const thread = harness.getCurrentThreadId();
  const tid    = thread ? thread.slice(-8) : 'no thread';
  return `${pc.bold(pc.cyan(mode))}  ${pc.dim('·')}  ${pc.dim(model)}  ${pc.dim('·')}  ${pc.dim(tid)}`;
}

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP_TEXT = `
Slash commands:
  /chat                Switch to conversational (read-only) mode
  /plan                Switch to planning mode
  /build               Switch to full build mode
  /create_environment  Switch to extension authoring mode
  /model <id>          Switch the active model
                       e.g. /model anthropic/claude-sonnet-4-20250514
                            /model ollama/llama3.2  (local)
  /threads             List conversation threads (numbered for /switch)
  /switch <n>          Switch to thread number <n>
  /new                 Start a new conversation thread
  /save-env <name>     Snapshot current extensions to a named save
  /load-env  <name>    Restore a saved extensions snapshot and reload
  /list-envs           List all saved environments
  /help                Show this message
  /quit                Exit
`.trim();

// ── Core TUI loop ─────────────────────────────────────────────────────────────

/**
 * Starts the interactive REPL.
 *
 * @param initialHarness  - The initialised Harness instance
 * @param config          - App config (needed for extensionsDir in env commands)
 * @param rebuild         - Rebuilds the harness from the current registry state;
 *                          also triggers onHarnessChange so the reference is updated
 * @param onHarnessChange - Called by cli.ts when the harness is swapped externally
 *                          (e.g. via reload_ecosystem tool call). The TUI registers
 *                          its own handler here so it stays in sync.
 */
export async function runTui(
  initialHarness: Harness,
  config: Config,
  rebuild: () => Promise<{ harness: Harness }>,
  onHarnessChange: (handler: (h: Harness) => void) => void,
): Promise<void> {
  let activeHarness = initialHarness;

  const spinner = new Spinner();
  let currentMessageText = '';
  let isStreaming = false;

  // Thread list populated by /threads; used by /switch
  let lastThreadList: Array<{ id: string; title?: string | null }> = [];

  // ── Event subscription ─────────────────────────────────────────────────────

  function subscribe(h: Harness) {
    return h.subscribe((event: HarnessEvent) => {
      switch (event.type) {

        case 'message_start':
          if (event.message.role === 'assistant') {
            spinner.stop();
            isStreaming = true;
            currentMessageText = '';
            process.stdout.write(pc.cyan('\nAssistant: '));
          }
          break;

        case 'message_update':
          if (event.message.role === 'assistant' && isStreaming) {
            for (const part of event.message.content) {
              if (part.type === 'text') {
                const delta = part.text.slice(currentMessageText.length);
                if (delta) { process.stdout.write(delta); currentMessageText = part.text; }
              }
            }
          }
          break;

        case 'message_end':
          if (isStreaming) {
            // Extra blank line after assistant responses for breathing room
            process.stdout.write('\n\n');
            isStreaming = false;
            currentMessageText = '';
          }
          break;

        case 'subagent_start':
          spinner.start(`${event.agentType} running…`);
          break;

        case 'subagent_end':
          spinner.update('thinking…');
          break;

        case 'tool_approval_required':
          spinner.stop();
          handleToolApproval(activeHarness, event.toolName, event.args);
          break;

        case 'ask_question':
          spinner.stop();
          handleQuestion(activeHarness, event.questionId, event.question, event.options);
          break;

        case 'plan_approval_required':
          spinner.stop();
          handlePlanApproval(activeHarness, event.planId, event.plan);
          break;

        case 'mode_changed':
          console.log(pc.yellow(`\n  ↳ mode: ${pc.bold(event.modeId)}`));
          break;

        case 'model_changed':
          console.log(pc.yellow(`\n  ↳ model: ${pc.bold(shortModel(event.modelId))}`));
          break;

        case 'error':
          spinner.stop();
          console.error(pc.red(`\nError: ${event.error.message}`));
          break;

        case 'agent_end':
          spinner.stop();
          break;
      }
    });
  }

  let unsubscribe = subscribe(activeHarness);

  // Register with cli.ts so external harness swaps (reload_ecosystem) update us too
  onHarnessChange((newHarness) => {
    unsubscribe();
    activeHarness = newHarness;
    unsubscribe = subscribe(newHarness);
    console.log(pc.yellow('\n  ↳ ecosystem reloaded'));
  });

  // ── Readline interface ─────────────────────────────────────────────────────

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
  });

  function prompt() {
    rl.setPrompt(`${renderStatus(activeHarness)}\n${pc.bold('You:')} `);
    rl.prompt();
  }

  console.log(pc.bold('\nAgent Swarm') + pc.dim('  —  multi-mode AI harness'));
  console.log(pc.dim('Type /help for commands · /quit to exit\n'));
  prompt();

  // ── Input handler ──────────────────────────────────────────────────────────

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);

      switch (cmd) {

        // ── Mode switches ────────────────────────────────────────────────────
        case 'chat':
        case 'plan':
        case 'build':
        case 'create_environment':
          await activeHarness.switchMode({ modeId: cmd });
          break;

        // ── Model switch ─────────────────────────────────────────────────────
        case 'model':
          if (!args[0]) {
            console.log(pc.dim('Usage: /model <provider>/<model-id>'));
            console.log(pc.dim('Examples: anthropic/claude-sonnet-4-20250514'));
            console.log(pc.dim('          openai/gpt-4o  ·  ollama/llama3.2  ·  openrouter/deepseek/deepseek-v4-flash'));
          } else {
            await activeHarness.switchModel({ modelId: args[0] });
          }
          break;

        // ── Thread listing ───────────────────────────────────────────────────
        case 'threads': {
          const threads = await activeHarness.memory.listThreads();
          lastThreadList = threads;
          if (!threads.length) {
            console.log(pc.dim('No threads yet. Use /new to create one.'));
          } else {
            console.log('');
            for (const [i, t] of threads.entries()) {
              const isCurrent = t.id === activeHarness.getCurrentThreadId();
              const marker = isCurrent ? pc.cyan('▶') : ' ';
              const num    = pc.dim(`${i + 1}.`);
              const id     = isCurrent ? pc.cyan(t.id.slice(-8)) : pc.dim(t.id.slice(-8));
              const title  = t.title ? t.title : pc.dim('(untitled)');
              console.log(`  ${marker} ${num} ${id}  ${title}`);
            }
            console.log(pc.dim(`\n  /switch <n> to change  (${threads.length} thread${threads.length !== 1 ? 's' : ''})`));
          }
          break;
        }

        // ── Thread switching ─────────────────────────────────────────────────
        case 'switch': {
          if (!args[0]) {
            console.log(pc.dim('Usage: /switch <n>  (run /threads to list)'));
            break;
          }
          if (!lastThreadList.length) {
            console.log(pc.dim('Run /threads first to build the list.'));
            break;
          }
          const n = parseInt(args[0], 10);
          if (isNaN(n) || n < 1 || n > lastThreadList.length) {
            console.log(pc.dim(`Enter a number between 1 and ${lastThreadList.length}.`));
            break;
          }
          const target = lastThreadList[n - 1];
          await activeHarness.memory.switchThread({ threadId: target.id });
          console.log(pc.dim(`  ↳ thread ${target.id.slice(-8)}${target.title ? '  ' + target.title : ''}`));
          break;
        }

        // ── New thread ───────────────────────────────────────────────────────
        case 'new': {
          const thread = await activeHarness.memory.createThread();
          await activeHarness.memory.switchThread({ threadId: thread.id });
          console.log(pc.dim(`  ↳ new thread ${thread.id.slice(-8)}`));
          break;
        }

        // ── Environment: save ────────────────────────────────────────────────
        case 'save-env': {
          if (!args[0]) { console.log(pc.dim('Usage: /save-env <name>')); break; }
          try {
            saveEnvironment(args[0], config.extensionsDir);
            console.log(pc.green(`  ✓ Environment "${args[0]}" saved.`));
          } catch (err) {
            console.error(pc.red(`  ✗ ${(err as Error).message}`));
          }
          break;
        }

        // ── Environment: load ────────────────────────────────────────────────
        case 'load-env': {
          if (!args[0]) { console.log(pc.dim('Usage: /load-env <name>')); break; }
          try {
            loadEnvironment(args[0], config.extensionsDir);
            console.log(pc.dim(`  Reloading ecosystem…`));
            await rebuild();
            // activeHarness + subscription are updated by onHarnessChange callback
            console.log(pc.green(`  ✓ Environment "${args[0]}" loaded and active.`));
          } catch (err) {
            console.error(pc.red(`  ✗ ${(err as Error).message}`));
          }
          break;
        }

        // ── Environment: list ────────────────────────────────────────────────
        case 'list-envs': {
          const envs = listEnvironments();
          if (!envs.length) {
            console.log(pc.dim('No saved environments. Use /save-env <name> to create one.'));
          } else {
            console.log('');
            for (const e of envs) {
              const date   = e.savedAt.getTime() > 0 ? e.savedAt.toLocaleDateString() : '—';
              const counts = pc.dim(`${e.agentCount} agent${e.agentCount !== 1 ? 's' : ''}, ${e.toolCount} tool${e.toolCount !== 1 ? 's' : ''}`);
              console.log(`  ${pc.bold(e.name)}  ${pc.dim(date)}  ${counts}`);
            }
          }
          break;
        }

        // ── Help / quit ──────────────────────────────────────────────────────
        case 'help':
          console.log('\n' + HELP_TEXT);
          break;

        case 'quit':
        case 'exit':
          rl.close();
          return;

        default:
          console.log(pc.dim(`Unknown command: /${cmd}  —  try /help`));
      }

      prompt();
      return;
    }

    // ── Regular message ────────────────────────────────────────────────────────
    try {
      await activeHarness.sendMessage({ content: input });
    } catch (err) {
      spinner.stop();
      console.error(pc.red(`\nSend error: ${(err as Error).message}`));
    }

    prompt();
  });

  // ── Tool approval handler ──────────────────────────────────────────────────

  function handleToolApproval(h: Harness, toolName: string, args: unknown) {
    const preview = JSON.stringify(args, null, 2).slice(0, 300);
    console.log(pc.yellow(`\nTool approval: ${pc.bold(toolName)}`));
    if (preview !== '{}') console.log(pc.dim(preview));
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

  // ── Question handler ───────────────────────────────────────────────────────

  function handleQuestion(
    h: Harness,
    questionId: string,
    question: string,
    options?: Array<{ label: string; description?: string }>,
  ) {
    console.log(pc.cyan(`\nQuestion: ${question}`));
    if (options?.length) {
      for (const [i, opt] of options.entries()) {
        console.log(`  ${pc.bold(String(i + 1))}. ${opt.label}${opt.description ? pc.dim('  —  ' + opt.description) : ''}`);
      }
    }
    rl.question(pc.bold('Answer: '), (answer) => {
      h.respondToQuestion({ questionId, answer: answer.trim() });
    });
  }

  // ── Plan approval handler ──────────────────────────────────────────────────

  function handlePlanApproval(h: Harness, planId: string, plan: string) {
    const divider = pc.dim('─'.repeat(Math.min(process.stdout.columns ?? 60, 60)));
    console.log(`\n${divider}`);
    console.log(plan);
    console.log(divider);
    rl.question(pc.bold('Approve plan? [y/n/feedback] '), (answer) => {
      const a = answer.trim();
      if (a.toLowerCase() === 'y' || a.toLowerCase() === 'yes') {
        h.respondToPlanApproval({ planId, response: { action: 'approved' } });
      } else {
        h.respondToPlanApproval({
          planId,
          response: { action: 'rejected', feedback: (a === 'n' || a === 'no') ? undefined : a },
        });
      }
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      spinner.stop();
      unsubscribe();
      resolve();
    });
  });
}
