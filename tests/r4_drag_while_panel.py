"""
r4_drag_while_panel.py - 端到端验证"面板展开时拖动不会被拉长"

修复目标：主进程 dragStart handler 必须把窗口从面板撑高状态压回 56，
          并在拖动期间持续锁 56 不被 ResizeObserver 反向拉高。

本测试用主进程暴露的 /debug/dragStart/Move/End 端点直接触发 IPC drag
路径，绕开 sandbox 下 pyautogui 与 Electron pointer 事件系统的兼容
问题（产品功能未受影响——真实鼠标点击老吴截图已证明）。
"""
import time
import json
import urllib.request

API = 'http://127.0.0.1:17890'


def call(method, path, payload=None):
    body = json.dumps(payload or {}).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(
        f'{API}{path}',
        data=body,
        method=method,
        headers={'Content-Type': 'application/json'} if body else {},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def bounds():
    return call('GET', '/window')['bounds']


# 1. codex 进 assist
call('POST', '/status', {'agent': 'codex', 'status': 'assist', 'task': '测试面板拖动'})
time.sleep(0.4)

# 2. 强制展开面板
call('POST', '/debug/expandPanel?id=codex')
time.sleep(0.8)
b1 = bounds()
print(f'面板展开后 bounds: {b1}  height={b1["height"]}')
panel_opened = b1['height'] > 70
print(f'面板确实展开 (>70): {panel_opened}')

# 3. dragStart（直接调 debug 端点走主进程 IPC 路径）
r = call('POST', '/debug/dragStart')
print(f'dragStart 响应: {r}')
time.sleep(0.2)
b_after_start = bounds()
print(f'dragStart 后 bounds: {b_after_start}  height={b_after_start["height"]}')
start_locked = b_after_start['height'] == 56
print(f'dragStart 后高度 == 56: {start_locked}')

# 4. 模拟 8 步 dragMove（用 debug 端点 + 屏幕坐标偏移）
# 在主进程内部，dragMove 用 screen.getCursorScreenPoint() 计算新位置。
# 我们在测试里调 setCursorPos 改变 cursor 位置，再调 dragMove。
import ctypes
user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

# 拿到初始 cursor 位置
class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
pt = POINT()
user32.GetCursorPos(ctypes.byref(pt))
start_cx, start_cy = pt.x, pt.y
print(f'初始 cursor 位置: ({start_cx},{start_cy})')

samples = []
for step in range(8):
    # 移动 cursor 到新位置
    dx = (step + 1) * 30
    dy = -(step + 1) * 6
    user32.SetCursorPos(start_cx + dx, start_cy + dy)
    time.sleep(0.05)
    call('POST', '/debug/dragMove')
    time.sleep(0.15)
    bs = bounds()
    samples.append(bs)
    print(f'  step {step+1}: cursor=({start_cx+dx},{start_cy+dy}) bounds h={bs["height"]}')

# 5. dragEnd
call('POST', '/debug/dragEnd')
time.sleep(0.6)
final = bounds()
print(f'拖完最终 bounds: {final}  height={final["height"]}')

# 6. 验收
all_locked = all(s['height'] == 56 for s in samples)
final_locked = final['height'] == 56
print()
print('==== 验收 ====')
print(f'面板展开 (h={b1["height"]}):               {panel_opened}')
print(f'dragStart 后高度 == 56:                       {start_locked}')
print(f'dragMove 期间 8 步全部 == 56:                 {all_locked}')
print(f'拖完最终高度 == 56:                           {final_locked}')
core_ok = panel_opened and start_locked and all_locked and final_locked
print(f'核心修复 PASS: {core_ok}')

# 复位
call('POST', '/debug/collapsePanel')
time.sleep(0.4)
call('POST', '/status', {'agent': 'codex', 'status': 'idle', 'task': ''})
print(f'复位后 bounds: {bounds()}')