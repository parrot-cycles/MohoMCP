import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../moho-plugin");

// Execute the real Lua modules. Only the Moho API and the file system are
// replaced, so these regressions can run without Moho or a system Lua install.
function runLua(body) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  for (const [name, relative] of Object.entries({
    jsonSource: "moho_mcp/json.lua", protocolSource: "moho_mcp/protocol.lua",
    validatorSource: "moho_mcp/validator.lua", serverSource: "moho_mcp/server.lua",
    documentSource: "moho_mcp/tools/document.lua", animationSource: "moho_mcp/tools/animation.lua",
    editSource: "moho_mcp/edit.lua", layerSource: "moho_mcp/tools/layer.lua",
    boneSource: "moho_mcp/tools/bone.lua", shapeSource: "moho_mcp/tools/shape.lua",
    scriptSource: "moho_mcp/tools/script.lua", batchSource: "moho_mcp/tools/batch.lua",
  })) {
    lua.lua_pushstring(L, to_luastring(fs.readFileSync(path.join(plugin, relative), "utf8")));
    lua.lua_setglobal(L, to_luastring(name));
  }
  try {
    if (lauxlib.luaL_dostring(L, to_luastring(body)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    }
  } finally { lua.lua_close(L); }
}

const serverSetup = `
local files = {}
os.getenv = function(name) if name == "TMPDIR" then return "/ipc" end end
os.remove = function(p) files[p] = nil; return true end
os.rename = function(a,b) files[b] = files[a]; files[a] = nil; return true end
io = {
  popen = function() return {close = function() end} end,
  open = function(p, mode)
    if mode == "r" or mode == "rb" then
      if files[p] == nil then return nil, "not found" end
      return {read = function() return files[p] end, close = function() end}
    end
    return {write = function(_, s) files[p] = s end, close = function() end}
  end,
}
json = assert(load(jsonSource))()
local protocol = assert(load(protocolSource))()
local validator = assert(load(validatorSource))()
local server = assert(load(serverSource))()
server.init({json=json, protocol=protocol, validator=validator})
assert(server.start())
local dir = server.getInfo().ipcDir
local function request(id)
  files[dir .. "req_" .. id .. ".json"] = json.encode({jsonrpc="2.0",id=id,method="document.getInfo"})
end
`;

describe("Lua IPC polling", () => {
  it("finds large per-process request IDs through Moho's file listing", () => runLua(serverSetup + `
    local listing = {}
    local moho = {
      BeginFileListing = function(_, d)
        listing = {}
        for p in pairs(files) do
          if p:sub(1, #d) == d then listing[#listing + 1] = p:sub(#d + 1) end
        end
        table.sort(listing)
      end,
      GetNextFile = function() return table.remove(listing, 1) end,
    }
    server.registerHandler("document.getInfo", function() return {ok=true} end)
    -- Two bridge processes (prefixes 42420001 and 42430001) plus noise files.
    local ids = {"424200010000001", "424300010000001", "424200010000002"}
    for _, id in ipairs(ids) do
      files[dir .. "req_" .. id .. ".json"] =
        '{"jsonrpc":"2.0","id":' .. id .. ',"method":"document.getInfo"}'
    end
    files[dir .. "req_9.json.tmp"] = "partial"
    files[dir .. "status.json"] = "{}"
    server.poll(moho)   -- at most 2 per poll
    server.poll(moho)
    for _, id in ipairs(ids) do
      assert(files[dir .. "req_" .. id .. ".json"] == nil, "request " .. id .. " not consumed")
      local resp = assert(files[dir .. "resp_" .. id .. ".json"], "no response for " .. id)
      assert(resp:find('"id":' .. id, 1, true), "response id mangled: " .. resp)
    end
    assert(files[dir .. "req_9.json.tmp"] == "partial", "half-written request touched")
  `));

  it("advertises the IPC protocol version the bridge checks in status.json", () => runLua(serverSetup + `
    local status = json.decode(files[dir .. "status.json"])
    assert(status.running == true and status.protocol == 2, files[dir .. "status.json"])
  `));

  it("falls back to probing small IDs when Moho has no file listing", () => runLua(serverSetup + `
    server.registerHandler("document.getInfo", function() return {ok=true} end)
    request(3)
    server.poll({})
    assert(files[dir .. "resp_3.json"] ~= nil)
  `));

  it("dispatches an in-flight request once when a handler triggers a nested repaint", () => runLua(serverSetup + `
    local calls = 0
    server.registerHandler("document.getInfo", function(moho)
      calls = calls + 1
      if calls == 1 then server.poll(moho) end
      return {calls=calls}
    end)
    request(1)
    server.poll({})
    assert(calls == 1, "nested callbacks dispatched the in-flight request twice")
    assert(files[dir .. "req_1.json"] == nil)
    assert(json.decode(files[dir .. "resp_1.json"]).result.calls == 1)
  `));

  it("releases the guard after an unexpected polling error", () => runLua(serverSetup + `
    server.registerHandler("document.getInfo", function() return {ok=true} end)
    request(1)
    local open = io.open
    io.open = function() error("transient file system error") end
    assert(not pcall(server.poll, {}))
    io.open = open
    server.poll({})
    assert(files[dir .. "resp_1.json"] ~= nil, "polling remained locked after an error")
  `));

  it("continues handling later requests after a handler fails", () => runLua(serverSetup + `
    local calls = 0
    server.registerHandler("document.getInfo", function()
      calls = calls + 1
      if calls == 1 then error("handler failed") end
      return {ok=true}
    end)
    request(1); server.poll({})
    assert(json.decode(files[dir .. "resp_1.json"]).error.code == -32603)
    request(2); server.poll({})
    assert(json.decode(files[dir .. "resp_2.json"]).result.ok)
  `));
});

