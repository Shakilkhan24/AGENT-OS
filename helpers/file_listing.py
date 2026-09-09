"""Short-lived descriptor cursors keep directory work bounded per request."""
import os
import stat
import time
import uuid
from file_scope import parts, walk

class Listings:
    def __init__(self):
        self.cursors = {}

    def close(self, token):
        cursor = self.cursors.pop(token, None)
        if cursor:
            cursor['iterator'].close()
            os.close(cursor['fd'])

    def unregister(self, session_id):
        for token, cursor in list(self.cursors.items()):
            if cursor['session'] == session_id:
                self.close(token)

    def page(self, root, session_id, relative, token=None, limit=200):
        now = time.monotonic()
        for key, cursor in list(self.cursors.items()):
            if cursor['expires'] < now:
                self.close(key)
        if not 1 <= limit <= 500:
            raise ValueError('Invalid directory page size')
        if token:
            cursor = self.cursors.get(token)
            if not cursor or cursor['session'] != session_id or cursor['path'] != relative:
                raise ValueError('Directory cursor expired; refresh the listing')
        else:
            if len(self.cursors) >= 16:
                self.close(next(iter(self.cursors)))
            fd = walk(root, parts(relative))
            token = str(uuid.uuid4())
            try:
                cursor = {'fd': fd, 'iterator': os.scandir(fd), 'session': session_id, 'path': relative, 'seen': 0, 'expires': now + 60}
                self.cursors[token] = cursor
            except BaseException:
                os.close(fd)
                raise
        cursor['expires'] = now + 60
        entries = []
        # Also bound vanished/blocked entries; a racing directory cannot monopolize a request.
        for _ in range(limit):
            try:
                entry = next(cursor['iterator'])
            except StopIteration:
                self.close(token)
                return {'entries': entries, 'truncated': False}
            cursor['seen'] += 1
            try:
                info = entry.stat(follow_symlinks=False)
                kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 else 'blocked'
                try:
                    entry.name.encode('utf-8')
                except UnicodeEncodeError:
                    kind = 'blocked'
                entries.append({'name': entry.name, 'kind': kind, 'size': info.st_size})
            except FileNotFoundError:
                pass
            if cursor['seen'] >= 20000:
                self.close(token)
                return {'entries': entries, 'truncated': True}
        return {'entries': entries, 'cursor': token, 'truncated': False}
