from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from rich_text_import.core import build_package  # noqa: E402
from test_docx import make_docx  # noqa: E402
from test_epub import CONTAINER_XML, PNG_1X1, _write_epub  # noqa: E402
from test_pdf import make_text_pdf  # noqa: E402


EPUB_OPF = b"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:e2e</dc:identifier>
    <dc:title>E2E EPUB</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="image" href="pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="chapter"/></spine>
</package>
"""
EPUB_CHAPTER = b"""<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 id="start">E2E chapter</h1><figure><img src="pixel.png" alt="pixel"/><figcaption>E2E image</figcaption></figure>
</body></html>"""
EPUB_NAV = b"""<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a href="chapter.xhtml#start">Chapter</a></li></ol></nav>
</body></html>"""


class EndToEndPackageTests(unittest.TestCase):
    def test_docx_builds_a_completed_auditable_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_docx(root / "fixture.docx")
            output = root / "docx-package"
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                build_package(source, output, language="en")

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            request = json.loads((output / "request.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "completed")
            self.assertTrue(manifest["downstream"]["eligible"])
            self.assertEqual(request["source_type"], "docx")
            self.assertEqual(
                manifest["source"]["mime_type"],
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            self.assertEqual((output / "source" / "original.docx").read_bytes(), source.read_bytes())
            self.assertTrue(all("package_path" in item for item in manifest["assets"]))

    def test_text_pdf_builds_a_completed_auditable_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_text_pdf(root / "fixture.pdf")
            output = root / "pdf-package"
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                build_package(source, output, user_instruction="保留公式。", language="en")

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            request = json.loads((output / "request.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "completed")
            self.assertTrue(manifest["downstream"]["eligible"])
            self.assertEqual(request["source_type"], "pdf")
            self.assertEqual(request["user_instruction"], "保留公式。")
            self.assertEqual((output / "source" / "original.pdf").read_bytes(), source.read_bytes())
            self.assertTrue(all("output_path" not in item and "path" not in item for item in manifest["assets"]))

    def test_epub_builds_a_completed_auditable_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "fixture.epub"
            _write_epub(
                source,
                [
                    ("OEBPS/content.opf", EPUB_OPF),
                    ("OEBPS/chapter.xhtml", EPUB_CHAPTER),
                    ("OEBPS/nav.xhtml", EPUB_NAV),
                    ("OEBPS/pixel.png", PNG_1X1),
                ],
            )
            output = root / "epub-package"
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                build_package(source, output, language="en")

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            request = json.loads((output / "request.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "completed")
            self.assertTrue(manifest["downstream"]["eligible"])
            self.assertEqual(request["source_type"], "epub")
            self.assertEqual(manifest["source"]["mime_type"], "application/epub+zip")
            self.assertEqual((output / "source" / "original.epub").read_bytes(), source.read_bytes())
            self.assertTrue(all("package_path" in item for item in manifest["assets"]))


if __name__ == "__main__":
    unittest.main()
