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
REPO="$(cd -P "$(dirname "$0")" && pwd)"
SRC="$REPO/moho-plugin"

# Physical path of $1: symlinks in the folder part are resolved, and the last
# component too when it is a symlink (no realpath/python dependency).
phys() {
    local p="$1" d b t n=0
    while :; do
        d="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd)" || { echo "$p"; return; }
        b="$(basename "$p")"
        if [ -L "$d/$b" ] && [ $n -lt 40 ]; then
            t="$(readlink "$d/$b")"
            case "$t" in /*) p="$t" ;; *) p="$d/$t" ;; esac
            n=$((n + 1))
        else
            echo "$d/$b"
            return
        fi
    done
}

# True when $1 resolves to the checkout or anything inside it.
in_repo() {
    local r; r="$(phys "$1")"
    [ "$r" = "$REPO" ] || case "$r" in "$REPO"/*) true ;; *) false ;; esac
}

# Remove one MohoMCP-owned path. A symlink is unlinked (its target is never
# touched); a real file or folder is deleted only if it does not resolve into
# this checkout.
safe_rm() {
    local p="$1"
    if [ -L "$p" ]; then
        rm -f "$p" && echo "  unlinked $p"
    elif [ -e "$p" ]; then
        if in_repo "$p"; then
            echo "ERROR: refusing to delete $p: it resolves into this checkout ($(phys "$p"))." >&2
            exit 1
        fi
        rm -rf "$p" && echo "  removed $p"
    fi
}

# Make $1 a real folder of its own: if it is a symlink (e.g. Menu/MohoMCP linked
# to <checkout>/moho-plugin by an older setup), drop only the link.
own_dir() {
    if [ -L "$1" ]; then
        rm -f "$1" && echo "  unlinked folder link $1"
    fi
    mkdir -p "$1" || { echo "ERROR: cannot create $1" >&2; exit 1; }
}

echo "Moho scripts folder: $SCRIPTS"
echo "Mode: $MODE"
echo ""
if [ ! -d "$SCRIPTS/Menu" ] && [ ! -d "$SCRIPTS/Tool" ]; then
    echo "ERROR: $SCRIPTS does not look like a Moho Scripts folder (no Menu/ or Tool/)." >&2
    echo "Pass your custom content Scripts folder or the Moho app, for example:"
    echo "  ./install-plugin.sh \"\$HOME/Library/Application Support/Moho/Moho Pro/Scripts\""
    echo "  ./install-plugin.sh \"/Applications/Moho.app\""
    exit 1
fi

# Moho's own folders must not lead back into the checkout.
for dir in "$SCRIPTS" "$SCRIPTS/Menu" "$SCRIPTS/Modules" "$TOOL_DEST"; do
    if [ -e "$dir" ] && in_repo "$dir"; then
        echo "ERROR: $dir resolves into this checkout ($(phys "$dir")); refusing to install there." >&2
        exit 1
    fi
done

own_dir "$MENU_DEST"
mkdir -p "$SCRIPTS/Modules" "$TOOL_DEST" || { echo "ERROR: cannot create folders." >&2; exit 1; }

# Older versions put library files in Menu/MohoMCP (as copies or symlinks).
echo "Removing files left by older installs..."
safe_rm "$MENU_DEST/moho_mcp"
safe_rm "$MENU_DEST/json.lua"
safe_rm "$MENU_DEST/MohoMCP_Server.lua"
safe_rm "$MODULE_DEST"
safe_rm "$TOOL_DEST/MohoMCP_Poller.lua"

if [ "$MODE" = link ]; then
    echo "Linking files into $SRC ..."
    ln -s "$SRC/MohoMCP_Server.lua" "$MENU_DEST/MohoMCP_Server.lua" &&
    ln -s "$SRC/moho_mcp" "$MODULE_DEST" &&
    ln -s "$SRC/MohoMCP_Poller.lua" "$TOOL_DEST/MohoMCP_Poller.lua" || { echo "ERROR: Linking failed." >&2; exit 1; }
else
    echo "Copying files..."
    mkdir -p "$MODULE_DEST" &&
    cp "$SRC/MohoMCP_Server.lua" "$MENU_DEST/" &&
    cp -R "$SRC/moho_mcp/." "$MODULE_DEST/" &&
    cp "$SRC/MohoMCP_Poller.lua" "$TOOL_DEST/" || { echo "ERROR: Copying failed." >&2; exit 1; }
fi

echo "Registering tool in tool list..."
TOOL_LIST="$TOOL_DEST/_tool_list.txt"
if [ -e "$TOOL_LIST" ] && in_repo "$TOOL_LIST"; then
    echo "  ERROR: $TOOL_LIST resolves into this checkout; not editing it." >&2
    exit 1
elif [ ! -f "$TOOL_LIST" ]; then
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
