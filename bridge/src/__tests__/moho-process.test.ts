import { describe, it, expect, vi, afterEach } from "vitest";
import { isMohoRunning, resetMohoProcessWarning } from "../moho-process.js";

describe("isMohoRunning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMohoProcessWarning();
  });

  it("does not check on other platforms", async () => {
    expect(await isMohoRunning("com.example.none", "win32")).toBe(true);
  });

  it("asks LaunchServices by bundle id", async () => {
    const run = vi.fn(async () => 'ASN:0x0-0x2bdebdc-"Moho":\n');
    expect(await isMohoRunning(undefined, "darwin", run)).toBe(true);
    expect(run).toHaveBeenCalledWith("lsappinfo", ["find", "bundleid=com.lostmarble.moho"]);
    expect(await isMohoRunning(undefined, "darwin", async () => "\n")).toBe(false);
  });

  it("warns once and assumes Moho is running when the check cannot run", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const broken = async (): Promise<string> => {
      throw new Error("spawn lsappinfo ENOENT");
    };
    expect(await isMohoRunning(undefined, "darwin", broken)).toBe(true);
    expect(await isMohoRunning(undefined, "darwin", broken)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain("could not check whether Moho is running");
  });

  it.skipIf(process.platform !== "darwin")("real lsappinfo: finds a running app and not a missing one", async () => {
    expect(await isMohoRunning("com.example.no-such-moho", "darwin")).toBe(false);
    expect(await isMohoRunning("com.apple.finder", "darwin")).toBe(true);
  });
});
