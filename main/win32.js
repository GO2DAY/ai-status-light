'use strict';

/**
 * main/win32.js — Win32 API 薄封装（koffi FFI，进程内调用，无子进程）
 *
 * 【这是已删除的 main/fg_watcher.py 的进程内替代实现的底层】
 * 原架构：Electron 主进程 spawn 一个常驻 python.exe 跑 fg_watcher.py（约 38MB
 * 内存、每 2 秒唤醒一次、还依赖本机写死的 Python 路径）。现在这些能力全部收进
 * 主进程：不再有子进程、不再依赖 Python、目标机器无需任何运行时。
 *
 * 对外只暴露四个纯函数（无持久句柄、无后台线程、无全局可变状态）：
 *   foregroundProcessName() -> string    前台窗口所属进程的 exe 名（小写），失败返回 ''
 *   processNames()          -> Set       当前所有进程的 exe 名（小写）
 *   imagePids(exeName)      -> number[]  该 exe 名的全部 PID（Electron 多进程）
 *   cpuSeconds(pids)        -> number    这些 PID 的 kernel+user CPU 累计秒数
 *
 * 稳定性约定（7x24 长跑，泄漏会崩）：
 *   - DLL 句柄与函数指针只在首次调用时 koffi.load 一次并缓存，绝不每轮 reload
 *   - 每个 OpenProcess / CreateToolhelp32Snapshot 都在 finally 里 CloseHandle
 *   - 任何单次调用失败都被吞掉，绝不向上抛（某个 PID 无权限不影响其他 PID）
 *
 * ---------------------------------------------------------------------------
 * koffi 用法备忘（来源：已删除的 tools/koffi-probe/probe.js，Electron 31.7.7 +
 * Node 20.18.0 主进程实测通过，原始输出见下）
 * ---------------------------------------------------------------------------
 *   [1] GetForegroundWindow -> hwnd=395212
 *   [1] foreground pid=11332 exe=UGREEN NAS.exe
 *   [2] 枚举进程总数=384, explorer.exe pids=[11800,6880,6600]
 *   [3] GetProcessTimes(pid=11800) ok=true kernel=286.48s user=184.13s
 *   OK | electron=31.7.7 node=20.18.0 | 27ms
 *
 * 关键坑：
 *   1) PROCESSENTRY32W 里的 szExeFile 必须声明为 `koffi.array('char16', 260)`，
 *      传参时用 `Buffer.alloc(520)`（260 个 UTF-16 码元 = 520 字节）初始化。
 *   2) 读回 exe 名时 koffi 可能返回 Buffer，也可能返回 number[]，两种都要兼容。
 *      第一版只按 JS 数组写，实测直接报 ".filter is not a function"。
 *      处理：Buffer -> toString('utf16le')；Array -> String.fromCharCode(...)
 *      两种结果都要截到第一个 \0（不要用 replace(/\0+$/,''），低效且对中间
 *      的 \0 处理不对）。
 *   3) FILETIME 用普通 JS 对象 {} 承接即可（_Out_ 会回填字段）：
 *        GetProcessTimes(h, {}, {}, kt, ut)
 *      再按 ((hi * 2^32) + lo) / 1e7 换算成秒。
 *   4) intptr_t 返回值在 64 位下 koffi 给的是 number，但非法句柄可能以 BigInt
 *      形态出现，所以 isValidHandle() 同时处理 number / bigint / -1 / 0xFFFFFFFF。
 */

const path = require('path');
const koffi = require('koffi');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000; // 无需管理员权限即可读进程信息
const TH32CS_SNAPPROCESS = 0x00000002;
const MAX_PATH = 260;

// 结构体只需注册一次。Node 的模块缓存保证本文件只会被 require 一次。
const PROCESSENTRY32W = koffi.struct('ASL_PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16', 260),
});

const FILETIME = koffi.struct('ASL_FILETIME', {
  dwLowDateTime: 'uint32',
  dwHighDateTime: 'uint32',
});

/** @type {object | null} */
let api = null;
/** @type {boolean} 加载失败后不再反复重试（每 2 秒 load 一次 DLL 没有意义） */
let apiFailed = false;

