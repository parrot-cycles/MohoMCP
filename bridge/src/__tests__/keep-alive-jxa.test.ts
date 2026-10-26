import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MACOS_KEEPALIVE_JXA } from "../keep-alive.js";

// Runs the real JXA helper with osascript. It only ever targets a `sleep`
// process or a made-up bundle id, never Moho.
describe.skipIf(process.platform !== "darwin")("macOS JXA keep-alive helper", () => {
  let dir = "";
  let script = "";
  let sleeper: ChildProcess;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moho-jxa-test-"));
    script = path.join(dir, "keep-alive.js");
    fs.writeFileSync(script, MACOS_KEEPALIVE_JXA);
    sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  });

  afterAll(() => {
    sleeper.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function selftest(name: string) {
    const out = execFileSync("osascript", ["-l", "JavaScript", script, "--selftest", dir, name, String(sleeper.pid)], {
      encoding: "utf8",
    });
    return JSON.parse(out) as { pending: boolean; pid: number; posted: boolean; access: boolean | null };
  }

  it("detects only complete req_<digits>.json files", () => {
    fs.writeFileSync(path.join(dir, "req_12.json.tmp"), "");
    fs.writeFileSync(path.join(dir, "resp_12.json"), "");
    expect(selftest("com.example.no-such-moho").pending).toBe(false);
    fs.writeFileSync(path.join(dir, "req_424200010000001.json"), "{}");
    expect(selftest("com.example.no-such-moho").pending).toBe(true);
  });

  it("ignores orphaned requests older than 60 s", () => {
    for (const f of fs.readdirSync(dir)) if (f.startsWith("req_")) fs.rmSync(path.join(dir, f));
    const orphan = path.join(dir, "req_7.json");
    fs.writeFileSync(orphan, "{}");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(orphan, old, old);
    expect(selftest("com.example.no-such-moho").pending).toBe(false);
    fs.writeFileSync(path.join(dir, "req_8.json"), "{}");
    expect(selftest("com.example.no-such-moho").pending).toBe(true);
  });

  it("finds apps by bundle id and reports whether events may be posted", () => {
    const r = selftest("com.apple.finder");
    expect(r.pid).toBeGreaterThan(0);
    expect(typeof r.access === "boolean" || r.access === null).toBe(true);
  });

  it("finds no pid for an app that is not running and posts a mouseMoved event without crashing", () => {
    const r = selftest("com.example.no-such-moho");
    expect(r.pid).toBe(0);
    expect(r.posted).toBe(true);
  });

  it("the loop keeps running while the bridge that spawned it is alive", async () => {
    const helper = spawn("osascript", ["-l", "JavaScript", script, dir, "com.example.no-such-moho", String(process.pid)], {
      stdio: "ignore",
    });
    let exited = false;
    helper.on("exit", () => { exited = true; });
    await new Promise((r) => setTimeout(r, 1500));
    expect(exited).toBe(false);
    helper.kill();
  }, 10000);

  it("the loop exits once its parent process is gone", async () => {
    const out = execFileSync(
      "sh",
      ["-c", `osascript -l JavaScript "$1" "$2" com.example.no-such-moho $$ >/dev/null 2>&1 & echo $!; sleep 0.3`, "sh", script, dir],
      { encoding: "utf8" },
    );
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const stillAlive = alive();
    if (stillAlive) process.kill(pid);
    expect(stillAlive).toBe(false);
  }, 10000);

  it("finds a menu item by title in a real app's menus, read-only", () => {
    const finder = selftest("com.apple.finder").pid;
    expect(finder).toBeGreaterThan(0);
    const run = (...a: string[]) =>
      JSON.parse(execFileSync("osascript", ["-l", "JavaScript", script, ...a], { encoding: "utf8" }));
    const menus = run("--menus", String(finder)) as Array<Array<{ title: string; sub: string[] }>>;
    const pick = menus.flat().find((it) => it.title && it.sub.some((t) => t));
    expect(pick, "no menu item with a submenu in Finder").toBeTruthy();
    const subTitle = pick!.sub.find((t) => t)!;
    const found = run("--find", String(finder), pick!.title, subTitle);
    expect(found.found).toBe(true);
    expect(found.title).toBe(subTitle);
    expect(typeof found.enabled).toBe("boolean");
    expect(run("--find", String(finder), pick!.title, "No Such Item 123").found).toBe(false);
    // The wake read caches the element and reuses it on the next tick.
    expect(run("--wake", String(finder), pick!.title, subTitle)).toEqual({ first: true, cached: true, second: true });
    expect(run("--wake", String(finder), pick!.title, "No Such Item 123")).toEqual({ first: false, cached: false, second: false });
  });

  it("caches the pid of a running app and remembers a miss", () => {
    const run = (...a: string[]) =>
      JSON.parse(execFileSync("osascript", ["-l", "JavaScript", script, ...a], { encoding: "utf8" }));
    const finder = run("--pidcache", "com.apple.finder");
    expect(finder.first).toBeGreaterThan(0);
    expect(finder.second).toBe(finder.first);
    expect(run("--pidcache", "com.example.no-such-moho")).toEqual({ first: 0, second: 0, checkedAt: true });
  });
});
