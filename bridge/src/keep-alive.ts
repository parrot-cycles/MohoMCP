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
let warnedAccess = false;
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

// macOS helper (JXA). Waking Moho so it polls, without bringing it forward:
//
// 1. Post a synthetic mouseMoved CGEvent to Moho's pid (cheap). It only
//    wakes Moho when the active tool's OnMouseMoved repaints (Transform
//    Layer/Points, Add Point, Freehand do; Select Points, Curvature, Draw
//    Shape, Select Shape, Eyedropper don't). Event type 5 =
//    kCGEventMouseMoved, button 0 = left; the cursor does not move. Do not
//    CFRelease the event: the JXA bridge owns it and a release crashes.
// 2. If the request is still pending AX_AFTER ms later, read (never press)
//    the AXEnabled attribute of our own menu item through the Accessibility
//    API. Moho validates the menu to answer, which calls
//    MohoMCP_Server:IsEnabled -> server.poll. Measured end to end: ~0.1 s via
//    the mouse path, ~0.5-1.1 s via the menu read, with every tool.
//    The menu-bar item is found by content (the menu that holds an item
//    titled MENU_FOLDER), not by its localized title; the element is cached
//    and looked up again when it stops answering.
//
// Moho is found by bundle id. Request files older than MAX_REQUEST_AGE s are
// orphans of a killed bridge and are ignored. At start the helper checks
// CGPreflightPostEventAccess and AXIsProcessTrusted and prints a token to
// stderr (console.log) for each missing permission.
// Arguments: <ipcDir> [bundleId] [bridgePid]. Test entry points:
// "--selftest <dir> <bundleId> <pid>", "--menus <pid>",
// "--find <pid> <itemTitle> <subItemTitle>", "--wake <pid> <itemTitle> <subItemTitle>"
// (all read-only).
// The loop exits when the bridge is gone.
export const MOHO_BUNDLE_ID = "com.lostmarble.moho";
/** Folder name under Scripts/Menu = submenu title in Moho's Scripts menu. */
export const MOHO_MENU_FOLDER = "MohoMCP";
/** MohoMCP_Server:UILabel() in moho-plugin/MohoMCP_Server.lua. */
export const MOHO_SERVER_MENU_ITEM = "Start/Stop MohoMCP Server";
export const NO_EVENT_ACCESS_TOKEN = "MOHOMCP_NO_EVENT_ACCESS";
export const NO_AX_ACCESS_TOKEN = "MOHOMCP_NO_AX_ACCESS";
export const WAKE_TIMING = {
  tickMs: 100,          // loop period while a request is pending
  idleTickMs: 250,      // loop period while nothing is pending
  nudgeEveryMs: 250,
  axAfterMs: 300,
  axEveryMs: 400,
  pidRecheckMs: 1000,   // how often to look for Moho again when it is not running
  axMissRetryMs: 2000,  // how long to wait before searching the menus again after a miss
};

export const MACOS_KEEPALIVE_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
ObjC.import('unistd');

var MAX_REQUEST_AGE = 60;
var BUNDLE_ID = ${JSON.stringify(MOHO_BUNDLE_ID)};
var MENU_FOLDER = ${JSON.stringify(MOHO_MENU_FOLDER)};
var SERVER_ITEM = ${JSON.stringify(MOHO_SERVER_MENU_ITEM)};
var TIMING = ${JSON.stringify(WAKE_TIMING)};

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

// pid of the running app with this bundle identifier, else 0 (walks every app).
function findPid(bundleId) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    if (ObjC.unwrap(app.bundleIdentifier) === bundleId) return app.processIdentifier;
  }
  return 0;
}

// Moho's pid, cached: while the cached process is still that app, no app list
// walk is needed; when Moho is not running, look again at most every
// pidRecheckMs. state = { pid, checkedAt }.
function cachedPid(state, bundleId, now) {
  if (state.pid > 0) {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(state.pid);
    if (app && !app.isNil() && !app.terminated && ObjC.unwrap(app.bundleIdentifier) === bundleId) return state.pid;
    state.pid = 0;
    state.checkedAt = -Infinity;
  }
  if (state.checkedAt !== undefined && now - state.checkedAt < TIMING.pidRecheckMs) return 0;
  state.checkedAt = now;
  state.pid = findPid(bundleId);
  return state.pid;
}

function nudge(pid) {
  var ev = $.CGEventCreateMouseEvent(null, 5, { x: 535, y: 317 }, 0);
  if (!ev) return false;
  $.CGEventPostToPid(pid, ev);
  return true;
}

