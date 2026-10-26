-- edit.lua
-- Shared helpers for MohoMCP write handlers that create content
-- (layer.create, shape.draw, bone.create, lua.run).
-- API calls mirror Moho's bundled scripts; see the comments for the source.

local edit = {}

--- Moho constants table (MOHO global, or LM.MOHO on some builds).
function edit.M()
    local M = nil
    pcall(function() M = MOHO end)
    if not M then
        pcall(function() M = LM.MOHO end)
    end
    return M
end

--- Absolute layer ID, or -1 when unavailable.
function edit.layerId(moho, lyr)
    local ok, id = pcall(function() return moho.document:LayerAbsoluteID(lyr) end)
    if ok and type(id) == "number" then return id end
    return -1
end

local function findByName(moho, container, name)
    local count = container:CountLayers()
    for i = 0, count - 1 do
        local child = container:Layer(i)
        if child then
            if child:Name() == name then
                return child
            end
            local isGroup = false
            pcall(function() isGroup = child:IsGroupType() end)
            if isGroup then
                local gOk, group = pcall(function() return moho:LayerAsGroup(child) end)
                if gOk and group then
                    local found = findByName(moho, group, name)
                    if found then return found end
                end
            end
        end
    end
    return nil
end

--- Resolve a layer reference: number = absolute layer ID, string = layer name
--- (first match, depth-first), nil = the current layer.
-- @return userdata|nil, string|nil
function edit.findLayer(moho, ref)
    if not moho or not moho.document then
        return nil, "No active document"
    end
    if ref == nil then
        if moho.layer then return moho.layer end
        return nil, "No current layer"
    end
    if type(ref) == "number" then
        local ok, lyr = pcall(function() return moho.document:LayerByAbsoluteID(ref) end)
        if ok and lyr then return lyr end
        return nil, "Layer not found with absolute ID " .. tostring(ref)
    end
    if type(ref) == "string" then
        local ok, lyr = pcall(findByName, moho, moho.document, ref)
        if ok and lyr then return lyr end
        return nil, "Layer not found with name '" .. ref .. "'"
    end
    return nil, "layer must be a layer ID (number) or name (string)"
end

--- Visit every layer depth-first: fn(layer, parentLayerOrNil, path), where
--- path is the "/"-joined names from the top level down to the layer.
function edit.eachLayer(moho, fn)
    local function walk(container, parent, prefix)
        for i = 0, container:CountLayers() - 1 do
            local child = container:Layer(i)
            if child then
                local path = prefix .. "/" .. tostring(child:Name())
                fn(child, parent, path)
                local isGroup = false
                pcall(function() isGroup = child:IsGroupType() end)
                if isGroup then
                    local gOk, group = pcall(function() return moho:LayerAsGroup(child) end)
                    if gOk and group then walk(group, child, path) end
                end
            end
        end
    end
    walk(moho.document, nil, "")
end

--- Human-readable layer type name.
function edit.typeName(lt)
    local M = edit.M()
    if M then
        for _, n in ipairs({ "VECTOR", "BONE", "GROUP", "IMAGE", "SWITCH", "PARTICLE", "NOTE", "AUDIO", "PATCH", "TEXT", "3D" }) do
            local v = M["LT_" .. n]
            if v ~= nil and v == lt then return n:lower() end
        end
    end
    return "unknown"
end

--- Elapsed-time source. os.clock() is process CPU time, so time spent outside
--- this Lua state is not counted. LM.Stopwatch is Moho's own wall-clock timer
--- (Scripts/Tool/lm_add_bone.lua:185-186 starts one, :272 compares
--- ElapsedTime() with a 0.3 s click delay). Without it, fall back to os.time():
--- wall clock with 1 s resolution, plenty for a 20 s limit.
-- @return function  returns seconds elapsed since this call
function edit.clock()
    local ok, sw = pcall(function()
        local w = LM.Stopwatch:new_local()
        w:Start()
        return w
    end)
    if ok and sw then
        return function() return sw:ElapsedTime() end
    end
    local t0 = os.time()
    return function() return os.difftime(os.time(), t0) end
end

--- Read a 2D point given as [x, y] or {x=, y=}.
function edit.point(p, label)
    if type(p) ~= "table" then
        return nil, label .. " must be [x, y]"
    end
    local x = p[1]; if x == nil then x = p.x end
    local y = p[2]; if y == nil then y = p.y end
    if type(x) ~= "number" or type(y) ~= "number" then
        return nil, label .. " must be [x, y] with numeric coordinates"
    end
    return { x = x, y = y }
end

--- Build an LM color struct from {r, g, b, a}.
--- Channels are 0..1; if any channel is above 1 the whole color is read as 0..255.
--- Pattern: LM.ColorVector:new_local() / :Set() / :AsColorStruct()
--- (Scripts/Menu/Particle Effects/lm_snow.lua:39-40, 113).
function edit.color(c, label)
    if type(c) ~= "table" then
        return nil, label .. " must be an object {r, g, b, a}"
    end
    local r, g, b, a = c.r, c.g, c.b, c.a
    if type(r) ~= "number" or type(g) ~= "number" or type(b) ~= "number" then
        return nil, label .. " needs numeric r, g, b"
    end
    if a ~= nil and type(a) ~= "number" then
        return nil, label .. ".a must be a number"
    end
    local scale = 1
    if r > 1 or g > 1 or b > 1 or (a or 0) > 1 then scale = 255 end
    if a == nil then a = scale end
    local function clamp(v) v = v / scale; if v < 0 then return 0 elseif v > 1 then return 1 end return v end
    local cv = LM.ColorVector:new_local()
    cv:Set(clamp(r), clamp(g), clamp(b), clamp(a))
    return cv:AsColorStruct()
end

--- Open an undo step and mark the document dirty, as Moho's own scripts do
--- (Scripts/Tool/lm_shape.lua:119-120, Scripts/Tool/lm_add_bone.lua:212-213).
-- @param lyr  Layer to snapshot, or nil for a document-level change
--             (Scripts/Menu/Particle Effects/lm_snow.lua:45-46).
function edit.begin(moho, lyr, extra)
    if extra ~= nil then
        moho.document:PrepUndo(lyr, extra)
    else
        moho.document:PrepUndo(lyr)
    end
    moho.document:SetDirty()
end

--- Ask for one UI refresh (moho:UpdateUI(), Scripts/Tool/lm_shape.lua:179)
--- after the current poll. server.poll performs it once per poll while its
--- re-entry guard is still held, so a synchronous repaint cannot dispatch
--- another request from inside a handler.
edit.uiDirty = false
function edit.finish()
    edit.uiDirty = true
end

return edit