const documentSetup = `
local document = assert(load(documentSource))()
local function layer(children)
  return {
    IsGroupType=function() return children ~= nil end,
    CountLayers=function() return #children end,
    Layer=function(_,i) return children[i+1] end,
  }
end
local children={layer(), layer({layer(),layer({layer()})})}
local doc={
  Width=function() return 1280 end, Height=function() return 720 end,
  Fps=function() return 24 end, StartFrame=function() return 1 end,
  EndFrame=function() return 48 end, CountLayers=function() return #children end,
  Layer=function(_,i) return children[i+1] end,
}
local moho={document=doc,LayerAsGroup=function(_,l) return l end}
`;

describe("Lua document metadata", () => {
  it("counts both endpoints in the rendered duration", () => runLua(documentSetup + `
    assert(document.getInfo(moho, {}).duration == 2)
    doc.StartFrame=function() return 9 end; doc.EndFrame=function() return 9 end
    assert(document.getInfo(moho, {}).duration == 1/24)
  `));

  it("counts nested layers when TotalLayerCount is unavailable", () => runLua(documentSetup + `
    local info=document.getInfo(moho,{})
    assert(info.totalLayers == 5)
    assert(info.topLevelLayers == 2)
  `));

  it("keeps a native TotalLayerCount result when available", () => runLua(documentSetup + `
    doc.TotalLayerCount=function() return 7 end
    assert(document.getInfo(moho,{}).totalLayers == 7)
  `));
});

describe("Lua document.screenshot", () => {
  it("refuses scene rendering on macOS instead of calling FileRender", () => runLua(documentSetup + `
    local rendered = false
    moho.FileRender = function() rendered = true end
    local r, err = document.screenshot(moho, {})
    assert(r == nil and err:find('mode "full"', 1, true), tostring(err))
    assert(not rendered, "FileRender must not be called")
  `));
});

describe("Lua animation keyframes", () => {
  it("queries interpolation at each key's frame rather than its index", () => runLua(`
    MOHO={INTERP_LINEAR=0,INTERP_SMOOTH=1,INTERP_STEP=5}
    local frames={0,12,48}
    local modes={[0]=0,[12]=1,[48]=5}
    local channel={
      CountKeys=function() return #frames end,
      GetKeyWhen=function(_,i) return frames[i+1] end,
      GetValue=function(_,f) return {x=f,y=f} end,
      GetKeyInterpMode=function(_,f) return modes[f] end,
    }
    local lyr={fTranslation=channel}
    local moho={document={LayerByAbsoluteID=function() return lyr end}}
    local animation=assert(load(animationSource))()
    local result=assert(animation.getKeyframes(moho,{layerId=0,channel="translation"}))
    assert(result.keyframes[1].interpolation == "linear")
    assert(result.keyframes[2].interpolation == "smooth")
    assert(result.keyframes[3].interpolation == "step")
  `));
});

