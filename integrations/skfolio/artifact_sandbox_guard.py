"""Runs inside the container before loading any candidate source; cgroup v2 only."""
import os as _guard_os
from pathlib import Path as _GuardPath


def _verify_container_contract():
    if _guard_os.getuid() != 65534 or _guard_os.getgid() != 65534:
        raise RuntimeError("Sandbox user restriction missing")
    status = dict(line.split(":", 1) for line in _GuardPath("/proc/self/status").read_text().splitlines() if ":" in line)
    if int(status["CapEff"].strip(), 16) != 0 or status["NoNewPrivs"].strip() != "1" or status["Seccomp"].strip() != "2":
        raise RuntimeError("Sandbox privilege restriction missing")
    if {p.name for p in _GuardPath("/sys/class/net").iterdir()} != {"lo"}:
        raise RuntimeError("Sandbox network restriction missing")
    mounts = [line.split() for line in _GuardPath("/proc/mounts").read_text().splitlines()]
    root = next(m for m in mounts if m[1] == "/")
    temporary = next(m for m in mounts if m[1] == "/tmp")
    if "ro" not in root[3].split(",") or temporary[2] != "tmpfs" or not {"noexec", "nosuid", "nodev"}.issubset(temporary[3].split(",")):
        raise RuntimeError("Sandbox filesystem restriction missing")
    filesystem = _guard_os.statvfs("/tmp")
    if filesystem.f_frsize * filesystem.f_blocks > 16 * 1024 * 1024:
        raise RuntimeError("Sandbox temporary storage exceeds limit")
    group = _GuardPath("/sys/fs/cgroup")
    memory = int((group / "memory.max").read_text())
    swap = int((group / "memory.swap.max").read_text())
    pids = int((group / "pids.max").read_text())
    quota, period = map(int, (group / "cpu.max").read_text().split())
    if not 0 < memory <= 128 * 1024 * 1024 or swap != 0 or not 0 < pids <= 16 or not 0 < quota <= period:
        raise RuntimeError("Sandbox resource restriction missing")


_verify_container_contract()
del _verify_container_contract, _guard_os, _GuardPath
