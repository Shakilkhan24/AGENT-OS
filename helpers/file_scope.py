"""Pinned-descriptor containment and bounded mutations."""
import ctypes
import errno
import os
import stat

MAX_TEXT = 2 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
libc = ctypes.CDLL(None, use_errno=True)

class OpenHow(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]

def identity(fd):
    s = os.fstat(fd)
    return f'{s.st_dev}:{s.st_ino}'

def parts(path):
    if not isinstance(path, str) or '\x00' in path or path.startswith('/'):
        raise ValueError('Use a path relative to this session directory')
    chunks = path.split('/')
    if '..' in chunks:
        raise ValueError('Paths cannot leave the session directory')
    return [p for p in chunks if p not in ('', '.')]

def beneath(root, chunks, flags):
    # Linux openat2 resolves the entire path beneath the pinned root in one
    # kernel operation, including during concurrent renames. Disallow symlinks,
    # magic links and crossing into mounted filesystems (including bind mounts).
    how = OpenHow(flags, 0, 0x08 | 0x04 | 0x02 | 0x01)
    fd = libc.syscall(437, root, os.fsencode('/'.join(chunks) or '.'), ctypes.byref(how), ctypes.sizeof(how))
    if fd < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return fd

def walk(root, chunks):
    return beneath(root, chunks, DIR_FLAGS)

def regular(fd, limit=MAX_TEXT):
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError('Only ordinary files with one hard link can be opened')
    if limit is not None and s.st_size > limit:
        raise ValueError('Text preview is limited to 2 MiB')

def read_bounded(fd, limit):
    chunks = []
    remaining = limit
    while remaining:
        chunk = os.read(fd, min(remaining, 65536))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)

def remove(parent, name, budget=None, depth=0):
    budget = [20000] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0 or depth > 128:
        raise ValueError("Deletion exceeds its entry/depth budget; partial deletion is possible")
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
        raise ValueError('Symbolic links are blocked')
    if stat.S_ISDIR(info.st_mode):
        fd = walk(parent, [name])
        try:
            with os.scandir(fd) as entries:
                for child in entries:
                    remove(fd, child.name, budget, depth + 1)
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)

def move_without_replace(parent, name, target, destination, fallback=False, checkpoint=lambda stage: None):
    if not fallback and libc.renameat2(parent, os.fsencode(name), target, os.fsencode(destination), 1) == 0:
        return
    code = errno.EOPNOTSUPP if fallback else ctypes.get_errno()
    if code not in (errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP):
        raise OSError(code, os.strerror(code))
    # WSL's Windows filesystem does not implement RENAME_NOREPLACE. Reserve
    # the destination exclusively before moving. Never use check-then-rename.
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        os.mkdir(destination, dir_fd=target)
        try:
            checkpoint('reserved-directory')
            os.rename(name, destination, src_dir_fd=parent, dst_dir_fd=target)
        except BaseException:
            try:
                os.rmdir(destination, dir_fd=target)
            except OSError:
                pass
            raise
    elif stat.S_ISREG(info.st_mode):
        os.link(name, destination, src_dir_fd=parent, dst_dir_fd=target, follow_symlinks=False)
        try:
            checkpoint('linked-file')
            os.unlink(name, dir_fd=parent)
        except BaseException:
            os.unlink(destination, dir_fd=target)
            raise
    else:
        raise ValueError('Only ordinary files and folders can be moved')

