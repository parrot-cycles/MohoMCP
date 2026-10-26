/**
 * File-based IPC client that communicates with the MOHO Lua server.
 *
 * Protocol:
 * - Bridge writes request to: <ipcDir>/req_<id>.json
 * - MOHO reads the request, processes it, writes: <ipcDir>/resp_<id>.json
 * - MOHO deletes the request file after processing
 * - Bridge reads the response file, then deletes it
 *
 * Request IDs are digits-only safe integers of the form
 * <per-process prefix><6-digit sequence>, so several bridge processes sharing
 * one IPC directory never write the same req_<id>.json / resp_<id>.json.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { parseResponse } from "./protocol.js";
import { startKeepAlive, stopKeepAlive } from "./keep-alive.js";

// ---------------------------------------------------------------------------
// Request IDs
// ---------------------------------------------------------------------------

/**
 * IPC protocol version this bridge speaks. The Lua plugin writes its own as
 * `protocol` in status.json (moho-plugin/moho_mcp/server.lua); they must match.
 * 2 = per-process request ID prefixes, which older plugins cannot find.
 */
export const PROTOCOL_VERSION = 2;

/** Sequence numbers per process run from 1 to SEQ_SPACE - 1, then wrap. */
export const SEQ_SPACE = 1_000_000;

/**
 * Per-process ID prefix: last 5 digits of the pid followed by the last
 * 4 digits of the start time in ms. Concurrent processes never share a pid,
 * and the time part guards against a recycled pid meeting stale files.
 * Max prefix 999_999_999, so prefix * SEQ_SPACE + seq stays below 2^53.
 */
export function makeIdPrefix(pid: number = process.pid, startMs: number = Date.now()): number {
  return (Math.abs(Math.trunc(pid)) % 100_000) * 10_000 + (Math.abs(Math.trunc(startMs)) % 10_000);
}

export interface MohoClientOptions {
  /** Override the per-process ID prefix (tests). */
  idPrefix?: number;
}

/**
 * Refuse to talk to a plugin that speaks another protocol: an older plugin
 * never sees this bridge's request files, so every call would time out.
 */
export function checkProtocol(protocol: unknown): void {
  if (protocol === PROTOCOL_VERSION) return;
  if (typeof protocol !== "number" || protocol < PROTOCOL_VERSION) {
    throw new Error(
      "Moho is running an older MohoMCP plugin " +
        `(protocol ${typeof protocol === "number" ? protocol : "1 or unknown"}, this bridge needs ${PROTOCOL_VERSION}) — ` +
        "restart Moho to load the new one, then start the MohoMCP server again. " +
        "Upgrade the bridge and the plugin together.",
    );
  }
  throw new Error(
    `Moho is running a newer MohoMCP plugin (protocol ${protocol}) than this bridge ` +
      `(protocol ${PROTOCOL_VERSION}) — rebuild the bridge (npm run build) and restart your MCP client.`,
  );
}

// ---------------------------------------------------------------------------
// MohoClient
// ---------------------------------------------------------------------------

export class MohoClient {
  private readonly idPrefix: number;
  private seq = 0;
  private connected = false;

  constructor(options: MohoClientOptions = {}) {
    this.idPrefix = options.idPrefix ?? makeIdPrefix();
  }

  /** Next digits-only request ID, unique across concurrent bridge processes. */
  nextRequestId(): number {
    this.seq = (this.seq % (SEQ_SPACE - 1)) + 1;
    return this.idPrefix * SEQ_SPACE + this.seq;
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /**
   * "Connect" by verifying the IPC directory exists and MOHO's status file
   * indicates the server is running.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const { ipcDir } = config.moho;

    // Ensure the IPC directory exists
    try {
      await fs.promises.mkdir(ipcDir, { recursive: true });
    } catch {
      // directory may already exist
    }

    // Check for MOHO's status file
    const statusPath = path.join(ipcDir, "status.json");
    try {
      const content = await fs.promises.readFile(statusPath, "utf-8");
      const status = JSON.parse(content);
      if (!status.running) {
        throw new Error("MOHO MCP server is not running (status.running=false)");
      }
      checkProtocol(status.protocol);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `MOHO MCP server is not running. No status file found at ${statusPath}. ` +
          "Start the MohoMCP Server from MOHO's Scripts menu first.",
        );
      }
      throw err;
    }

    this.connected = true;
    startKeepAlive();
    process.stderr.write(
      `[moho-mcp] Connected to MOHO via file IPC at ${ipcDir}\n`,
    );
  }

  /**
   * Disconnect — no-op for file IPC but resets state.
   */
  disconnect(): void {
    stopKeepAlive();
    this.connected = false;
  }

  /**
   * Returns whether the client is "connected" (IPC dir verified).
   */
  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // Request / response
  // -----------------------------------------------------------------------

  /**
   * Send a JSON-RPC request to MOHO via file IPC and await the response.
   */
  async sendRequest(
    method: string,
    params: Record<string, unknown> = {},
    options?: { timeout?: number },
  ): Promise<unknown> {
    if (!this.connected) {
      throw new Error(
        "Not connected to MOHO. Is the MOHO application running with the MCP plugin loaded?",
      );
    }

    const id = this.nextRequestId();
    const { ipcDir, pollInterval, requestTimeout } = config.moho;
    const timeout = options?.timeout ?? requestTimeout;

    // Build JSON-RPC request
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const reqFileName = `req_${id}.json`;
    const respFileName = `resp_${id}.json`;
    const reqPath = path.join(ipcDir, reqFileName);
    const respPath = path.join(ipcDir, respFileName);

    // Write request file atomically (write to .tmp then rename)
    const tmpPath = reqPath + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(request), "utf-8");
    await fs.promises.rename(tmpPath, reqPath);

    // Poll for response file
    const startTime = Date.now();

    while (true) {
      // Check if response file exists
      try {
        const content = await fs.promises.readFile(respPath, "utf-8");
        // Delete response file
        await fs.promises.unlink(respPath).catch(() => {});

        // Parse and return
        const response = parseResponse(content);

        if (response.error) {
          throw new Error(
            `MOHO error [${response.error.code}]: ${response.error.message}${
              response.error.data
                ? ` (${JSON.stringify(response.error.data)})`
                : ""
            }`,
          );
        }

        return response.result;
      } catch (err) {
        // File doesn't exist yet — keep polling
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Check timeout
          if (Date.now() - startTime > timeout) {
            // Clean up the request file if it's still there
            await fs.promises.unlink(reqPath).catch(() => {});
            throw new Error(
              `Request ${method} (id=${id}) timed out after ${timeout}ms. ` +
              "Is the MOHO MCP server running and polling?",
            );
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          continue;
        }

        // Re-throw non-ENOENT errors (parse errors, MOHO errors, etc.)
        throw err;
      }
    }
  }
}
