from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.shared import Inches
from PIL import Image


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from rich_text_import.docx import extract_docx  # noqa: E402


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_docx(path: Path) -> Path:
    image_path = path.with_suffix(".png")
    Image.new("RGB", (16, 16), "white").save(image_path)
    document = Document()
    document.core_properties.title = "DOCX Synthetic Canary"
    document.core_properties.author = "Fixture"
    document.add_heading("Section One", level=1)
    document.add_paragraph("A clean paragraph with ordinary punctuation.")
    document.add_paragraph("First bullet", style="List Bullet")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Item"
    table.cell(0, 1).text = "Value"
    table.cell(1, 0).text = "alpha"
    table.cell(1, 1).text = "1"
    document.add_picture(str(image_path), width=Inches(0.2))
    document.save(path)
    return path


class DocxExtractionTests(unittest.TestCase):
    def test_docx_preserves_order_and_emits_clean_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_docx(root / "fixture.docx")
            before = digest(source)
            result = extract_docx(source, root / "assets")

            self.assertEqual(result["status"], "completed", result["warnings"])
            self.assertEqual(result["format"], "docx")
            self.assertEqual(digest(source), before)
            self.assertTrue(result["metadata"]["source_unchanged"])
            self.assertLess(result["markdown"].index("Section One"), result["markdown"].index("First bullet"))
            self.assertLess(result["markdown"].index("First bullet"), result["markdown"].index("| Item | Value |"))
            self.assertIn("- First bullet", result["markdown"])
            self.assertIn("![", result["markdown"])
            self.assertNotRegex(result["markdown"], r"<!--|<\/?w:|^:{3,}")
            self.assertEqual(result["quality"]["images_extracted"], 1)
            self.assertEqual(len(result["assets"]), 1)
            self.assertTrue(Path(result["assets"][0]["output_path"]).is_file())

    def test_invalid_docx_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "broken.docx"
            source.write_bytes(b"not a docx")
            result = extract_docx(source, root / "assets")
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["markdown"], "")


if __name__ == "__main__":
    unittest.main()
