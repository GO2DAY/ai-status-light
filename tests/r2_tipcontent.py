"""Decisive: hover each light in turn, OCR-free check via tooltip window position
   and content screenshot. Hover light #4 (Codex) deliberately."""
import ctypes, json, time, urllib.request
from ctypes import wintypes
import pyautogui

pyautogui.FAILSAFE = False
user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
BASE = 'http://127.0.0.1:17890'
SCALE = 1.5

class RECT(ctypes.Structure):
    _fields_ = [('left', wintypes.LONG), ('top', wintypes.LONG),
                ('right', wintypes.LONG), ('bottom', wintypes.LONG)]

def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as res:
        return res.status, json.loads(res.read().decode())

def px(dip):
    return int(round(dip * SCALE))

_, j = http('GET', '/window')
b = j['bounds']
print('bounds', b)

def hover(i):
    """Hover light index i, return tooltip rect + screenshot path."""
    cx = px(b['x']) + px(12 + 56 * i + 28)
    cy = px(b['y']) + px(28)
    pyautogui.moveTo(cx - 200, cy - 300, duration=0.1)  # approach from outside
    time.sleep(0.3)
    pyautogui.moveTo(cx, cy, duration=0.3)
    time.sleep(1.2)
    h = user32.FindWindowW(None, 'tooltip')
    if not h or not user32.IsWindowVisible(h):
        return None
    r = RECT()
    dwmapi.DwmGetWindowAttribute(h, 9, ctypes.byref(r), ctypes.sizeof(r))
    return r

r0 = hover(0)
print('hover light0 -> tip', r0 and (r0.left, r0.top, r0.right, r0.bottom))
if r0:
    img = pyautogui.screenshot(region=(r0.left, r0.top, r0.right - r0.left, r0.bottom - r0.top))
    img.save('tests/r2-tip-l0.png')

r3 = hover(3)
print('hover light3 -> tip', r3 and (r3.left, r3.top, r3.right, r3.bottom))
if r3:
    img = pyautogui.screenshot(region=(r3.left, r3.top, r3.right - r3.left, r3.bottom - r3.top))
    img.save('tests/r2-tip-l3.png')

# anchor x should track the hovered light
if r0 and r3:
    d_anchor = (r3.left - r0.left)
    print('anchor shift for 3 lights right:', d_anchor, 'expected ~', 3 * 84)
    print('ANCHOR_TRACKS' if abs(d_anchor - 252) < 30 else 'ANCHOR_STATIC')
pyautogui.moveTo(40, 40, duration=0.2)
print('done')
