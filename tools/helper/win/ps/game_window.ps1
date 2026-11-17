# VTube Pro: which windows could be the player's game? Prints ONE JSON line: {"w":[{...}]} with the visible, not-minimised
# top-level windows (top of the z-order first): exe name + path, process id, title, window class, the window rectangle and
# the rectangle of the monitor it is mostly on (virtual-desktop pixels, DPI aware), and whether that monitor is the primary
# one. Read-only: it only asks Windows (EnumWindows, GetWindowRect, MonitorFromWindow, the process image name) and changes
# nothing. Run by: the helper (server/gameWindow.ts) on a click, or at most every 30 s while a game may be running, at
# below-normal priority, as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File game_window.ps1 -Max 40
param(
  [ValidateRange(1, 200)] [int]$Max = 40
)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class VtpWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONINFO { public int cb; public RECT mon; public RECT work; public int flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONINFO i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  public static List<object[]> List() {
    SetProcessDPIAware();
    var res = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      if (r.R - r.L < 200 || r.B - r.T < 150) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      IntPtr m = MonitorFromWindow(h, 2);
      var mi = new MONINFO(); mi.cb = Marshal.SizeOf(typeof(MONINFO));
      if (!GetMonitorInfo(m, ref mi)) return true;
      res.Add(new object[] { (int)pid, t.ToString(), c.ToString(), r.L, r.T, r.R - r.L, r.B - r.T, mi.mon.L, mi.mon.T, mi.mon.R - mi.mon.L, mi.mon.B - mi.mon.T, (mi.flags & 1) != 0 });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
$out = New-Object System.Collections.ArrayList
foreach ($w in [VtpWin]::List()) {
  if ($out.Count -ge $Max) { break }
  $p = Get-Process -Id $w[0] -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $path = ''; try { $path = $p.MainModule.FileName } catch { }
  $exe = if ($path) { [System.IO.Path]::GetFileName($path) } else { $p.ProcessName + '.exe' }
  [void]$out.Add([ordered]@{ exe = $exe; path = $path; pid = [int]$w[0]; title = [string]$w[1]; cls = [string]$w[2];
    x = [int]$w[3]; y = [int]$w[4]; w = [int]$w[5]; h = [int]$w[6]; mx = [int]$w[7]; my = [int]$w[8]; mw = [int]$w[9]; mh = [int]$w[10]; primary = [bool]$w[11] })
}
[Console]::Out.WriteLine((@{ w = @($out) } | ConvertTo-Json -Compress -Depth 4))
