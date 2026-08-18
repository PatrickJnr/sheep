# Drives a Baa native application through Win32, the way a person would:
# finds its controls, clicks buttons by their caption, reads what it says back.
param([string]$Process, [string[]]$Click, [switch]$Dump)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);

    public static List<IntPtr> Children(IntPtr parent) {
        var found = new List<IntPtr>();
        EnumChildWindows(parent, (h, p) => { found.Add(h); return true; }, IntPtr.Zero);
        return found;
    }
    // GetWindowText cannot read a control owned by another process: it
    // returns the window caption, which an EDIT does not have. WM_GETTEXT is
    // marshalled across the process boundary and does work.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, StringBuilder l);
    public static string Text(IntPtr h) {
        var b = new StringBuilder(8192);
        SendMessageW(h, 0x000D, (IntPtr)b.Capacity, b);
        return b.ToString();
    }
    public static List<string> Items(IntPtr h) {
        var found = new List<string>();
        int count = (int)SendMessageW(h, 0x018B, IntPtr.Zero, IntPtr.Zero);
        for (int i = 0; i < count; i++) {
            var b = new StringBuilder(1024);
            SendMessageW(h, 0x0189, (IntPtr)i, b);
            found.Add(b.ToString());
        }
        return found;
    }
    public static string Class(IntPtr h) {
        var b = new StringBuilder(64);
        GetClassNameW(h, b, b.Capacity);
        return b.ToString();
    }
    public static void Click(IntPtr h) { SendMessageW(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
}
'@

$proc = @(Get-Process $Process -ErrorAction Stop)[0]
$main = $proc.MainWindowHandle
$children = [Win]::Children($main)

if ($Dump) {
    foreach ($h in $children) {
        $id = [Win]::GetDlgCtrlID($h)
        "{0,-4} {1,-10} {2}" -f $id, [Win]::Class($h), [Win]::Text($h)
    }
    return
}

foreach ($caption in $Click) {
    $target = $children | Where-Object { [Win]::Class($_) -eq "Button" -and [Win]::Text($_) -eq $caption } | Select-Object -First 1
    if ($null -eq $target) { "no button: $caption"; continue }
    [Win]::Click($target)
    Start-Sleep -Milliseconds 120
}

Start-Sleep -Milliseconds 300
foreach ($h in $children) {
    $class = [Win]::Class($h)
    if ($class -eq "Static" -or $class -eq "Edit") {
        "{0}: {1}" -f $class, [Win]::Text($h)
    }
    if ($class -eq "ListBox") {
        "ListBox: " + (([Win]::Items($h)) -join " | ")
    }
}
