-- svg.lua
-- svg.import: import an SVG file with Moho's bundled SVG importer
-- (Scripts/Tool/ss_svg_import14.lua, global SS_SVGImport) without its dialogs.
-- SS_SVGImport:Run asks LM.GUI.OpenFile for a path when browseFirst/hideDialog
-- is set (ss_svg_import14.lua:530-531) and skips its options dialog when
-- hideDialog is true (:549). The importer opens its own undo step and marks
-- the document dirty (PrepUndo(nil) + SetDirty, :3030-3031).
-- Import options (scaling, layer minifying, etc.) are whatever the user last
-- saved in the importer's own dialog (its SS_SVGImport.* prefs); only the file
-- dialog and the options dialog are bypassed.

local svg = {}

local function isAbsolute(path)
    return path:sub(1, 1) == "/" or path:match("^%a:[\\/]") ~= nil
end

--- Layer identities that survive layer insertion (absolute IDs shift).
--- Preferred: layer:UUID() (used by ss_svg_import14.lua:1401). Without it,
--- a "path|type" signature, counted as a multiset, so existing layers are
--- matched one-to-one and only the extra ones count as added.
local function snapshot(edit, moho)
    local uuids, sigs, haveUuid = {}, {}, true
    edit.eachLayer(moho, function(lyr, _, path)
        local ok, uuid = pcall(function() return lyr:UUID() end)
        if ok and uuid ~= nil and uuid ~= "" then
            uuids[tostring(uuid)] = true
        else
            haveUuid = false
        end
        local lt = nil
        pcall(function() lt = lyr:LayerType() end)
        local sig = path .. "|" .. tostring(lt)
        sigs[sig] = (sigs[sig] or 0) + 1
    end)
    return { uuids = uuids, sigs = sigs, haveUuid = haveUuid }
end

--- Import an SVG file.
-- @param params table { path: absolute path to an existing .svg file }
-- @return table { path, added = [{ layerId, name, type, parentId }], count }
function svg.import(moho, params)
    local edit = require("moho_mcp.edit")
    local path = params.path
    if type(path) ~= "string" or path == "" then
        return nil, "path must be a non-empty string"
    end
    if not isAbsolute(path) then
        return nil, "path must be absolute: " .. path
    end
    if path:sub(-4) ~= ".svg" then
        return nil, "path must end in .svg (lowercase): " .. path
    end
    local f = io.open(path, "rb")
    if not f then
        return nil, "SVG file not found: " .. path
    end
    f:close()
    if not moho or not moho.document then
        return nil, "No active document"
    end
    local importer = rawget(_G, "SS_SVGImport")
    if type(importer) ~= "table" or type(importer.Run) ~= "function" then
        return nil, "Moho's SVG importer (SS_SVGImport, Tool/ss_svg_import14.lua) is not loaded"
    end
    local gui = LM and LM.GUI
    if type(gui) ~= "table" and type(gui) ~= "userdata" then
        return nil, "LM.GUI is unavailable"
    end

    local before = snapshot(edit, moho)

    local origOpen = gui.OpenFile
    local origHide, origBrowse = importer.hideDialog, importer.browseFirst
    local ok, err = pcall(function()
        gui.OpenFile = function() return path end
        importer.hideDialog = true
        importer:Run(moho)
    end)
    -- Restore in every path, each step on its own.
    pcall(function() gui.OpenFile = origOpen end)
    pcall(function() importer.hideDialog = origHide end)
    pcall(function() importer.browseFirst = origBrowse end)

    edit.finish()

    if not ok then
        return nil, "SVG import failed: " .. tostring(err)
    end

    local added = {}
    local remaining = {}
    for sig, n in pairs(before.sigs) do remaining[sig] = n end
    edit.eachLayer(moho, function(lyr, parent, path)
        local lt = nil
        pcall(function() lt = lyr:LayerType() end)
        local isNew
        local ok, uuid = pcall(function() return lyr:UUID() end)
        if before.haveUuid and ok and uuid ~= nil and uuid ~= "" then
            isNew = not before.uuids[tostring(uuid)]
        else
            local sig = path .. "|" .. tostring(lt)
            if (remaining[sig] or 0) > 0 then
                remaining[sig] = remaining[sig] - 1
                isNew = false
            else
                isNew = true
            end
        end
        if isNew then
            added[#added + 1] = {
                layerId  = edit.layerId(moho, lyr),
                name     = lyr:Name(),
                type     = edit.typeName(lt),
                parentId = parent and edit.layerId(moho, parent) or -1,
            }
        end
    end)
    if #added == 0 then
        return nil, "The SVG importer added no layers (is " .. path .. " a valid SVG?)"
    end

    return { path = path, added = added, count = #added }
end

return svg
