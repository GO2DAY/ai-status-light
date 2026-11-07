"""Round-2 Bug 3 refined: drag tracking at increasing speeds + position memory."""
import ctypes, json, time, urllib.request
from ctypes import wintypes
import threading
import pyautogui

pyautogui.FAILSAFE = False
user32 = ctypes.windll.user32
BASE = 'http://127.0.0.1:17890'
SCALE = 1.5

def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as res:
        return res.status, json.loads(res.read().decode())

def bounds():
    _, j = http('GET', '/window')
    return j['bounds']

def px(dip):
    return int(round(dip * SCALE))

results = []
def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, detail)

def drag(dx_px, dy_px, steps, step_delay):
    """Drag from left padding of strip by (dx,dy) physical px."""
    b = bounds()
    sx = px(b['x']) + 9
    sy = px(b['y']) + px(28)
    pyautogui.moveTo(sx, sy, duration=0.2)
    time.sleep(0.2)
    pyautogui.mouseDown()
    time.sleep(0.15)
    for i in range(1, steps + 1):
        pyautogui.moveTo(sx + dx_px * i / steps, sy + dy_px * i / steps)
        time.sleep(step_delay)
    pyautogui.mouseUp()
    time.sleep(0.6)
    return bounds(), b

# ---- 1. slow horizontal drag (+200 DIP = 300px right) ----------------------
b_after, b0 = drag(300, 0, steps=30, step_delay=0.04)
dx = b_after['x'] - b0['x']
check('slow horizontal drag (+200 DIP)', abs(dx - 200) < 40, f'dx={dx} (x {b0["x"]}->{b_after["x"]})')

# ---- 2. slow vertical drag down (+600 DIP = 900px) -------------------------
b_after, b0 = drag(0, 900, steps=60, step_delay=0.04)
dy = b_after['y'] - b0['y']
check('slow vertical drag (+600 DIP)', abs(dy - 600) < 80, f'dy={dy} (y {b0["y"]}->{b_after["y"]})')

# ---- 3. fast diagonal fling (+300 DIP right, -400 DIP up) -------------------
b_after, b0 = drag(450, -600, steps=8, step_delay=0.01)
dx, dy = b_after['x'] - b0['x'], b_after['y'] - b0['y']
moved = abs(dx) > 100 or abs(dy) > 100
check('fast fling moves window substantially (may lose some tracking)', moved, f'dx={dx} dy={dy}')

# ---- 4. HTTP alive during a drag -------------------------------------------
http_results = []
stop = threading.Event()
def hammer():
    while not stop.is_set():
        try:
            s, _ = http('POST', '/status', {'agent': 'qa-drag2', 'status': 'running'})
            http_results.append(s)
        except Exception as e:
            http_results.append(str(e))
        time.sleep(0.15)
t = threading.Thread(target=hammer); t.start()
time.sleep(0.2)
b_after, b0 = drag(225, 225, steps=30, step_delay=0.05)
stop.set(); t.join()
ok = sum(1 for r in http_results if r == 200)
check('HTTP reporting uninterrupted during drag', ok == len(http_results) and len(http_results) > 5,
      f'{ok}/{len(http_results)} 200s, window dx={b_after["x"]-b0["x"]} dy={b_after["y"]-b0["y"]}')

# ---- 5. position persisted (fixed falsy-zero handling) ----------------------
time.sleep(1.0)
cfg = json.load(open('config.json', encoding='utf-8'))
saved = cfg.get('window') or {}
sx_, sy_ = saved.get('x'), saved.get('y')
b = bounds()
check('position persisted to config.json',
      sx_ is not None and sy_ is not None and abs(sx_ - b['x']) < 3 and abs(sy_ - b['y']) < 3,
      f'config=({sx_},{sy_}) actual=({b["x"]},{b["y"]})')

http('DELETE', '/agents/qa-drag2')
print('FINAL_BOUNDS', b)
print('R2_DRAG_RESULT', 'ALL_PASS' if all(results) else f'{results.count(False)}_FAILED')
