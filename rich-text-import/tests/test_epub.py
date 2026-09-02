from __future__ import annotations

import base64
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from rich_text_import.epub import extract_epub  # noqa: E402


CONTAINER_XML = b"""<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _write_epub(path: Path, entries: list[tuple[str, bytes]]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", CONTAINER_XML)
        for name, payload in entries:
            archive.writestr(name, payload)


class ExtractEpubTests(unittest.TestCase):
    def test_explicit_spine_index_reads_original_position_only(self) -> None:
        opf = b"""<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
  <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
  <spine><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>"""
        nav = b"""<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="a.xhtml">A</a></li><li><a href="b.xhtml">B</a></li><li><a href="c.xhtml">C</a></li></ol></nav></body></html>"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "indexed.epub"
            _write_epub(epub_path, [("OEBPS/content.opf", opf), ("OEBPS/a.xhtml", b'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>BODY A</p></body></html>'), ("OEBPS/b.xhtml", b'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>BODY B</p></body></html>'), ("OEBPS/c.xhtml", b'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>BODY C</p></body></html>'), ("OEBPS/nav.xhtml", nav)])
            result = extract_epub(epub_path, root / "assets", spine_index=2)

            self.assertEqual(result["status"], "completed", result["warnings"])
            self.assertNotIn("BODY A", result["markdown"])
            self.assertIn("BODY B", result["markdown"])
            self.assertNotIn("BODY C", result["markdown"])
            self.assertIn('id="epub-chapter-0002"', result["markdown"])
            self.assertEqual(result["metadata"]["chapter_selection"], "spine_index")
            self.assertEqual(result["metadata"]["requested_spine_index"], 2)
            self.assertEqual([item["index"] for item in result["metadata"]["spine"] if item["selected"]], [2])

    def test_unresolved_selected_spine_item_fails_without_fallback(self) -> None:
        opf = b"""<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata><manifest><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="missing"/></spine></package>"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "missing-last.epub"
            _write_epub(epub_path, [("OEBPS/content.opf", opf), ("OEBPS/first.xhtml", b'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>MUST NOT FALL BACK</p></body></html>')])
            result = extract_epub(epub_path, root / "assets", chapter_selection="last")

            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["markdown"], "")
            self.assertNotIn("MUST NOT FALL BACK", result["markdown"])

    def test_missing_fragment_inside_selected_chapter_is_not_out_of_scope(self) -> None:
        opf = b"""<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c"/></spine></package>"""
        chapter = b'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="ok">Chapter</h1><p><a href="#missing">Broken local target</a></p></body></html>'
        nav = b'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c.xhtml#ok">Chapter</a></li></ol></nav></body></html>'
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "missing-fragment.epub"
            _write_epub(epub_path, [("OEBPS/content.opf", opf), ("OEBPS/c.xhtml", chapter), ("OEBPS/nav.xhtml", nav)])
            result = extract_epub(epub_path, root / "assets", spine_index=1)

            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["quality"]["internal_links_out_of_scope"], 0)
            self.assertTrue(any("unresolved internal link" in item for item in result["warnings"]))

    def test_last_chapter_selection_reads_only_final_spine_body(self) -> None:
        opf = b"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:last</dc:identifier>
    <dc:title>Last Chapter Fixture</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="first" href="first.xhtml" media-type="application/xhtml+xml"/>
    <item id="last" href="last.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="unused" href="unused.png" media-type="image/png"/>
    <item id="used" href="used.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="first"/><itemref idref="last"/></spine>
