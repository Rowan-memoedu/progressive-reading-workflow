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
from rich_text_import.literature import (  # noqa: E402
    extract_literature_epub,
    publish_literature_package,
)
from test_epub import _write_epub  # noqa: E402


OPF = b"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:literature</dc:identifier>
    <dc:title>Literature Fixture</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="book"/></spine>
</package>
"""

BOOK = b"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><div>
  <p id="part-one" class="Heading-1">Part One</p>
  <p id="chapter-1" class="Heading-2">Chapter 1</p>
  <p>First <em>original</em> paragraph with a <a href="#fn1">note</a>.</p>
  <blockquote><p>Quoted source text.</p></blockquote>
  <aside epub:type="footnote" id="fn1"><p>Footnote source text.</p></aside>
  <p id="chapter-2" class="Heading-2">Chapter 2</p><p>Second <strong>original</strong> paragraph.</p>
  <p id="chapter-3" class="Heading-2">Chapter 3</p><p>Third original paragraph.</p>
  <p id="chapter-4" class="Heading-2">Chapter 4</p><p>Fourth original paragraph.</p>
  <p id="chapter-5" class="Heading-2">Chapter 5</p><p>Fifth body must stay out.</p>
</div></body></html>
"""

NCX = b"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="p" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="book.xhtml#part-one"/></navPoint>
  <navPoint id="c1" playOrder="2"><navLabel><text>Chapter 1</text></navLabel><content src="book.xhtml#chapter-1"/></navPoint>
  <navPoint id="c2" playOrder="3"><navLabel><text>Chapter 2</text></navLabel><content src="book.xhtml#chapter-2"/></navPoint>
  <navPoint id="c3" playOrder="4"><navLabel><text>Chapter 3</text></navLabel><content src="book.xhtml#chapter-3"/></navPoint>
  <navPoint id="c4" playOrder="5"><navLabel><text>Chapter 4</text></navLabel><content src="book.xhtml#chapter-4"/></navPoint>
  <navPoint id="c5" playOrder="6"><navLabel><text>Chapter 5</text></navLabel><content src="book.xhtml#chapter-5"/></navPoint>
</navMap></ncx>
"""


def make_literature_epub(path: Path) -> Path:
    _write_epub(
        path,
        [
            ("OEBPS/content.opf", OPF),
            ("OEBPS/book.xhtml", BOOK),
            ("OEBPS/toc.ncx", NCX),
        ],
    )
    return path


class LiteratureEpubTests(unittest.TestCase):
    def test_direct_publication_simplifies_chinese_and_preserves_raw_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "traditional.epub"
            _write_epub(source, [("OEBPS/content.opf", OPF), ("OEBPS/book.xhtml", BOOK.replace(b"Third original paragraph.", "獨立範例：繁體中文與社會。".encode("utf-8"))), ("OEBPS/toc.ncx", NCX)])
            package = root / "imports" / "traditional"
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                build_package(source, package, literature_chapter_count=4)
            raw_before = (package / "raw.md").read_bytes()
            report = publish_literature_package(package, root / "阅读区" / "Epub" / "traditional.md", 4, root)
            self.assertEqual(report["status"], "READY", report)
            self.assertEqual(raw_before, (package / "raw.md").read_bytes())
            self.assertIn("独立范例：繁体中文与社会。", (root / "阅读区" / "Epub" / "traditional.md").read_text(encoding="utf-8"))
            self.assertGreater(report["chinese_script"]["changed_characters"], 0)
            self.assertEqual(report["published_sha256"], report["publication_projection_sha256"])

    def test_selects_four_logical_chapters_inside_one_spine_item(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_literature_epub(root / "fixture.epub")
            result = extract_literature_epub(source, root / "assets", 4)

            self.assertEqual(result["status"], "completed", result["warnings"])
            self.assertEqual(result["quality"]["logical_chapters_extracted"], 4)
            self.assertEqual(result["quality"]["selected_spine_items"], 1)
            self.assertEqual(result["markdown"].count("## Chapter "), 4)
            self.assertIn("# Part One", result["markdown"])
            self.assertIn("*original*", result["markdown"])
            self.assertIn("**original**", result["markdown"])
            self.assertIn("> Quoted source text.", result["markdown"])
            self.assertIn("Footnote source text.", result["markdown"])
            self.assertIn("](#source-fn1)", result["markdown"])
            self.assertNotIn("Chapter 5", result["markdown"])
            self.assertNotIn("Fifth body", result["markdown"])
            self.assertNotIn("epub-chapter-", result["markdown"])
            self.assertEqual(
                [item["label"] for item in result["metadata"]["literature_chapters"]],
                ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"],
            )

    def test_literature_package_bypasses_semantic_preprocess_and_publishes_flat(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_literature_epub(root / "fixture.epub")
            package = root / "imports" / "fixture"
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                build_package(source, package, literature_chapter_count=4)

            manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
            self.assertFalse((package / "request.json").exists())
            self.assertFalse(manifest["downstream"]["eligible"])
            self.assertEqual(manifest["downstream"]["reason"], "literature_direct_publish_only")

            target = root / "阅读区" / "Epub" / "Literature Fixture - Part One Chapters 1-4.md"
            report = publish_literature_package(package, target, 4, root)
            self.assertEqual(report["status"], "READY", report)
            self.assertEqual(report["publication_status"], "published")
            self.assertTrue(target.is_file())
            self.assertNotEqual(target.name.lower(), "reading.md")
            self.assertEqual(report["published_sha256"], report["markdown_sha256"])


if __name__ == "__main__":
    unittest.main()