// ---------------------------------------------------------------------------
// Creation tools against a stubbed Moho API (shapes mirror the bundled scripts)
// ---------------------------------------------------------------------------

const fakeMoho = `
json = assert(load(jsonSource))()
MOHO = {LT_VECTOR=1, LT_BONE=2, LT_GROUP=3, SMOOTH=0.4, PEAKED=0}
local function vec(x, y)
  local v = {x=x or 0, y=y or 0}
  function v:Set(a, b) if type(a) == "table" then self.x, self.y = a.x, a.y else self.x, self.y = a, b end end
  return v
end
LM = {
  Vector2 = {new_local=function() return vec() end},
  ColorVector = {new_local=function()
    local c = {}
    function c:Set(r, g, b, a) self.r, self.g, self.b, self.a = r, g, b, a end
    function c:AsColorStruct()
      local function b(v) return math.floor(v * 255 + 0.5) end
      return {r=b(self.r), g=b(self.g), b=b(self.b), a=b(self.a)}
    end
    return c
  end},
  Stopwatch = {new_local=function()
    local w = {}
    function w:Start() self.t0 = os.clock() end
    function w:ElapsedTime() return os.clock() - self.t0 end
    return w
  end},
  -- Translation-only matrices are enough to check parent-space conversion.
  Matrix = {new_local=function()
    local m = {ox=0, oy=0}
    function m:Set(o) self.ox, self.oy = o.ox, o.oy end
    function m:Invert() self.ox, self.oy = -self.ox, -self.oy end
    function m:Transform(v) v.x, v.y = v.x + self.ox, v.y + self.oy end
    return m
  end},
}
local function chan(v)
  return {v=v, SetValue=function(self, f, val) self.v, self.frame = val, f end,
          GetValue=function(self) return self.v end}
end
calls = {}
local function log(s) calls[#calls + 1] = s end

local function newMesh()
  local m = {points={}, shapes={}}
  local function add(v)
    m.points[#m.points + 1] = {x=v.x, y=v.y, fSelected=false,
      SetCurvature=function(self, c, f) self.curvature = c end}
  end
  function m:CountPoints() return #self.points end
  function m:Point(i) return self.points[i + 1] end
  function m:AddLonePoint(v, f) log("AddLonePoint"); add(v) end
  function m:AppendPoint(v, f) add(v) end
  function m:WeldPoints(a, b, f) log("WeldPoints " .. a .. " " .. b); table.remove(self.points, a + 1) end
  function m:SelectNone() for _, p in ipairs(self.points) do p.fSelected = false end end
  function m:SelectConnected() log("SelectConnected") end
  function m:Shape(i) return self.shapes[i + 1] end
  function m:CountShapes() return #self.shapes end
  return m
end

local nextId = 0
local function newLayer(name, lt)
  local l = {name=name, lt=lt, id=nextId, children={}}
  nextId = nextId + 1
  if lt == MOHO.LT_VECTOR then l.mesh = newMesh() end
  function l:Name() return self.name end
  function l:SetName(n) self.name = n end
  function l:LayerType() return self.lt end
  function l:IsGroupType() return self.lt ~= MOHO.LT_VECTOR end
  function l:IsBoneType() return self.lt == MOHO.LT_BONE end
  function l:CountLayers() return #self.children end
  function l:Layer(i) return self.children[i + 1] end
  function l:Parent() return self.parent end
  return l
end

local function newSkeleton()
  local s = {bones={}}
  function s:CountBones() return #self.bones end
  function s:Bone(i) return self.bones[i + 1] end
  function s:BoneID(b) for i, x in ipairs(self.bones) do if x == b then return i - 1 end end return -1 end
  function s:UpdateBoneMatrix(id) log("UpdateBoneMatrix " .. id) end
  function s:AddBone(f)
    local b = {fParent=-1, fAnimParent=chan(-1), fAnimPos=chan(vec()), fAnimAngle=chan(0),
               fPos=vec(), fTempPos=vec(), fLength=0, fAngle=0, fRestMatrix={ox=0, oy=0}}
    function b:SetName(n) self.name = n end
    function b:Name() return self.name end
    self.bones[#self.bones + 1] = b
    return b
  end
  return s
end

local root = {}
doc = {}
function doc:CountLayers() return #root end
function doc:Layer(i) return root[i + 1] end
local all = {}
function doc:LayerByAbsoluteID(id) return all[id] end
function doc:LayerAbsoluteID(l) return l and l.id or -1 end
function doc:PrepUndo(l, extra) log("PrepUndo " .. (l and l.name or "nil") .. (extra and " true" or "")) end
function doc:SetDirty() log("SetDirty") end
function doc:Height() return 720 end

local function addRoot(name, lt)
  local l = newLayer(name, lt); root[#root + 1] = l; all[l.id] = l; return l
end
art = addRoot("Art", MOHO.LT_VECTOR)
rig = addRoot("Rig", MOHO.LT_BONE)
rig.skel = newSkeleton()
local hip = rig.skel:AddBone(0); hip.name = "hip"; hip.fRestMatrix = {ox=1, oy=0}
sketch = newLayer("Sketch", MOHO.LT_VECTOR); all[sketch.id] = sketch
rig.children[1] = sketch; sketch.parent = rig

moho = {document=doc, layer=art, uiUpdates=0}
function moho:SetSelLayer(l) log("SetSelLayer " .. l.name); self.layer = l end
function moho:Mesh() return self.layer.mesh end
function moho:LayerAsGroup(l) return l end
function moho:LayerAsBone(l) return {Skeleton=function() return l.skel end} end
function moho:UpdateUI() self.uiUpdates = self.uiUpdates + 1 end
-- Like Moho, a new layer goes next to the current layer, inside its group.
function moho:CreateNewLayer(lt, flag)
  log("CreateNewLayer")
  local l = newLayer("Layer " .. nextId, lt); all[l.id] = l
  local group = self.layer and self.layer.parent
  if group then group.children[#group.children + 1] = l; l.parent = group else root[#root + 1] = l end
  self.layer = l
  return l
end
function moho:PlaceLayerInGroup(l, g, a, b)
  local from = l.parent and l.parent.children or root
  for i, x in ipairs(from) do if x == l then table.remove(from, i) break end end
  g.children[#g.children + 1] = l
  l.parent = g
end
function moho:CreateShape(fill, b, f)
  local mesh = self.layer.mesh
  local sel = {}
  for i, p in ipairs(mesh.points) do if p.fSelected then sel[#sel + 1] = i - 1 end end
  local shape = {fHasFill=fill, fHasOutline=true, points=sel,
    fMyStyle={fFillCol=chan(), fLineCol=chan(), fLineWidth=0}}
  function shape:MakePlain() self.plain = true end
  mesh.shapes[#mesh.shapes + 1] = shape
  return #mesh.shapes - 1
end

package.preload["moho_mcp.edit"] = function() return assert(load(editSource))() end
edit = require("moho_mcp.edit")
layerTools = assert(load(layerSource))()
boneTools = assert(load(boneSource))()
shapeTools = assert(load(shapeSource))()
scriptTools = assert(load(scriptSource))()
function indexOf(s) for i, c in ipairs(calls) do if c == s then return i end end return nil end
`;

