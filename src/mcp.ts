/**
 * MCP loader — Step 6
 *
 * Reads the `mcpServers` map from config and spawns each server as a stdio
 * child process using the Model Context Protocol SDK. Tools from each server
 * are namespaced as "<serverName>__<toolName>" to avoid collisions when
 * multiple servers expose tools with the same name.
 *
 * MCP servers run as long-lived child processes. Call `shutdownMcp()` on
 * process exit to send SIGTERM to all spawned servers.
 *
 * If no mcpServers are configured, `loadMcp()` returns an empty toolset map
 * immediately without spawning any processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from './config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single MCP tool callable by agents.
 * Matches the shape createTool produces so it can be passed directly into
 * the Harness's `tools` config.
 */
export interface McpTool {
  id: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: unknown) => Promise<any>;
}

/**
 * The return value of `loadMcp()`.
 * Keys are server names from config; values are maps of namespaced tool names
 * to tool objects.
 */
export type McpToolsets = Record<string, Record<string, McpTool>>;

// ── MCP JSON-RPC client ───────────────────────────────────────────────────────

/** Minimal JSON-RPC 2.0 message shape used over stdio. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Raw tool descriptor returned by the MCP `tools/list` method. */
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Minimal stdio MCP client.
 *
 * Communicates with the child process via newline-delimited JSON-RPC over
 * stdin/stdout. Each request gets a unique integer ID; the response queue
 * maps IDs to Promise resolvers so concurrent calls work correctly.
 */
class StdioMcpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (res: JsonRpcResponse) => void>();
  private buffer = '';

  constructor(proc: ChildProcess) {
    this.proc = proc;

    // Accumulate stdout chunks and flush complete newline-delimited JSON lines
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      // The last element may be an incomplete line — keep it in the buffer
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        } catch {
          // Ignore non-JSON output (e.g. server startup logs on stdout)
        }
      }
    });
  }

  /** Sends a JSON-RPC request and awaits the matching response. */
  call(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pending.set(id, (res) => {
        if (res.error) reject(new Error(res.error.message));
        else resolve(res.result);
      });
      // Write request to the server's stdin, newline-terminated
      this.proc.stdin?.write(JSON.stringify(req) + '\n');
    });
  }

  /** Terminates the child process. */
  kill() {
    this.proc.kill('SIGTERM');
  }
}

// ── Module-level process registry for shutdown ────────────────────────────────

/** All live MCP clients, keyed by server name, for coordinated shutdown. */
const activeClients = new Map<string, StdioMcpClient>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Spawns all configured MCP servers and fetches their tool lists.
 *
 * For each server:
 *   1. Spawn the command as a child process
 *   2. Send `initialize` + `tools/list` over JSON-RPC
 *   3. Build a callable McpTool for each tool, namespaced "<server>__<tool>"
 *
 * Returns an empty object if `config.mcpServers` is empty.
 */
export async function loadMcp(config: Config): Promise<McpToolsets> {
  const toolsets: McpToolsets = {};

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers) as [string, { command: string; args?: string[]; env?: Record<string, string> }][]) {
    try {
      // Spawn the MCP server process
      const proc = spawn(serverConfig.command, serverConfig.args ?? [], {
        stdio: ['pipe', 'pipe', 'inherit'], // pipe stdin/stdout, inherit stderr for logs
        env: { ...process.env, ...serverConfig.env },
      });

      const client = new StdioMcpClient(proc);
      activeClients.set(serverName, client);

      // MCP handshake: initialize then list tools
      await client.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agent-swarm', version: '1.0.0' },
      });

      const listResult = await client.call('tools/list') as { tools?: McpToolDescriptor[] };
      const mcpTools = listResult.tools ?? [];

      // Build a callable McpTool for each descriptor
      const serverTools: Record<string, McpTool> = {};
      for (const descriptor of mcpTools) {
        // Namespace the tool name to avoid collisions across servers
        const toolId = `${serverName}__${descriptor.name}`;

        serverTools[toolId] = {
          id: toolId,
          description: descriptor.description ?? descriptor.name,
          inputSchema: descriptor.inputSchema,
          execute: async (input: unknown) => {
            // Forward the call to the server via JSON-RPC
            return client.call('tools/call', {
              name: descriptor.name,
              arguments: input,
            });
          },
        };
      }

      toolsets[serverName] = serverTools;
      console.log(`[mcp] Loaded ${mcpTools.length} tool(s) from server "${serverName}"`);
    } catch (err) {
      // A failing server should not block startup; other servers still work
      console.warn(`[mcp] Failed to load server "${serverName}":`, err);
    }
  }

  return toolsets;
}

/**
 * Sends SIGTERM to all spawned MCP server processes.
 * Call this during SIGINT / process exit to avoid orphaned child processes.
 */
export function shutdownMcp(): void {
  for (const [name, client] of activeClients) {
    try {
      client.kill();
    } catch {
      // Best-effort
    }
    activeClients.delete(name);
  }
}
