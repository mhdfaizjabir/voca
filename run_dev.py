#!/usr/bin/env python
"""
Starts the API server, voice agent worker, and frontend together in one
terminal, with each service's output prefixed and color-coded. Ctrl+C stops
all three.

Usage:
    python run_dev.py

Requires backend/.venv-api, backend/agent/.venv, and frontend/node_modules
to already exist (see README for first-time setup).
"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"


def venv_python(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


API_PYTHON = venv_python(BACKEND / ".venv-api")
AGENT_PYTHON = venv_python(BACKEND / "agent" / ".venv")

SERVICES = [
    {
        "name": "api",
        "cmd": [str(API_PYTHON), "-m", "uvicorn", "api.main:app", "--reload", "--port", "8001"],
        "cwd": BACKEND,
        "check_path": API_PYTHON,
    },
    {
        "name": "agent",
        "cmd": [str(AGENT_PYTHON), "agent.py", "dev"],
        "cwd": BACKEND / "agent",
        "check_path": AGENT_PYTHON,
    },
    {
        "name": "frontend",
        "cmd": ["npm", "run", "dev"],
        "cwd": FRONTEND,
        "shell": os.name == "nt",
        "check_path": FRONTEND / "node_modules",
    },
]

COLORS = {"api": "\033[36m", "agent": "\033[35m", "frontend": "\033[33m"}
RESET = "\033[0m"


def stream_output(name: str, proc: subprocess.Popen) -> None:
    color = COLORS.get(name, "")
    for line in proc.stdout:
        print(f"{color}[{name}]{RESET} {line}", end="")


def stop_process(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.terminate()


def main() -> None:
    for svc in SERVICES:
        if not svc["check_path"].exists():
            print(f"Missing prerequisite for '{svc['name']}': {svc['check_path']}")
            print("Set it up first per the README, then re-run this script.")
            sys.exit(1)

    procs: list[tuple[str, subprocess.Popen]] = []
    for svc in SERVICES:
        proc = subprocess.Popen(
            svc["cmd"],
            cwd=svc["cwd"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            shell=svc.get("shell", False),
        )
        procs.append((svc["name"], proc))
        threading.Thread(target=stream_output, args=(svc["name"], proc), daemon=True).start()

    print("\nAll services starting (api, agent, frontend). Press Ctrl+C to stop everything.\n")

    try:
        while True:
            time.sleep(1)
            for name, proc in procs:
                if proc.poll() is not None:
                    print(f"\n[{name}] exited with code {proc.returncode} - stopping everything.\n")
                    raise KeyboardInterrupt
    except KeyboardInterrupt:
        print("\nStopping all services...")
        for _, proc in procs:
            stop_process(proc)
        print("All stopped.")


if __name__ == "__main__":
    main()
