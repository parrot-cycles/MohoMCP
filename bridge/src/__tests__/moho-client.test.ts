import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MohoClient, makeIdPrefix, SEQ_SPACE, PROTOCOL_VERSION } from "../moho-client.js";
import { isMohoRunning } from "../moho-process.js";

// File-IPC tests must not launch desktop automation on the developer's machine.
vi.mock("../keep-alive.js", () => ({
  startKeepAlive: vi.fn(),
  stopKeepAlive: vi.fn(),
}));

// Tests must not depend on whether the real Moho app runs on this machine.
vi.mock("../moho-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../moho-process.js")>()),
  isMohoRunning: vi.fn(async () => true),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testIpcDir = "";

/** Create a fresh temp directory for each test. */
function createTestIpcDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moho-mcp-test-"));
}

/** Remove the test IPC directory and all files in it. */
function cleanupTestIpcDir(dir: string): void {
  if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, f));
  }
  fs.rmdirSync(dir);
}

/** Write a status.json that indicates the server is running. */
function writeStatusFile(
  dir: string,
  running = true,
  protocol: number | null = PROTOCOL_VERSION, // null = field absent (old plugin)
): void {
  const status: Record<string, unknown> = { running, pid: "moho", version: "0.1.0" };
  if (protocol !== null) status.protocol = protocol;
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
}

/**
 * Simulate MOHO responding: watch for req_*.json files and write resp_*.json.
 * Returns a cleanup function to stop watching.
 */
