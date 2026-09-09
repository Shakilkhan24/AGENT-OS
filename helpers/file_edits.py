"""Optimistic content checks protect editor saves from ordinary external changes."""
import hashlib
import os
import stat
from file_scope import MAX_TEXT, beneath
from file_preview import preview

READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

def save(root, chunks, parent, name, content, expected, checkpoint=lambda: None):
    content = content.encode('utf-8')
    if len(content) > MAX_TEXT:
        raise ValueError('Text files are limited to 2 MiB')
    if not isinstance(expected, str) or len(expected) != 64:
        raise ValueError('A content hash from opening the file is required')
    current_fd = beneath(root, chunks, READ_FLAGS)
    try:
        current = preview(current_fd)
        mode = stat.S_IMODE(os.fstat(current_fd).st_mode) & 0o777
    finally:
        os.close(current_fd)
    if current.get('hash') != expected:
        return {'saved': False, 'current': current}
    temporary = f'.minimal-{os.urandom(12).hex()}'
    tmp = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
    try:
        with os.fdopen(tmp, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        checkpoint()
        # Reopen by path: the editor may have replaced the inode while we wrote the draft.
        current_fd = beneath(root, chunks, READ_FLAGS)
        try:
            current = preview(current_fd)
        finally:
            os.close(current_fd)
        if current.get('hash') != expected:
            return {'saved': False, 'current': current}
        # Linux rename has no content-CAS primitive. A non-cooperating writer can still
        # race this final check; document that small window instead of claiming a lock.
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
        return {'saved': True, 'hash': hashlib.sha256(content).hexdigest()}
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
