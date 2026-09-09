import os
from pathlib import Path
import tempfile
import unittest
from file_scope import DIR_FLAGS, move_without_replace

class MoveTests(unittest.TestCase):
    def test_hard_interruption_preserves_the_documented_partial_states(self):
        for kind in ('file', 'directory'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                source, target = Path(root) / 'source', Path(root) / 'target'
                if kind == 'file':
                    source.write_text('preserved')
                else:
                    source.mkdir()
                    (source / 'child').write_text('preserved')
                fd = os.open(root, DIR_FLAGS)
                try:
                    child = os.fork()
                    if child == 0:
                        move_without_replace(fd, 'source', fd, 'target', fallback=True, checkpoint=lambda stage: os._exit(92))
                        os._exit(0)
                    self.assertEqual(os.waitpid(child, 0)[1], 92 << 8)
                    self.assertTrue(source.exists())
                    self.assertTrue(target.exists())
                    if kind == 'file':
                        self.assertEqual(source.stat().st_ino, target.stat().st_ino)
                        self.assertEqual(source.read_text(), 'preserved')
                    else:
                        self.assertEqual(list(target.iterdir()), [])
                        self.assertEqual((source / 'child').read_text(), 'preserved')
                finally:
                    os.close(fd)
