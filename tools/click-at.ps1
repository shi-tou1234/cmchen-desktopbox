param(
  [int]$X = 88,
  [int]$Y = 990
)
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
"@
[M]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 400
[M]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 60
[M]::mouse_event(4, 0, 0, 0, 0)
Write-Output "CLICKED $X $Y"
