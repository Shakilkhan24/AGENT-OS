"""Do not let long-lived tmux servers inherit Electron's private descriptors."""
import os
import sys
from fds import close_inherited
close_inherited()
os.execvp(sys.argv[1], sys.argv[1:])