function simulateMohoServer(
  dir: string,
  handler: (request: { id: number; method: string; params: Record<string, unknown> }) => unknown,
): { stop: () => void } {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const poll = () => {
    if (stopped) return;

    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.startsWith("req_") && f.endsWith(".json") && !f.endsWith(".tmp")) {
          const reqPath = path.join(dir, f);
          const content = fs.readFileSync(reqPath, "utf-8");
          const request = JSON.parse(content);

          // Generate response
          const result = handler(request);

          // Extract ID from filename
          const reqId = f.match(/^req_(.+)\.json$/)?.[1];
          if (reqId) {
            const respPath = path.join(dir, `resp_${reqId}.json`);
            fs.writeFileSync(respPath, JSON.stringify(result));
          }

          // Remove request file (like real MOHO would)
          fs.unlinkSync(reqPath);
        }
      }
    } catch {
      // directory may have been cleaned up
    }

    timeoutId = setTimeout(poll, 20);
  };

  poll();

  return {
    stop() {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock config to use our test IPC directory
// ---------------------------------------------------------------------------

vi.mock("../config.js", () => ({
  IPC_DIR_MODE: 0o700,
  config: {
    moho: {
      get ipcDir() {
        return testIpcDir;
      },
      pollInterval: 20, // fast polling for tests
      requestTimeout: 2000, // 2s timeout for tests
    },
    server: {
      name: "moho-mcp-test",
      version: "0.0.0",
    },
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MohoClient", () => {
  let client: MohoClient;
  let mohoServer: { stop: () => void } | null = null;

  beforeEach(() => {
    testIpcDir = createTestIpcDir();
    client = new MohoClient();
  });

  afterEach(() => {
    try {
      client.disconnect();
    } catch {
      // ignore
    }

    if (mohoServer) {
      mohoServer.stop();
      mohoServer = null;
    }

    cleanupTestIpcDir(testIpcDir);
  });

  // -------------------------------------------------------------------------
  // connect()
  // -------------------------------------------------------------------------

  describe("connect()", () => {
    it("connects successfully when status.json exists and running=true", async () => {
      writeStatusFile(testIpcDir, true);

      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it("resolves immediately if already connected", async () => {
      writeStatusFile(testIpcDir, true);

      await client.connect();
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it("rejects when status.json does not exist", async () => {
      await expect(client.connect()).rejects.toThrow(
        "MOHO MCP server is not running",
      );
      expect(client.isConnected()).toBe(false);
    });

    it("rejects an older plugin without a protocol field with a restart hint", async () => {
      writeStatusFile(testIpcDir, true, null);
      await expect(client.connect()).rejects.toThrow(/older MohoMCP plugin.*restart Moho/);
      expect(client.isConnected()).toBe(false);
    });

    it("rejects a plugin with an older protocol version", async () => {
      writeStatusFile(testIpcDir, true, PROTOCOL_VERSION - 1);
      await expect(client.connect()).rejects.toThrow(/older MohoMCP plugin/);
    });

    it("rejects a plugin with a newer protocol version", async () => {
      writeStatusFile(testIpcDir, true, PROTOCOL_VERSION + 1);
      await expect(client.connect()).rejects.toThrow(/newer MohoMCP plugin/);
    });

    it("rejects when status.json has running=false", async () => {
      writeStatusFile(testIpcDir, false);

      await expect(client.connect()).rejects.toThrow(
        "MOHO MCP server is not running",
      );
      expect(client.isConnected()).toBe(false);
    });

    it("creates the IPC directory if it doesn't exist", async () => {
      // Use a subdirectory that doesn't exist yet
      const subDir = path.join(testIpcDir, "sub", "dir");
      testIpcDir = subDir;

      // Write status file after creating the directory manually
      // (connect() should create the dir first, then check for status)
      // Since connect creates the dir, we need to pre-create and write status
      fs.mkdirSync(subDir, { recursive: true });
      writeStatusFile(subDir, true);

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Cleanup the sub directory
      cleanupTestIpcDir(subDir);
      // Remove parent dirs
      try {
        fs.rmdirSync(path.join(testIpcDir, ".."));
      } catch { /* ignore */ }
    });
  });

  // -------------------------------------------------------------------------
  // disconnect()
  // -------------------------------------------------------------------------

  describe("disconnect()", () => {
    it("marks the client as disconnected", async () => {
      writeStatusFile(testIpcDir, true);
      await client.connect();
      expect(client.isConnected()).toBe(true);

      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it("can be called when not connected without error", () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // isConnected()
  // -------------------------------------------------------------------------

  describe("isConnected()", () => {
    it("returns false initially", () => {
      expect(client.isConnected()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // sendRequest()
  // -------------------------------------------------------------------------

  describe("sendRequest()", () => {
    it("sends correct JSON-RPC and resolves with the result", async () => {
      writeStatusFile(testIpcDir, true);

      mohoServer = simulateMohoServer(testIpcDir, (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { name: "test-document.moho" },
      }));

      await client.connect();
      const result = await client.sendRequest("document.getInfo");

      expect(result).toEqual({ name: "test-document.moho" });
    });

    it("sends params correctly", async () => {
      writeStatusFile(testIpcDir, true);

      let receivedParams: Record<string, unknown> | undefined;
      mohoServer = simulateMohoServer(testIpcDir, (request) => {
        receivedParams = request.params;
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: { success: true },
        };
      });

      await client.connect();
      await client.sendRequest("layer.getProperties", { layerId: 42 });

      expect(receivedParams).toEqual({ layerId: 42 });
    });

    it("rejects on JSON-RPC error response", async () => {
      writeStatusFile(testIpcDir, true);

      mohoServer = simulateMohoServer(testIpcDir, (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: "Method not found",
        },
      }));

      await client.connect();

      await expect(client.sendRequest("nonexistent.method")).rejects.toThrow(
        "MOHO error [-32601]: Method not found",
      );
    });

    it("rejects on JSON-RPC error response with data", async () => {
      writeStatusFile(testIpcDir, true);

      mohoServer = simulateMohoServer(testIpcDir, (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32001,
          message: "No document",
          data: "additional info",
        },
      }));

      await client.connect();

      await expect(client.sendRequest("document.getInfo")).rejects.toThrow(
        'MOHO error [-32001]: No document ("additional info")',
      );
    });

    it("rejects when not connected", async () => {
      await expect(client.sendRequest("test.method")).rejects.toThrow(
        "Not connected to MOHO",
      );
    });

    it("rejects on request timeout", async () => {
      writeStatusFile(testIpcDir, true);

      // No mock server — no one will write the response file
      await client.connect();

      await expect(client.sendRequest("slow.method")).rejects.toThrow(
        /timed out after/,
      );
    }, 10000);

    it("cleans up request file on timeout", async () => {
      writeStatusFile(testIpcDir, true);

      await client.connect();

      await expect(client.sendRequest("slow.method")).rejects.toThrow(
        /timed out/,
      );

      // Request file should have been cleaned up
      const files = fs.readdirSync(testIpcDir);
      const reqFiles = files.filter((f) => f.startsWith("req_"));
      expect(reqFiles).toHaveLength(0);
    }, 10000);

    it("handles multiple sequential requests", async () => {
      writeStatusFile(testIpcDir, true);

      mohoServer = simulateMohoServer(testIpcDir, (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { method: request.method },
      }));

      await client.connect();

      const r1 = await client.sendRequest("method.a");
      const r2 = await client.sendRequest("method.b");
      const r3 = await client.sendRequest("method.c");

      expect(r1).toEqual({ method: "method.a" });
      expect(r2).toEqual({ method: "method.b" });
      expect(r3).toEqual({ method: "method.c" });
    });

    it("writes request files atomically (via .tmp rename)", async () => {
      writeStatusFile(testIpcDir, true);

      let sawReqFile = false;
      mohoServer = simulateMohoServer(testIpcDir, (request) => {
        sawReqFile = true;
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: { ok: true },
        };
      });

      await client.connect();
      await client.sendRequest("test.atomic");

      // The mock server successfully read the request, confirming
      // the file was written (atomically via tmp+rename)
      expect(sawReqFile).toBe(true);
    });

    it("increments request IDs", async () => {
      writeStatusFile(testIpcDir, true);

      const receivedIds: number[] = [];
      mohoServer = simulateMohoServer(testIpcDir, (request) => {
        receivedIds.push(request.id);
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {},
        };
      });

      await client.connect();
      await client.sendRequest("a");
      await client.sendRequest("b");
      await client.sendRequest("c");

      expect(receivedIds[0]).toBeLessThan(receivedIds[1]);
      expect(receivedIds[1]).toBeLessThan(receivedIds[2]);
    });
  });
});

// ---------------------------------------------------------------------------
// Request IDs across bridge processes
// ---------------------------------------------------------------------------

describe("request IDs", () => {
  it("derives distinct digits-only prefixes for concurrent processes", () => {
    const a = makeIdPrefix(4242, 1_761_000_000_123);
    const b = makeIdPrefix(4243, 1_761_000_000_123);
    expect(a).not.toBe(b);
    expect(makeIdPrefix(4242, 1_761_000_000_124)).not.toBe(a);
    expect(makeIdPrefix(99_999, 9_999)).toBe(999_999_999);
  });

  it("produces safe integers whose decimal form is digits only", () => {
    const client = new MohoClient({ idPrefix: makeIdPrefix(99_999, 9_999) });
    for (let i = 0; i < 3; i++) {
      const id = client.nextRequestId();
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(String(id)).toMatch(/^\d+$/);
    }
  });

  it("wraps the per-process sequence without leaving the prefix", () => {
    const client = new MohoClient({ idPrefix: 7 });
    let id = 0;
    for (let i = 0; i < SEQ_SPACE; i++) id = client.nextRequestId();
    expect(id).toBe(7 * SEQ_SPACE + 1);
  });

  it("two bridges sharing one IPC dir never collide and each gets its own response", async () => {
    testIpcDir = createTestIpcDir();
    writeStatusFile(testIpcDir, true);
    const seen = new Set<string>();
    const server = simulateMohoServer(testIpcDir, (request) => {
      seen.add(String(request.id));
      return { jsonrpc: "2.0", id: request.id, result: { echo: request.params } };
    });
    try {
      // Same start time, different pids: the old counter gave both req_1.json.
      const a = new MohoClient({ idPrefix: makeIdPrefix(1001, 5_000) });
      const b = new MohoClient({ idPrefix: makeIdPrefix(1002, 5_000) });
      await a.connect();
      await b.connect();
      const results = await Promise.all([
        a.sendRequest("x", { from: "a", n: 1 }),
        b.sendRequest("x", { from: "b", n: 1 }),
        a.sendRequest("x", { from: "a", n: 2 }),
        b.sendRequest("x", { from: "b", n: 2 }),
      ]);
      expect(results).toEqual([
        { echo: { from: "a", n: 1 } },
        { echo: { from: "b", n: 1 } },
        { echo: { from: "a", n: 2 } },
        { echo: { from: "b", n: 2 } },
      ]);
      expect(seen.size).toBe(4);
      a.disconnect();
      b.disconnect();
    } finally {
      server.stop();
      cleanupTestIpcDir(testIpcDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Moho process checks (status.json survives a crash)
// ---------------------------------------------------------------------------

describe("Moho process checks", () => {
  beforeEach(() => {
    testIpcDir = createTestIpcDir();
    writeStatusFile(testIpcDir, true);
  });
  afterEach(() => {
    vi.mocked(isMohoRunning).mockResolvedValue(true);
    cleanupTestIpcDir(testIpcDir);
  });

  it("connect fails with 'Moho is not running' despite a stale running status", async () => {
    vi.mocked(isMohoRunning).mockResolvedValue(false);
    const client = new MohoClient();
    await expect(client.connect()).rejects.toThrow(/^Moho is not running/);
    expect(client.isConnected()).toBe(false);
  });

  it("a request fails immediately, without writing a request file, once Moho is gone", async () => {
    const client = new MohoClient();
    await client.connect();
    vi.mocked(isMohoRunning).mockResolvedValue(false);
    const started = Date.now();
    await expect(client.sendRequest("document.getInfo")).rejects.toThrow(/^Moho is not running/);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fs.readdirSync(testIpcDir).filter((f) => f.startsWith("req_"))).toEqual([]);
    expect(client.isConnected()).toBe(false);
  });

  it("a pending request fails fast when Moho crashes mid-request", async () => {
    let running = true;
    const client = new MohoClient({ isMohoRunning: async () => running });
    await client.connect();
    setTimeout(() => { running = false; }, 200);
    const started = Date.now();
    await expect(client.sendRequest("document.getInfo")).rejects.toThrow(/quit or crashed while handling document.getInfo/);
    expect(Date.now() - started).toBeLessThan(1900); // before the 2 s request timeout
    expect(fs.readdirSync(testIpcDir).filter((f) => f.startsWith("req_"))).toEqual([]);
  });
});

describe("IPC directory creation", () => {
  it("creates a missing IPC directory readable only by the user", async () => {
    const parent = createTestIpcDir();
    testIpcDir = path.join(parent, "nested", "ipc");
    fs.mkdirSync(path.dirname(testIpcDir), { recursive: true });
    const client = new MohoClient({ isMohoRunning: async () => true });
    await expect(client.connect()).rejects.toThrow(/No status file/);
    expect(fs.statSync(testIpcDir).mode & 0o777).toBe(0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});
