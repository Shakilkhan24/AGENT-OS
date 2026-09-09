"""Descriptor-relative session file service. No shell, no followed symlinks."""
import json
import uuid
import os
import stat
import sys
from fds import close_inherited

close_inherited()
from file_scope import DIR_FLAGS, MAX_TEXT, identity, parts, walk, beneath, regular, read_bounded, remove, move_without_replace
from file_preview import preview
from file_edits import save
from file_listing import Listings
ROOTS = {}
LISTINGS = Listings()

def handle(req):
    action = req['action']
    if req.get('apiVersion') != 2:
        raise ValueError('File API version mismatch')
    if action == 'register':
        directory = os.path.realpath(req['directory'])
        fd = os.open(directory, DIR_FLAGS)
        key = identity(fd)
        if req.get('identity') and req['identity'] != key:
            os.close(fd)
            raise ValueError('The session directory was replaced. Bind a new session to it.')
        LISTINGS.unregister(req['sessionId'])
        old = ROOTS.pop(req['sessionId'], None)
        if old is not None:
            os.close(old)
        ROOTS[req['sessionId']] = fd
        return {'directory': directory, 'identity': key}
    if action == 'unregister':
        LISTINGS.unregister(req['sessionId'])
        fd = ROOTS.pop(req['sessionId'], None)
        if fd is not None:
            os.close(fd)
        return None
    root = ROOTS[req['sessionId']]
    chunks = parts(req.get('path', ''))
    if action in ('list', 'list-page'):
        page = LISTINGS.page(root, req['sessionId'], req.get('path', ''), req.get('cursor'), req.get('limit', 200))
        if action == 'list-page':
            return page
        entries = page['entries']
        while page.get('cursor'):
            page = LISTINGS.page(root, req['sessionId'], req.get('path', ''), page['cursor'], 500)
            entries.extend(page['entries'])
        return sorted(entries, key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))
    if action == 'directory':
        fd = walk(root, chunks)
        try:
            return os.readlink(f'/proc/self/fd/{fd}')
        finally:
            os.close(fd)
    if not chunks:
        raise ValueError('The session root cannot be modified')
    parent = walk(root, chunks[:-1])
    name = chunks[-1]
    try:
        if action == 'write':
            return save(root, chunks, parent, name, req['content'], req.get('expectedHash'))
        if action in ('read', 'preview'):
            fd = beneath(root, chunks, os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | os.O_RDONLY)
            try:
                if action == 'preview':
                    return preview(fd)
                regular(fd)
                content = read_bounded(fd, MAX_TEXT + 1)
                if len(content) > MAX_TEXT or b'\x00' in content:
                    raise ValueError('This file is too large or is not a text file')
                return content.decode('utf-8')
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
        result = {'apiVersion': 2, 'id': req['id'], 'correlationId': req['correlationId'], 'ok': True, 'result': handle(req)}
    except Exception as error:
        result = {'apiVersion': 2, 'id': req.get('id'), 'correlationId': req.get('correlationId', str(uuid.uuid4())), 'ok': False, 'error': {'code': 'INVALID_REQUEST' if isinstance(error, ValueError) else 'IO_ERROR', 'message': str(error)[:4096], 'sourceId': 'file-worker', 'correlationId': req.get('correlationId', str(uuid.uuid4())), 'retryable': False, 'outcomeUnknown': req.get('action') in ('write', 'move', 'delete', 'create')}}
    print(json.dumps(result), flush=True)