describe("Lua layer.create", () => {
  it("creates a named vector layer inside a parent group as one undo step", () => runLua(fakeMoho + `
    local r = assert(layerTools.create(moho, {type="vector", name="Face", parent="Rig"}))
    assert(r.name == "Face" and r.type == "vector" and r.parentId == rig.id)
    assert(doc:LayerByAbsoluteID(r.layerId):Name() == "Face")
    assert(rig.children[2].name == "Face", "not placed in the parent group")
    assert(indexOf("PrepUndo nil") < indexOf("CreateNewLayer"), "undo must be prepared first")
    assert(indexOf("SetDirty"))
    assert(edit.uiDirty == true)
  `));

  it("reports the parent Moho actually used, also when no parent was requested", () => runLua(fakeMoho + `
    local g = assert(layerTools.create(moho, {type="group", name="G"}))
    assert(g.parentId == -1)
    local inner = assert(layerTools.create(moho, {type="vector", name="Inner", parent="G"}))
    assert(inner.parentId == g.layerId)
    moho.layer = doc:LayerByAbsoluteID(inner.layerId) -- Moho makes the new layer current
    local rig2 = assert(layerTools.create(moho, {type="bone", name="Rig2"}))
    assert(rig2.parentId == g.layerId, "parentId " .. tostring(rig2.parentId) .. " but the layer is inside G")
  `));

  it("creates group and bone layers and rejects other types or non-group parents", () => runLua(fakeMoho + `
    assert(layerTools.create(moho, {type="group", name="G"}).type == "group")
    assert(layerTools.create(moho, {type="bone", name="B"}).type == "bone")
    local r, err = layerTools.create(moho, {type="image", name="I"})
    assert(r == nil and err:find("type must be"))
    r, err = layerTools.create(moho, {type="vector", name="X", parent="Art"})
    assert(r == nil and err:find("not a group"), err)
    r, err = layerTools.create(moho, {type="vector", name="X", parent=999})
    assert(r == nil and err:find("not found"), err)
    assert(indexOf("CreateNewLayer") and #calls == 6, "rejected calls must not touch the document")
  `));
});