function buildApi() {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func(
      'uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *pid)'
    ),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(intptr_t h)'),
    QueryFullProcessImageNameW: kernel32.func(
      'int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ char16 *buf, _Inout_ uint32 *size)'
    ),
    CreateToolhelp32Snapshot: kernel32.func(
      'intptr_t __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'
    ),
    Process32FirstW: kernel32.func(
      'int __stdcall Process32FirstW(intptr_t snap, _Inout_ ASL_PROCESSENTRY32W *pe)'
    ),
    Process32NextW: kernel32.func(
      'int __stdcall Process32NextW(intptr_t snap, _Inout_ ASL_PROCESSENTRY32W *pe)'
    ),
    GetProcessTimes: kernel32.func(
      'int __stdcall GetProcessTimes(intptr_t h, _Out_ ASL_FILETIME *ct, _Out_ ASL_FILETIME *et, _Out_ ASL_FILETIME *kt, _Out_ ASL_FILETIME *ut)'
    ),
    RegisterApplicationRestart: kernel32.func(
      'int __stdcall RegisterApplicationRestart(const char16 *pwzCommandLine, uint32 dwFlags)'
    ),
  };
}

/** 返回缓存的 API 对象；非 Windows 或 koffi 不可用时返回 null（调用方降级）。 */
function win32() {
  if (api) return api;
  if (apiFailed) return null;
  try {
    api = buildApi();
  } catch (err) {
    apiFailed = true;
    api = null;
    console.error('[status-light] win32/koffi unavailable:', err && err.message);
  }
  return api;
}

/**
 * Win32 句柄有效性判断。0 / NULL / INVALID_HANDLE_VALUE(-1 / 0xFFFFFFFF /
 * 0xFFFFFFFFFFFFFFFF) 都算无效 —— 无效句柄不能 CloseHandle，有效句柄必须 Close。
 */
function isValidHandle(h) {
  if (h === null || h === undefined || h === false) return false;
  if (typeof h === 'bigint') {
    return h !== 0n && h !== 0xffffffffn && h !== 0xffffffffffffffffn;
  }
  const n = Number(h);
  return Number.isFinite(n) && n !== 0 && n !== -1 && n !== 0xffffffff;
}

/** UTF-16 缓冲区 -> JS 字符串，截到第一个 NUL。 */
function trimNul(s) {
  const i = s.indexOf('\u0000');
  return i >= 0 ? s.slice(0, i) : s;
}

/** szExeFile 读回后可能是 Buffer 或 number[]，两种都兼容（见顶部坑 #2）。 */
function readExeName(raw) {
  if (typeof raw === 'string') return trimNul(raw);
  if (Buffer.isBuffer(raw)) return trimNul(raw.toString('utf16le'));
  if (Array.isArray(raw)) {
    let s = '';
    for (const c of raw) {
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  return '';
}

/**
 * 前台窗口所属进程的 exe 文件名（小写，如 'doubao.exe'）。
 * 失败（无前台窗口 / 无权限 / 非 Windows）一律返回 ''。
 */
function foregroundProcessName() {
  const a = win32();
  if (!a) return '';
  try {
    const hwnd = a.GetForegroundWindow();
    if (!isValidHandle(hwnd)) return '';
    const pidRef = [0];
    a.GetWindowThreadProcessId(hwnd, pidRef);
    const pid = pidRef[0];
    if (!pid) return '';
    const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!isValidHandle(h)) return '';
    try {
      const buf = Buffer.alloc(MAX_PATH * 8); // 2048+ 字节，足够放下长路径
      const sizeRef = [buf.length / 2]; // QueryFullProcessImageNameW 的单位是字符数
      if (a.QueryFullProcessImageNameW(h, 0, buf, sizeRef)) {
        const chars = Math.min(sizeRef[0], buf.length / 2);
        const full = buf.toString('utf16le', 0, chars * 2);
        return path.win32.basename(trimNul(full)).toLowerCase();
      }
    } finally {
      a.CloseHandle(h);
    }
  } catch (err) {
    // 前台窗口可能在两次调用之间消失；吞掉即可，下一轮再试。
  }
  return '';
}

/**
 * 一次性快照整个进程表，返回 [{pid, name}]。快照句柄在 finally 里关闭。
 * 所有枚举类接口都以它为底座，避免同一轮里反复 CreateToolhelp32Snapshot。
 */
function snapshotProcesses() {
  const a = win32();
  const list = [];
  if (!a) return list;
  const snap = a.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!isValidHandle(snap)) return list;
  try {
    const pe = {
      dwSize: koffi.sizeof(PROCESSENTRY32W),
      szExeFile: Buffer.alloc(MAX_PATH * 2),
    };
    if (a.Process32FirstW(snap, pe)) {
      do {
        const name = readExeName(pe.szExeFile).toLowerCase();
        if (name) list.push({ pid: pe.th32ProcessID, name });
      } while (a.Process32NextW(snap, pe));
    }
  } catch (err) {
    // 进程表在遍历途中变化是常态；已拿到的部分照常返回。
  } finally {
    try {
      a.CloseHandle(snap);
    } catch (err) {
      /* ignore */
    }
  }
  return list;
}

