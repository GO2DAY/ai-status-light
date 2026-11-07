"""Hover the 8th light (red/stuck) and screenshot strip + area below it."""
import ctypes, time
from ctypes import wintypes
import pyautogui

pyautogui.FAILSAFE = False
user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi

class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

hwnd = user32.FindWindowW(None, "AI Status Light")
rect = RECT()
dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
w = rect.right - rect.left
h = rect.bottom - rect.top
print(f"window: left={rect.left} top={rect.top} w={w} h={h}")

# physical px per logical px = 1.5; lights start after 12 logical px padding
# 8th light (index 7) center:
scale = h / 56.0
cx = rect.left + int((12 + 56 * 7.5) * scale)
cy = rect.top + h // 2
print(f"hover at ({cx},{cy}) scale={scale}")
pyautogui.moveTo(cx, cy, duration=0.3)
time.sleep(1.2)

# capture strip + 260px below (tooltip zone)
img = pyautogui.screenshot(region=(rect.left, rect.top, w, h + 260))
img.save("tests/hover.png")
print("SAVED tests/hover.png", img.size)
pyautogui.moveTo(cx, cy + 400, duration=0.2)  # move mouse away
