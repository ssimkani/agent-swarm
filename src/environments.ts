/**
 * Environment management — save and restore named snapshots of the extensions directory.
 *
 * A "saved environment" is a timestamped copy of the agents/ and tools/ sub-directories,
 * stored under ~/.config/terminal-agent/saved-environments/<name>/.
 *
 * Slash commands in the TUI call these functions; after loading, the caller is
 * responsible for triggering a registry reload so the new files take effect.
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SAVES_DIR = join(homedir(), '.config', 'terminal-agent', 'saved-environments');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SavedEnvironment {
  name: string;
  savedAt: Date;
  agentCount: number;
  toolCount: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Counts TypeScript/JavaScript files in a directory (non-recursive). */
function countExtFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js')).length;
  } catch {
    return 0;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Snapshots the agents/ and tools/ directories from extensionsDir to a named save slot.
 * Overwrites any existing save with the same name.
 */
export function saveEnvironment(name: string, extensionsDir: string): void {
  if (!/^[\w-]+$/.test(name)) {
    throw new Error('Name must contain only letters, numbers, hyphens, and underscores');
  }

  const destDir = join(SAVES_DIR, name);
  mkdirSync(destDir, { recursive: true });

  for (const sub of ['agents', 'tools'] as const) {
    const src = join(extensionsDir, sub);
    const dst = join(destDir, sub);
    if (existsSync(dst)) rmSync(dst, { recursive: true });
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  }

  writeFileSync(join(destDir, 'meta.json'), JSON.stringify({
    name,
    savedAt: new Date().toISOString(),
    agentCount: countExtFiles(join(extensionsDir, 'agents')),
    toolCount:  countExtFiles(join(extensionsDir, 'tools')),
  }, null, 2));
}

/**
 * Restores extensionsDir from a named save slot, replacing current agents/ and tools/.
 * After calling this, trigger a registry reload so changes take effect.
 */
export function loadEnvironment(name: string, extensionsDir: string): void {
  const srcDir = join(SAVES_DIR, name);
  if (!existsSync(srcDir)) throw new Error(`No saved environment named "${name}"`);

  for (const sub of ['agents', 'tools'] as const) {
    const dst = join(extensionsDir, sub);
    if (existsSync(dst)) rmSync(dst, { recursive: true });
    const src = join(srcDir, sub);
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  }
}

/** Returns all saved environments, newest first. */
export function listEnvironments(): SavedEnvironment[] {
  if (!existsSync(SAVES_DIR)) return [];

  const envs: SavedEnvironment[] = [];

  for (const name of readdirSync(SAVES_DIR)) {
    const envDir = join(SAVES_DIR, name);
    if (!statSync(envDir).isDirectory()) continue;

    let savedAt = new Date(0);
    let agentCount = 0;
    let toolCount  = 0;

    try {
      const meta = JSON.parse(readFileSync(join(envDir, 'meta.json'), 'utf8'));
      savedAt    = new Date(meta.savedAt);
      agentCount = meta.agentCount ?? 0;
      toolCount  = meta.toolCount  ?? 0;
    } catch {
      agentCount = countExtFiles(join(envDir, 'agents'));
      toolCount  = countExtFiles(join(envDir, 'tools'));
    }

    envs.push({ name, savedAt, agentCount, toolCount });
  }

  return envs.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}

/** Permanently removes a saved environment. */
export function deleteEnvironment(name: string): void {
  const dir = join(SAVES_DIR, name);
  if (!existsSync(dir)) throw new Error(`No saved environment named "${name}"`);
  rmSync(dir, { recursive: true });
}