describe("Lua shape.draw", () => {
  it("draws a filled closed polygon in a named layer without grabbing selected points", () => runLua(fakeMoho + `
    local m = sketch.mesh
    m.points[1] = {x=9, y=9, fSelected=true, SetCurvature=function() end}
    local r = assert(shapeTools.draw(moho, {layer="Sketch", closed=true,
      points={{0,0},{1,0},{0.5,1}}, fill={r=1, g=0, b=0}}))
    assert(indexOf("SetSelLayer Sketch") < indexOf("AddLonePoint"), "shape must be built on the target layer")
    assert(moho.layer == art and indexOf("SetSelLayer Art"), "previous current layer not restored")
    assert(indexOf("PrepUndo Sketch") and indexOf("SetDirty"))
    assert(#m.points == 4, "closing point must be welded away")
    assert(indexOf("WeldPoints 4 1"))
    assert(r.layerId == sketch.id and r.shapeId == 0 and r.closed)
    assert(table.concat(r.pointIds, ",") == "1,2,3")
    local shp = m.shapes[1]
    assert(table.concat(shp.points, ",") == "1,2,3", "shape used other points: " .. table.concat(shp.points, ","))
    assert(shp.fHasFill and not shp.fHasOutline and shp.plain)
    local c = shp.fMyStyle.fFillCol.v
    assert(c.r == 255 and c.g == 0 and c.b == 0 and c.a == 255)
    assert(r.hasFill == true and r.hasOutline == false)
    assert(m.points[2].curvature == MOHO.PEAKED)
    assert(edit.uiDirty)
  `));

  it("draws a smooth open stroke with 0-255 colors and pixel width", () => runLua(fakeMoho + `
    local r = assert(shapeTools.draw(moho, {points={{0,0},{1,1},{2,0}}, smooth=true,
      stroke={r=0, g=128, b=255, a=255}, strokeWidth=7.2}))
    assert(r.layerId == art.id and not r.closed and r.hasOutline and not r.hasFill)
    assert(indexOf("SetSelLayer Art") == nil, "current layer should be used as is")
    local shp = art.mesh.shapes[1]
    assert(math.abs(shp.fMyStyle.fLineWidth - 0.01) < 1e-9)
    assert(shp.fMyStyle.fLineCol.v.g == 128)
    assert(art.mesh.points[1].curvature == MOHO.SMOOTH)
  `));

  it("rejects bad input before touching the document", () => runLua(fakeMoho + `
    local function fails(p, pat)
      local r, err = shapeTools.draw(moho, p)
      assert(r == nil and err:find(pat), tostring(err))
    end
    fails({points={{0,0}}}, "at least 2")
    fails({points={{0,0},{1,1}}, closed=true}, "at least 3")
    fails({points={{0,0},{1,1}}, fill={r=1,g=0,b=0}}, "requires closed")
    fails({points={{0,0},{"a",1}}}, "numeric")
    fails({points={{0,0},{1,1}}, layer="Rig"}, "not a vector layer")
    fails({points={{0,0},{1,1}}, stroke={r=1}}, "numeric r, g, b")
    assert(#calls == 0, "document modified: " .. table.concat(calls, ","))
  `));
});

