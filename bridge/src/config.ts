import path from "node:path";
import os from "node:os";

/**
 * IPC directory, per user, never the shared /tmp. Must match the plugin's
 * getIpcDir (moho-plugin/moho_mcp/server.lua): TEMP, TMP, TMPDIR, then
 * ~/.moho-mcp. MOHO_MCP_IPC_DIR overrides it.
 */
export function defaultIpcDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (env.MOHO_MCP_IPC_DIR) return env.MOHO_MCP_IPC_DIR;
  const tmp = env.TEMP || env.TMP || env.TMPDIR;
  if (tmp) return path.join(tmp, "moho-mcp");
  return path.join(home, ".moho-mcp");
}

/** Created with this mode when missing: only the owner may read or write. */
export const IPC_DIR_MODE = 0o700;

export const config = {
  moho: {
    ipcDir: defaultIpcDir(),
    pollInterval: 100,      // ms between checking for response files
    requestTimeout: 10000,  // ms before a request times out
    renderTimeout: 30000,   // ms timeout for render/screenshot requests
    luaRunTimeout: 30000,   // ms timeout for lua.run (Lua side stops chunks after 20 s)
    batchBudgetMs: 25000,   // total time the plugin allows one batch (moho_mcp/tools/batch.lua)
    batchTimeoutPerOp: 500, // additional ms per operation in a batch
    maxBatchSize: 50,       // maximum number of operations in a single batch
  },
  server: {
    name: "moho-mcp",
    version: "0.1.0",
  },
} as const;
