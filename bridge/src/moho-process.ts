/**
 * Is the Moho application actually running?
 *
 * status.json is written by the plugin when its server starts and stays
 * `running: true` after Moho crashes or quits, so it cannot be trusted alone.
 * On macOS ask the process table (pgrep -x Moho). Other platforms are not
 * checked (always true) so their behaviour is unchanged.
 */

import { execFile } from "node:child_process";

export const MOHO_PROCESS_NAME = "Moho";

export const MOHO_NOT_RUNNING =
  "Moho is not running. Start Moho, open a document and choose Scripts > MohoMCP Server, then try again.";

export function isMohoRunning(
  name: string = MOHO_PROCESS_NAME,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "darwin") return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", name], (err) => {
      if (!err) return resolve(true);
      // pgrep exits 1 when nothing matched; any other failure (pgrep missing,
      // sandbox) must not block requests.
      resolve((err as { code?: unknown }).code !== 1);
    });
  });
}
