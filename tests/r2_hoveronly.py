"""Hover light 1 with strip preset near bottom; tooltip must pop ABOVE."""
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

results = []
def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, detail)

_, j = http('GET', '/window')
b = j['bounds']
print('bounds', b)
http('POST', '/status', {'agent': 'kimi', 'status': 'stuck', 'task': 'tip-above probe'})

light_cx = px(b['x']) + px(12 + 28)
light_cy = px(b['y']) + px(28)
pyautogui.moveTo(light_cx, light_cy, duration=0.3)
time.sleep(1.4)

h = user32.FindWindowW(None, 'tooltip')
visible = bool(h) and bool(user32.IsWindowVisible(h))
check('tooltip appears (bottom position)', visible)
if visible:
    r = RECT()
    dwmapi.DwmGetWindowAttribute(h, 9, ctypes.byref(r), ctypes.sizeof(r))
    strip_top = px(b['y'])
    check('tooltip pops ABOVE strip near bottom', r.bottom <= strip_top + 6,
          f'tip.bottom={r.bottom} strip_top={strip_top}')
    img = pyautogui.screenshot(region=(min(px(b['x']), r.left) - 8, r.top - 8,
                                       560, px(b['y'] + b['height']) - r.top + 16))
    img.save('tests/r2-tip-above.png')
    print('saved tests/r2-tip-above.png', img.size)
pyautogui.moveTo(light_cx, 20, duration=0.2)
time.sleep(0.8)
h2 = user32.FindWindowW(None, 'tooltip')
check('tooltip hides after mouse leave', not (h2 and user32.IsWindowVisible(h2)))
http('POST', '/status', {'agent': 'kimi', 'status': 'offline'})
print('R2_HOVER_RESULT', 'ALL_PASS' if all(results) else f'{results.count(False)}_FAILED')
