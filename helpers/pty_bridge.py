"""A disposable tmux client PTY, never the owner of the running work."""
import base64
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios
from fds import close_inherited

close_inherited()
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, master = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ.pop('TMUX', None)
    os.execvp(sys.argv[3], sys.argv[3:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
selector = selectors.DefaultSelector()
selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
selector.register(master, selectors.EVENT_READ)
os.set_blocking(master, False)
buffer = b''
pending_input = bytearray()
stdin_paused = False
try:
    while True:
        for key, events in selector.select():
            if key.fd == master:
                if events & selectors.EVENT_READ:
                    try:
                        data = os.read(master, 32768)
                    except BlockingIOError:
                        data = None
                    except OSError as error:
                        if error.errno == errno.EIO:
                            sys.exit(0)
                        raise
                    if data == b'':
                        sys.exit(0)
                    if data:
                        print(json.dumps({'data': base64.b64encode(data).decode('ascii')}), flush=True)
                if events & selectors.EVENT_WRITE:
                    try:
                        written = os.write(master, pending_input)
                        del pending_input[:written]
                    except BlockingIOError:
                        pass
                    if not pending_input:
                        selector.modify(master, selectors.EVENT_READ)
                    if stdin_paused and len(pending_input) < 128 * 1024:
                        selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
                        stdin_paused = False
            else:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    sys.exit(0)
                buffer += data
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    req = json.loads(line)
                    if 'data' in req:
                        pending_input.extend(base64.b64decode(req['data']))
                        if pending_input:
                            selector.modify(master, selectors.EVENT_READ | selectors.EVENT_WRITE)
                    elif 'cols' in req:
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', req['rows'], req['cols'], 0, 0))
                if len(pending_input) >= 256 * 1024:
                    selector.unregister(sys.stdin.fileno())
                    stdin_paused = True
finally:
    selector.close()
    os.close(master)
    try:
        os.kill(pid, signal.SIGHUP)
        os.waitpid(pid, 0)
    except ProcessLookupError:
        pass
