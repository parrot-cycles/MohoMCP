#!/bin/bash
# MohoMCP plugin installer (macOS).
#
# Usage: ./install-plugin.sh [--link] [TARGET]
#
#   TARGET  Where Moho looks for scripts. One of:
#           - a Moho Scripts folder, e.g. your custom content folder
#             "~/Library/Application Support/Moho/Moho Pro/Scripts" (the default)
#           - a Moho app, e.g. "/Applications/Moho.app" (installs into
#             Contents/Resources/Support/Scripts; editing the app bundle breaks
#             its code signature, so prefer the custom content folder)
#   --link  Symlink the files into this checkout instead of copying them, so
#           the installed plugin follows the working tree (development).
#
# Layout written (Moho runs every .lua under Scripts/Menu at launch, so only the
# menu script goes there; library modules go in Scripts/Modules):
#   Menu/MohoMCP/MohoMCP_Server.lua
#   Modules/moho_mcp/            (the whole moho-plugin/moho_mcp folder)
#   Tool/MohoMCP_Poller.lua      (+ one "MohoMCP_Poller" line in Tool/_tool_list.txt)

set -u

MODE=copy
TARGET=""
for arg in "$@"; do
    case "$arg" in
        --link) MODE=link ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) TARGET="$arg" ;;
    esac
done

echo "============================================"
echo " MohoMCP Plugin Installer (macOS)"
echo "============================================"
echo ""

TARGET="${TARGET:-$HOME/Library/Application Support/Moho/Moho Pro/Scripts}"
TARGET="${TARGET%/}"
case "$TARGET" in
    *.app)
        SCRIPTS="$TARGET/Contents/Resources/Support/Scripts"
        echo "WARNING: installing into the app bundle breaks its code signature."
        echo "         Prefer the custom content folder (run without arguments)."
        ;;
    *) SCRIPTS="$TARGET" ;;
esac

MENU_DEST="$SCRIPTS/Menu/MohoMCP"
MODULE_DEST="$SCRIPTS/Modules/moho_mcp"
TOOL_DEST="$SCRIPTS/Tool"
SRC="$(cd "$(dirname "$0")" && pwd)/moho-plugin"

echo "Moho scripts folder: $SCRIPTS"
echo "Mode: $MODE"
echo ""
if [ ! -d "$SCRIPTS/Menu" ] && [ ! -d "$SCRIPTS/Tool" ]; then
    echo "ERROR: $SCRIPTS does not look like a Moho Scripts folder (no Menu/ or Tool/)."
    echo "Pass your custom content Scripts folder or the Moho app, for example:"
    echo "  ./install-plugin.sh \"\$HOME/Library/Application Support/Moho/Moho Pro/Scripts\""
    echo "  ./install-plugin.sh \"/Applications/Moho.app\""
    exit 1
fi

# Older versions put library files in Menu/MohoMCP (as copies or symlinks).
# rm -rf on a symlink removes only the link, never the checkout it points to.
echo "Removing library files left in the Menu folder by older versions..."
for old in "$MENU_DEST/moho_mcp" "$MENU_DEST/json.lua"; do
    if [ -L "$old" ] || [ -e "$old" ]; then
        rm -rf "$old" && echo "  removed $old"
    fi
done

mkdir -p "$MENU_DEST" "$SCRIPTS/Modules" "$TOOL_DEST" || { echo "ERROR: cannot create folders."; exit 1; }

# Replace whatever is at the module destination (old copy, old link).
if [ -L "$MODULE_DEST" ]; then
    rm -f "$MODULE_DEST"
elif [ -e "$MODULE_DEST" ]; then
    rm -rf "$MODULE_DEST"
fi

if [ "$MODE" = link ]; then
    echo "Linking files into $SRC ..."
    ln -sfn "$SRC/MohoMCP_Server.lua" "$MENU_DEST/MohoMCP_Server.lua" &&
    ln -sfn "$SRC/moho_mcp" "$MODULE_DEST" &&
    ln -sfn "$SRC/MohoMCP_Poller.lua" "$TOOL_DEST/MohoMCP_Poller.lua" || { echo "ERROR: Linking failed."; exit 1; }
else
    echo "Copying files..."
    rm -f "$MENU_DEST/MohoMCP_Server.lua" "$TOOL_DEST/MohoMCP_Poller.lua"
    mkdir -p "$MODULE_DEST" &&
    cp -f "$SRC/MohoMCP_Server.lua" "$MENU_DEST/" &&
    cp -Rf "$SRC/moho_mcp/." "$MODULE_DEST/" &&
    cp -f "$SRC/MohoMCP_Poller.lua" "$TOOL_DEST/" || { echo "ERROR: Copying failed."; exit 1; }
fi

echo "Registering tool in tool list..."
TOOL_LIST="$TOOL_DEST/_tool_list.txt"
if [ ! -f "$TOOL_LIST" ]; then
    echo "  WARNING: $TOOL_LIST not found; not creating one (it would replace Moho's"
    echo "  own tool list). Add this tab-separated line to the tool list Moho uses:"
    echo "    tool	MohoMCP_Poller	..."
elif grep -q "MohoMCP_Poller" "$TOOL_LIST"; then
    echo "  MohoMCP_Poller already in _tool_list.txt"
else
    # Make sure the file ends with a newline before appending.
    [ -n "$(tail -c1 "$TOOL_LIST")" ] && echo "" >> "$TOOL_LIST"
    printf 'tool\tMohoMCP_Poller\t...\n' >> "$TOOL_LIST"
    echo "  Added MohoMCP_Poller to _tool_list.txt"
fi

echo ""
echo "Installed:"
ls -la "$MENU_DEST" "$TOOL_DEST/MohoMCP_Poller.lua"
ls -lad "$MODULE_DEST"

echo ""
echo "============================================"
echo " Installation complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. (Re)start Moho - it only loads plugin modules once per launch"
echo "  2. Scripts menu > MohoMCP > Start/Stop MohoMCP Server"
echo "  3. Select the 'MohoMCP Poller' tool from the toolbar"
echo "     (it will be in the last tool group)"
echo "  4. While the tool is selected, the server polls for requests"
echo ""
