/**
 * Cross-platform keep-alive for MOHO viewport polling.
 *
 * MOHO's Lua polling relies on DrawMe callbacks that only fire during
 * viewport repaints.  When the user isn't interacting with MOHO the
 * viewport stops repainting and polling stalls.
 *
 * On Windows: spawns a hidden PowerShell process that calls Win32
 * RedrawWindow on the MOHO window (~4 Hz).
 *
 * On macOS: spawns a JavaScript-for-Automation (osascript -l JavaScript)
 * helper. While a req_*.json is pending it posts a synthetic mouseMoved
 * CGEvent straight to the running Moho process (CGEventPostToPid): Moho
 * repaints and polls, the cursor does not move, focus does not change, and
 * it works whether Moho is frontmost or in the background. It never launches
 * or activates Moho; if Moho is not running it does nothing.
 */

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";

let keepAliveProcess: ChildProcess | null = null;
let scriptPath: string | null = null;

// PowerShell script that forces MOHO viewport repaints via Win32 API.
const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class MohoKeepAlive {
    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);

    public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

    private static List<IntPtr> childWindows = new List<IntPtr>();

    private static bool EnumCallback(IntPtr hWnd, IntPtr lParam) {
        childWindows.Add(hWnd);
        return true;
    }

    public static IntPtr[] GetChildWindows(IntPtr parent) {
        childWindows.Clear();
        EnumChildWindows(parent, EnumCallback, IntPtr.Zero);
        return childWindows.ToArray();
    }
}
"@

$WM_MOUSEMOVE = 0x0200
$RDW_INVALIDATE = 0x0001
$RDW_UPDATENOW  = 0x0100
$RDW_ALLCHILDREN = 0x0080
$rdwFlags = $RDW_INVALIDATE -bor $RDW_UPDATENOW -bor $RDW_ALLCHILDREN

