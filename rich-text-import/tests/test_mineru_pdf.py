from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from rich_text_import.mineru_pdf import extract_mineru_pdf  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fixture(root: Path) -> tuple[Path, Path]:
    source = root / "fixture.pdf"
    pdf = canvas.Canvas(str(source), pagesize=A4)
    pdf.drawString(54, 780, "Fixture")
    pdf.showPage()
    pdf.drawString(54, 780, "Second page")
    pdf.save()

    run = root / "mineru-run"
    item = run / "fixture-data-id"
    images = item / "images"
    images.mkdir(parents=True)
    Image.new("RGB", (64, 32), "white").save(images / "figure.jpg")
    (item / "full.md").write_text("# Fixture\n", encoding="utf-8")
    (item / "layout.json").write_text("{}\n", encoding="utf-8")
    with zipfile.ZipFile(item / "mineru-result.zip", "w") as archive:
        archive.writestr("full.md", "# Fixture\n")
    content = [
        {"type": "text", "text": "Fixture", "text_level": 1, "bbox": [50, 50, 400, 100], "page_idx": 0},
        {"type": "text", "text": "public class Welcome", "text_level": 2, "bbox": [50, 105, 400, 140], "page_idx": 0},
        {"type": "text", "text": "Identifiers public class Welcome", "text_level": 2, "bbox": [50, 142, 400, 148], "page_idx": 0},
        {"type": "text", "text": "▶ First item", "bbox": [50, 150, 400, 200], "page_idx": 0},
        {"type": "text", "text": "System.out is the standard output object.", "bbox": [50, 202, 400, 218], "page_idx": 0},
        {"type": "text", "text": "A compiler (编译器) translates source programs into machine code.", "bbox": [50, 218, 400, 219], "page_idx": 0},
        {"type": "text", "text": "The method signature is public void println(String x)", "bbox": [50, 218, 400, 219], "page_idx": 0},
        {"type": "text", "text": "public class Welcome {\n    int x = 1;\n}", "bbox": [50, 220, 400, 350], "page_idx": 0},
        {"type": "image", "img_path": "images/figure.jpg", "bbox": [450, 150, 800, 350], "page_idx": 0},
        {"type": "code", "code_body": "```java\npublic class A {\n}\nThis class is an example\n```", "bbox": [50, 400, 500, 600], "page_idx": 0},
        {"type": "equation", "text": "$$\nx=1\n$$", "bbox": [50, 100, 300, 200], "page_idx": 1},
        {"type": "aside_text", "text": "1\n2\n3", "bbox": [10, 100, 30, 300], "page_idx": 1},
        {"type": "aside_text", "text": "Keep this note", "bbox": [400, 100, 700, 200], "page_idx": 1},
        {"type": "footer", "text": "footer", "bbox": [50, 950, 300, 980], "page_idx": 1},
    ]
    (item / "fixture_content_list.json").write_text(
        json.dumps(content), encoding="utf-8"
    )
    manifest = {
        "batch_id": "fixture-batch",
        "model_version": "vlm",
        "language": "ch",
        "enable_table": True,
        "enable_formula": True,
        "request_files": [
            {"name": source.name, "data_id": item.name, "is_ocr": True}
        ],
        "results": [
            {"data_id": item.name, "file_name": source.name, "state": "done"}
        ],
    }
    (run / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return source, item


class MineruPdfAdapterTests(unittest.TestCase):
    def test_academic_notes_references_and_chart_captions_are_source_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, item = _fixture(root)
            content_path = item / "fixture_content_list.json"
            content = json.loads(content_path.read_text(encoding="utf-8"))
            content.extend([
                {"type": "page_footnote", "text": "$^{9}$ Independent footnote source.", "page_idx": 0},
                {"type": "ref_text", "text": "Author. (2020). Independent bibliography entry.", "page_idx": 1},
                {"type": "text", "text": "The working class needs representation in public debate.", "page_idx": 1},
                {"type": "text", "text": "Public institutions include public servants who work with private businesses and middle class families.", "page_idx": 1},
                {"type": "chart", "img_path": "images/figure.jpg", "chart_caption": ["Independent chart caption."], "chart_footnote": ["Independent chart source note."], "page_idx": 1},
                {"type": "table", "table_body": "<table><tr><td>Cell</td></tr></table>", "table_caption": ["Independent table caption."], "table_footnote": ["Independent table note."], "page_idx": 1}
            ])
            content_path.write_text(json.dumps(content), encoding="utf-8")
            result = extract_mineru_pdf(source, root / "assets", item)
            for text in ["$^{9}$ Independent footnote source.", "Author. (2020). Independent bibliography entry.", "Independent chart caption.", "Independent chart source note.", "Independent table caption.", "Independent table note.", "<td>Cell</td>"]:
                self.assertIn(text, result["markdown"])
            self.assertEqual(result["quality"]["image_count"], 2)
            self.assertEqual(result["assets"][0]["occurrence_count"], 2)
            self.assertIn("The working class needs representation in public debate.", result["markdown"])
            self.assertNotIn("`class needs`", result["markdown"])
            self.assertIn("Public institutions include public servants who work with private businesses and middle class families.", result["markdown"])

    def test_valid_result_preserves_pages_code_lists_and_safe_images(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, item = _fixture(root)
            source_hash = _sha256(source)

            result = extract_mineru_pdf(source, root / "assets", item)

            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["variant"], "mineru_vlm")
            self.assertEqual(_sha256(source), source_hash)
            self.assertIn('<!-- pdf-page:1 -->', result["markdown"])
            self.assertIn('<!-- pdf-page:2 -->', result["markdown"])
            self.assertIn("- First item", result["markdown"])
            self.assertIn("## `public class Welcome`", result["markdown"])
            self.assertIn("## Identifiers `public class Welcome`", result["markdown"])
            self.assertIn("System.out is the standard output object.", result["markdown"])
            self.assertNotIn("```java\nSystem.out is the standard output object.", result["markdown"])
            self.assertNotIn("```text\nA compiler", result["markdown"])
            self.assertIn("The method signature is `public void println(String x)`", result["markdown"])
            self.assertIn("recovered-from=text", result["markdown"])
            self.assertEqual(result["markdown"].count("```java"), 2)
            self.assertIn("public class A {\n}\n```\n\nThis class is an example", result["markdown"])
            self.assertNotIn("footer", result["markdown"])
            self.assertNotIn("1\n2\n3", result["markdown"])
            self.assertIn("> **Aside:** Keep this note", result["markdown"])
            self.assertEqual(result["quality"]["code_block_count"], 2)
            self.assertEqual(result["quality"]["image_asset_count"], 1)
            self.assertTrue(result["assets"][0]["browser_safe"])
            self.assertTrue(Path(result["assets"][0]["path"]).is_file())

    def test_incomplete_result_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, item = _fixture(root)
            (item / "mineru-result.zip").unlink()

            with self.assertRaisesRegex(ValueError, "mineru_result_incomplete"):
                extract_mineru_pdf(source, root / "assets", item)


if __name__ == "__main__":
    unittest.main()
