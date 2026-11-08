import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from rich_text_import.book_routing import logical_chapter_count
from rich_text_import.core import RichTextImportError, build_package


class BookRoutingTests(unittest.TestCase):
    def test_logical_chapters_ignore_code_and_keep_language_independence(self):
        self.assertEqual(logical_chapter_count('# Chapter 1. A\n## Section\n# Chapter II. B'), 2)
        self.assertEqual(logical_chapter_count('# 第一章 甲\n## 第一节 乙\n# 第二章 丙'), 2)
        self.assertEqual(logical_chapter_count('```md\n# Chapter 1\n# Chapter 2\n```\n# Essay'), 0)

    def test_single_spine_book_is_routed_before_any_whole_book_request_is_published(self):
        with tempfile.TemporaryDirectory(dir='D:/Artifacts/BookSimplifier') as temporary:
            root = Path(temporary)
            source = root / 'independent.epub'
            with zipfile.ZipFile(source, 'w') as archive:
                archive.writestr('mimetype', 'application/epub+zip')
                archive.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
                archive.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>routing-independent</dc:identifier><dc:title>Field Studies</dc:title><dc:language>en</dc:language></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="body"/></spine></package>')
                archive.writestr('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="body.xhtml">Field Studies</a></li></ol></nav></body></html>')
                archive.writestr('body.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1. Recording</h1><h2>Observations</h2><p>Preserve every observation.</p><h1>Chapter 2. Analysis</h1><h2>Testing</h2><p>Check each prediction.</p></body></html>')
            with patch('rich_text_import.core.PROJECT_ROOT', root):
                with self.assertRaisesRegex(RichTextImportError, 'book_import_requires_book_workflow:logical_chapters=2'):
                    build_package(source, root / 'blocked')
                self.assertFalse((root / 'blocked').exists())
                run = build_package(source, root / 'intentional', allow_whole_book_request=True)
                self.assertEqual(run['manifest']['status'], 'completed')
                selected = build_package(source, root / 'selected', epub_spine_index=1)
                self.assertEqual(selected['manifest']['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