describe("Lua bone.create", () => {
  it("adds a named child bone in its parent's space as one undo step", () => runLua(fakeMoho + `
    moho.layer = rig
    local r = assert(boneTools.create(moho, {name="thigh", origin={3, 2}, length=1, angle=math.pi/2, parent="hip"}))
    assert(r.boneId == 1 and r.parentId == 0 and r.name == "thigh" and r.layerId == rig.id)
    local b = rig.skel:Bone(1)
    assert(b.fParent == 0 and b.fAnimParent.v == 0)
    local p = b.fAnimPos.v
    assert(math.abs(p.x - 2) < 1e-9 and math.abs(p.y - 2) < 1e-9, "origin not in parent space")
    assert(math.abs(b.fAngle - math.pi/2) < 1e-9 and b.fAnimAngle.v == b.fAngle)
    assert(b.fLength == 1 and b.fTempLength == 1 and b.fPos.x == p.x)
    assert(indexOf("PrepUndo Rig true") and indexOf("SetDirty") and indexOf("UpdateBoneMatrix 1"))
  `));

  it("rejects non-bone layers and unknown parents", () => runLua(fakeMoho + `
    local r, err = boneTools.create(moho, {layer="Art", name="b", origin={0,0}, length=1})
    assert(r == nil and err:find("not a bone layer"))
    r, err = boneTools.create(moho, {layer="Rig", name="b", origin={0,0}, length=1, parent="nope"})
    assert(r == nil and err:find("not found"))
    r, err = boneTools.create(moho, {layer=rig.id, name="b", origin={0,0}, length=1, parent=5})
    assert(r == nil and err:find("out of range"))
    assert(#calls == 0)
  `));
});

