import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from file_edits import save
from file_scope import DIR_FLAGS

class EditTests(unittest.TestCase):
    def test_replacement_during_save_preserves_external_version(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'file'
            file.write_text('original')
            fd = os.open(root, DIR_FLAGS)
            try:
                result = save(fd, ['file'], fd, 'file', 'mine', hashlib.sha256(b'original').hexdigest(), lambda: file.write_text('external'))
                self.assertFalse(result['saved'])
                self.assertEqual(file.read_text(), 'external')
                self.assertEqual(list(Path(root).iterdir()), [file])
            finally:
                os.close(fd)