</package>"""
        first = b"""<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="first">DO NOT EXTRACT FIRST BODY</h1><img src="unused.png"/></body></html>"""
        last = b"""<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="last">Final chapter only</h1><p><a href="first.xhtml#first">Earlier chapter</a></p><figure><img src="used.png"/><figcaption>Selected image</figcaption></figure></body></html>"""
        nav = b"""<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="first.xhtml#first">First</a></li><li><a href="last.xhtml#last">Last</a></li></ol></nav></body></html>"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "last-only.epub"
            _write_epub(
                epub_path,
                [
                    ("OEBPS/content.opf", opf),
                    ("OEBPS/first.xhtml", first),
                    ("OEBPS/last.xhtml", last),
                    ("OEBPS/nav.xhtml", nav),
                    ("OEBPS/unused.png", PNG_1X1),
                    ("OEBPS/used.png", PNG_1X1),
                ],
            )
            result = extract_epub(
                epub_path,
                root / "assets",
                chapter_selection="last",
            )

            self.assertEqual(result["status"], "completed", result["warnings"])
            self.assertNotIn("DO NOT EXTRACT FIRST BODY", result["markdown"])
            self.assertIn("Final chapter only", result["markdown"])
            self.assertIn('id="epub-chapter-0002"', result["markdown"])
            self.assertNotIn('id="epub-chapter-0001"', result["markdown"])
            self.assertEqual(result["metadata"]["chapter_selection"], "last")
            self.assertEqual(result["quality"]["selected_spine_items"], 1)
            self.assertEqual(result["quality"]["chapters_extracted"], 1)
            self.assertEqual(result["quality"]["internal_links_out_of_scope"], 1)
            self.assertIn("[Earlier chapter](first.xhtml#first)", result["markdown"])
            self.assertEqual(len(result["assets"]), 1)
            self.assertEqual(result["assets"][0]["source_path"], "OEBPS/used.png")
            self.assertEqual([item["label"] for item in result["metadata"]["toc"]], ["Last"])

    def test_epub3_follows_spine_and_preserves_structure(self) -> None:
        opf = b"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:book</dc:identifier>
    <dc:title>Synthetic Book</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Codex Fixture</dc:creator>
  </metadata>
  <manifest>
    <item id="c2" href="chapter-z.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="chapter-a.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="pic" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>
"""
        chapter_two = b"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><section id="second-target"><h1>Second in spine</h1><p>Second body.</p></section></body>
</html>
"""
        chapter_one = b"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <section id="first"><h1>First in spine</h1>
      <p>Continue at <a href="chapter-z.xhtml#second-target">chapter two</a>.</p>
      <p>See <a href="#fn1">note one</a>.</p>
      <figure><img src="images/pixel.png" alt="one pixel"/><figcaption>Pixel caption</figcaption></figure>
      <aside epub:type="footnote" id="fn1"><p>Footnote text <a href="#first">back</a></p></aside>
    </section>
  </body>
</html>
"""
        nav = b"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter-a.xhtml#first">First</a></li>
    <li><a href="chapter-z.xhtml#second-target">Second</a></li>
  </ol></nav></body>
</html>
"""

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "fixture.epub"
            # ZIP order is deliberately chapter two before chapter one.
            _write_epub(
                epub_path,
                [
                    ("OEBPS/chapter-z.xhtml", chapter_two),
                    ("OEBPS/images/pixel.png", PNG_1X1),
                    ("OEBPS/content.opf", opf),
                    ("OEBPS/nav.xhtml", nav),
                    ("OEBPS/chapter-a.xhtml", chapter_one),
                ],
            )
            assets_dir = root / "output" / "assets"
            result = extract_epub(epub_path, assets_dir)

            self.assertEqual(result["status"], "completed", result["warnings"])
            self.assertEqual(result["format"], "epub")
            self.assertEqual(result["variant"], "epub3_or_epub2")
            self.assertLess(
                result["markdown"].index("First in spine"),
                result["markdown"].index("Second in spine"),
            )
            self.assertEqual(result["metadata"]["title"], "Synthetic Book")
            self.assertEqual(result["metadata"]["identifier"], "urn:test:book")
            self.assertEqual(result["metadata"]["creators"], ["Codex Fixture"])
            self.assertEqual(result["metadata"]["toc_kind"], "nav")
            self.assertEqual([e["label"] for e in result["metadata"]["toc"]], ["First", "Second"])
            self.assertIn('<a id="epub-chapter-0001"></a>', result["markdown"])
            self.assertIn('<a id="epub-chapter-0001--fn1"></a>', result["markdown"])
            self.assertIn("[chapter two](#epub-chapter-0002--second-target)", result["markdown"])
            self.assertIn("[note one](#epub-chapter-0001--fn1)", result["markdown"])
            self.assertIn("[back](#epub-chapter-0001--first)", result["markdown"])
            self.assertIn("**Footnote:**", result["markdown"])
            self.assertIn("Pixel caption", result["markdown"])
            self.assertEqual(len(result["assets"]), 1)
            self.assertTrue(Path(result["assets"][0]["output_path"]).is_file())
            self.assertIn(result["assets"][0]["markdown_path"], result["markdown"])
            self.assertEqual(result["quality"]["internal_links_total"], 3)
            self.assertEqual(result["quality"]["internal_links_resolved"], 3)

    def test_epub2_preserves_ncx_toc(self) -> None:
        opf = b"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:epub2</dc:identifier>
    <dc:title>EPUB Two</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter"/></spine>
