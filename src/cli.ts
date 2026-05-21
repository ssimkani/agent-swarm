/**
 * CLI entrypoint
 *
 * Top-level orchestration for the `agent` binary.
 *
 * Startup sequence:
 *   1. Parse argv (--help, --version, --cwd, --model)
 *   2. ensureProjectDir()        — create .agent/ if needed
 *   3. loadConfig()              — merge user + project config
 *   4. Apply --model override    — overrides all per-mode models if set
 *   5. loadRegistry()            — scan extensions/ for agents and tools
 *   6. loadMcp()                 — spawn configured MCP servers
 *   7. createHarness()           — assemble the Harness with all modes
 *   8. harness.init()            — connect to storage
 *   9. selectOrCreateThread      — load or create a conversation thread
 *  10. runTui()                  — start the interactive REPL
 *
 * SIGINT / SIGTERM trigger a clean shutdown:
 *   - harness.destroy()   — closes open DB connections
 *   - shutdownMcp()       — SIGTERMs all MCP child processes
 *
 * Flags:
 *   --cwd  / -C  Point the agent at a different project directory
 *   --model / -m Override the model for all modes (any Mastra provider string)
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness } from '@mastra/core/harness';
import { ensureProjectDir } from './workspace.js';
import { loadConfig } from './config.js';
import { loadRegistry } from './registry.js';
import { loadMcp, shutdownMcp } from './mcp.js';
import { createHarness } from './harness.js';
import { runTui } from './tui.js';

// ── Version ───────────────────────────────────────────────────────────────────

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgv() {
  const { values } = parseArgs({
    options: {
      help:    { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      cwd:     { type: 'string',  short: 'C' },
      model:   { type: 'string',  short: 'm' },
    },
    strict: false,
    allowPositionals: true,
  });
  return values as { help?: boolean; version?: boolean; cwd?: string; model?: string };
}

const HELP_TEXT = `
Usage: agent [options]

Options:
  -h, --help           Show this help message
  -v, --version        Print the version number
  -C, --cwd <dir>      Use a different project directory (default: current directory)
  -m, --model <id>     Override the model for all modes

Model providers (format: <provider>/<model>):
  anthropic/<model>             ANTHROPIC_API_KEY
  openai/<model>                OPENAI_API_KEY
  google/<model>                GOOGLE_GENERATIVE_AI_API_KEY
  openrouter/<provider>/<model> OPENROUTER_API_KEY
  ollama/<model>                local — no key needed
  lmstudio/<model>              local — no key needed
  groq/<model>                  GROQ_API_KEY

Examples:
  agent --model anthropic/claude-sonnet-4-20250514
  agent --model ollama/llama3.2
  agent --model openrouter/deepseek/deepseek-v4-flash

Modes (switch with slash commands inside the REPL):
  /chat               Conversational assistant (read-only)
  /plan               Research and structured planning
  /build              Full implementation with file editing
  /create_environment Create and manage agent/tool extensions

Configuration files:
  ~/.config/terminal-agent/config.json   User-level config
  ./.agent/config.json                   Project-level config (overrides user)

Data:
  ./.agent/data.db   Per-project conversation history (SQLite via LibSQL)
`.trim();

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const args = parseArgv();

  if (args.help)    { console.log(HELP_TEXT); process.exit(0); }
  if (args.version) { console.log(readVersion()); process.exit(0); }

  if (args.cwd) process.chdir(args.cwd);

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  ensureProjectDir();

  const config = await loadConfig();

  // --model overrides the default model and clears per-mode overrides so the
  // flag applies uniformly across all modes.
  if (args.model) {
    config.model      = args.model;
    config.modeModels = {};
  }

  const registry = await loadRegistry(config);
  const mcp      = await loadMcp(config);

  // ── Harness-change notification ────────────────────────────────────────────

  // The TUI registers a handler here so it can resubscribe when the harness is
  // swapped by reload_ecosystem or by /load-env in the TUI itself.
  let tuiHarnessHandler: ((h: Harness) => void) | undefined;

  let activeHarness: Harness;

  const { harness, rebuild } = await createHarness({
    config,
    registry,
    mcp,
    onHarnessRebuilt: async (newHarness: Harness) => {
      const prev = activeHarness;
      const prevModeId = prev.getCurrentModeId();
      activeHarness = newHarness;
      // Notify TUI first so it resubscribes before any mode/model events fire
      tuiHarnessHandler?.(newHarness);
      // Restore the mode the user was in before the reload
      try {
        if (prevModeId && prevModeId !== newHarness.getCurrentModeId()) {
          await newHarness.switchMode({ modeId: prevModeId });
        }
      } catch { /* best-effort */ }
      try { await prev.destroy(); } catch { /* best-effort */ }
    },
  });

  activeHarness = harness;

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  async function shutdown() {
    console.log('\nShutting down…');
    try { await activeHarness.destroy(); } catch { /* best-effort */ }
    shutdownMcp();
    process.exit(0);
  }

  process.once('SIGINT',  () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  // ── Initialise and run ─────────────────────────────────────────────────────

  await activeHarness.init();
  await activeHarness.selectOrCreateThread();

  // Apply --model flag to all modes in the active thread so it beats persisted values.
  if (args.model) {
    for (const modeId of ['chat', 'plan', 'build', 'create_environment']) {
      await activeHarness.switchModel({ modelId: args.model, modeId });
    }
  }

  await runTui(
    activeHarness,
    config,
    rebuild,
    (handler) => { tuiHarnessHandler = handler; },
  );

  await shutdown();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
