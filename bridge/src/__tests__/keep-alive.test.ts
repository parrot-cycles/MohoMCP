import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import {
  startKeepAlive, stopKeepAlive, MACOS_KEEPALIVE_JXA, MOHO_BUNDLE_ID, NO_EVENT_ACCESS_TOKEN, noEventAccessMessage,
} from "../keep-alive.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("keep-alive lifecycle", () => {
  let directory: string;
  let originalDirectory: string;
  let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "moho-keep-alive-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(directory);
    originalDirectory = config.moho.ipcDir;
    Object.assign(config.moho, { ipcDir: directory });
    child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.spyOn(os, "platform").mockReturnValue("darwin");
  });

  afterEach(() => {
    stopKeepAlive();
    Object.assign(config.moho, { ipcDir: originalDirectory });
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("passes the configured IPC directory as data to a persistent macOS JXA helper", () => {
    Object.assign(config.moho, { ipcDir: path.join(directory, 'custom "quoted" IPC') });
    startKeepAlive();
    const scriptPath = path.join(config.moho.ipcDir, `keep-alive-${process.pid}.js`);
    expect(spawn).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", scriptPath, config.moho.ipcDir, "com.lostmarble.moho", String(process.pid)],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
    expect(MOHO_BUNDLE_ID).toBe("com.lostmarble.moho");
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toBe(MACOS_KEEPALIVE_JXA);
    expect(script).not.toContain(config.moho.ipcDir);
  });

  it("nudges Moho by pid with a mouseMoved event and never launches or activates it", () => {
    expect(MACOS_KEEPALIVE_JXA).toContain("CGEventPostToPid");
    expect(MACOS_KEEPALIVE_JXA).toContain("CGEventCreateMouseEvent(null, 5,");
    expect(MACOS_KEEPALIVE_JXA).toContain("runningApplications");
    expect(MACOS_KEEPALIVE_JXA).toContain("bundleIdentifier");
    expect(MACOS_KEEPALIVE_JXA).toContain("var bundleId = argv[1] || 'com.lostmarble.moho';");
    expect(MACOS_KEEPALIVE_JXA).toContain("MAX_REQUEST_AGE = 60");
    expect(MACOS_KEEPALIVE_JXA).toContain("/^req_\\d+\\.json$/");
    expect(MACOS_KEEPALIVE_JXA).not.toMatch(/activate|launch|tell application|openApplication|CFRelease/i);
  });

  it("warns on stderr when the helper reports it may not post events", () => {
    const stderr = new EventEmitter();
    Object.assign(child, { stderr });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    startKeepAlive();
    stderr.emit("data", Buffer.from(NO_EVENT_ACCESS_TOKEN + "\n"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("WARNING: grant Accessibility to"));
    expect(noEventAccessMessage({ __CFBundleIdentifier: "com.anthropic.claudefordesktop" })).toMatch(
      /^grant Accessibility to com\.anthropic\.claudefordesktop .*wake Moho/,
    );
  });

  it("does not spawn duplicate helpers and cleans up on disconnect", () => {
    startKeepAlive();
    startKeepAlive();
    expect(spawn).toHaveBeenCalledTimes(1);
    const scriptPath = path.join(directory, `keep-alive-${process.pid}.js`);
    expect(fs.existsSync(scriptPath)).toBe(true);
    stopKeepAlive();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(scriptPath)).toBe(false);
    stopKeepAlive();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("can restart after the helper exits", () => {
    startKeepAlive();
    child.emit("exit", 0);
    startKeepAlive();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps the Windows helper backend with a custom IPC directory", () => {
    vi.mocked(os.platform).mockReturnValue("win32");
    startKeepAlive();
    expect(spawn).toHaveBeenCalledWith("powershell", expect.arrayContaining([
      "-File", path.join(directory, "keep-alive.ps1"),
    ]), expect.any(Object));
    expect(fs.existsSync(path.join(directory, "keep-alive.ps1"))).toBe(true);
  });
});