describe("Lua lua.run", () => {
  it("returns JSON-safe values, captures print, and exposes moho and the document", () => runLua(fakeMoho + `
    local r = assert(scriptTools.run(moho, {code=[[
      print("layers", doc:CountLayers())
      return {name = moho.layer:Name(), list = {1, 2, 3}, co = coroutine.create(print), nan = 0/0}
    ]]}))
    assert(r.output == "layers\t2", r.output)
    assert(r.result.name == "Art" and #r.result.list == 3)
    assert(r.result.co:find("^thread"), "non-JSON values must be tostring'd")
    local encoded = json.encode(r)
    assert(encoded:find('"name":"Art"', 1, true), encoded)
    assert(indexOf("PrepUndo nil") and indexOf("SetDirty"))
    local r2 = assert(scriptTools.run(moho, {code="return 1, nil, 'x'", undo=false}))
    assert(r2.result[1] == 1 and r2.result[2] == json.null and r2.result[3] == "x")
  `));

  it("reports Lua errors with output instead of raising", () => runLua(fakeMoho + `
    local r, err = scriptTools.run(moho, {code="print('before'); error('boom')"})
    assert(r == nil and err:find("boom") and err:find("before"), err)
    r, err = scriptTools.run(moho, {code="return +"})
    assert(r == nil and err:find("syntax"), err)
  `));

  it("measures the time limit with Moho's wall-clock stopwatch when available", () => runLua(fakeMoho + `
    LM.Stopwatch = {new_local=function()
      return {Start=function() end, ElapsedTime=function() return 99 end}
    end}
    assert(scriptTools.clock()() == 99)
    LM.Stopwatch = nil
    local t = scriptTools.clock()()
    assert(type(t) == "number" and t >= 0 and t < 2, "os.time fallback")
    assert(scriptTools.timeLimit == 20)
  `));

  it("always restores the previous hook and ignores a hook firing after the chunk", () => runLua(fakeMoho + `
    local sentinel = function() end
    debug.sethook(sentinel, "", 1000000000)
    local installed
    local realSet = debug.sethook
    debug.sethook = function(f, ...)
      if f ~= nil and f ~= sentinel then installed = f end
      return realSet(f, ...)
    end
    scriptTools.timeLimit = 0
    assert(scriptTools.run(moho, {code="return 1", undo=false}))
    assert(debug.gethook() == sentinel, "hook not restored after success")
    assert(installed, "no time-limit hook was installed")
    -- Past the limit, a late fire must be a no-op once the chunk has returned.
    assert(pcall(installed), "late hook fire escaped")
    scriptTools.timeLimit = 0.05
    local r, err = scriptTools.run(moho, {code="while true do end", undo=false})
    assert(r == nil and err:find("time limit"), tostring(err))
    assert(debug.gethook() == sentinel, "hook not restored after timeout")
    r, err = scriptTools.run(moho, {code="error('x')", undo=false})
    assert(r == nil and debug.gethook() == sentinel, "hook not restored after error")
    debug.sethook = realSet
    debug.sethook()
  `));

  it("caps captured print output at 64 KB with a marker", () => runLua(fakeMoho + `
    local r = assert(scriptTools.run(moho, {undo=false, code=[[
      local chunk = string.rep("x", 1000)
      for i = 1, 100 do print(chunk) end
      print("after the cap")
    ]]}))
    assert(#r.output <= 64 * 1024, "output is " .. #r.output .. " bytes")
    assert(r.output:sub(-#"…[truncated]") == "…[truncated]", "missing marker")
    assert(not r.output:find("after the cap", 1, true))
    assert(r.truncated == true)
    local small = assert(scriptTools.run(moho, {undo=false, code="print('a', 1); print('b')"}))
    assert(small.output == "a\\t1\\nb" and small.truncated == nil, small.output)
  `));

  it("caps the serialized result at about 1 MB with a marker", () => runLua(fakeMoho + `
    local r = assert(scriptTools.run(moho, {undo=false, code=[[
      local t = {}
      for i = 1, 3000 do t[i] = string.rep("y", 1000) end
      return t
    ]]}))
    assert(r.truncated == true)
    local last = r.result[#r.result]
    assert(last:sub(-#"…[truncated]") == "…[truncated]", "missing marker")
    local encoded = json.encode(r.result)
    assert(#encoded < 1024 * 1024 + 4096, "encoded result is " .. #encoded .. " bytes")
    local big = assert(scriptTools.run(moho, {undo=false, code="return string.rep('z', 2 * 1024 * 1024)"}))
    assert(#big.result <= 1024 * 1024 and big.result:sub(-#"…[truncated]") == "…[truncated]")
  `));

  it("blocks document-level File calls on moho's class during the chunk only", () => runLua(fakeMoho + `
    -- Methods live on a class table reached through the metatable, like tolua++.
    local calls = {}
    local class = {}
    for _, n in ipairs({"FileNew","FileOpen","FileClose","FileRender","FileImport","FileImportImageSequence","FileSave"}) do
      class[n] = function(self) calls[#calls + 1] = n; return n end
    end
    class.__index = class
    local base = getmetatable(moho)
    setmetatable(moho, class)
    local seen
    _G.SomeImporter = {Run = function(_, m) seen = m; return m:FileSave() end}
    for _, n in ipairs({"FileNew","FileOpen","FileClose","FileRender","FileImport","FileImportImageSequence"}) do
      local r, err = scriptTools.run(moho, {undo=false, code="return moho:" .. n .. "('/tmp/x')"})
      assert(r == nil and err:find("moho:" .. n .. "() is blocked", 1, true), tostring(err))
    end
    assert(#calls == 0, "a blocked method reached Moho: " .. table.concat(calls, ","))
    -- The real object is passed through unchanged and other methods still work.
    local r = assert(scriptTools.run(moho, {undo=false, code="return SomeImporter:Run(moho)"}))
    assert(rawequal(seen, moho) and r.result == "FileSave")
    -- Restored after the chunk, also after an error and after a timeout.
    assert(moho:FileNew() == "FileNew")
    scriptTools.run(moho, {undo=false, code="error('x')"})
    assert(moho:FileRender() == "FileRender")
    scriptTools.timeLimit = 0.05
    scriptTools.run(moho, {undo=false, code="while true do end"})
    assert(moho:FileOpen() == "FileOpen")
    setmetatable(moho, base)
  `));

  it("emits the result truncation marker once, even when nested", () => runLua(fakeMoho + `
    local r = assert(scriptTools.run(moho, {undo=false, code=[[
      local outer = {}
      for i = 1, 3 do
        local inner = {}
        for j = 1, 600 do inner[j] = string.rep("q", 1000) end
        outer[i] = inner
      end
      return outer, "after"
    ]]}))
    local encoded = json.encode(r.result)
    local _, n = encoded:gsub("…%[truncated%]", "")
    assert(n == 1, "marker appears " .. n .. " times")
    assert(r.truncated == true)
  `));

  it("aborts a runaway loop", () => runLua(fakeMoho + `
    scriptTools.timeLimit = 0.05
    local r, err = scriptTools.run(moho, {code="while true do end", undo=false})
    assert(r == nil and err:find("time limit"), tostring(err))
  `));
});

