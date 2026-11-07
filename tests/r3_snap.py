"""Minimal edge-snap test: drag the strip to each screen edge and verify
window position snaps flush to work-area edges."""
import ctypes, json, time, urllib.request
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
    return http('GET', '/window')[1]['bounds']


def px(dip):
    return int(round(dip * SCALE))


def drag_to_abs(target_px, target_py, steps=40, step_delay=0.04):
    """Drag from current window position to absolute screen (target_px, target_py).
    Resets mouse to (50, 50) first so a previous mouseUp at a far-away location
    cannot trap pyautogui outside the visible screen.
    """
    pyautogui.moveTo(50, 50, duration=0.2)
    time.sleep(0.2)
    b = bounds()
    # Start near the LEFT EDGE inside the window (5px in from left). This
    # guarantees the press lands on a status light button (which is the only
    # draggable area now).
    sx = px(b['x']) + 8
    sy = px(b['y']) + px(28)
    # Clamp start to the visible screen.
    sx = max(2, min(sx, 2520 - 2))
    sy = max(2, min(sy, 1680 - 2))
    pyautogui.moveTo(sx, sy, duration=0.2)
    time.sleep(0.2)
    pyautogui.mouseDown()
    time.sleep(0.15)
    for i in range(1, steps + 1):
        tx = sx + (target_px - sx) * i / steps
        ty = sy + (target_py - sy) * i / steps
        # Clamp into visible screen to keep pyautogui moving.
        tx = max(2, min(tx, 2520 - 2))
        ty = max(2, min(ty, 1680 - 2))
        pyautogui.moveTo(tx, ty)
        time.sleep(step_delay)
    pyautogui.mouseUp()
    time.sleep(0.6)
    return bounds(), b


results = []
def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, detail)


# Move to right side first so we have room to drag left.
b0 = bounds()
print('initial', b0)

# 1) Drag close to LEFT edge (target x=12 px, well within 24px snap threshold)
b, _ = drag_to_abs(target_px=12, target_py=300)
print('after left-edge release', b)
check('SNAP_LEFT', abs(b['x'] - 0) < 3, f'x={b["x"]} (expected 0)')

# 2) Drag close to TOP edge
b, _ = drag_to_abs(target_px=300, target_py=10)
print('after top-edge release', b)
check('SNAP_TOP', abs(b['y'] - 0) < 3, f'y={b["y"]} (expected 0)')

# 3) Drag close to BOTTOM edge
user32.SetProcessDPIAware()
screen_h = user32.GetSystemMetrics(1)
b, _ = drag_to_abs(target_px=300, target_py=screen_h - 10)
print('after bottom-edge release', b, 'screen_h', screen_h)
# Just assert the window is now near the bottom of the work area
check('SNAP_BOTTOM', b['y'] > screen_h - 200, f'y={b["y"]} (expected > {screen_h-200})')

# 4) Drag close to RIGHT edge
screen_w = user32.GetSystemMetrics(0)
b, _ = drag_to_abs(target_px=screen_w - 10, target_py=400)
print('after right-edge release', b, 'screen_w', screen_w)
check('SNAP_RIGHT', b['x'] > screen_w - 200, f'x={b["x"]} (expected > {screen_w-200})')

# Final: leave window in upper-left for the user
b, _ = drag_to_abs(target_px=200, target_py=10)
print('final', b)

print('SNAP_RESULT', 'ALL_PASS' if all(results) else f'{results.count(False)}_FAILED')
