"""Locate the AI Status Light window, report its flags, and screenshot it."""
import ctypes
from ctypes import wintypes

import pyautogui

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


hwnd = user32.FindWindowW(None, "AI Status Light")
if not hwnd:
    print("WINDOW_NOT_FOUND")
    raise SystemExit(1)

visible = bool(user32.IsWindowVisible(hwnd))
exstyle = user32.GetWindowLongW(hwnd, -20) & 0xFFFFFFFF
topmost = bool(exstyle & 0x00000008)
print(f"HWND={hwnd} visible={visible} EXSTYLE=0x{exstyle:08X} TOPMOST={topmost}")

rect = RECT()
# DWMWA_EXTENDED_FRAME_BOUNDS = 9 gives the real visible bounds
dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top
print(f"RECT left={rect.left} top={rect.top} w={w} h={h}")

user32.SetForegroundWindow(hwnd)
import time
time.sleep(0.6)

pad = 6
x = max(0, rect.left - pad)
y = max(0, rect.top - pad)
img = pyautogui.screenshot(region=(x, y, w + 2 * pad, h + 2 * pad))
img.save("tests/window.png")
print("SAVED tests/window.png size=", img.size)
