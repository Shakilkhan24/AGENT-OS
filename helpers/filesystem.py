"""Descriptor-relative session file service. No shell, no followed symlinks."""
import ctypes
import base64
import errno
import json
import os
import stat
import sys
from fds import close_inherited

close_inherited()
MAX_TEXT = 2 * 1024 * 1024
ROOTS = {}
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

def remove(parent, name):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
        raise ValueError('Symbolic links are blocked')
    if stat.S_ISDIR(info.st_mode):
        fd = walk(parent, [name])
        try:
            for child in os.listdir(fd):
                remove(fd, child)
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)

def move_without_replace(parent, name, target, destination):
    if libc.renameat2(parent, os.fsencode(name), target, os.fsencode(destination), 1) == 0:
        return
    code = ctypes.get_errno()
    if code not in (errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP):
        raise OSError(code, os.strerror(code))
    # WSL's Windows filesystem does not implement RENAME_NOREPLACE. Reserve
    # the destination exclusively before moving. Never use check-then-rename.
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        os.mkdir(destination, dir_fd=target)
        try:
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
            os.unlink(name, dir_fd=parent)
        except BaseException:
            os.unlink(destination, dir_fd=target)
            raise
    else:
        raise ValueError('Only ordinary files and folders can be moved')

def handle(req):
    action = req['action']
    if action == 'register':
        directory = os.path.realpath(req['directory'])
        fd = os.open(directory, DIR_FLAGS)
        key = identity(fd)
        if req.get('identity') and req['identity'] != key:
            os.close(fd)
            raise ValueError('The session directory was replaced. Bind a new session to it.')
        old = ROOTS.pop(req['sessionId'], None)
        if old is not None:
            os.close(old)
        ROOTS[req['sessionId']] = fd
        return {'directory': directory, 'identity': key}
    if action == 'unregister':
        fd = ROOTS.pop(req['sessionId'], None)
        if fd is not None:
            os.close(fd)
        return None
    root = ROOTS[req['sessionId']]
    chunks = parts(req.get('path', ''))
    if action in ('list', 'directory'):
        fd = walk(root, chunks)
        try:
            if action == 'directory':
                return os.readlink(f'/proc/self/fd/{fd}')
            entries = []
            for name in os.listdir(fd):
                try:
                    s = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                kind = 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) and s.st_nlink == 1 else 'blocked'
                entries.append({'name': name, 'kind': kind, 'size': s.st_size})
                if len(entries) > 20000:
                    raise ValueError('This directory has more than 20,000 entries')
            return sorted(entries, key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))
        finally:
            os.close(fd)
    if not chunks:
        raise ValueError('The session root cannot be modified')
    parent = walk(root, chunks[:-1])
    name = chunks[-1]
    try:
        if action in ('read', 'write', 'preview'):
            flags = os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | (os.O_RDWR if action == 'write' else os.O_RDONLY)
            fd = beneath(root, chunks, flags)
            try:
                regular(fd, None if action == 'preview' else MAX_TEXT)
                if action == 'preview':
                    size = os.fstat(fd).st_size
                    content = read_bounded(fd, min(size + 1, 10 * 1024 * 1024 + 1))
                    mime = None
                    if content.startswith(b'\x89PNG\r\n\x1a\n'):
                        mime = 'image/png'
                    elif content.startswith(b'\xff\xd8\xff'):
                        mime = 'image/jpeg'
                    elif content.startswith((b'GIF87a', b'GIF89a')):
                        mime = 'image/gif'
                    elif content[:4] == b'RIFF' and content[8:12] == b'WEBP':
                        mime = 'image/webp'
                    if mime and len(content) <= 10 * 1024 * 1024:
                        return {'kind': 'image', 'content': f'data:{mime};base64,' + base64.b64encode(content).decode('ascii'), 'size': size}
                    if size <= MAX_TEXT and b'\x00' not in content:
                        try:
                            return {'kind': 'text', 'content': content.decode('utf-8'), 'size': size}
                        except UnicodeDecodeError:
                            pass
                    lines = []
                    for offset in range(0, min(len(content), 1024), 16):
                        chunk = content[offset:offset + 16]
                        printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
                        lines.append(f'{offset:08x}  {chunk.hex(" "):47}  {printable}')
                    return {'kind': 'binary', 'content': '\n'.join(lines), 'size': size}
                if action == 'read':
                    content = read_bounded(fd, MAX_TEXT + 1)
                    if len(content) > MAX_TEXT or b'\x00' in content:
                        raise ValueError('This file is too large or is not a text file')
                    return content.decode('utf-8')
                content = req['content'].encode('utf-8')
                if len(content) > MAX_TEXT:
                    raise ValueError('Text files are limited to 2 MiB')
                # Write a new inode and replace atomically: never mutate a linked external inode.
                temporary = f'.minimal-{os.urandom(12).hex()}'
                tmp = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(os.fstat(fd).st_mode) & 0o777, dir_fd=parent)
                try:
                    with os.fdopen(tmp, 'wb') as output:
                        output.write(content)
                        output.flush()
                        os.fsync(output.fileno())
                    os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                    os.fsync(parent)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=parent)
                    except FileNotFoundError:
                        pass
                return None
            finally:
                os.close(fd)
        if action == 'create':
            if req['kind'] == 'directory':
                os.mkdir(name, dir_fd=parent)
            else:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
                os.close(fd)
            return None
        if action == 'move':
            dest = parts(req['destination'])
            if not dest:
                raise ValueError('The session root cannot be replaced')
            if stat.S_ISLNK(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                raise ValueError('Symbolic links are blocked')
            target = walk(root, dest[:-1])
            try:
                # RENAME_NOREPLACE prevents races and accidental overwrite.
                move_without_replace(parent, name, target, dest[-1])
            finally:
                os.close(target)
            return None
        if action == 'delete':
            remove(parent, name)
            return None
        raise ValueError('Unsupported file operation')
    finally:
        os.close(parent)

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        result = {'id': req['id'], 'result': handle(req)}
    except Exception as error:
        result = {'id': req.get('id'), 'error': str(error)}
    print(json.dumps(result), flush=True)
