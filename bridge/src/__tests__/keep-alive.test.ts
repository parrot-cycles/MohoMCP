import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import {
  startKeepAlive, stopKeepAlive, MACOS_KEEPALIVE_JXA, MOHO_BUNDLE_ID, NO_EVENT_ACCESS_TOKEN, NO_AX_ACCESS_TOKEN,
  noEventAccessMessage, MOHO_SERVER_MENU_ITEM, MOHO_MENU_FOLDER,
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
    expect(MACOS_KEEPALIVE_JXA).toContain('var BUNDLE_ID = "com.lostmarble.moho";');
    expect(MACOS_KEEPALIVE_JXA).toContain("var bundleId = argv[1] || BUNDLE_ID;");
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

  it("warns once when the helper reports it is not trusted for Accessibility", () => {
    const stderr = new EventEmitter();
    Object.assign(child, { stderr });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    startKeepAlive();
    stderr.emit("data", Buffer.from(NO_AX_ACCESS_TOKEN + "\n"));
    stderr.emit("data", Buffer.from(NO_EVENT_ACCESS_TOKEN + "\n"));
    const warnings = write.mock.calls.filter((c) => String(c[0]).includes("grant Accessibility"));
    expect(warnings).toHaveLength(1);
  });

  it("only reads the menu item: no AX actions, clicks or key events", () => {
    expect(MACOS_KEEPALIVE_JXA).toContain("AXUIElementCopyAttributeValue");
    expect(MACOS_KEEPALIVE_JXA).toContain("'AXEnabled'");
    expect(MACOS_KEEPALIVE_JXA).not.toMatch(/PerformAction|AXPress|SetAttributeValue|click|keystroke|CGEventCreateKeyboardEvent/i);
    // The menu-bar item is found by content, not by the localized "Scripts" title.
    expect(MACOS_KEEPALIVE_JXA).not.toContain("Scripts");
  });

  it("looks up the server menu item by the plugin's own UILabel", () => {
    const lua = fs.readFileSync(path.resolve(__dirname, "../../../moho-plugin/MohoMCP_Server.lua"), "utf8");
    expect(lua).toContain(`return "${MOHO_SERVER_MENU_ITEM}"`);
    expect(MOHO_MENU_FOLDER).toBe("MohoMCP");
  });

  describe("Moho pid cache (real helper code, stubbed ObjC)", () => {
    function load(env: { running: boolean; walks: { n: number } }) {
      const moho = { bundleIdentifier: "com.lostmarble.moho", processIdentifier: 42 };
      const $ = {
        NSWorkspace: {
          sharedWorkspace: {
            get runningApplications() {
              env.walks.n++;
              const list = env.running ? [moho] : [];
              return { count: list.length, objectAtIndex: (i: number) => list[i] };
            },
          },
        },
        NSRunningApplication: {
          runningApplicationWithProcessIdentifier: (pid: number) =>
            env.running && pid === 42 ? { isNil: () => false, terminated: false, bundleIdentifier: "com.lostmarble.moho" } : null,
        },
      };
      return new Function("ObjC", "$", "Ref", "delay", "console", `${MACOS_KEEPALIVE_JXA}\nreturn { cachedPid };`)(
        { import() {}, bindFunction() {}, unwrap: (x: unknown) => x, deepUnwrap: (x: unknown) => x }, $, () => [], () => {}, console,
      ) as { cachedPid: (s: Record<string, number>, id: string, now: number) => number };
    }

    it("walks the app list once while Moho keeps running", () => {
      const env = { running: true, walks: { n: 0 } };
      const { cachedPid } = load(env);
      const st = {};
      for (let t = 0; t < 2000; t += 100) expect(cachedPid(st, "com.lostmarble.moho", t)).toBe(42);
      expect(env.walks.n).toBe(1);
    });

    it("notices Moho quitting and looks again at most once a second while it is gone", () => {
      const env = { running: true, walks: { n: 0 } };
      const { cachedPid } = load(env);
      const st = {};
      expect(cachedPid(st, "com.lostmarble.moho", 0)).toBe(42);
      env.running = false;
      expect(cachedPid(st, "com.lostmarble.moho", 100)).toBe(0); // invalidated, one walk
      for (let t = 200; t < 1100; t += 100) expect(cachedPid(st, "com.lostmarble.moho", t)).toBe(0);
      expect(env.walks.n).toBe(2);
      env.running = true;
      expect(cachedPid(st, "com.lostmarble.moho", 1100)).toBe(42);
      expect(env.walks.n).toBe(3);
    });
  });

  describe("wake scheduling (real helper code, stubbed ObjC)", () => {
    type State = Record<string, number | boolean>;
    const { wakeStep } = new Function(
      "ObjC", "$", "Ref", "delay", "console",
      `${MACOS_KEEPALIVE_JXA}\nreturn { wakeStep };`,
    )({ import() {}, bindFunction() {}, unwrap: (x: unknown) => x, deepUnwrap: (x: unknown) => x }, {}, () => [], () => {}, console) as {
      wakeStep: (s: State, now: number, pending: boolean, a: { nudge(): void; axWake(): void }) => void;
    };

    function simulate(pendingAt: (t: number) => boolean, until: number) {
      const log: string[] = [];
      const state: State = {};
      for (let t = 0; t <= until; t += 100) {
        wakeStep(state, t, pendingAt(t), {
          nudge: () => log.push(`nudge@${t}`),
          axWake: () => log.push(`ax@${t}`),
        });
      }
      return log;
    }

    it("nudges first and reads the menu only if the request is still pending 300 ms later", () => {
      expect(simulate(() => true, 1000)).toEqual([
        "nudge@0", "nudge@300", "ax@300", "nudge@600", "ax@700", "nudge@900",
      ]);
    });

    it("never reads the menu for requests answered within 300 ms", () => {
      expect(simulate((t) => t < 200 || (t >= 500 && t < 700), 1000)).toEqual(["nudge@0", "nudge@500"]);
    });

    it("does nothing while no request is pending", () => {
      expect(simulate(() => false, 1000)).toEqual([]);
    });
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