/** 当前所有进程 exe 名（小写）的集合 —— 等价于原 Python 的 tasklist_set()。 */
function processNames() {
  const set = new Set();
  for (const p of snapshotProcesses()) set.add(p.name);
  return set;
}

/**
 * 指定 exe 名的全部 PID（小写比对）。Electron 应用会有一串同名进程，
 * CPU 采样必须覆盖全部 PID 才能算出真实负载。
 */
function imagePids(imageName) {
  const target = String(imageName || '').toLowerCase();
  if (!target) return [];
  return snapshotProcesses()
    .filter((p) => p.name === target)
    .map((p) => p.pid);
}

/** FILETIME -> 秒（100ns 为单位）。 */
function filetimeSeconds(ft) {
  if (!ft) return 0;
  return ((ft.dwHighDateTime || 0) * 4294967296 + (ft.dwLowDateTime || 0)) / 1e7;
}

/**
 * 这些 PID 的 (kernel + user) CPU 累计秒数之和。
 * 已退出的 PID 会被 OpenProcess 失败跳过；单个 PID 出错不影响其他 PID。
 */
function cpuSeconds(pids) {
  const a = win32();
  let total = 0;
  if (!a || !Array.isArray(pids)) return total;
  for (const pid of pids) {
    let h = 0;
    try {
      h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!isValidHandle(h)) continue;
      const ct = {};
      const et = {};
      const kt = {};
      const ut = {};
      if (a.GetProcessTimes(h, ct, et, kt, ut)) {
        total += filetimeSeconds(kt) + filetimeSeconds(ut);
      }
    } catch (err) {
      // 单个 PID 拿不到（权限/已退出）属正常，继续下一个。
    } finally {
      if (isValidHandle(h)) {
        try {
          a.CloseHandle(h);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }
  return total;
}

/**
 * 向 Windows 注册"应用崩溃/被结束一段时间后自动重启"（RegisterApplicationRestart）。
 *
 * 这是 supervisor 之外的第二层兜底，两者覆盖面互补：
 *   - supervisor 管"进程活着但卡死"（心跳超时 -> 主动重启）
 *   - 这个管"进程整个没了"（被任务管理器结束、崩溃、系统更新重启后 Windows
 *     自己把我们拉起来），这种场景 supervisor 自己也没了，救不了。
 *
 * 传 null 命令行 = 用当前进程的原始命令行重启，flags 0 = 不在系统重启后自动拉起
 * （只覆盖崩溃/被结束，避免变成开机自启动骚扰用户）。
 *
 * 只在打包后的正式版调用：开发态注册会把 node_modules/electron/dist/electron.exe
 * 登记进系统的重启列表，等于给自己造了个开机启动项。
 *
 * @returns {boolean} 是否注册成功；失败不算致命，调用方只需记一行日志。
 */
function registerApplicationRestart() {
  const a = win32();
  if (!a) return false;
  try {
    // 返回值是 HRESULT：0 (S_OK) 表示成功。
    return a.RegisterApplicationRestart(null, 0) === 0;
  } catch (err) {
    return false;
  }
}

module.exports = {
  foregroundProcessName,
  processNames,
  imagePids,
  cpuSeconds,
  registerApplicationRestart,
  isAvailable: () => win32() !== null,
};
