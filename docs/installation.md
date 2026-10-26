# Installation Guide

## Prerequisites

- **Moho Pro 14** (14.4 or later recommended) installed
- **Node.js** 18+ installed ([nodejs.org](https://nodejs.org))
- **Windows 10/11** or **macOS** (all features supported on both platforms)

### macOS-specific prerequisites

- **Accessibility permissions** — required for input simulation tools (mouse clicks, keyboard shortcuts). Go to System Settings > Privacy & Security > Accessibility and add your terminal app and/or Claude Desktop.
- **cliclick** (optional, recommended) — `brew install cliclick` — provides more reliable mouse input. Without it, the bridge falls back to CoreGraphics via JXA.

## Step 1: Install the MOHO Plugin

The plugin consists of Lua files that run inside MOHO's scripting environment.

### Option A: Use the install script (recommended)

**Windows:**
```cmd
install-plugin.bat
```

**macOS:**
```bash
./install-plugin.sh                 # copy into your custom content folder
./install-plugin.sh --link          # symlink into this checkout (development)
./install-plugin.sh "/Applications/Moho.app"   # into the app bundle (breaks its code signature)
```

Without a target, the macOS script installs into Moho's custom content folder, `~/Library/Application Support/Moho/Moho Pro/Scripts`. A target can be any Moho `Scripts` folder or a Moho `.app`. With `--link` the installed files are symlinks into `moho-plugin/` of this checkout, so pulling or editing the checkout updates the plugin (restart Moho to load it). The script also removes `Menu/MohoMCP/moho_mcp` and `Menu/MohoMCP/json.lua` left by older versions, and adds the poller to `Tool/_tool_list.txt` only once (it never creates that file).

The scripts automatically copy all files to the correct locations and register the poller tool.

On Windows the script finds Moho wherever it is installed. If it can't, or you have several Moho versions, pass the install folder: `install-plugin.bat "D:\Apps\Moho 14"`. If Moho is under `C:\Program Files`, run the script as Administrator.

### Option B: Manual installation

#### Locate Your MOHO Scripts Directory

| Platform | Scripts directory |
|----------|-------------------|
| Windows (default) | `C:\Program Files\Moho 14\Resources\Support\Scripts\` |
| Windows (other install location) | `<Moho folder>\Resources\Support\Scripts\` |
| macOS (custom content folder, recommended) | `~/Library/Application Support/Moho/Moho Pro/Scripts/` |
| macOS (app bundle; breaks its code signature) | `/Applications/Moho.app/Contents/Resources/Support/Scripts/` |

#### Copy files

> **Only copy the files listed here.** MOHO runs every `.lua` file under `Scripts/Menu/` as a menu script at startup. Library modules or the `tests/` folder placed there cause script errors, and `tests/run_tests.lua` can stop MOHO from starting.

```
Scripts/
├── Menu/MohoMCP/
│   └── MohoMCP_Server.lua      <- Main menu script & DrawMe hooks
├── Tool/
│   └── MohoMCP_Poller.lua      <- Poller tool
└── Modules/moho_mcp/           <- Copy the whole moho-plugin/moho_mcp/ folder
    ├── json.lua                <- JSON encoder/decoder library
    ├── server.lua              <- File-based IPC server core
    ├── protocol.lua            <- JSON-RPC 2.0 protocol handling
    ├── validator.lua           <- Method allow-list & parameter validation
    └── tools/                  <- Tool handler implementations
        ├── document.lua
        ├── layer.lua
        ├── bone.lua
        ├── animation.lua
        ├── mesh.lua
        └── batch.lua
```

Then register the poller by adding this line (tab-separated) to `Scripts/Tool/_tool_list.txt`:

```
tool	MohoMCP_Poller	...
```

If you installed an older version, delete `Menu/MohoMCP/json.lua` and `Menu/MohoMCP/moho_mcp/`.

### Verify Installation

1. Open Moho Pro 14
2. Check the **Scripts** menu — you should see **"MohoMCP Server"**
3. Click it to start the server — check MOHO's script console for `[MohoMCP] Server started`

## Step 2: Build the Bridge Server

```bash
cd bridge
npm install
npm run build
```

This compiles the TypeScript source to JavaScript in `bridge/dist/`.

## Step 3: Configure Your MCP Client

### Claude Code

Place a `.mcp.json` in your project root (or wherever you run Claude Code from):

**Windows:**
```json
{
  "mcpServers": {
    "moho-mcp": {
      "command": "node",
      "args": ["C:/path/to/MohoMCP/bridge/dist/index.js"]
    }
  }
}
```

**macOS:**
```json
{
  "mcpServers": {
    "moho-mcp": {
      "command": "node",
      "args": ["/path/to/MohoMCP/bridge/dist/index.js"]
    }
  }
}
```

Claude Code will automatically discover and connect to the server.

### Claude Desktop

Edit your Claude Desktop configuration file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the MohoMCP server (same format as above — use the full path to `bridge/dist/index.js`).

## Updating

**Upgrade the bridge and the plugin together, then restart Moho.** Moho loads the plugin's Lua modules once and keeps them in memory, so pulling new plugin files (or re-running the install script) has no effect until Moho is restarted. The plugin writes its IPC protocol version into `status.json`; a bridge that needs a different version refuses to connect with "Moho is running an older MohoMCP plugin — restart Moho to load the new one" instead of letting every request time out.

1. Update the checkout (or re-run the install script) and rebuild the bridge: `cd bridge && npm run build`
2. Quit and restart Moho, then start **Scripts > MohoMCP Server** again
3. Restart your MCP clients so they run the new `bridge/dist`

## Step 4: Start Everything

1. **Open Moho Pro 14** and load a project
2. **Start the plugin:** Scripts > MohoMCP Server
3. **Select the MohoMCP Poller tool** from the toolbar (last tool group)
4. **Start Claude Desktop** (or open Claude Code in a directory with `.mcp.json`) — the bridge auto-connects

## How Communication Works

The bridge and MOHO communicate via JSON files in a platform-specific temp directory:

| Platform | IPC directory |
|----------|---------------|
| Windows | `%TEMP%\moho-mcp\` |
| macOS | `$TMPDIR/moho-mcp/` (typically `/private/var/folders/.../moho-mcp/`) |

```
<temp>/moho-mcp/
├── status.json          <- Written by Lua when server starts
├── req_<id>.json        <- Bridge writes request
├── resp_<id>.json       <- Lua writes response, deletes req file
└── ...
```

1. Bridge writes a JSON-RPC 2.0 request as `req_<id>.json`. `<id>` is digits only: a per-process prefix (last 5 digits of the pid + last 4 digits of the start time in ms) followed by a 6-digit sequence, so concurrent bridge processes never share a file name
2. MOHO Lua plugin polls for new request files during DrawMe/IsEnabled callbacks
3. Lua processes the request, writes `resp_<id>.json`, deletes the request file
4. Bridge reads the response, deletes the response file

A background keep-alive process periodically forces MOHO viewport repaints (~4 Hz) so the Lua polling loop stays responsive even when the user isn't interacting with MOHO:
- **Windows:** Hidden PowerShell process calling Win32 `RedrawWindow()`
- **macOS:** a JavaScript-for-Automation helper (`osascript -l JavaScript`) that, while a request file is pending, posts a synthetic mouse-moved event to the running Moho process (`CGEventPostToPid`). The cursor does not move, focus does not change, and it works with Moho in the background or frontmost. It never launches or activates Moho and does nothing when Moho is not running. If your MCP client app has not been allowed to control the computer, macOS may ask for Accessibility permission the first time.

The helper uses the bridge's configured IPC directory and exits when the bridge does; disconnecting stops it and removes its script. The helper finds Moho by its bundle id (`com.lostmarble.moho`), ignores request files older than 60 s (left behind by a killed bridge), and at start checks whether it may post events; if not, the bridge logs "grant Accessibility to <app> so MohoMCP can wake Moho". The bridge also checks that Moho is running (`lsappinfo find bundleid=com.lostmarble.moho`) before connecting, before each request and while waiting, and reports "Moho is not running" instead of timing out: `status.json` keeps saying `running: true` after a crash. If that check itself cannot run, the bridge warns once and carries on.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOHO_MCP_IPC_DIR` | `<system-temp>/moho-mcp` | Override the IPC directory (same value must be used by both bridge and plugin) |

### Internal Timeouts

Configured in `bridge/src/config.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `pollInterval` | 100ms | How often bridge checks for response files |
| `requestTimeout` | 10,000ms | Max wait for a normal Lua response |
| `renderTimeout` | 30,000ms | Max wait for screenshot/render operations |
| `luaRunTimeout` | 30,000ms | Max wait for `lua_run` and for batches containing `lua.run` (Lua stops chunks after 20 s; a timed-out call may still apply its edit later) |
| `batchTimeoutPerOp` | 500ms | Additional timeout per operation in a batch |
| `maxBatchSize` | 50 | Maximum operations per `batch_execute` call |

## Troubleshooting

### Server doesn't appear in Scripts menu

- Ensure `MohoMCP_Server.lua` is in the correct scripts directory
- Restart MOHO after copying files
- Check MOHO's script console for Lua load errors

### Bridge can't connect (no status.json)

- Ensure MOHO is running and the MohoMCP Server script has been activated
- Check that the status file exists:
  - **Windows:** `dir %TEMP%\moho-mcp\status.json`
  - **macOS:** `ls $TMPDIR/moho-mcp/status.json`
- Verify the IPC directory is accessible

### "Moho is running an older MohoMCP plugin"

The bridge and the plugin in Moho's memory speak different IPC protocol versions. Restart Moho so it loads the updated plugin, start the MohoMCP Server again, and retry. If the message says the plugin is *newer*, rebuild the bridge (`npm run build`) and restart your MCP client.

### Requests time out

- MOHO may not be repainting frequently enough. The keep-alive mechanism should handle this automatically, but verify that MOHO's main window is visible (not minimized)
- Check MOHO's script console for error messages
- Try increasing `requestTimeout` in `config.ts`

### Screenshot returns black image

- Ensure a document is open in MOHO
- For `mode="scene"`: MOHO needs a valid frame to render. On macOS scene mode is disabled (rendering from the plugin crashes Moho); use `mode="full"`
- For `mode="full"`: The MOHO window must be visible (not minimized or fully occluded)

### Input tools don't work

- Mouse/keyboard tools require the MOHO window to be in the foreground
- Coordinates are relative to the MOHO window's top-left corner
- Use `document_screenshot(mode="full")` first to identify UI element positions
- **macOS:** Ensure Accessibility permissions are granted (System Settings > Privacy & Security > Accessibility)
- **macOS:** If mouse clicks are unreliable, install `cliclick` (`brew install cliclick`)
