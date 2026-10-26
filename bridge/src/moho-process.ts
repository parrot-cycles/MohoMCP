/**
 * Is the Moho application actually running?
 *
 * status.json is written by the plugin when its server starts and stays
 * `running: true` after Moho crashes or quits, so it cannot be trusted alone.
 * On macOS ask LaunchServices for a running app with Moho's bundle id
 * (`lsappinfo find bundleid=com.lostmarble.moho`, ~10 ms, independent of the
 * executable name). If that check cannot run, warn once and assume Moho is
 * running rather than blocking requests. Other platforms are not checked
 * (always true) so their behaviour is unchanged.
 */

import { execFile } from "node:child_process";
import { MOHO_BUNDLE_ID } from "./keep-alive.js";

export const MOHO_NOT_RUNNING =
  "Moho is not running. Start Moho, open a document and choose Scripts > MohoMCP Server, then try again.";

type Runner = (cmd: string, args: string[]) => Promise<string>;

const runFile: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

let warned = false;

export async function isMohoRunning(
  bundleId: string = MOHO_BUNDLE_ID,
  platform: NodeJS.Platform = process.platform,
  run: Runner = runFile,
): Promise<boolean> {
  if (platform !== "darwin") return true;
  try {
    const out = await run("lsappinfo", ["find", `bundleid=${bundleId}`]);
    return /ASN:/.test(out);
  } catch (err) {
    if (!warned) {
      warned = true;
      process.stderr.write(
        `[moho-mcp] WARNING: could not check whether Moho is running (${(err as Error).message}); ` +
          "assuming it is.\n",
      );
    }
    return true;
  }
}

/** Test hook: allow the next failure to warn again. */
export function resetMohoProcessWarning(): void {
  warned = false;
}
