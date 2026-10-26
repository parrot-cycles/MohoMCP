-- script.lua
-- lua.run: execute a Lua chunk inside Moho, like Blender MCP's execute_blender_code.
-- The chunk sees `moho` (the ScriptInterface of the current callback),
-- `doc`/`document` (moho.document), `json`, and every global (MOHO, LM, ...).
-- Globals it assigns stay in a per-call environment.

local script = {}

-- CPU seconds before a runaway chunk is aborted; under the bridge's 10 s timeout.
script.timeLimit = 8

local MAX_OUTPUT = 64 * 1024 -- bytes of captured print() output
local MAX_DEPTH = 16

local jsonNull = function()
    local j = rawget(_G, "json")
    if type(j) == "table" and j.null ~= nil then return j.null end
    return nil
end

--- Convert any Lua value into something json.encode accepts.
--- Tables become arrays (keys 1..n) or objects (keys via tostring);
--- userdata, functions and threads become tostring(); NaN/inf become strings.
local function toJson(v, depth, seen)
    local t = type(v)
    if t == "nil" then
        return jsonNull()
    elseif t == "boolean" or t == "string" then
        return v
    elseif t == "number" then
        if v ~= v or v == math.huge or v == -math.huge then
            return tostring(v)
        end
        return v
    elseif t == "table" then
        if seen[v] then return "<cycle>" end
        if depth >= MAX_DEPTH then return "<max depth>" end
        seen[v] = true
        local n = #v
        local count = 0
        for _ in pairs(v) do count = count + 1 end
        local out = {}
        if count > 0 and count == n then
            for i = 1, n do
                local item = toJson(v[i], depth + 1, seen)
                if item == nil then item = "nil" end
                out[i] = item
            end
        else
            for k, val in pairs(v) do
                local item = toJson(val, depth + 1, seen)
                if item ~= nil then out[tostring(k)] = item end
            end
            -- json.lua encodes an empty table as []; mark non-empty maps as objects.
            local j = rawget(_G, "json")
            if count > 0 and type(j) == "table" and j.object then
                out = j.object(out)
            end
        end
        seen[v] = nil
        return out
    else
        return tostring(v)
    end
end

--- Run a Lua chunk.
-- @param params table { code: string, undo?: boolean (default true) }
-- @return table { result: any, output: string }
function script.run(moho, params)
    local code = params.code
    if type(code) ~= "string" or code == "" then
        return nil, "code must be a non-empty string"
    end

    local lines, size = {}, 0
    local function capture(...)
        local parts = {}
        for i = 1, select("#", ...) do
            parts[i] = tostring((select(i, ...)))
        end
        local line = table.concat(parts, "\t")
        if size < MAX_OUTPUT then
            lines[#lines + 1] = line
            size = size + #line + 1
        end
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

    -- Abort runaway loops instead of freezing Moho.
    local hookSet = false
    local oldHook, oldMask, oldCount
    if debug and debug.sethook then
        local started = os.clock()
        local limit = script.timeLimit
        oldHook, oldMask, oldCount = debug.gethook()
        hookSet = pcall(debug.sethook, function()
            if os.clock() - started > limit then
                error("lua.run time limit (" .. limit .. " s CPU) exceeded", 2)
            end
        end, "", 100000)
    end

    local packed = table.pack(pcall(chunk))

    if hookSet then
        if oldHook then
            pcall(debug.sethook, oldHook, oldMask, oldCount)
        else
            pcall(debug.sethook)
        end
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

    local result
    if packed.n <= 1 then
        result = jsonNull()
    elseif packed.n == 2 then
        result = toJson(packed[2], 0, {})
    else
        result = {}
        for i = 2, packed.n do
            local item = toJson(packed[i], 0, {})
            if item == nil then item = "nil" end
            result[i - 1] = item
        end
    end

    return { result = result, output = output }
end

script._toJson = toJson

return script
