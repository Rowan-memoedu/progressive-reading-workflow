from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from rich_text_import.pdf import _looks_like_layout_table, extract_pdf  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_text_pdf(path: Path) -> Path:
    image_path = path.with_suffix(".png")
    image = Image.new("RGB", (180, 80), "white")
    drawing = ImageDraw.Draw(image)
    drawing.rectangle((4, 4, 175, 75), outline="black", width=2)
    drawing.text((18, 30), "Synthetic figure", fill="black")
    image.save(image_path)

    pdf = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    pdf.setTitle("Synthetic Text PDF Canary")
    pdf.bookmarkPage("chapter-1")
    pdf.addOutlineEntry("Chapter One", "chapter-1", level=0)
    pdf.setFont("Helvetica-Bold", 20)
    pdf.drawString(54, height - 64, "Synthetic Text PDF Canary")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(54, height - 92, "This paragraph is generated locally and contains no private material.")
    pdf.setFont("Courier", 10)
    pdf.drawString(54, height - 122, "def canary(): return 42")
    pdf.setFont("Helvetica", 12)
    pdf.drawString(54, height - 150, "E = mc^2")

    table = Table([["Item", "Value"], ["alpha", "1"], ["beta", "2"]], colWidths=[120, 90])
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.75, colors.black),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ]
        )
    )
    table.wrapOn(pdf, width, height)
    table.drawOn(pdf, 54, height - 260)
    pdf.drawImage(str(image_path), 330, height - 255, width=180, height=80)
    pdf.setFont("Helvetica", 9)
    pdf.drawString(330, height - 270, "Figure 1. A synthetic local fixture.")
    pdf.setFont("Helvetica", 7)
    pdf.drawString(54, 48, "1 Synthetic footnote for traceability.")
    pdf.showPage()

    pdf.bookmarkPage("chapter-2")
    pdf.addOutlineEntry("Chapter Two", "chapter-2", level=0)
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(54, height - 64, "Second Section")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(54, height - 92, "The second page verifies stable page anchors and reading order.")
    pdf.save()
    return path


def make_blank_pdf(path: Path) -> Path:
    pdf = canvas.Canvas(str(path), pagesize=A4)
    pdf.showPage()
    pdf.save()
    return path


def make_image_only_pdf(path: Path) -> Path:
    image_path = path.with_suffix(".png")
    image = Image.new("RGB", (800, 300), "white")
    drawing = ImageDraw.Draw(image)
    drawing.text((40, 120), "SCANNED IMAGE ONLY - OCR MUST NOT RUN", fill="black")
    image.save(image_path)
    pdf = canvas.Canvas(str(path), pagesize=A4)
    pdf.drawImage(str(image_path), 40, 500, width=515, height=193)
    pdf.showPage()
    pdf.save()
    return path


class PdfExtractionTests(unittest.TestCase):
    def test_page_layout_box_is_not_treated_as_a_data_table(self) -> None:
        lines = [
            {"top": top, "bottom": top + 10}
            for top in (80, 110, 140, 170, 200, 230, 260, 290)
        ]

        self.assertTrue(
            _looks_like_layout_table((40, 60, 555, 330), lines, page_height=700)
        )
        self.assertFalse(
            _looks_like_layout_table((40, 130, 300, 190), lines, page_height=700)
        )

    def test_text_pdf_preserves_source_and_extracts_traceable_structure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            source = make_text_pdf(tmp_path / "synthetic-text.pdf")
            source_hash_before = _sha256(source)

            result = extract_pdf(source, tmp_path / "assets")

            self.assertEqual(result["format"], "pdf")
            self.assertEqual(result["variant"], "text")
            self.assertEqual(result["status"], "completed")
            self.assertEqual(_sha256(source), source_hash_before)
            self.assertEqual(result["metadata"]["source_sha256"], source_hash_before)
            self.assertEqual(result["metadata"]["source_sha256_after"], source_hash_before)
            self.assertIs(result["metadata"]["source_unchanged"], True)
            self.assertIn('<a id="pdf-page-1"></a>', result["markdown"])
            self.assertIn('<a id="pdf-page-2"></a>', result["markdown"])
            self.assertIn("# Synthetic Text PDF Canary", result["markdown"])
            self.assertIn("This paragraph is generated locally", result["markdown"])
            self.assertIn("<!-- pdf-structure:table page=1 index=1 -->", result["markdown"])
            self.assertIn("<!-- pdf-structure:code page=1 -->", result["markdown"])
            self.assertIn("<!-- pdf-structure:formula page=1 -->", result["markdown"])
            self.assertIn("<!-- pdf-structure:caption page=1 -->", result["markdown"])
            self.assertIn("<!-- pdf-structure:footnote page=1 -->", result["markdown"])
            self.assertEqual(result["quality"]["page_count"], 2)
            self.assertEqual(result["quality"]["pages_with_text"], 2)
            self.assertEqual(result["quality"]["table_count"], 1)
            self.assertGreaterEqual(result["quality"]["structure_marker_count"], 3)
            self.assertEqual(
                result["anchors"],
                [
                    {"kind": "page", "page_number": 1, "id": "pdf-page-1"},
                    {"kind": "page", "page_number": 2, "id": "pdf-page-2"},
                ],
            )
            self.assertTrue(result["assets"])
            self.assertTrue(all(Path(asset["path"]).is_file() for asset in result["assets"]))

    def test_pdf_without_text_layer_fails_closed_without_ocr(self) -> None:
        for builder in (make_blank_pdf, make_image_only_pdf):
            with self.subTest(builder=builder.__name__), tempfile.TemporaryDirectory() as directory:
                tmp_path = Path(directory)
                source = builder(tmp_path / f"{builder.__name__}.pdf")
                source_hash_before = _sha256(source)

                result = extract_pdf(source, tmp_path / "assets")

                self.assertEqual(result["status"], "ocr_required")
                self.assertEqual(result["variant"], "text")
                self.assertEqual(result["quality"]["pages_with_text"], 0)
                self.assertIs(result["metadata"]["source_unchanged"], True)
                self.assertEqual(_sha256(source), source_hash_before)
                self.assertIn("no_text_layer_detected;ocr_not_run", result["warnings"][0])
                self.assertIn('<a id="pdf-page-1"></a>', result["markdown"])
                self.assertNotIn("SCANNED IMAGE ONLY", result["markdown"])

    def test_invalid_pdf_is_failed_not_partial_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            source = tmp_path / "not-a-pdf.pdf"
            source.write_bytes(b"not a pdf")

            result = extract_pdf(source, tmp_path / "assets")

            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["markdown"], "")
            self.assertEqual(result["warnings"], ["invalid_pdf_signature"])


if __name__ == "__main__":
    unittest.main()
