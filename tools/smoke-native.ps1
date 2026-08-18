# Smoke tests for the native applications, driven through Win32.
#
# Builds each example application, starts it, drives it the way a person would
# — clicking buttons, choosing menu items, typing into fields — and checks what
# the window says back. Nothing is simulated: a click here is the same
# WM_COMMAND a mouse produces, and the text is read with WM_GETTEXT, which is
# the only way to read another process's controls.
#
#     pwsh -File tools/smoke-native.ps1
#     pwsh -File tools/smoke-native.ps1 -KeepOpen   # leave the windows up
#
# Windows only, and needs the runtime built:
#     cargo build --release --manifest-path rust/Cargo.toml
param([switch]$KeepOpen)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'src/cli/index.ts'
$failures = 0
$checks = 0

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Smoke {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, StringBuilder l);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] public static extern IntPtr Send(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int pos);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int pos);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuStringW(IntPtr menu, uint item, StringBuilder s, int n, uint flags);

    public static List<IntPtr> Kids(IntPtr p) {
        var f = new List<IntPtr>();
        EnumChildWindows(p, (h, x) => { f.Add(h); return true; }, IntPtr.Zero);
        return f;
    }
    public static string Cls(IntPtr h) { var b = new StringBuilder(64); GetClassNameW(h, b, 64); return b.ToString(); }
    // WM_GETTEXT, not GetWindowText: the latter cannot read a control owned by
    // another process and returns an empty string for every edit and list.
    public static string Txt(IntPtr h) { var b = new StringBuilder(16384); SendMessageW(h, 0x000D, (IntPtr)16384, b); return b.ToString(); }
    public static string Caption(IntPtr h) { var b = new StringBuilder(512); GetWindowTextW(h, b, 512); return b.ToString(); }
    public static void Click(IntPtr h) { Send(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
    public static void Command(IntPtr window, uint id) { Send(window, 0x0111, (IntPtr)id, IntPtr.Zero); }
    public static void Replace(IntPtr edit, string text) {
        Send(edit, 0x00B1, IntPtr.Zero, (IntPtr)(-1));
        SendMessageW(edit, 0x00C2, (IntPtr)1, new StringBuilder(text));
    }
    public static int ListCount(IntPtr h) { return (int)Send(h, 0x018B, IntPtr.Zero, IntPtr.Zero); }
    public static string ListItem(IntPtr h, int i) { var b = new StringBuilder(1024); SendMessageW(h, 0x0189, (IntPtr)i, b); return b.ToString(); }

    /// The command id of a menu item, found by its label.
    public static uint MenuId(IntPtr window, string label) {
        var bar = GetMenu(window);
        if (bar == IntPtr.Zero) return 0;
        for (int i = 0; i < GetMenuItemCount(bar); i++) {
            var sub = GetSubMenu(bar, i);
            for (int j = 0; j < GetMenuItemCount(sub); j++) {
                var b = new StringBuilder(128);
                GetMenuStringW(sub, (uint)j, b, 128, 0x0400);
                if (b.ToString().StartsWith(label)) return GetMenuItemID(sub, j);
            }
        }
        return 0;
    }
}
'@

function Check([string]$what, $actual, $expected) {
    $script:checks++
    if ("$actual" -eq "$expected") {
        Write-Host ("  ok   {0}" -f $what)
    } else {
        $script:failures++
        Write-Host ("  FAIL {0}`n         expected: {1}`n         actual:   {2}" -f $what, $expected, $actual)
    }
}

function Start-App([string]$project, [string]$exe, [string]$process) {
    Write-Host "$process"
    Push-Location (Join-Path $root $project)
    try {
        & node $cli app build | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "build failed" }
        $path = Join-Path (Get-Location) "build/$exe"
        Start-Process -FilePath $path | Out-Null
    } finally {
        Pop-Location
    }
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 150
        $p = @(Get-Process $process -ErrorAction SilentlyContinue)
        if ($p.Count -gt 0 -and $p[0].MainWindowHandle -ne 0) { return $p[0] }
    }
    throw "$process did not open a window"
}

function Stop-App([string]$process) {
    if (-not $KeepOpen) {
        Get-Process $process -ErrorAction SilentlyContinue | Stop-Process -Force
    }
}

function Kids($proc) { [Smoke]::Kids($proc.MainWindowHandle) }
function ByClass($kids, [string]$class, [int]$nth = 0) {
    @($kids | Where-Object { [Smoke]::Cls($_) -eq $class })[$nth]
}
function Button($kids, [string]$caption) {
    @($kids | Where-Object { [Smoke]::Cls($_) -eq 'Button' -and [Smoke]::Txt($_) -eq $caption })[0]
}

