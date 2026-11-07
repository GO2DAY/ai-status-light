"""Round-2 UI regression for AI Status Light.

Covers:
  Bug 1: hover tooltip is a separate always-on-top window ("tooltip"),
         pops below the strip when it fits, above when it doesn't.
  Bug 3: IPC dragging moves the window, HTTP reporting keeps working
         during the drag, position persists to config.json.

Outputs verdict lines + screenshots r2-tip-below.png / r2-tip-above.png.
"""
import ctypes, json, time, urllib.request
from ctypes import wintypes
import threading
import pyautogui

pyautogui.FAILSAFE = False
user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
BASE = 'http://127.0.0.1:17890'
SCALE = 1.5  # display DPI scale (verified earlier: 1680x1120 logical @150%)

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
    return j['bounds']  # DIP: {x, y, width, height}

def tip_rect():
    h = user32.FindWindowW(None, 'tooltip')
    if not h or not user32.IsWindowVisible(h):
        return None
    r = RECT()
    dwmapi.DwmGetWindowAttribute(h, 9, ctypes.byref(r), ctypes.sizeof(r))
    return r

def px(dip):  # DIP -> physical px
    return int(round(dip * SCALE))

def shot(path, x, y, w, h):
    img = pyautogui.screenshot(region=(max(0, x), max(0, y), w, h))
    img.save(path)
    print('saved', path, img.size)

results = []
def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, detail)

# ---- setup: make workbuddy running so the tooltip has content -------------
http('POST', '/status', {'agent': 'workbuddy', 'status': 'running', 'task': 'round2 hover regression'})
b0 = bounds()
print('initial bounds', b0)

# ---- Bug 1a: hover with strip near top -> tooltip below --------------------
b = bounds()
light_cx = px(b['x']) + px(12 + 28)   # first light center
light_cy = px(b['y']) + px(28)
pyautogui.moveTo(light_cx, light_cy, duration=0.3)
time.sleep(1.4)
tip = tip_rect()
check('tooltip appears on hover', tip is not None, f'tip={tip and (tip.left, tip.top, tip.right, tip.bottom)}')
if tip:
    strip_bottom = px(b['y'] + b['height'])
    check('tooltip pops BELOW strip at top position', tip.top >= strip_bottom - 6,
          f'tip.top={tip.top} strip_bottom={strip_bottom}')
    shot('tests/r2-tip-below.png', min(px(b['x']), tip.left) - 8, px(b['y']) - 4,
         560, (tip.bottom - px(b['y'])) + 16)
pyautogui.moveTo(light_cx, light_cy + 500, duration=0.2)  # mouse away
time.sleep(0.8)
check('tooltip hides after mouse leave', tip_rect() is None)

# ---- Bug 3: drag strip toward bottom-right, HTTP alive during drag ---------
http_results = []
stop_flag = threading.Event()
def hammer():
    while not stop_flag.is_set():
        try:
            s, _ = http('POST', '/status', {'agent': 'qa-drag', 'status': 'running'})
            http_results.append(s)
        except Exception as e:
            http_results.append(str(e))
        time.sleep(0.15)

b = bounds()
drag_x = px(b['x']) + 9          # left padding (12 DIP wide, no interactive el)
drag_y = px(b['y']) + px(28)
DX, DY = 375, 1500 - drag_y      # +250 DIP right; to y=1000 DIP (near bottom)
t = threading.Thread(target=hammer); t.start()
time.sleep(0.3)
pyautogui.moveTo(drag_x, drag_y, duration=0.2)
pyautogui.mouseDown()
steps = 40
for i in range(1, steps + 1):
    pyautogui.moveTo(drag_x + DX * i / steps, drag_y + DY * i / steps, duration=0.05)
pyautogui.mouseUp()
stop_flag.set(); t.join()
time.sleep(0.5)
b2 = bounds()
print('after drag bounds', b2)
dx, dy = b2['x'] - b['x'], b2['y'] - b['y']
check('window moved by drag (~+250 DIP x, large +y)', abs(dx - 250) < 40 and dy > 500, f'dx={dx} dy={dy}')
ok_http = sum(1 for r in http_results if r == 200)
check('HTTP reporting uninterrupted during drag', ok_http == len(http_results) and len(http_results) > 5,
      f'{ok_http}/{len(http_results)} status=200')

# ---- position persisted to config.json -------------------------------------
time.sleep(0.8)
cfg = json.load(open('config.json', encoding='utf-8'))
saved = cfg.get('window', {})
check('position persisted to config.json',
      abs((saved.get('x') or -9999) - b2['x']) < 3 and abs((saved.get('y') or -9999) - b2['y']) < 3,
      f"config=({saved.get('x')},{saved.get('y')}) actual=({b2['x']},{b2['y']})")

# ---- Bug 1b: hover near screen bottom -> tooltip above ---------------------
b = bounds()
light_cx = px(b['x']) + px(12 + 28)
light_cy = px(b['y']) + px(28)
pyautogui.moveTo(light_cx, light_cy, duration=0.3)
time.sleep(1.4)
tip = tip_rect()
check('tooltip appears on hover (bottom position)', tip is not None,
      f'tip={tip and (tip.left, tip.top, tip.right, tip.bottom)}')
if tip:
    strip_top = px(b['y'])
    check('tooltip pops ABOVE strip near bottom', tip.bottom <= strip_top + 6,
          f'tip.bottom={tip.bottom} strip_top={strip_top}')
    shot('tests/r2-tip-above.png', min(px(b['x']), tip.left) - 8, tip.top - 8,
         560, (px(b['y'] + b['height']) - tip.top) + 16)
pyautogui.moveTo(light_cx, 10, duration=0.2)
time.sleep(0.8)
check('tooltip hides after mouse leave (bottom)', tip_rect() is None)

# ---- cleanup ----------------------------------------------------------------
http('POST', '/status', {'agent': 'workbuddy', 'status': 'offline'})
http('DELETE', '/agents/qa-drag')
print('R2_UI_RESULT', 'ALL_PASS' if all(results) else f'{results.count(False)}_FAILED')