describe("Lua creation tools through the server", () => {
  const setup = fakeMoho + `
local files = {}
os.getenv = function(name) if name == "TMPDIR" then return "/ipc" end end
os.remove = function(p) files[p] = nil; return true end
os.rename = function(a,b) files[b] = files[a]; files[a] = nil; return true end
io = {
  popen = function() return {close = function() end} end,
  open = function(p, mode)
    if mode == "r" or mode == "rb" then
      if files[p] == nil then return nil, "not found" end
      return {read = function() return files[p] end, close = function() end}
    end
    return {write = function(_, s) files[p] = s end, close = function() end}
  end,
}
local protocol = assert(load(protocolSource))()
local validator = assert(load(validatorSource))()
local server = assert(load(serverSource))()
package.loaded["moho_mcp.validator"] = validator
package.loaded["moho_mcp.server"] = server
server.init({json=json, protocol=protocol, validator=validator})
server.registerHandler("layer.create", layerTools.create)
server.registerHandler("shape.draw", shapeTools.draw)
server.registerHandler("bone.create", boneTools.create)
server.registerHandler("lua.run", scriptTools.run)
server.registerHandler("batch.execute", assert(load(batchSource))().execute)
assert(server.start())
local dir = server.getInfo().ipcDir
function call(id, method, params)
  files[dir .. "req_" .. id .. ".json"] = json.encode({jsonrpc="2.0", id=id, method=method, params=params})
  server.poll(moho)
  return json.decode(assert(files[dir .. "resp_" .. id .. ".json"], "no response"))
end
`;

  it("turns a Lua error into a JSON-RPC error and keeps serving", () => runLua(setup + `
    local resp = call(1, "lua.run", {code="error('kaput')"})
    assert(resp.error.code == -32603 and resp.error.message:find("kaput"), json.encode(resp))
    resp = call(2, "lua.run", {code="return 41 + 1"})
    assert(resp.result.result == 42)
  `));

  it("validates required params for each new method", () => runLua(setup + `
    assert(call(1, "shape.draw", {}).error.code == -32602)
    assert(call(2, "layer.create", {type="vector"}).error.code == -32602)
    assert(call(3, "bone.create", {name="b", origin={0,0}}).error.code == -32602)
    assert(call(4, "lua.run", {code=5}).error.code == -32602)
  `));

  it("refreshes the UI once per poll, under the re-entry guard", () => runLua(setup + `
    local nested, nestedDispatch = 0, false
    moho.UpdateUI = function(self)
      self.uiUpdates = self.uiUpdates + 1
      -- A request arrives and a synchronous repaint re-enters the poll hook.
      files[dir .. "req_99.json"] = json.encode({jsonrpc="2.0", id=99, method="lua.run", params={code="return 1"}})
      server.poll(self)
      nestedDispatch = files[dir .. "resp_99.json"] ~= nil
      nested = nested + 1
    end
    local resp = call(1, "batch.execute", {operations={
      {method="layer.create", params={type="vector", name="Ink"}},
      {method="shape.draw", params={layer="Ink", closed=true, points={{0,0},{1,0},{1,1}}}},
      {method="lua.run", params={code="return moho.layer:Name()"}},
    }})
    assert(resp.result.summary.succeeded == 3, json.encode(resp))
    assert(resp.result.results[3].result.result == "Ink")
    assert(moho.uiUpdates == 1 and nested == 1, "UpdateUI calls: " .. moho.uiUpdates)
    assert(edit.uiDirty == false)
    assert(not nestedDispatch, "a request was dispatched from inside UpdateUI")
    moho.UpdateUI = function() end
    server.poll(moho)
    assert(json.decode(files[dir .. "resp_99.json"]).result.result == 1)
  `));
});
