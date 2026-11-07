"""Bug 1b: drag strip near screen bottom (gently), verify tooltip pops ABOVE."""
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

def bounds():
    _, j = http('GET', '/window')
    return j['bounds']

def tip_rect():
    h = user32.FindWindowW(None, 'tooltip')
    if not h or not user32.IsWindowVisible(h):
        return None
    r = RECT()
    dwmapi.DwmGetWindowAttribute(h, 9, ctypes.byref(r), ctypes.sizeof(r))
    return r

def px(dip):
    return int(round(dip * SCALE))

results = []
def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, detail)

http('POST', '/status', {'agent': 'kimi', 'status': 'stuck', 'task': 'tip-above probe'})

# gentle vertical drag: 45 steps, 60ms apart, ~20px per step (window can follow)
b0 = bounds()
sx = px(b0['x']) + 9
sy = px(b0['y']) + px(28)
target_dy = px(950) - sy  # to y=950 DIP: below-tooltip no longer fits
print('drag from', (sx, sy), 'dy', target_dy)
pyautogui.moveTo(sx, sy, duration=0.2)
time.sleep(0.2)
pyautogui.mouseDown()
time.sleep(0.2)
steps = 45
for i in range(1, steps + 1):
    pyautogui.moveTo(sx, sy + target_dy * i / steps)
    time.sleep(0.06)
pyautogui.mouseUp()
time.sleep(0.8)
try:
    b1 = bounds()
    dy = b1['y'] - b0['y']
    check('gentle vertical drag to bottom area', dy > 400, f'y {b0["y"]}->{b1["y"]} (dy={dy})')
except Exception as e:
    check('gentle vertical drag to bottom area', False, f'API dead after drag: {e}')
    print('R2_TIPABOVE_RESULT', 'APP_FROZE_DURING_DRAG')
    raise SystemExit(1)

# hover light 1, tooltip should pop ABOVE
light_cx = px(b1['x']) + px(12 + 28)
light_cy = px(b1['y']) + px(28)
pyautogui.moveTo(light_cx, light_cy, duration=0.3)
time.sleep(1.4)
tip = tip_rect()
check('tooltip appears (bottom position)', tip is not None,
      f'tip={tip and (tip.left, tip.top, tip.right, tip.bottom)}')
if tip:
    strip_top = px(b1['y'])
    check('tooltip pops ABOVE strip near bottom', tip.bottom <= strip_top + 6,
          f'tip.bottom={tip.bottom} strip_top={strip_top}')
    img = pyautogui.screenshot(region=(min(px(b1['x']), tip.left) - 8, tip.top - 8,
                                       560, px(b1['y'] + b1['height']) - tip.top + 16))
    img.save('tests/r2-tip-above.png')
    print('saved tests/r2-tip-above.png', img.size)
pyautogui.moveTo(light_cx, 20, duration=0.2)
time.sleep(0.8)
check('tooltip hides after mouse leave', tip_rect() is None)

http('POST', '/status', {'agent': 'kimi', 'status': 'offline'})
print('R2_TIPABOVE_RESULT', 'ALL_PASS' if all(results) else f'{results.count(False)}_FAILED')
