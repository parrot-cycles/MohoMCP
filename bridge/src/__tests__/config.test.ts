import { describe, it, expect } from "vitest";
import { config, defaultIpcDir } from "../config.js";
import path from "node:path";

describe("config", () => {
  describe("moho section", () => {
    it("has a default ipcDir string", () => {
      expect(typeof config.moho.ipcDir).toBe("string");
      expect(config.moho.ipcDir.length).toBeGreaterThan(0);
    });

    it("has pollInterval of 100ms", () => {
      expect(config.moho.pollInterval).toBe(100);
    });

    it("has a requestTimeout of 10000ms", () => {
      expect(config.moho.requestTimeout).toBe(10000);
    });
  });

  describe("server section", () => {
    it('has name "moho-mcp"', () => {
      expect(config.server.name).toBe("moho-mcp");
    });

    it('has version "0.1.0"', () => {
      expect(config.server.version).toBe("0.1.0");
    });
  });

  describe("structure", () => {
    it("has exactly two top-level keys: moho and server", () => {
      const keys = Object.keys(config);
      expect(keys).toHaveLength(2);
      expect(keys).toContain("moho");
      expect(keys).toContain("server");
    });
  });

  describe("defaultIpcDir", () => {
    it("prefers MOHO_MCP_IPC_DIR, then TEMP, TMP, TMPDIR like the plugin", () => {
      expect(defaultIpcDir({ MOHO_MCP_IPC_DIR: "/x/ipc", TMPDIR: "/t" }, "/home/u")).toBe("/x/ipc");
      expect(defaultIpcDir({ TEMP: "/a", TMP: "/b", TMPDIR: "/c" }, "/home/u")).toBe(path.join("/a", "moho-mcp"));
      expect(defaultIpcDir({ TMP: "/b", TMPDIR: "/c" }, "/home/u")).toBe(path.join("/b", "moho-mcp"));
      expect(defaultIpcDir({ TMPDIR: "/var/folders/T/" }, "/home/u")).toBe(path.join("/var/folders/T", "moho-mcp"));
    });

    it("falls back to a per-user folder, never the shared /tmp", () => {
      expect(defaultIpcDir({}, "/home/u")).toBe(path.join("/home/u", ".moho-mcp"));
      expect(defaultIpcDir({ TMPDIR: "" }, "/home/u")).toBe(path.join("/home/u", ".moho-mcp"));
    });
  });
});
