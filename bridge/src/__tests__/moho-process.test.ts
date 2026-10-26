import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { isMohoRunning } from "../moho-process.js";

describe("isMohoRunning", () => {
  it("does not check on other platforms", async () => {
    expect(await isMohoRunning("NoSuchProcessXyz", "win32")).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")("matches an exact process name with pgrep", async () => {
    expect(await isMohoRunning("NoSuchProcessXyz", "darwin")).toBe(false);
    const sleeper = spawn("sleep", ["10"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await isMohoRunning("sleep", "darwin")).toBe(true);
      expect(await isMohoRunning("slee", "darwin")).toBe(false);
    } finally {
      sleeper.kill();
    }
  });
});
