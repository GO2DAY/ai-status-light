"""Click the 8th light (stuck) and verify the detail panel expands the window."""
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

r = win_rect()
h = r.bottom - r.top
scale = h / 56.0
cx = r.left + int((12 + 56 * 7.5) * scale)
cy = r.top + h // 2
print(f"before: h={h}; clicking ({cx},{cy})")
pyautogui.click(cx, cy)
time.sleep(1.5)

r2 = win_rect()
h2 = r2.bottom - r2.top
print(f"after:  h={h2}")
expanded = h2 > h + 30
print("PANEL_EXPANDED" if expanded else "PANEL_NOT_EXPANDED")

img = pyautogui.screenshot(region=(r2.left, r2.top, r2.right - r2.left, h2 + 20))
img.save("tests/panel.png")
print("SAVED tests/panel.png", img.size)

# click again to collapse
pyautogui.click(cx, cy)
time.sleep(1.0)
r3 = win_rect()
print(f"collapsed: h={r3.bottom - r3.top}")
