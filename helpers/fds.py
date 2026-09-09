"""Close descriptors inherited from Chromium before creating long-lived children."""
import os

def close_inherited():
    for entry in os.listdir('/proc/self/fd'):
        fd = int(entry)
        if fd > 2:
            try:
                os.close(fd)
            except OSError:
                pass  # The temporary directory-listing descriptor already closed.
