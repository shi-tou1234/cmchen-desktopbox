using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DeskBasketMouse {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

    static bool Contains(RECT rect, POINT point) {
        return point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom;
    }

    // WindowFromPoint 跳过鼠标穿透的 Dock；改为检查它前面的窗口，避免误把覆盖它的应用当成 Dock。
    public static bool DockExposed(IntPtr dock, POINT point) {
        RECT rect;
        if (dock == IntPtr.Zero || !IsWindowVisible(dock) || IsIconic(dock) ||
            !GetWindowRect(dock, out rect) || !Contains(rect, point)) return false;
        IntPtr above = GetWindow(dock, 3); // GW_HWNDPREV：真实 Z 序里比 Dock 更靠前的窗口
        for (int count = 0; above != IntPtr.Zero && count < 2048; count++) {
            int cloaked;
            bool hiddenDesktop = DwmGetWindowAttribute(above, 14, out cloaked, 4) == 0 && cloaked != 0;
            if (IsWindowVisible(above) && !IsIconic(above) && !hiddenDesktop &&
                (GetWindowLong(above, -20) & 0x20) == 0 &&
                GetWindowRect(above, out rect) && Contains(rect, point)) return false;
            above = GetWindow(above, 3);
        }
        return above == IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int max);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    static string ClassOf(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return "";
        StringBuilder buffer = new StringBuilder(256);
        GetClassName(hWnd, buffer, 256);
        return buffer.ToString();
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    public static bool Fullscreen() {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || IsIconic(hwnd)) return false;
        string cls = ClassOf(hwnd);
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return false;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (pid.ToString() == Environment.GetEnvironmentVariable("DESKBASKET_PARENT_PID")) return false;
        RECT rect; if (!GetWindowRect(hwnd, out rect)) return false;
        MONITORINFO info = new MONITORINFO(); info.Size = Marshal.SizeOf(info);
        if (!GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info)) return false;
        return Math.Abs(rect.Left-info.Monitor.Left) <= 2 && Math.Abs(rect.Top-info.Monitor.Top) <= 2 &&
            Math.Abs(rect.Right-info.Monitor.Right) <= 2 && Math.Abs(rect.Bottom-info.Monitor.Bottom) <= 2;
    }

    public static string Report() {
        // 所有窗口矩形与光标都使用物理像素；主进程用 screenToDipPoint 转成 Electron DIP。
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        int bits = 0;
        // 取最高位 0x8000 = "此刻按着"。
        // 别用最低位 0x0001：那是"上一次调用之后按过"的锁存位，这个循环每 125ms 自己查一次，
        // 等于每次把自己上一轮置起的锁存位吃掉了——真机实测按住不放也永远报 0。
        if ((GetAsyncKeyState(0x01) & 0x8000) != 0) bits |= 1;   // VK_LBUTTON
        if ((GetAsyncKeyState(0x02) & 0x8000) != 0) bits |= 2;   // VK_RBUTTON

        POINT point;
        GetCursorPos(out point);
        // GA_ROOT = 2：往上找到顶层窗口。桌面图标压着的是哪个子窗口各版本不同，根一直是 Progman/WorkerW
        IntPtr root = GetAncestor(WindowFromPoint(point), 2);
        string cls = ClassOf(root);
        int over = (cls == "Progman" || cls == "WorkerW") ? 1 : 0;
        long handle;
        Int64.TryParse(Environment.GetEnvironmentVariable("DESKBASKET_MOUSE_DOCK"), out handle);
        int exposed = DockExposed(new IntPtr(handle), point) ? 1 : 0;
        return bits.ToString() + ":" + over.ToString() + ":" + exposed.ToString() + ":" + point.X + ":" + point.Y + ":" + root.ToInt64() + ":" + (Fullscreen() ? "1" : "0");
    }
}
public static class DeskBasketZ {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("kernel32.dll")]
    public static extern uint GetLastError();

    public static string Handle(long hwnd, bool top) {
        IntPtr h = (IntPtr)hwnd;
        // HWND_TOPMOST(-1) / HWND_NOTOPMOST(-2)；NOMOVE|NOSIZE|NOACTIVATE，只动 z 序
        IntPtr after = top ? (IntPtr)(-1) : (IntPtr)(-2);
        bool ok = SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        int style = GetWindowLong(h, -20);
        string tail = ((style & 0x8) != 0) ? "1" : "0";
        if (ok) { return "OK " + tail; }
        return "ERR " + GetLastError() + " " + tail;
    }
}

public static class Program {
  static bool ParentAlive() {
    int pid; if (!Int32.TryParse(Environment.GetEnvironmentVariable("DESKBASKET_PARENT_PID"), out pid)) return true;
    try { return !System.Diagnostics.Process.GetProcessById(pid).HasExited; } catch { return false; }
  }
  public static void Main(string[] args) {
    try {
      if (args.Length > 0 && args[0] == "zorder") {
        Console.WriteLine("DESKBASKET_Z READY"); Console.Out.Flush();
        string line;
        while ((line = Console.ReadLine()) != null && ParentAlive()) {
          string[] parts = line.Trim().Split(' '); long hwnd;
          if (parts.Length != 2 || !Int64.TryParse(parts[1], out hwnd) || hwnd <= 0 || (parts[0] != "TOP" && parts[0] != "UNTOP")) continue;
          Console.WriteLine("DESKBASKET_Z " + DeskBasketZ.Handle(hwnd, parts[0] == "TOP")); Console.Out.Flush();
        }
      } else {
        while (ParentAlive()) {
          Console.WriteLine(DeskBasketMouse.Report()); Console.Out.Flush();
          System.Threading.Thread.Sleep(125);
        }
      }
    } catch (System.IO.IOException) { }
  }
}
