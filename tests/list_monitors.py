"""Enumerate monitors and their work areas (physical px + DIP at 1.5 scale)."""
import ctypes
import ctypes.wintypes as wt

user32 = ctypes.windll.user32
monitors = []

MonitorEnumProc = ctypes.WINFUNCTYPE(
    ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.POINTER(wt.RECT), ctypes.c_long
)

class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("rcMonitor", wt.RECT),
        ("rcWork", wt.RECT),
        ("dwFlags", ctypes.c_ulong),
    ]

def callback(hMonitor, hdc, lprect, lparam):
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    if user32.GetMonitorInfoW(hMonitor, ctypes.byref(mi)):
        monitors.append((mi.rcMonitor, mi.rcWork))
    return 1

user32.EnumDisplayMonitors(None, None, MonitorEnumProc(callback), 0)

for i, (mon, work) in enumerate(monitors):
    print(f"Monitor {i}: full=({mon.left},{mon.top})-({mon.right},{mon.bottom})  "
          f"work=({work.left},{work.top})-({work.right},{work.bottom})  "
          f"DIP work=({work.left/1.5:.0f},{work.top/1.5:.0f})-({work.right/1.5:.0f},{work.bottom/1.5:.0f})")
