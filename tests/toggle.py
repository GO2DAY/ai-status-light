"""Carefully test click-toggle: expand then collapse with generous waits."""
import ctypes, time
from ctypes import wintypes
import pyautogui

pyautogui.FAILSAFE = False
user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi

class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

def win_rect():
    hwnd = user32.FindWindowW(None, "AI Status Light")
    r = RECT()
    dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r))
    return r

def h():
    r = win_rect()
    return r.bottom - r.top

r = win_rect()
hh = r.bottom - r.top
scale = hh / 56.0
cx = r.left + int((12 + 56 * 7.5) * scale)
cy = r.top + hh // 2
print(f"start h={hh} click=({cx},{cy})")

pyautogui.moveTo(cx, cy + 300, duration=0.2)  # park mouse away first
time.sleep(0.5)
print("h with mouse away:", h())

pyautogui.click(cx, cy)
time.sleep(2.5)
h1 = h()
print("after click#1:", h1)

pyautogui.moveTo(cx, cy + 300, duration=0.2)
time.sleep(0.5)
pyautogui.click(cx, cy)
time.sleep(2.5)
h2 = h()
print("after click#2:", h2)

print("TOGGLE_OK" if (h1 > 100 and h2 < 100) else "TOGGLE_FAIL")
