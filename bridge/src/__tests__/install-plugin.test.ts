import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
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
