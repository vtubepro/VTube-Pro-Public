// Global keys, Windows half 2 (docs/b16/BINDINGS.md): the small hidden helper process. It is a PowerShell script that compiles a
// 90-line C# class once (Add-Type, no installer, no native npm module) and then does exactly one job: RegisterHotKey for the
// combos VTube Pro sent it, and say "down <id>" when one is pressed and "up <id>" when its key is let go again (it checks the
// key's state every 30 ms ONLY while a combo is held). It is NOT a keyboard hook: Windows hands it nothing but the exact
// combos it asked for, so it cannot see anything else that is typed. It reads commands from stdin (protocol: win32.ts), so
// it needs no files, no ports and no admin rights, and it quits by itself when VTube Pro's helper goes away (stdin closes).
//
// The text is embedded (the release bundles the helper into one file); the host writes it to the OS temp folder to run it.

export const HOTKEY_HOST_CS = String.raw`
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class VtpHotkeyHost : NativeWindow {
  const int WM_HOTKEY = 0x0312, WM_TIMER = 0x0113, WM_APP_CMD = 0x8001, TIMER_ID = 77, MAX_HOLD_MS = 120000;
  [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, IntPtr proc);
  [DllImport("user32.dll")] static extern bool KillTimer(IntPtr h, UIntPtr id);

  readonly ConcurrentQueue<string> q = new ConcurrentQueue<string>();
  readonly Dictionary<int, string> names = new Dictionary<int, string>();
  readonly Dictionary<int, int> vks = new Dictionary<int, int>();
  readonly Dictionary<int, int> held = new Dictionary<int, int>();
  int next = 1; bool timer = false;

  public VtpHotkeyHost() { var cp = new CreateParams(); cp.Parent = new IntPtr(-3); CreateHandle(cp); }
  public void Post(string line) { q.Enqueue(line); PostMessage(Handle, WM_APP_CMD, IntPtr.Zero, IntPtr.Zero); }
  static void Say(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }

  void Clear() {
    foreach (var h in held) Say("up " + names[h.Key]);
    held.Clear();
    foreach (var k in names.Keys) UnregisterHotKey(Handle, k);
    names.Clear(); vks.Clear();
    if (timer) { KillTimer(Handle, (UIntPtr)TIMER_ID); timer = false; }
  }
  void Cmd(string line) {
    var p = line.Trim().Split(' ');
    if (p[0] == "clear") { Clear(); return; }
    if (p[0] == "quit") { Clear(); Application.ExitThread(); return; }
    if (p[0] == "reg" && p.Length >= 4) {
      uint mods, vk;
      if (!uint.TryParse(p[2], out mods) || !uint.TryParse(p[3], out vk)) { Say("fail " + p[1] + " 0"); return; }
      int id = next++;
      if (RegisterHotKey(Handle, id, mods, vk)) { names[id] = p[1]; vks[id] = (int)vk; Say("ok " + p[1]); }
      else Say("fail " + p[1] + " " + Marshal.GetLastWin32Error());
    }
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_APP_CMD) { string l; while (q.TryDequeue(out l)) Cmd(l); return; }
    if (m.Msg == WM_HOTKEY) {
      int id = m.WParam.ToInt32(); string n;
      if (names.TryGetValue(id, out n) && !held.ContainsKey(id)) {
        held[id] = Environment.TickCount; Say("down " + n);
        if (!timer) { SetTimer(Handle, (UIntPtr)TIMER_ID, 30, IntPtr.Zero); timer = true; }
      }
      return;
    }
    if (m.Msg == WM_TIMER && m.WParam.ToInt32() == TIMER_ID) {
      var gone = new List<int>();
      foreach (var h in held) {
        bool down = (GetAsyncKeyState(vks[h.Key]) & 0x8000) != 0;
        if (!down || unchecked(Environment.TickCount - h.Value) > MAX_HOLD_MS) gone.Add(h.Key);
      }
      foreach (var id in gone) { held.Remove(id); Say("up " + names[id]); }
      if (held.Count == 0 && timer) { KillTimer(Handle, (UIntPtr)TIMER_ID); timer = false; }
      return;
    }
    base.WndProc(ref m);
  }
  public static void Run() {
    var host = new VtpHotkeyHost();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) host.Post(line);
      host.Post("quit");
    });
    reader.IsBackground = true; reader.Start();
    Say("ready");
    Application.Run(new ApplicationContext());
  }
}
`;

/** The PowerShell file: compile the class, run it. */
export const HOTKEY_HOST_PS1 = `$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
${HOTKEY_HOST_CS}
'@
[VtpHotkeyHost]::Run()
`;
