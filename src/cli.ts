/**
 * CLI entrypoint — Step 13
 *
 * Top-level orchestration for the `agent` binary.
 *
 * Startup sequence:
 *   1. Parse argv (--help, --version, --cwd)
 *   2. ensureProjectDir()   — create .agent/ if needed
 *   3. loadConfig()         — merge user + project config
 *   4. loadRegistry()       — scan extensions/ for agents and tools
 *   5. loadMcp()            — spawn configured MCP servers
 *   6. createHarness()      — assemble the Harness with all modes
 *   7. harness.init()       — connect to storage
 *   8. selectOrCreateThread — load or create a conversation thread
 *   9. runTui()             — start the interactive REPL
 *
 * SIGINT (Ctrl-C) triggers a clean shutdown:
 *   - harness.destroy()   — closes open DB connections
 *   - shutdownMcp()       — SIGTERMs all MCP child processes
 *
 * The `--cwd` flag lets users point the agent at a different project directory
 * than the shell's current directory, which is useful for IDE integrations.
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

/** Reads the version from package.json at build time. */
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
    },
    strict: false,
    allowPositionals: true,
  });
  return values as { help?: boolean; version?: boolean; cwd?: string };
}

const HELP_TEXT = `
Usage: agent [options]

Options:
  -h, --help       Show this help message
  -v, --version    Print the version number
  -C, --cwd <dir>  Use a different project directory (default: current directory)

Modes (switch with slash commands inside the REPL):
  /chat               Conversational assistant (read-only)
  /plan               Research and structured planning
  /build              Full implementation with file editing
  /create_environment Create and manage agent/tool extensions

Environment variables (one per provider):
  ANTHROPIC_API_KEY   — anthropic/* models
  OPENAI_API_KEY      — openai/* models
  GOOGLE_GENERATIVE_AI_API_KEY — google/* models
  OPENROUTER_API_KEY  — openrouter/* models

Configuration files:
  ~/.config/terminal-agent/config.json   User-level config
  ./.agent/config.json                   Project-level config (overrides user)

Data:
  ./.agent/data.db   Per-project conversation history (SQLite via LibSQL)
`.trim();

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Entry point — called by bin/agent.js.
 *
 * All errors are caught and printed before exiting with code 1
 * so the shell always sees a clean exit status.
 */
export async function main(): Promise<void> {
  const args = parseArgv();

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.version) {
    console.log(readVersion());
    process.exit(0);
  }

  // Allow the user to point the agent at a different directory
  if (args.cwd) {
    process.chdir(args.cwd);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  // Create .agent/ before anything tries to read/write inside it
  ensureProjectDir();

  const config = await loadConfig();
  const registry = await loadRegistry(config);
  const mcp = await loadMcp(config);

  // Track the active harness — swapped by onHarnessRebuilt when reload_ecosystem fires
  let activeHarness: Harness;

  const { harness } = await createHarness({
    config,
    registry,
    mcp,
    // Called by reload_ecosystem after the new harness is built and initialised.
    // Destroys the old instance and promotes the new one as the active harness.
    onHarnessRebuilt: async (newHarness: Harness) => {
      const prev = activeHarness;
      activeHarness = newHarness;
      try { await prev.destroy(); } catch { /* best-effort */ }
    },
  });

  activeHarness = harness;

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  async function shutdown() {
    console.log('\nShutting down…');
    try {
      await activeHarness.destroy();
    } catch { /* best-effort */ }
    shutdownMcp();
    process.exit(0);
  }

  // Register once; subsequent Ctrl-C calls force-exit after the first one queues
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  // ── Initialise and run ────────────────────────────────────────────────────

  await activeHarness.init();
  await activeHarness.selectOrCreateThread();

  await runTui(activeHarness);

  // runTui resolves when the user types /quit
  await shutdown();
}

// Allow running directly as a module for development
// e.g. `tsx src/cli.ts`
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
