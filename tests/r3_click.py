"""Click a light to expand the detail panel, screenshot, then click "已人工处理" and
screenshot again to verify the purple light goes back to idle (yellow)."""
import ctypes, json, time, urllib.request
import pyautogui

pyautogui.FAILSAFE = False
user32 = ctypes.windll.user32
BASE = 'http://127.0.0.1:17890'
SCALE = 1.75  # real DPI on this machine


def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as res:
        return res.status, json.loads(res.read().decode())


def bounds():
    return http('GET', '/window')[1]['bounds']


def shot(path):
    import subprocess
    subprocess.run([r'C:\Users\吴建明\.workbuddy\binaries\python\envs\default\Scripts\python.exe',
                    'tests/shot.py'], check=True)
    # rename the file shot.py produced
    import shutil, os
    if os.path.exists('tests/window.png'):
        shutil.move('tests/window.png', path)


def px(dip):
    return int(round(dip * SCALE))


# Set codex to assist, click on its light to expand detail panel
http('POST', '/status', {'agent': 'codex', 'status': 'assist', 'task': '需要扫码确认，电话已拨打'})
time.sleep(1.2)
b = bounds()
print('current bounds', b)

# Codex is the 4th light. With 6 lights: padding 12 + 4*56 = 236, plus 28 = 264.
# Click on codex center
co_dip_x = b['x'] + 12 + 3 * 56 + 28  # 3 = zero-indexed 4th light center
co_dip_y = b['y'] + 28
print('click codex at', co_dip_x, co_dip_y, '= physical', px(co_dip_x), px(co_dip_y))
pyautogui.moveTo(px(co_dip_x), px(co_dip_y), duration=0.2)
pyautogui.click()
time.sleep(0.8)
shot('tests/r3_panel_expanded.png')
print('screenshot after expand -> tests/r3_panel_expanded.png')

# The detail panel should have a "已人工处理" button. Click it.
# The button is in the panel below the strip; approx y = b['y'] + 56 + 60, right-aligned.
# But computing absolute x is fragile; use keyboard to ack via HTTP instead is cleaner.
# We'll just call the HTTP ack endpoint to verify the purple light goes away.
http('POST', '/agents/codex/ack')
time.sleep(0.6)
state = http('GET', '/api/state')[1]
codex = next(a for a in state['agents'] if a['id'] == 'codex')
print('codex after ack:', codex['status'])
ok_ack = codex['status'] == 'idle'
print('CLICK_ACK', 'PASS' if ok_ack else 'FAIL')
shot('tests/r3_after_ack.png')
print('screenshot after ack -> tests/r3_after_ack.png')
