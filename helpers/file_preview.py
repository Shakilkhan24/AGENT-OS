"""Header-first previews. Unrecognized large binaries require only 1 KiB of I/O."""
import base64
import codecs
import hashlib
import os
from file_scope import MAX_TEXT, read_bounded, regular

MAX_IMAGE = 10 * 1024 * 1024

def preview(fd):
    regular(fd, None)
    os.lseek(fd, 0, os.SEEK_SET)
    size = os.fstat(fd).st_size
    header = read_bounded(fd, 1024)
    mime = None
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif header.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    elif header.startswith((b'GIF87a', b'GIF89a')):
        mime = 'image/gif'
    elif header[:4] == b'RIFF' and header[8:12] == b'WEBP':
        mime = 'image/webp'
    if mime and size <= MAX_IMAGE:
        content = header + read_bounded(fd, MAX_IMAGE + 1 - len(header))
        if len(content) <= MAX_IMAGE:
            return {'kind': 'image', 'content': f'data:{mime};base64,' + base64.b64encode(content).decode('ascii'), 'size': len(content)}
    if not mime and size <= MAX_TEXT and b'\0' not in header:
        try:
            codecs.getincrementaldecoder('utf-8')().decode(header, final=False)
            os.lseek(fd, len(header), os.SEEK_SET)
            content = header + read_bounded(fd, MAX_TEXT + 1 - len(header))
            if len(content) <= MAX_TEXT and b'\0' not in content:
                return {'kind': 'text', 'content': content.decode('utf-8'), 'size': len(content), 'hash': hashlib.sha256(content).hexdigest()}
        except UnicodeDecodeError:
            pass
    lines = []
    for offset in range(0, len(header), 16):
        chunk = header[offset:offset + 16]
        printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        lines.append(f'{offset:08x}  {chunk.hex(" "):47}  {printable}')
    return {'kind': 'binary', 'content': '\n'.join(lines), 'size': size}