# ------------------------------------------------------------------ calculator

$proc = Start-App 'examples/native/calculator' 'Calculator.exe' 'Calculator'
try {
    $kids = Kids $proc
    $display = ByClass $kids 'Static'
    $history = ByClass $kids 'ListBox'

    foreach ($key in '2', '+', '3', '*', '4', '=') {
        [Smoke]::Click((Button $kids $key)); Start-Sleep -Milliseconds 80
    }
    Check 'multiplication binds tighter than addition' ([Smoke]::Txt($display)) '14'
    Check 'the calculation is remembered' ([Smoke]::ListItem($history, 0)) '2+3*4 = 14'

    [Smoke]::Click((Button $kids 'Clear')); Start-Sleep -Milliseconds 80
    foreach ($key in '2', '^', '3', '^', '2', '=') {
        [Smoke]::Click((Button $kids $key)); Start-Sleep -Milliseconds 80
    }
    Check 'the power operator is right-associative' ([Smoke]::Txt($display)) '512'

    [Smoke]::Click((Button $kids 'Clear')); Start-Sleep -Milliseconds 80
    foreach ($key in '1', '/', '0', '=') {
        [Smoke]::Click((Button $kids $key)); Start-Sleep -Milliseconds 80
    }
    Check 'dividing by zero says so' ([Smoke]::Txt($display)) 'Dividing by zero has no answer.'
} finally {
    Stop-App 'Calculator'
}

# --------------------------------------------------------------------- notepad

$proc = Start-App 'examples/native/notepad' 'Notepad.exe' 'Notepad'
try {
    $kids = Kids $proc
    $editor = ByClass $kids 'Edit'
    $status = ByClass $kids 'Static'

    Check 'an empty document is one line' ([Smoke]::Txt($status)) '1 line, 0 words, 0 characters'
    # The dash is an em dash, spelled by code point: the literal is otherwise
    # indistinguishable from a hyphen in a diff and in this file.
    Check 'and is not modified' `
        ([Smoke]::Caption($proc.MainWindowHandle)) ('Untitled ' + [char]0x2014 + ' Notepad')

    [Smoke]::Replace($editor, "one two`r`nthree four`r`n"); Start-Sleep -Milliseconds 500
    Check 'typing updates the counts' ([Smoke]::Txt($status)) '2 lines, 4 words, 21 characters'
    Check 'and marks the document modified' `
        ((Get-Process -Id $proc.Id).MainWindowTitle) ([char]0x2022 + ' Untitled ' + [char]0x2014 + ' Notepad')

    $copy = [Smoke]::MenuId($proc.MainWindowHandle, 'Copy all')
    Check 'the menu bar has a Copy all item' ($copy -gt 0) 'True'
    [Smoke]::Command($proc.MainWindowHandle, $copy); Start-Sleep -Milliseconds 500
    Add-Type -AssemblyName System.Windows.Forms
    Check 'choosing it copies the text' ([System.Windows.Forms.Clipboard]::GetText().Length) 21
} finally {
    Stop-App 'Notepad'
}

# ----------------------------------------------------------------- json viewer

$proc = Start-App 'examples/native/json-viewer' 'JsonViewer.exe' 'JsonViewer'
try {
    $kids = Kids $proc
    $source = ByClass $kids 'Edit'
    $status = ByClass $kids 'Static'
    $tree = ByClass $kids 'ListBox'

    Check 'the sample document is a tree' ([Smoke]::ListCount($tree)) 7

    [Smoke]::Replace($source, 'not json at all'); Start-Sleep -Milliseconds 500
    Check 'invalid JSON is refused' ([Smoke]::Txt($status)) 'That is not valid JSON.'
    Check 'and shows no rows' ([Smoke]::ListCount($tree)) 0

    [Smoke]::Replace($source, '[1, [2, [3, [4]]]]'); Start-Sleep -Milliseconds 500
    Check 'nesting becomes depth, not recursion' ([Smoke]::ListCount($tree)) 8

    [Smoke]::Replace($source, ''); Start-Sleep -Milliseconds 500
    Check 'an empty document asks for one' ([Smoke]::Txt($status)) 'Paste some JSON to inspect.'
} finally {
    Stop-App 'JsonViewer'
}

Write-Host ''
if ($failures -eq 0) {
    Write-Host "$checks checks passed"
    exit 0
}
Write-Host "$failures of $checks checks failed"
exit 1
