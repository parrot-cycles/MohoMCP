-- svg.lua
-- svg.import: import an SVG file with Moho's bundled SVG importer
-- (Scripts/Tool/ss_svg_import14.lua, global SS_SVGImport) without its dialogs.
-- SS_SVGImport:Run asks LM.GUI.OpenFile for a path when browseFirst/hideDialog
-- is set (ss_svg_import14.lua:530-531) and skips its options dialog when
-- hideDialog is true (:549). The importer opens its own undo step and marks
-- the document dirty (PrepUndo(nil) + SetDirty, :3030-3031).

local svg = {}

local function isAbsolute(path)
    return path:sub(1, 1) == "/" or path:match("^%a:[\\/]") ~= nil
end

--- Identity of a layer that survives layer insertion (absolute IDs shift).
local function layerKey(lyr)
    local ok, uuid = pcall(function() return lyr:UUID() end)
    if ok and uuid ~= nil then return "uuid:" .. tostring(uuid) end
    return lyr
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

    local before = {}
    edit.eachLayer(moho, function(lyr) before[layerKey(lyr)] = true end)

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
    edit.eachLayer(moho, function(lyr, parent)
        if not before[layerKey(lyr)] then
            local lt = nil
            pcall(function() lt = lyr:LayerType() end)
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
