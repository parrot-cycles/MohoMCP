-- batch.lua
-- Batch execution handler for MohoMCP.
-- Executes multiple operations in a single IPC round-trip, collapsing
-- N file-based request/response cycles into one Lua poll cycle.

local batch = {}

-- Maximum number of operations allowed in a single batch
local MAX_OPERATIONS = 50

-- Total wall-clock seconds one batch may take. Checked between operations and
-- passed into lua.run as its remaining limit. The bridge waits longer
-- (bridge/src/config.ts batchBudgetMs + 5 s + per-op allowance).
batch.TIME_BUDGET = 25
-- At most this many slow operations per batch.
batch.MAX_HEAVY = 5
local heavyMethods = { ["lua.run"] = true, ["svg.import"] = true }

-- Methods that are not allowed inside a batch
local disallowedInBatch = {
    ["document.screenshot"] = true,  -- too slow / heavyweight for batching
    ["batch.execute"]       = true,  -- no nesting
}

--- Execute a batch of operations.
-- @param moho  The MOHO ScriptInterface object
-- @param params table  { operations: table[], stopOnError?: boolean }
-- @return table  { results: table[], summary: table }
function batch.execute(moho, params)
    local operations = params.operations
    local stopOnError = params.stopOnError or false

    -- Validate operations is a non-empty array
    if type(operations) ~= "table" or #operations == 0 then
        return nil, "operations must be a non-empty array"
    end

    if #operations > MAX_OPERATIONS then
        return nil, "Too many operations: " .. #operations
            .. " (max " .. MAX_OPERATIONS .. ")"
    end

    local heavy = 0
    for _, op in ipairs(operations) do
        if type(op) == "table" and heavyMethods[op.method] then heavy = heavy + 1 end
    end
    if heavy > batch.MAX_HEAVY then
        return nil, "At most " .. batch.MAX_HEAVY .. " lua.run/svg.import operations per batch (got " .. heavy .. ")"
    end

    -- Lazy-load dependencies (available via package.loaded after server.init)
    local validator = require("moho_mcp.validator")
    local server = require("moho_mcp.server")
    local elapsed = require("moho_mcp.edit").clock()
    local budget = batch.TIME_BUDGET
    local outOfTime = false

    local results = {}
    local succeeded = 0
    local failed = 0
    local executed = 0
    local stoppedEarly = false

    for i, op in ipairs(operations) do
        -- Check if we should stop due to a previous error
        if stoppedEarly then
            results[i] = {
                success = false,
                index = i,
                error = { code = -32000, message = outOfTime
                    and ("Skipped: batch time budget (" .. budget .. " s) exhausted")
                    or "Skipped (stopOnError)" },
            }
            goto continue
        end

        -- Stop starting operations once the batch has used its time budget.
        local remaining = budget - elapsed()
        if remaining <= 0 then
            outOfTime = true
            stoppedEarly = true
            results[i] = {
                success = false,
                index = i,
                error = { code = -32000, message = "Skipped: batch time budget (" .. budget .. " s) exhausted" },
            }
            goto continue
        end

        -- Validate operation structure
        if type(op) ~= "table" or type(op.method) ~= "string" then
            results[i] = {
                success = false,
                index = i,
                error = { code = -32600, message = "Invalid operation at index " .. i .. ": must have a string 'method'" },
            }
            failed = failed + 1
            executed = executed + 1
            if stopOnError then
                stoppedEarly = true
            end
            goto continue
        end

        local method = op.method
        local opParams = op.params or {}
        if method == "lua.run" and type(opParams) == "table" then
            -- Give the chunk only what is left of the batch budget.
            local copy = {}
            for k, v in pairs(opParams) do copy[k] = v end
            copy._timeLimit = remaining
            opParams = copy
        end

        -- Check disallowed methods
        if disallowedInBatch[method] then
            results[i] = {
                success = false,
                index = i,
                error = { code = -32601, message = "Method not allowed in batch: " .. method },
            }
            failed = failed + 1
            executed = executed + 1
            if stopOnError then
                stoppedEarly = true
            end
            goto continue
        end

        -- Check allow-list
        if not validator.isAllowed(method) then
            results[i] = {
                success = false,
                index = i,
                error = { code = -32601, message = "Method not found: " .. method },
            }
            failed = failed + 1
            executed = executed + 1
            if stopOnError then
                stoppedEarly = true
            end
            goto continue
        end

        -- Validate params
        local valid, validErr = validator.validateParams(method, opParams)
        if not valid then
            results[i] = {
                success = false,
                index = i,
                error = { code = -32602, message = validErr or "Invalid parameters" },
            }
            failed = failed + 1
            executed = executed + 1
            if stopOnError then
                stoppedEarly = true
            end
            goto continue
        end

        -- Look up handler
        local handler = server.getHandler(method)
        if not handler then
            results[i] = {
                success = false,
                index = i,
                error = { code = -32601, message = "No handler registered for: " .. method },
            }
            failed = failed + 1
            executed = executed + 1
            if stopOnError then
                stoppedEarly = true
            end
            goto continue
        end

        -- Execute with pcall
        local ok, result, handlerErr = pcall(handler, moho, opParams)
        executed = executed + 1

        if not ok then
            -- pcall caught an error (result is the error message)
            results[i] = {
                success = false,
                index = i,
                error = { code = -32603, message = "Handler error: " .. tostring(result) },
            }
            failed = failed + 1
            if stopOnError then
                stoppedEarly = true
            end
        elseif result == nil and handlerErr then
            -- Handler returned nil + error string
            results[i] = {
                success = false,
                index = i,
                error = { code = -32603, message = handlerErr },
            }
            failed = failed + 1
            if stopOnError then
                stoppedEarly = true
            end
        else
            results[i] = {
                success = true,
                index = i,
                result = result,
            }
            succeeded = succeeded + 1
        end

        ::continue::
    end

    -- Fill any remaining slots if stoppedEarly (already done in the loop above)

    return {
        results = results,
        summary = {
            timeBudgetExhausted = outOfTime,
            total = #operations,
            executed = executed,
            succeeded = succeeded,
            failed = failed,
            stoppedEarly = stoppedEarly,
        },
    }
end

return batch
