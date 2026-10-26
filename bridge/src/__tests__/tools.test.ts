import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { registerTools } from "../tools.js";
import { MohoClient } from "../moho-client.js";

// ---------------------------------------------------------------------------
// We mock MohoClient so we don't need a real TCP connection
// ---------------------------------------------------------------------------

vi.mock("../moho-client.js", () => {
  const MohoClient = vi.fn();
  MohoClient.prototype.isConnected = vi.fn().mockReturnValue(true);
  MohoClient.prototype.connect = vi.fn().mockResolvedValue(undefined);
  MohoClient.prototype.sendRequest = vi.fn().mockResolvedValue({ ok: true });
  MohoClient.prototype.disconnect = vi.fn();
  return { MohoClient };
});

// ---------------------------------------------------------------------------
// Minimal mock of McpServer that captures tool registrations
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (...args: unknown[]) => Promise<unknown>;
}

function createMockMcpServer() {
  const tools: RegisteredTool[] = [];

  return {
    tools,
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) {
      tools.push({ name, description, schema, handler });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerTools", () => {
  let mockServer: ReturnType<typeof createMockMcpServer>;
  let client: MohoClient;

  beforeEach(() => {
    mockServer = createMockMcpServer();
    client = new MohoClient();
    vi.clearAllMocks();
  });

  it("registers tools without throwing", () => {
    expect(() =>
      registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], client),
    ).not.toThrow();
  });

  it("registers exactly 31 tools", () => {
    registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], client);
    expect(mockServer.tools).toHaveLength(31);
  });

  it("registers all expected tool names", () => {
    registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], client);

    const names = mockServer.tools.map((t) => t.name);

    // Read-only query tools
    expect(names).toContain("document_getInfo");
    expect(names).toContain("document_getLayers");
    expect(names).toContain("layer_getProperties");
    expect(names).toContain("layer_getChildren");
    expect(names).toContain("layer_getBones");
    expect(names).toContain("bone_getProperties");
    expect(names).toContain("animation_getKeyframes");
    expect(names).toContain("animation_getFrameState");
    expect(names).toContain("mesh_getPoints");
    expect(names).toContain("mesh_getShapes");

    // Mutation tools
    expect(names).toContain("bone_setTransform");
    expect(names).toContain("bone_selectBone");
    expect(names).toContain("animation_setKeyframe");
    expect(names).toContain("animation_deleteKeyframe");
    expect(names).toContain("animation_setInterpolation");
    expect(names).toContain("document_setFrame");
    expect(names).toContain("layer_setTransform");
    expect(names).toContain("layer_setVisibility");
    expect(names).toContain("layer_setOpacity");
    expect(names).toContain("layer_setName");
    expect(names).toContain("layer_selectLayer");

    // Screenshot & input tools
    expect(names).toContain("document_screenshot");
    expect(names).toContain("input_mouseClick");
    expect(names).toContain("input_mouseDrag");
    expect(names).toContain("input_sendKeys");

    // Creation tools
    expect(names).toContain("layer_create");
    expect(names).toContain("shape_draw");
    expect(names).toContain("bone_create");
    expect(names).toContain("lua_run");
    expect(names).toContain("svg_import");
  });

  it("each tool has a non-empty description", () => {
    registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], client);

    for (const tool of mockServer.tools) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  describe("tool handlers", () => {
    beforeEach(() => {
      registerTools(
        mockServer as unknown as Parameters<typeof registerTools>[0],
        client,
      );
    });

    function findTool(name: string): RegisteredTool {
      const tool = mockServer.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Tool ${name} not found`);
      return tool;
    }

    it("document_getInfo handler returns success content on success", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        name: "doc.moho",
      });

      const tool = findTool("document_getInfo");
      const result = (await tool.handler({})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.name).toBe("doc.moho");
    });

    it("handler returns error content on failure", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection lost"),
      );

      const tool = findTool("document_getInfo");
      const result = (await tool.handler({})) as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Connection lost");
    });

    it("handler calls ensureConnected (connect if not connected)", async () => {
      (client.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (client.sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const tool = findTool("document_getLayers");
      await tool.handler({});

      expect(client.connect).toHaveBeenCalled();
    });

    it("layer_getProperties handler passes layerId param", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        type: "vector",
      });

      const tool = findTool("layer_getProperties");
      await tool.handler({ layerId: 5 });

      expect(client.sendRequest).toHaveBeenCalledWith("layer.getProperties", {
        layerId: 5,
      });
    });

    it("bone_getProperties handler passes layerId and boneId params", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        angle: 45,
      });

      const tool = findTool("bone_getProperties");
      await tool.handler({ layerId: 1, boneId: 3 });

      expect(client.sendRequest).toHaveBeenCalledWith("bone.getProperties", {
        layerId: 1,
        boneId: 3,
      });
    });

    it("animation_getKeyframes handler passes layerId and channel params", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool = findTool("animation_getKeyframes");
      await tool.handler({ layerId: 2, channel: "rotation" });

      expect(client.sendRequest).toHaveBeenCalledWith(
        "animation.getKeyframes",
        {
          layerId: 2,
          channel: "rotation",
        },
      );
    });

    it("animation_getFrameState handler passes layerId and frame params", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        frame: 10,
      });

      const tool = findTool("animation_getFrameState");
      await tool.handler({ layerId: 3, frame: 10 });

      expect(client.sendRequest).toHaveBeenCalledWith(
        "animation.getFrameState",
        {
          layerId: 3,
          frame: 10,
        },
      );
    });

    function parse(name: string, input: unknown) {
      return z.object(findTool(name).schema as z.ZodRawShape).safeParse(input);
    }

    it("lua_run forwards code and the undo flag with the longer lua timeout", async () => {
      await findTool("lua_run").handler({ code: "return 1", undo: false });
      expect(client.sendRequest).toHaveBeenCalledWith(
        "lua.run",
        { code: "return 1", undo: false },
        { timeout: 30000 },
      );
    });

    it("batch_execute uses the lua timeout only when the batch contains lua.run", async () => {
      const batch = findTool("batch_execute");
      await batch.handler({ operations: [{ method: "layer.create" }, { method: "lua.run" }], stopOnError: false });
      expect(client.sendRequest).toHaveBeenLastCalledWith(
        "batch.execute",
        expect.anything(),
        { timeout: 30000 + 2 * 500 },
      );
      await batch.handler({ operations: [{ method: "layer.create" }], stopOnError: false });
      expect(client.sendRequest).toHaveBeenLastCalledWith(
        "batch.execute",
        expect.anything(),
        { timeout: 10000 + 500 },
      );
    });

    it("lua_run requires non-empty code", () => {
      expect(parse("lua_run", { code: "return 1" }).success).toBe(true);
      expect(parse("lua_run", { code: "" }).success).toBe(false);
      expect(parse("lua_run", {}).success).toBe(false);
    });

    it("shape_draw forwards points, style and layer to shape.draw", async () => {
      const args = {
        layer: "Ink",
        points: [[0, 0], [1, 0], [1, 1]],
        closed: true,
        fill: { r: 1, g: 0, b: 0 },
        stroke: { r: 0, g: 0, b: 0, a: 1 },
        strokeWidth: 4,
        smooth: true,
      };
      await findTool("shape_draw").handler(args);
      expect(client.sendRequest).toHaveBeenCalledWith("shape.draw", args);
    });

    it("shape_draw validates points, colors and width", () => {
      expect(parse("shape_draw", { points: [[0, 0], [1, 1]] }).success).toBe(true);
      expect(parse("shape_draw", { layer: 3, points: [[0, 0], [1, 1]], fill: { r: 255, g: 0, b: 0, a: 128 } }).success).toBe(true);
      expect(parse("shape_draw", { points: [[0, 0]] }).success).toBe(false);
      expect(parse("shape_draw", { points: [[0, 0], [1]] }).success).toBe(false);
      expect(parse("shape_draw", { points: [[0, 0], [1, 1]], fill: { r: 300, g: 0, b: 0 } }).success).toBe(false);
      expect(parse("shape_draw", { points: [[0, 0], [1, 1]], stroke: { r: 1, g: 0 } }).success).toBe(false);
      expect(parse("shape_draw", { points: [[0, 0], [1, 1]], strokeWidth: -1 }).success).toBe(false);
      expect(parse("shape_draw", { points: [[0, 0], [1, 1]], layer: 1.5 }).success).toBe(false);
    });

    it("layer_create forwards to layer.create and allows only supported types", async () => {
      await findTool("layer_create").handler({ type: "vector", name: "Ink", parent: "Group" });
      expect(client.sendRequest).toHaveBeenCalledWith("layer.create", { type: "vector", name: "Ink", parent: "Group" });
      for (const type of ["vector", "group", "bone"]) {
        expect(parse("layer_create", { type, name: "L" }).success).toBe(true);
      }
      expect(parse("layer_create", { type: "image", name: "L" }).success).toBe(false);
      expect(parse("layer_create", { type: "vector", name: "" }).success).toBe(false);
      expect(parse("layer_create", { type: "vector" }).success).toBe(false);
    });

    it("bone_create forwards to bone.create and validates its params", async () => {
      const args = { layer: 2, name: "arm", origin: [0, 0.5], length: 0.4, angle: 1.57, parent: "torso" };
      await findTool("bone_create").handler(args);
      expect(client.sendRequest).toHaveBeenCalledWith("bone.create", args);
      expect(parse("bone_create", { name: "a", origin: [0, 0], length: 1 }).success).toBe(true);
      expect(parse("bone_create", { name: "a", origin: [0, 0], length: -1 }).success).toBe(false);
      expect(parse("bone_create", { name: "a", origin: [0], length: 1 }).success).toBe(false);
      expect(parse("bone_create", { name: "a", origin: [0, 0], length: 1, parent: -1 }).success).toBe(false);
      expect(parse("bone_create", { origin: [0, 0], length: 1 }).success).toBe(false);
    });

    it("new tools report MOHO errors as tool errors", async () => {
      (client.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("MOHO error [-32603]: Lua error: boom"),
      );
      const result = (await findTool("lua_run").handler({ code: "error('boom')" })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("boom");
    });

    it("document_screenshot scene mode refuses on macOS without contacting Moho", async () => {
      const spy = vi.spyOn(os, "platform").mockReturnValue("darwin");
      try {
        const result = (await findTool("document_screenshot").handler({})) as {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('mode "full"');
        expect(client.sendRequest).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("svg_import validates the path and forwards existing files to svg.import", async () => {
      expect(parse("svg_import", { path: "/tmp/a.svg" }).success).toBe(true);
      expect(parse("svg_import", { path: "a.svg" }).success).toBe(false);
      expect(parse("svg_import", { path: "/tmp/a.SVG" }).success).toBe(false);
      expect(parse("svg_import", {}).success).toBe(false);

      const missing = (await findTool("svg_import").handler({ path: "/nonexistent/x.svg" })) as { isError?: boolean };
      expect(missing.isError).toBe(true);
      expect(client.sendRequest).not.toHaveBeenCalled();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moho-svg-test-"));
      const file = path.join(dir, "logo.svg");
      fs.writeFileSync(file, "<svg xmlns='http://www.w3.org/2000/svg'/>");
      try {
        await findTool("svg_import").handler({ path: file });
        expect(client.sendRequest).toHaveBeenCalledWith("svg.import", { path: file }, { timeout: 30000 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
