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

--- The truncation marker, handed out once per result; "" afterwards so
--- enclosing tables do not repeat it.
local function marker(state)
    if state.marked then return "" end
    state.marked = true
    return TRUNCATED
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
        if not charge(state, 2) then return marker(state) end
        state.seen[v] = true
        local n = #v
        local count = 0
        for _ in pairs(v) do count = count + 1 end
        local out = {}
        if count > 0 and count == n then
            for i = 1, n do
                if state.truncated then
                    if not state.marked then out[#out + 1] = marker(state) end
                    break
                end
                local item = toJson(v[i], depth + 1, state)
                if item == nil then item = "nil" end
                out[i] = item
            end
        else
            for k, val in pairs(v) do
                if state.truncated then
                    if not state.marked then out[marker(state)] = true end
                    break
                end
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
        if room > 0 then return str:sub(1, room) .. marker(state) end
        return marker(state)
    end
end

-- Document-level calls that crash Moho when made from inside the poll
-- (live test: moho:FileNew() -> SIGSEGV in MohoView::DrawViewContents;
-- FileRender -> SIGSEGV in ScriptInterface_FileRender). FileSave/FileSaveAs
-- stay allowed but are untested inside the poll.
script.BLOCKED_METHODS = {
    "FileNew", "FileOpen", "FileClose", "FileRender", "FileImport", "FileImportImageSequence",
}

--- The table that actually holds method `name` for `obj`: the object itself
--- (plain tables) or a table on its metatable chain (tolua++ classes keep
--- methods in the class metatable and chain to the base class's).
local function methodHolder(obj, name)
    if type(obj) == "table" and rawget(obj, name) ~= nil then return obj end
    local ok, mt = pcall(getmetatable, obj)
    local hops = 0
    while ok and type(mt) == "table" and hops < 16 do
        if rawget(mt, name) ~= nil then return mt end
        local idx = rawget(mt, "__index")
        if type(idx) == "table" and idx ~= mt and rawget(idx, name) ~= nil then return idx end
        ok, mt = pcall(getmetatable, mt)
        hops = hops + 1
    end
    return nil
end

--- Temporarily replace the blocked methods where they live, so the real
--- `moho` userdata can still be handed to other scripts' APIs. Each swap is
--- verified: if `moho.<name>` does not resolve to the stub afterwards (the
--- binding looks methods up some other way), the swap is undone and the name
--- is reported as missed. Never raises.
-- @return function  restores the originals (safe to call more than once)
-- @return table  names that could not be blocked
local function blockFileCalls(moho)
    local saved, missed = {}, {}
    local function restore()
        for i = #saved, 1, -1 do
            local entry = saved[i]
            pcall(rawset, entry[1], entry[2], entry[3])
        end
    end
    local ok = pcall(function()
        for _, name in ipairs(script.BLOCKED_METHODS) do
            local holder = moho ~= nil and methodHolder(moho, name) or nil
            local blocked = false
            if holder then
                local entry = { holder, name, rawget(holder, name) }
                local stub = function()
                    error("moho:" .. name .. "() is blocked in lua_run: Moho crashes when it creates, opens, "
                        .. "closes, imports or renders documents from inside the MohoMCP poll", 2)
                end
                saved[#saved + 1] = entry
                rawset(holder, name, stub)
                local resolved = nil
                pcall(function() resolved = moho[name] end)
                if rawequal(resolved, stub) then
                    blocked = true
                else
                    rawset(holder, name, entry[3])
                    saved[#saved] = nil
                end
            end
            if not blocked then missed[#missed + 1] = name end
        end
    end)
    if not ok then
        -- Something in the binding raised: undo everything, block nothing.
        restore()
        saved = {}
        missed = {}
        for _, name in ipairs(script.BLOCKED_METHODS) do missed[#missed + 1] = name end
    end
    return restore, missed
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

    -- Block document-level calls for the duration of the chunk. If a method
    -- could not be intercepted (unexpected binding layout), refuse chunks that
    -- mention it rather than risk a crash.
    local unblock, missed = blockFileCalls(moho)
    for _, name in ipairs(missed) do
        local present = false
        pcall(function() present = moho[name] ~= nil end)
        if present and code:find(name, 1, true) then
            unblock()
            return nil, "moho:" .. name .. "() is blocked in lua_run (it crashes Moho inside the MohoMCP poll)"
        end
    end

    -- Changes made by the chunk are one undoable step, like a menu script
    -- (Scripts/Menu/Particle Effects/lm_snow.lua:45-46). Protected, so a
    -- failure here cannot leave the File methods swapped.
    local prepOk, prepErr = pcall(function()
        if params.undo ~= false and doc then
            doc:PrepUndo(nil)
            doc:SetDirty()
        end
    end)
    if not prepOk then
        unblock()
        return nil, "lua_run could not open an undo step: " .. tostring(prepErr)
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
        local gotHook
        gotHook, oldHook, oldMask, oldCount = pcall(debug.gethook)
        if not gotHook then oldHook = nil end
        hookSet = pcall(debug.sethook, function()
            if active and elapsed() > limit then
                error("lua.run time limit (" .. limit .. " s) exceeded", 2)
            end
        end, "", 100000)
    end

    local ranOk, packed = pcall(function()
        local r = table.pack(pcall(chunk))
        active = false
        unblock()
        return r
    end)
    active = false
    unblock()
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

    local state = { seen = {}, bytes = 0, truncated = false, marked = false }
    local result
    if packed.n <= 1 then
        result = jsonNull()
    elseif packed.n == 2 then
        result = toJson(packed[2], 0, state)
    else
        result = {}
        for i = 2, packed.n do
            if state.truncated then
                if not state.marked then result[#result + 1] = marker(state) end
                break
            end
            local item = toJson(packed[i], 0, state)
            if item == nil then item = "nil" end
            result[i - 1] = item
        end
    end

    return { result = result, output = output, truncated = (state.truncated or outputCut) or nil }
end

script._toJson = toJson

return script