// ---- Accessibility (read-only: attributes are copied, never acted on) ----
var axBound = false;
function bindAx() {
  if (axBound) return;
  // The bridged signatures use CF out-pointers JXA cannot fill; bind as ids.
  ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
  ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
  axBound = true;
}
function axAttr(el, name) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(el, $(name), ref);
  return err === 0 ? ref[0] : null;
}
function axChildren(el) {
  var arr = axAttr(el, 'AXChildren');
  var out = [];
  if (!arr) return out;
  for (var i = 0; i < arr.count; i++) out.push(arr.objectAtIndex(i));
  return out;
}
function axTitle(el) {
  var t = axAttr(el, 'AXTitle');
  return t ? ObjC.unwrap(t) : '';
}
// Items of the menu attached to a menu-bar item or a submenu item.
function axMenuItems(el) {
  var menus = axChildren(el);
  return menus.length ? axChildren(menus[0]) : [];
}
// The menu item <subTitle> inside the item titled <itemTitle> that sits in
// any top-level menu of app <pid>, or null.
function axFindItem(pid, itemTitle, subTitle) {
  bindAx();
  var bar = axAttr($.AXUIElementCreateApplication(pid), 'AXMenuBar');
  if (!bar) return null;
  var tops = axChildren(bar);
  for (var i = 0; i < tops.length; i++) {
    var items = axMenuItems(tops[i]);
    for (var j = 0; j < items.length; j++) {
      if (axTitle(items[j]) !== itemTitle) continue;
      var subs = axMenuItems(items[j]);
      for (var k = 0; k < subs.length; k++) {
        if (axTitle(subs[k]) === subTitle) return subs[k];
      }
    }
  }
  return null;
}
var cachedItem = null, cachedItemPid = 0, axMissAt = -Infinity;
// Read our menu item's enabled state; Moho validates the menu to answer.
function axWake(pid, itemTitle, subTitle) {
  if (!cachedItem || cachedItemPid !== pid) {
    var now = Date.now();
    if (cachedItemPid === pid && now - axMissAt < TIMING.axMissRetryMs) return false;
    cachedItem = axFindItem(pid, itemTitle || MENU_FOLDER, subTitle || SERVER_ITEM);
    cachedItemPid = pid;
    if (!cachedItem) { axMissAt = now; return false; }
  }
  var enabled = axAttr(cachedItem, 'AXEnabled');
  if (enabled === null) { cachedItem = null; return false; }
  return true;
}

// One scheduling step: mouse nudge every nudgeEveryMs while a request is
// pending; once it has been pending axAfterMs, also the menu read every
// axEveryMs. Mutates state; actions = { nudge(), axWake() }.
function wakeStep(state, now, isPending, actions) {
  if (!isPending) { state.active = false; return; }
  if (!state.active) { state.active = true; state.since = now; state.lastNudge = -Infinity; state.lastAx = -Infinity; }
  if (now - state.lastNudge >= TIMING.nudgeEveryMs) { state.lastNudge = now; actions.nudge(); }
  if (now - state.since >= TIMING.axAfterMs && now - state.lastAx >= TIMING.axEveryMs) {
    state.lastAx = now;
    actions.axWake();
  }
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
function axTrusted() {
  try { return $.AXIsProcessTrusted() ? true : false; } catch (e) { return null; }
}

function run(argv) {
  if (argv[0] === '--selftest') {
    return JSON.stringify({ pending: pending(argv[1]), pid: findPid(argv[2]), posted: nudge(Number(argv[3])), access: canPostEvents(), ax: axTrusted() });
  }
  if (argv[0] === '--menus') {
    bindAx();
    var bar = axAttr($.AXUIElementCreateApplication(Number(argv[1])), 'AXMenuBar');
    var tops = bar ? axChildren(bar) : [];
    return JSON.stringify(tops.map(function (t) {
      return axMenuItems(t).map(function (it) {
        return { title: axTitle(it), sub: axMenuItems(it).map(axTitle) };
      });
    }));
  }
  if (argv[0] === '--pidcache') {
    var st = {}, t0 = Date.now();
    var a = cachedPid(st, argv[1], t0);
    var b = cachedPid(st, argv[1], t0 + 10);
    return JSON.stringify({ first: a, second: b, checkedAt: st.checkedAt === t0 });
  }
  if (argv[0] === '--wake') {
    var first = axWake(Number(argv[1]), argv[2], argv[3]);
    var cached = !!cachedItem;
    var second = axWake(Number(argv[1]), argv[2], argv[3]);
    return JSON.stringify({ first: first, cached: cached, second: second });
  }
  if (argv[0] === '--find') {
    var item = axFindItem(Number(argv[1]), argv[2], argv[3]);
    var en = item ? axAttr(item, 'AXEnabled') : null;
    return JSON.stringify({ found: !!item, title: item ? axTitle(item) : null, enabled: en === null ? null : !!ObjC.unwrap(en) });
  }
  var dir = argv[0];
  var bundleId = argv[1] || BUNDLE_ID;
  if (canPostEvents() === false) console.log(${JSON.stringify(NO_EVENT_ACCESS_TOKEN)});
  if (axTrusted() === false) console.log(${JSON.stringify(NO_AX_ACCESS_TOKEN)});
  // Exit once the bridge that spawned us is gone (we get reparented).
  var parent = argv[2] ? Number(argv[2]) : $.getppid();
  var state = {}, pidState = {};
  while (true) {
    if ($.getppid() !== parent) return;
    var isPending = false;
    try {
      isPending = pending(dir);
      var pid = isPending ? cachedPid(pidState, bundleId, Date.now()) : 0;
      wakeStep(state, Date.now(), isPending && pid > 0, {
        nudge: function () { nudge(pid); },
        axWake: function () { try { axWake(pid); } catch (e) { cachedItem = null; } },
      });
    } catch (e) {}
    delay((isPending ? TIMING.tickMs : TIMING.idleTickMs) / 1000);
  }
}
`;

/** Who to grant Accessibility to: the app this bridge runs under, if known. */
export function noEventAccessMessage(env: NodeJS.ProcessEnv = process.env): string {
  const app = env.__CFBundleIdentifier || env.TERM_PROGRAM || "the app that runs your MCP client";
  return (
    `grant Accessibility to ${app} (System Settings > Privacy & Security > Accessibility) ` +
    "so MohoMCP can wake Moho (it posts a mouse-moved event to Moho and reads, never clicks, " +
    "its own Scripts menu item); until then requests may time out while Moho is idle."
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
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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

    warnedAccess = false;
    keepAliveProcess = spawn(
      "osascript",
      ["-l", "JavaScript", scriptPath, dir, MOHO_BUNDLE_ID, String(process.pid)],
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: false,
      },
    );
    keepAliveProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!warnedAccess && (text.includes(NO_EVENT_ACCESS_TOKEN) || text.includes(NO_AX_ACCESS_TOKEN))) {
        warnedAccess = true;
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
