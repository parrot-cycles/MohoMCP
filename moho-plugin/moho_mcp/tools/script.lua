-- script.lua
-- lua.run: execute a Lua chunk inside Moho, like Blender MCP's execute_blender_code.
-- The chunk sees `moho` (the ScriptInterface of the current callback),
-- `doc`/`document` (moho.document), `json`, and every global (MOHO, LM, ...).
-- Globals it assigns stay in a per-call environment.

local script = {}

-- Wall-clock seconds before a runaway chunk is aborted. Well under the bridge's
-- lua_run timeout (30 s, bridge/src/config.ts luaRunTimeout), which also covers
-- the wait for Moho to repaint and pick the request up.
script.timeLimit = 20

local MAX_OUTPUT = 64 * 1024   -- hard cap on captured print() output, bytes
local MAX_RESULT = 1024 * 1024 -- approximate cap on the serialized result, bytes
local MAX_DEPTH = 16
local TRUNCATED = "…[truncated]"

--- Elapsed-time source. os.clock() is process CPU time, so time spent outside
--- this Lua state is not counted. LM.Stopwatch is Moho's own wall-clock timer
--- (Scripts/Tool/lm_add_bone.lua:185-186 starts one, :272 compares
--- ElapsedTime() with a 0.3 s click delay). Without it, fall back to os.time():
--- wall clock with 1 s resolution, plenty for a 20 s limit.
-- @return function  returns seconds elapsed since this call
function script.clock()
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

local jsonNull = function()
    local j = rawget(_G, "json")
    if type(j) == "table" and j.null ~= nil then return j.null end
    return nil
end

--- Charge `cost` bytes against the result budget; false once it is spent.
local function charge(state, cost)
    if state.truncated then return false end
    if state.bytes + cost > MAX_RESULT then
        state.truncated = true
        return false
    end
    state.bytes = state.bytes + cost
    return true
end

--- Convert any Lua value into something json.encode accepts.
--- Tables become arrays (keys 1..n) or objects (keys via tostring);
--- userdata, functions and threads become tostring(); NaN/inf become strings.
--- Output beyond MAX_RESULT is replaced by a "…[truncated]" marker.
local function toJson(v, depth, state)
    local t = type(v)
    if t == "nil" then
        return jsonNull()
    elseif t == "boolean" then
        charge(state, 5)
        return v
    elseif t == "number" then
        charge(state, 24)
        if v ~= v or v == math.huge or v == -math.huge then
            return tostring(v)
        end
        return v
    elseif t == "table" then
        if state.seen[v] then return "<cycle>" end
        if depth >= MAX_DEPTH then return "<max depth>" end
        if not charge(state, 2) then return TRUNCATED end
        state.seen[v] = true
        local n = #v
        local count = 0
        for _ in pairs(v) do count = count + 1 end
        local out = {}
        if count > 0 and count == n then
            for i = 1, n do
                if state.truncated then out[#out + 1] = TRUNCATED; break end
                local item = toJson(v[i], depth + 1, state)
                if item == nil then item = "nil" end
                out[i] = item
            end
        else
            for k, val in pairs(v) do
                if state.truncated then out[TRUNCATED] = true; break end
                local key = tostring(k)
                charge(state, #key + 4)
                local item = toJson(val, depth + 1, state)
                if item ~= nil then out[key] = item end
            end
            -- json.lua encodes an empty table as []; mark non-empty maps as objects.
            local j = rawget(_G, "json")
            if count > 0 and type(j) == "table" and j.object then
                out = j.object(out)
            end
        end
        state.seen[v] = nil
        return out
    else
        local str = t == "string" and v or tostring(v)
        if charge(state, #str + 2) then return str end
        local room = MAX_RESULT - state.bytes - #TRUNCATED
        state.bytes = MAX_RESULT
        if room > 0 then return str:sub(1, room) .. TRUNCATED end
        return TRUNCATED
    end
end

--- Run a Lua chunk.
-- @param params table { code: string, undo?: boolean (default true) }
-- @return table { result: any, output: string, truncated?: boolean }
function script.run(moho, params)
    local code = params.code
    if type(code) ~= "string" or code == "" then
        return nil, "code must be a non-empty string"
    end

    -- print() capture with a hard MAX_OUTPUT cap (marker included).
    local lines, size, outputCut = {}, 0, false
    local function capture(...)
        if outputCut then return end
        local parts = {}
        for i = 1, select("#", ...) do
            parts[i] = tostring((select(i, ...)))
        end
        local line = table.concat(parts, "\t")
        local sep = (#lines > 0) and 1 or 0
        if size + sep + #line > MAX_OUTPUT then
            local room = MAX_OUTPUT - size - sep - #TRUNCATED
            line = (room > 0 and line:sub(1, room) or "") .. TRUNCATED
            outputCut = true
        end
        lines[#lines + 1] = line
        size = size + sep + #line
    end

    local doc = moho and moho.document
    local env = setmetatable({
        moho = moho,
        doc = doc,
        document = doc,
        print = capture,
    }, { __index = _G })

    local chunk, loadErr = load(code, "=lua_run", "t", env)
    if not chunk then
        return nil, "Lua syntax error: " .. tostring(loadErr)
    end

    -- Changes made by the chunk are one undoable step, like a menu script
    -- (Scripts/Menu/Particle Effects/lm_snow.lua:45-46).
    if params.undo ~= false and doc then
        doc:PrepUndo(nil)
        doc:SetDirty()
    end

    -- Abort runaway Lua loops instead of freezing Moho. The count hook only
    -- fires between Lua instructions, never inside one long C call.
    -- `active` is cleared the moment the chunk returns, so a hook firing late
    -- (before it is removed) is a no-op and cannot escape this handler.
    local active = true
    local hookSet = false
    local oldHook, oldMask, oldCount
    if debug and debug.sethook and debug.gethook then
        local elapsed = script.clock()
        local limit = script.timeLimit
        oldHook, oldMask, oldCount = debug.gethook()
        hookSet = pcall(debug.sethook, function()
            if active and elapsed() > limit then
                error("lua.run time limit (" .. limit .. " s) exceeded", 2)
            end
        end, "", 100000)
    end

    local ranOk, packed = pcall(function()
        local r = table.pack(pcall(chunk))
        active = false
        return r
    end)
    active = false
    if hookSet then
        if oldHook then
            pcall(debug.sethook, oldHook, oldMask, oldCount)
        else
            pcall(debug.sethook)
        end
    end
    if not ranOk then
        packed = { n = 2, false, packed }
    end

    if params.undo ~= false then
        local edit = package.loaded["moho_mcp.edit"]
        if type(edit) == "table" and edit.finish then edit.finish() end
    end

    local output = table.concat(lines, "\n")
    if not packed[1] then
        local msg = "Lua error: " .. tostring(packed[2])
        if output ~= "" then msg = msg .. "\nOutput before the error:\n" .. output end
        return nil, msg
    end

    local state = { seen = {}, bytes = 0, truncated = false }
    local result
    if packed.n <= 1 then
        result = jsonNull()
    elseif packed.n == 2 then
        result = toJson(packed[2], 0, state)
    else
        result = {}
        for i = 2, packed.n do
            if state.truncated then result[#result + 1] = TRUNCATED; break end
            local item = toJson(packed[i], 0, state)
            if item == nil then item = "nil" end
            result[i - 1] = item
        end
    end

    return { result = result, output = output, truncated = (state.truncated or outputCut) or nil }
end

script._toJson = toJson

return script
