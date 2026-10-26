-- shape.lua
-- shape.draw: create points, a curve and a shape in a vector layer.
-- Mirrors Moho's own procedural drawing:
--   Scripts/Tool/lm_shape.lua:206-229 (AddLonePoint/AppendPoint/WeldPoints,
--     SetCurvature, SelectConnected, moho:CreateShape(fill, false, 0))
--   Scripts/Menu/Particle Effects/lm_snow.lua:84-113 and lm_rain.lua:98-110
--     (moho:Mesh(), MakePlain, fFillCol / fLineCol / fLineWidth)
--   Scripts/Menu/Layer Effects/rt_break_apart_shapes.lua:333-334
--     (moho:SetSelLayer(layer) then moho:Mesh() targets that layer)

local edit = require("moho_mcp.edit")

local shape = {}

local function isVectorLayer(lyr)
    local M = edit.M()
    local ok, lt = pcall(function() return lyr:LayerType() end)
    return ok and M ~= nil and lt == M.LT_VECTOR
end

--- Draw a polyline/polygon as a new shape.
-- @param params table {
--     layer?: number|string, layerId?: number,
--     points: [[x, y], ...] (Moho world units, at least 2; 3 when closed),
--     closed?: boolean, fill?: {r,g,b,a}, stroke?: {r,g,b,a},
--     strokeWidth?: number (pixels), smooth?|curved?: boolean }
-- @return table { layerId, layerName, shapeId, pointIds, closed, hasFill, hasOutline }
function shape.draw(moho, params)
    local pts = params.points
    if type(pts) ~= "table" or #pts < 2 then
        return nil, "points must be an array of at least 2 [x, y] pairs"
    end
    local closed = params.closed == true
    if closed and #pts < 3 then
        return nil, "a closed shape needs at least 3 points"
    end
    local coords = {}
    for i, p in ipairs(pts) do
        local xy, perr = edit.point(p, "points[" .. i .. "]")
        if not xy then return nil, perr end
        coords[i] = xy
    end

    local fillCol, strokeCol
    if params.fill ~= nil then
        if not closed then
            return nil, "fill requires closed = true"
        end
        local c, cerr = edit.color(params.fill, "fill")
        if not c then return nil, cerr end
        fillCol = c
    end
    if params.stroke ~= nil then
        local c, cerr = edit.color(params.stroke, "stroke")
        if not c then return nil, cerr end
        strokeCol = c
    end
    if params.strokeWidth ~= nil and (type(params.strokeWidth) ~= "number" or params.strokeWidth < 0) then
        return nil, "strokeWidth must be a non-negative number (pixels)"
    end

    local ref = params.layer
    if ref == nil then ref = params.layerId end
    local lyr, lerr = edit.findLayer(moho, ref)
    if not lyr then return nil, lerr end
    if not isVectorLayer(lyr) then
        return nil, "Layer '" .. tostring(lyr:Name()) .. "' is not a vector layer"
    end
    local targetId = edit.layerId(moho, lyr)

    -- moho:CreateShape works on the current layer, so make the target current
    -- and switch back afterwards, as rt_break_apart_shapes.lua:333-355 does.
    local prevLayer = nil
    if edit.layerId(moho, moho.layer) ~= targetId then
        prevLayer = moho.layer
        moho:SetSelLayer(lyr)
        if edit.layerId(moho, moho.layer) ~= targetId then
            if prevLayer then moho:SetSelLayer(prevLayer) end
            return nil, "Could not make layer " .. tostring(targetId) .. " the current layer"
        end
    end
    local function restoreLayer()
        if prevLayer then pcall(function() moho:SetSelLayer(prevLayer) end) end
    end
    local mesh = moho:Mesh()
    if mesh == nil then
        restoreLayer()
        return nil, "Current layer has no mesh"
    end

    edit.begin(moho, lyr)

    mesh:SelectNone()
    local n = mesh:CountPoints()
    local v = LM.Vector2:new_local()
    v:Set(coords[1].x, coords[1].y)
    mesh:AddLonePoint(v, 0)
    for i = 2, #coords do
        v:Set(coords[i].x, coords[i].y)
        mesh:AppendPoint(v, 0)
    end
    if closed then
        v:Set(coords[1].x, coords[1].y)
        mesh:AppendPoint(v, 0)
        mesh:WeldPoints(n + #coords, n, 0)
    end

    local M = edit.M()
    local smooth = params.smooth == true or params.curved == true
    local curvature = smooth and M.SMOOTH or M.PEAKED
    local pointIds = {}
    for i = 0, #coords - 1 do
        local pt = mesh:Point(n + i)
        pt:SetCurvature(curvature, 0)
        pt.fSelected = true
        pointIds[#pointIds + 1] = n + i
    end
    mesh:SelectConnected()

    local wantFill = closed and (fillCol ~= nil or strokeCol == nil)
    local shapeId = moho:CreateShape(wantFill, false, 0)
    if shapeId < 0 and wantFill then
        -- Same fallback as rt_break_apart_shapes.lua:294-298.
        shapeId = moho:CreateShape(false, false, 0)
        wantFill = false
    end
    mesh:SelectNone()
    if shapeId < 0 then
        restoreLayer()
        edit.finish()
        return nil, "Moho could not create a shape from these points (points " ..
            n .. ".." .. (n + #coords - 1) .. " were added)"
    end

    local shp = mesh:Shape(shapeId)
    if fillCol ~= nil or strokeCol ~= nil then
        shp:MakePlain()
    end
    if wantFill and fillCol ~= nil and strokeCol == nil then
        shp.fHasOutline = false
    end
    if fillCol ~= nil then
        shp.fMyStyle.fFillCol:SetValue(0, fillCol)
    end
    if strokeCol ~= nil then
        shp.fMyStyle.fLineCol:SetValue(0, strokeCol)
    end
    if params.strokeWidth ~= nil then
        -- Moho stores line width as a fraction of the document height
        -- (Scripts/Menu/Tiling/lm_tile1.lua:168).
        shp.fMyStyle.fLineWidth = params.strokeWidth / moho.document:Height()
    end

    restoreLayer()
    edit.finish()

    local hasFill, hasOutline = wantFill, true
    pcall(function() hasFill = shp.fHasFill end)
    pcall(function() hasOutline = shp.fHasOutline end)

    return {
        layerId    = targetId,
        layerName  = lyr:Name(),
        shapeId    = shapeId,
        pointIds   = pointIds,
        closed     = closed,
        hasFill    = hasFill and true or false,
        hasOutline = hasOutline and true or false,
    }
end

return shape
