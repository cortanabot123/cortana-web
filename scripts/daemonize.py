#!/usr/bin/env python3
"""Detach the Cortana Web server from the calling shell/session.

Double-fork + setsid, then exec scripts/start-cortana.sh with output appended to
/opt/data/cache/scratch/cortana-web.log. Writes the daemon PID to
/opt/data/cache/scratch/cortana-web.pid. Idempotent: refuses to start a second copy
when the port already answers.
"""
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = "/opt/data/cache/scratch/cortana-web.log"
PIDFILE = "/opt/data/cache/scratch/cortana-web.pid"
PORT = int(os.environ.get("PORT", "3000"))


def port_open() -> bool:
    s = socket.socket()
    s.settimeout(1.5)
    try:
        s.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


if port_open():
    print(f"already listening on :{PORT}; nothing to do")
    sys.exit(0)

if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)

os.chdir(ROOT)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
logfd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(logfd, 1)
os.dup2(logfd, 2)

pid = os.fork()  # grandchild is the actual server, so we can record its pid
if pid > 0:
    with open(PIDFILE, "w") as f:
        f.write(str(pid))
    os._exit(0)

os.execv(os.path.join(ROOT, "scripts", "start-cortana.sh"),
         [os.path.join(ROOT, "scripts", "start-cortana.sh")])
