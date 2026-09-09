import os
import tempfile
import unittest
from file_preview import preview

class PreviewTests(unittest.TestCase):
    def test_large_binary_reads_only_header(self):
        with tempfile.NamedTemporaryFile() as file:
            file.truncate(500 * 1024 * 1024)
            result = preview(file.fileno())
            self.assertEqual(result['kind'], 'binary')
            self.assertEqual(os.lseek(file.fileno(), 0, os.SEEK_CUR), 1024)

    def test_utf8_crossing_header_boundary_is_text(self):
        with tempfile.NamedTemporaryFile() as file:
            file.write(('a' * 1023 + 'λ').encode())
            file.flush()
            result = preview(file.fileno())
            self.assertEqual(result['kind'], 'text')
            self.assertEqual(len(result['hash']), 64)
