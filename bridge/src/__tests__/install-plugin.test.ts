import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(__dirname, "../../..");
const installer = path.join(repo, "install-plugin.sh");
const plugin = path.join(repo, "moho-plugin");

function run(...args: string[]): string {
  return execFileSync("bash", [installer, ...args], { encoding: "utf8" });
}

describe.skipIf(process.platform === "win32")("install-plugin.sh", () => {
  let scripts = "";
  let oldTarget = "";

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moho-install-test-"));
    scripts = path.join(root, "Scripts");
    oldTarget = path.join(root, "old-checkout-moho_mcp");
    fs.mkdirSync(path.join(scripts, "Menu", "MohoMCP"), { recursive: true });
    fs.mkdirSync(path.join(scripts, "Tool"), { recursive: true });
    fs.mkdirSync(oldTarget);
    fs.writeFileSync(path.join(oldTarget, "keep.lua"), "-- must survive");
    // Old layout: library links inside Menu/MohoMCP; tool list without trailing newline.
    fs.symlinkSync(oldTarget, path.join(scripts, "Menu", "MohoMCP", "moho_mcp"));
    fs.writeFileSync(path.join(scripts, "Menu", "MohoMCP", "json.lua"), "-- old");
    fs.writeFileSync(path.join(scripts, "Tool", "_tool_list.txt"), "tool\tlm_select_points\t...");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(scripts), { recursive: true, force: true });
  });

  it("--link symlinks the new layout into the checkout and cleans the old one", () => {
    run("--link", scripts);
    run("--link", scripts); // idempotent
    const menu = path.join(scripts, "Menu", "MohoMCP");
    expect(fs.readdirSync(menu)).toEqual(["MohoMCP_Server.lua"]);
    expect(fs.readlinkSync(path.join(menu, "MohoMCP_Server.lua"))).toBe(path.join(plugin, "MohoMCP_Server.lua"));
    expect(fs.readlinkSync(path.join(scripts, "Modules", "moho_mcp"))).toBe(path.join(plugin, "moho_mcp"));
    expect(fs.readlinkSync(path.join(scripts, "Tool", "MohoMCP_Poller.lua"))).toBe(path.join(plugin, "MohoMCP_Poller.lua"));
    const list = fs.readFileSync(path.join(scripts, "Tool", "_tool_list.txt"), "utf8");
    expect(list.match(/MohoMCP_Poller/g)).toHaveLength(1);
    expect(list).toBe("tool\tlm_select_points\t...\ntool\tMohoMCP_Poller\t...\n");
    expect(fs.readFileSync(path.join(oldTarget, "keep.lua"), "utf8")).toBe("-- must survive");
  });

  it("copy mode replaces links with copies without writing through them", () => {
    run("--link", scripts);
    const before = fs.readFileSync(path.join(plugin, "MohoMCP_Server.lua"), "utf8");
    run(scripts);
    const server = path.join(scripts, "Menu", "MohoMCP", "MohoMCP_Server.lua");
    expect(fs.lstatSync(server).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(scripts, "Modules", "moho_mcp")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(scripts, "Modules", "moho_mcp", "json.lua"))).toBe(true);
    expect(fs.existsSync(path.join(scripts, "Modules", "moho_mcp", "tools", "shape.lua"))).toBe(true);
    expect(fs.readFileSync(path.join(plugin, "MohoMCP_Server.lua"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(scripts, "Modules", "moho_mcp", "tests"))).toBe(false);
  });

  it("refuses a folder that is not a Moho Scripts folder", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "moho-install-empty-"));
    try {
      expect(() => run("--link", empty)).toThrow();
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

// A setup where Moho's folders link back into a checkout must never delete or
// overwrite the checkout. These tests run a throwaway copy of the repo so a
// regression cannot damage the real one.
describe.skipIf(process.platform === "win32")("install-plugin.sh with links into the checkout", () => {
  let root = "";
  let fakeRepo = "";
  let scripts = "";

  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p);
        else out[path.relative(dir, p)] = st.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : fs.readFileSync(p, "utf8");
      }
    };
    walk(dir);
    return out;
  }

  function runFake(...args: string[]) {
    return execFileSync("bash", [path.join(fakeRepo, "install-plugin.sh"), ...args], { encoding: "utf8" });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "moho-install-guard-"));
    fakeRepo = path.join(root, "repo");
    fs.mkdirSync(fakeRepo);
    fs.copyFileSync(installer, path.join(fakeRepo, "install-plugin.sh"));
    fs.cpSync(plugin, path.join(fakeRepo, "moho-plugin"), { recursive: true });
    scripts = path.join(root, "Scripts");
    fs.mkdirSync(path.join(scripts, "Menu"), { recursive: true });
    fs.mkdirSync(path.join(scripts, "Tool"), { recursive: true });
    fs.writeFileSync(path.join(scripts, "Tool", "_tool_list.txt"), "tool\tlm_select_points\t...\n");
    // The dangerous layout: the whole Menu/MohoMCP folder is a link to <repo>/moho-plugin.
    fs.symlinkSync(path.join(fakeRepo, "moho-plugin"), path.join(scripts, "Menu", "MohoMCP"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const mode of ["--link", "copy"]) {
    it(`${mode}: replaces a directory-symlinked Menu/MohoMCP without touching the checkout`, () => {
      const before = snapshot(fakeRepo);
      runFake(...(mode === "--link" ? ["--link", scripts] : [scripts]));
      expect(snapshot(fakeRepo)).toEqual(before);
      const menu = path.join(scripts, "Menu", "MohoMCP");
      expect(fs.lstatSync(menu).isSymbolicLink()).toBe(false);
      expect(fs.readdirSync(menu)).toEqual(["MohoMCP_Server.lua"]);
      const server = path.join(menu, "MohoMCP_Server.lua");
      if (mode === "--link") {
        expect(fs.readlinkSync(server)).toBe(path.join(fs.realpathSync(fakeRepo), "moho-plugin", "MohoMCP_Server.lua"));
      } else {
        expect(fs.lstatSync(server).isSymbolicLink()).toBe(false);
      }
    });
  }

  it("refuses when a Moho folder it writes into resolves into the checkout", () => {
    fs.symlinkSync(path.join(fakeRepo, "moho-plugin"), path.join(scripts, "Modules"));
    const before = snapshot(fakeRepo);
    expect(() => runFake("--link", scripts)).toThrow(/resolves into this checkout/);
    expect(snapshot(fakeRepo)).toEqual(before);
  });

  it("unlinks a file symlink at a destination instead of writing through it", () => {
    fs.rmSync(path.join(scripts, "Menu", "MohoMCP"));
    fs.mkdirSync(path.join(scripts, "Menu", "MohoMCP"));
    fs.symlinkSync(path.join(fakeRepo, "moho-plugin", "MohoMCP_Poller.lua"), path.join(scripts, "Tool", "MohoMCP_Poller.lua"));
    fs.symlinkSync(path.join(fakeRepo, "moho-plugin", "moho_mcp"), path.join(scripts, "Menu", "MohoMCP", "moho_mcp"));
    const before = snapshot(fakeRepo);
    runFake(scripts);
    expect(snapshot(fakeRepo)).toEqual(before);
    expect(fs.lstatSync(path.join(scripts, "Tool", "MohoMCP_Poller.lua")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(scripts, "Menu", "MohoMCP", "moho_mcp"))).toBe(false);
  });
});
