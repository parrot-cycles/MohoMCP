import { describe, it, expect, vi } from "vitest";
import { config, defaultIpcDir, darwinUserTempDir } from "../config.js";
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
      const none = () => null;
      expect(defaultIpcDir({}, "/home/u", "linux", none)).toBe(path.join("/home/u", ".moho-mcp"));
      expect(defaultIpcDir({ TMPDIR: "" }, "/home/u", "darwin", none)).toBe(path.join("/home/u", ".moho-mcp"));
    });

    it("on macOS without TEMP/TMP/TMPDIR uses getconf DARWIN_USER_TEMP_DIR, like Moho's TMPDIR", () => {
      const getconf = vi.fn(() => "/var/folders/zn/abc/T/");
      expect(defaultIpcDir({ HOME: "/Users/u" }, "/Users/u", "darwin", getconf)).toBe(
        path.join("/var/folders/zn/abc/T", "moho-mcp"),
      );
      expect(getconf).toHaveBeenCalledTimes(1);
      // Not consulted when the environment already says where temp is, or off macOS.
      getconf.mockClear();
      expect(defaultIpcDir({ TMPDIR: "/t" }, "/Users/u", "darwin", getconf)).toBe(path.join("/t", "moho-mcp"));
      expect(defaultIpcDir({}, "/home/u", "linux", getconf)).toBe(path.join("/home/u", ".moho-mcp"));
      expect(getconf).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform !== "darwin")("real getconf returns the per-user temp folder", () => {
      const dir = darwinUserTempDir();
      expect(dir).toMatch(/^\/var\/folders\/.+\/T\/?$/);
    });
  });
});
