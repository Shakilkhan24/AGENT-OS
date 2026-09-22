"""Exec a runtime while retaining one flock descriptor; never unlink the lock inode."""
import fcntl
import json
import os
import stat
import sys


def main():
    lock_path, executable, *arguments = sys.argv[1:]
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise PermissionError("Runtime lock has unsafe ownership, links or permissions")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.stderr.write(json.dumps({"code": "BUSY", "message": "A runtime already owns this profile"}) + "\n")
        return 73
    # Keep only stdio and this lock. Node spawn closes non-stdio descriptors by
    # default; providers must not use pass-through descriptor lists containing it.
    for name in os.listdir("/proc/self/fd"):
        other = int(name)
        if other > 2 and other != fd:
            try:
                os.close(other)
            except OSError:
                pass
    os.set_inheritable(fd, True)
    environment = dict(os.environ, MINIMAL_LOCK_FD=str(fd))
    os.execve(executable, [executable, *arguments], environment)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.stderr.write(json.dumps({"code": "UNAVAILABLE", "message": str(error)}) + "\n")
        sys.exit(1)
