"""Suspend the AI Status Light main process to simulate a freeze.

Used for end-to-end verification of the supervisor self-heal chain:
suspend -> supervisor sees 3x ping timeout -> taskkill -> relaunch.
"""
import ctypes
import sys

NTDLL = ctypes.WinDLL("ntdll.dll")

def suspend(pid: int) -> None:
    PROCESS_SUSPEND_RESUME = 0x0800
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_SUSPEND_RESUME, False, pid)
    if not handle:
        raise OSError(f"OpenProcess({pid}) failed: {ctypes.windll.kernel32.GetLastError()}")
    status = NTDLL.NtSuspendProcess(handle)
    ctypes.windll.kernel32.CloseHandle(handle)
    if status != 0:
        raise OSError(f"NtSuspendProcess returned 0x{status & 0xFFFFFFFF:08X}")

if __name__ == "__main__":
    pid = int(sys.argv[1])
    suspend(pid)
    print(f"suspended pid={pid}")