</package>
"""
        chapter = b"""<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="start">EPUB2 chapter</h1></body></html>"""
        ncx = b"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel>
  <content src="text/chapter.xhtml#start"/></navPoint></navMap>
</ncx>
"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "epub2.epub"
            _write_epub(
                epub_path,
                [
                    ("OEBPS/content.opf", opf),
                    ("OEBPS/text/chapter.xhtml", chapter),
                    ("OEBPS/toc.ncx", ncx),
                ],
            )
            result = extract_epub(epub_path, root / "assets")

            self.assertEqual(result["status"], "completed", result["warnings"])
            self.assertEqual(result["metadata"]["package_version"], "2.0")
            self.assertEqual(result["metadata"]["toc_kind"], "ncx")
            self.assertEqual(result["metadata"]["toc"][0]["label"], "Chapter One")
            self.assertEqual(result["metadata"]["toc"][0]["play_order"], "1")
            self.assertEqual(result["quality"]["toc_entries"], 1)

    def test_missing_toc_is_partial_not_complete(self) -> None:
        opf = b"""<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
  <manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c"/></spine></package>"""
        chapter = b"""<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Readable</p></body></html>"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "partial.epub"
            _write_epub(
                epub_path,
                [("OEBPS/content.opf", opf), ("OEBPS/c.xhtml", chapter)],
            )
            result = extract_epub(epub_path, root / "assets")

            self.assertEqual(result["status"], "partial")
            self.assertIn("Readable", result["markdown"])
            self.assertTrue(any("no usable NAV or NCX" in w for w in result["warnings"]))

    def test_malformed_epub_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bad_path = root / "broken.epub"
            bad_path.write_bytes(b"not-a-zip")
            result = extract_epub(bad_path, root / "assets")

            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["markdown"], "")
            self.assertEqual(result["assets"], [])
            self.assertFalse((root / "assets").exists())

    def test_epub_without_spine_fails_closed(self) -> None:
        opf = b"""<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
  <manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest>
</package>"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "no-spine.epub"
            _write_epub(epub_path, [("OEBPS/content.opf", opf)])
            result = extract_epub(epub_path, root / "assets")

            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["markdown"], "")
            self.assertTrue(any("no spine" in w for w in result["warnings"]))

    def test_zip_without_epub_mimetype_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            epub_path = root / "not-epub.epub"
            with zipfile.ZipFile(epub_path, "w") as archive:
                archive.writestr("META-INF/container.xml", CONTAINER_XML)
            result = extract_epub(epub_path, root / "assets")

            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["markdown"], "")
            self.assertTrue(any("mimetype entry is missing" in w for w in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
