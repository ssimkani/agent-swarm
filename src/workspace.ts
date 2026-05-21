/**
 * Storage and workspace factory — Step 4
 *
 * Provides two things the Harness needs:
 *
 *   1. `createStorage()` — A LibSQLStore-backed MastraCompositeStore that persists
 *      threads and messages to a local SQLite file at <cwd>/.agent/data.db.
 *      Threads are therefore scoped per-project (each project directory has its own DB).
 *
 *   2. `createMemory()` — A Memory instance wired to the same storage backend so
 *      conversation history is available across sessions.
 *
 * Workspace filesystem integration is intentionally omitted here; the Harness
 * can receive a WorkspaceConfig directly when one is needed (e.g. for future
 * LocalFilesystem integration). Keeping storage separate from workspace avoids
 * taking on optional filesystem dependencies in the base package.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * Creates the LibSQL storage backend for this project.
 *
 * The DB file lives at <cwd>/.agent/data.db so each project directory maintains
 * its own independent conversation history and thread list — no cross-project
 * state leaks.
 *
 * The .agent/ directory is created if it doesn't already exist.
 */
export function createStorage(): LibSQLStore {
  const agentDir = join(process.cwd(), '.agent');
  // Ensure the directory exists before LibSQL tries to open the file
  mkdirSync(agentDir, { recursive: true });

  return new LibSQLStore({
    id: join(agentDir, 'data.db'),
    url: `file:${join(agentDir, 'data.db')}`,
  });
}

// ── Memory ────────────────────────────────────────────────────────────────────

/**
 * Creates the Memory instance that the Harness uses for conversation history.
 *
 * Memory is backed by the same LibSQL store so messages are durable between
 * process restarts. The last-N-messages window keeps context manageable without
 * a fixed token limit (the Harness handles token accounting separately).
 *
 * @param storage - The LibSQLStore returned by `createStorage()`.
 */
export function createMemory(storage: LibSQLStore): Memory {
  return new Memory({
    storage,
    // Keep the most recent 50 messages in the active context window.
    // Older messages are preserved in storage but not sent to the model.
    options: {
      lastMessages: 50,
    },
  });
}

// ── Project directory bootstrap ───────────────────────────────────────────────

/**
 * Ensures the .agent/ project directory exists.
 * Called at CLI startup before storage or config are read.
 */
export function ensureProjectDir(): void {
  mkdirSync(join(process.cwd(), '.agent'), { recursive: true });
}