while ($true) {
    $procs = Get-Process -Name "Moho*" -ErrorAction SilentlyContinue
    if (-not $procs) {
        Start-Sleep -Seconds 2
        continue
    }
    foreach ($p in $procs) {
        $hwnd = $p.MainWindowHandle
        if ($hwnd -ne [IntPtr]::Zero) {
            [MohoKeepAlive]::RedrawWindow($hwnd, [IntPtr]::Zero, [IntPtr]::Zero, $rdwFlags) | Out-Null
            $children = [MohoKeepAlive]::GetChildWindows($hwnd)
            foreach ($child in $children) {
                [MohoKeepAlive]::PostMessage($child, $WM_MOUSEMOVE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            }
        }
    }
    Start-Sleep -Milliseconds 250
}
`;

// macOS helper (JXA). `tell application "Moho" to activate` did nothing when
// Moho was already frontmost and relaunched Moho after a crash; a mouseMoved
// event posted to Moho's pid was answered 10/10 in ~280 ms in a live test.
// Event type 5 = kCGEventMouseMoved, button 0 = kCGMouseButtonLeft. The point
// is arbitrary (the cursor does not move). Do not CFRelease the event: the
// JXA bridge owns it and a manual release crashes osascript.
// Moho is found by bundle id, not by executable name.
// Request files older than MAX_REQUEST_AGE seconds are orphans of a killed
// bridge and are ignored, so helpers don't nudge Moho forever.
// At start the helper checks CGPreflightPostEventAccess (bound by hand: it is
// not in JXA's CoreGraphics bridge) and prints NO_EVENT_ACCESS_TOKEN to stderr
// (console.log) when posting events is not permitted.
// Arguments: <ipcDir> [bundleId] [bridgePid];
// "--selftest <dir> <bundleId> <pid>" runs each step once and prints JSON
// (used by tests, never posts to Moho). The loop exits when the bridge is gone.
export const MOHO_BUNDLE_ID = "com.lostmarble.moho";
export const NO_EVENT_ACCESS_TOKEN = "MOHOMCP_NO_EVENT_ACCESS";
export const MACOS_KEEPALIVE_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('unistd');

var MAX_REQUEST_AGE = 60;

function pending(dir) {
  var fm = $.NSFileManager.defaultManager;
  var items = fm.contentsOfDirectoryAtPathError(dir, null);
  if (!items) return false;
  var names = ObjC.deepUnwrap(items) || [];
  for (var i = 0; i < names.length; i++) {
    if (!/^req_\d+\.json$/.test(names[i])) continue;
    var attrs = fm.attributesOfItemAtPathError(dir + '/' + names[i], null);
    if (!attrs || attrs.isNil()) continue;
    var age = -attrs.fileModificationDate.timeIntervalSinceNow;
    if (age <= MAX_REQUEST_AGE) return true;
  }
  return false;
}

// pid of the running app with this bundle identifier, else 0.
function findPid(bundleId) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    if (ObjC.unwrap(app.bundleIdentifier) === bundleId) return app.processIdentifier;
  }
  return 0;
}

function nudge(pid) {
  var ev = $.CGEventCreateMouseEvent(null, 5, { x: 535, y: 317 }, 0);
  if (!ev) return false;
  $.CGEventPostToPid(pid, ev);
  return true;
}

// true / false, or null when the check is unavailable.
function canPostEvents() {
  try {
    ObjC.bindFunction('CGPreflightPostEventAccess', ['bool', []]);
    return $.CGPreflightPostEventAccess() ? true : false;
  } catch (e) {
    return null;
  }
}

function run(argv) {
  if (argv[0] === '--selftest') {
    return JSON.stringify({ pending: pending(argv[1]), pid: findPid(argv[2]), posted: nudge(Number(argv[3])), access: canPostEvents() });
  }
  var dir = argv[0];
  var bundleId = argv[1] || '` + MOHO_BUNDLE_ID + String.raw`';
  if (canPostEvents() === false) console.log('` + NO_EVENT_ACCESS_TOKEN + String.raw`');
  // Exit once the bridge that spawned us is gone (we get reparented).
  var parent = argv[2] ? Number(argv[2]) : $.getppid();
  while (true) {
    if ($.getppid() !== parent) return;
    try {
      if (pending(dir)) {
        var pid = findPid(bundleId);
        if (pid > 0) nudge(pid);
      }
    } catch (e) {}
    delay(0.25);
  }
}
`;

/** Who to grant Accessibility to: the app this bridge runs under, if known. */
export function noEventAccessMessage(env: NodeJS.ProcessEnv = process.env): string {
  const app = env.__CFBundleIdentifier || env.TERM_PROGRAM || "the app that runs your MCP client";
  return (
    `grant Accessibility to ${app} (System Settings > Privacy & Security > Accessibility) ` +
    "so MohoMCP can wake Moho; until then requests may time out while Moho is idle."
  );
}

/**
 * Start the keep-alive process. Works on Windows and macOS.
 * No-op on unsupported platforms or if already running.
 */
export function startKeepAlive(): void {
  if (keepAliveProcess) {
    return;
  }

  const platform = os.platform();
  if (platform !== "win32" && platform !== "darwin") {
    return;
  }

  // Write the script to the IPC temp directory
  const dir = config.moho.ipcDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // already exists
  }

  if (platform === "win32") {
    scriptPath = path.join(dir, "keep-alive.ps1");
    fs.writeFileSync(scriptPath, PS_SCRIPT, "utf-8");

    keepAliveProcess = spawn(
      "powershell",
      ["-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        stdio: "ignore",
        detached: false,
        windowsHide: true,
      },
    );
  } else {
    // macOS: one helper file per bridge process, so bridges sharing the IPC
    // directory never delete each other's script.
    scriptPath = path.join(dir, `keep-alive-${process.pid}.js`);
    fs.writeFileSync(scriptPath, MACOS_KEEPALIVE_JXA, "utf-8");

    keepAliveProcess = spawn(
      "osascript",
      ["-l", "JavaScript", scriptPath, dir, MOHO_BUNDLE_ID, String(process.pid)],
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: false,
      },
    );
    keepAliveProcess.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(NO_EVENT_ACCESS_TOKEN)) {
        process.stderr.write(`[moho-mcp] WARNING: ${noEventAccessMessage()}\n`);
      }
    });
  }

  keepAliveProcess.on("exit", () => {
    keepAliveProcess = null;
  });

  process.stderr.write("[moho-mcp] Keep-alive started (MOHO viewport refresh)\n");
}

/**
 * Stop the keep-alive process and clean up the temp script.
 */
export function stopKeepAlive(): void {
  if (keepAliveProcess) {
    keepAliveProcess.kill();
    keepAliveProcess = null;
    process.stderr.write("[moho-mcp] Keep-alive stopped\n");
  }

  if (scriptPath) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // ignore cleanup errors
    }
    scriptPath = null;
  }
}
