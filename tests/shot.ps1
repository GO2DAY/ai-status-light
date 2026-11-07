Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hwnd = [Win32]::FindWindow($null, "AI Status Light")
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "WINDOW_NOT_FOUND"; exit 1 }
Write-Output "HWND=$hwnd visible=$([Win32]::IsWindowVisible($hwnd))"
$GWL_EXSTYLE = -20
$WS_EX_TOPMOST = 0x00000008
$exstyle = [Win32]::GetWindowLong($hwnd, $GWL_EXSTYLE)
Write-Output ("EXSTYLE=0x{0:X8} TOPMOST={1}" -f $exstyle, (($exstyle -band $WS_EX_TOPMOST) -ne 0))
$rect = New-Object Win32+RECT
[Win32]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [Runtime.InteropServices.Marshal]::SizeOf($rect)) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
Write-Output "RECT left=$($rect.Left) top=$($rect.Top) w=$w h=$h"
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500
$pad = 4
$x = [Math]::Max(0, $rect.Left - $pad); $y = [Math]::Max(0, $rect.Top - $pad)
$bmp = New-Object System.Drawing.Bitmap ($w + 2*$pad), ($h + 2*$pad)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$out = Join-Path $PSScriptRoot "window.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "SAVED=$out"
