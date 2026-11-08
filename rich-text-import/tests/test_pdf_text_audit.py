from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from rich_text_import.pdf_text_audit import build_text_audit, _native_quality, _simplify_many
from rich_text_import.core import build_package
from test_mineru_pdf import _fixture


def make_pdf(path: Path, pages: list[list[str]]) -> Path:
    document = canvas.Canvas(str(path), pagesize=A4)
    for lines in pages:
        for index, text in enumerate(lines):
            document.drawString(50, 780-index*25, text)
        document.showPage()
    document.save()
    return path


def content(pages: list[str]) -> list[dict]:
    return [{"type": "text", "text": text, "page_idx": index} for index, text in enumerate(pages) if text]


class PdfTextAuditTests(unittest.TestCase):
    def test_column_order_punctuation_and_line_hyphenation_are_not_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = make_pdf(Path(directory)/"columns.pdf", [["Alpha studies inter-", "national organizations in 2024.", "Beta studies local institutions."]])
            ocr = "Beta studies local institutions. Alpha studies international organizations in 2024!"
            audit = build_text_audit(pdf, content([ocr]), [ocr])
            self.assertEqual(audit["report"]["document_text_layer_vs_ocr"]["missing_tokens"], 0)
            self.assertEqual(audit["report"]["summary"]["adapter_missing_tokens"], 0)

    def test_number_and_name_differences_are_localized_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            text = "The survey by Alice Example counted 1500 residents in 2024."
            pdf = make_pdf(Path(directory)/"survey.pdf", [[text]])
            changed = text.replace("Alice", "Alicia").replace("1500", "15000")
            with patch("socket.create_connection", side_effect=AssertionError("audit attempted network")):
                audit = build_text_audit(pdf, content([changed]), [changed])
            page = audit["report"]["pages"][0]
            self.assertEqual(page["numeric_difference_candidates"], {"1500": 1})
            self.assertIn("alice", page["capitalized_word_difference_candidates"])
            self.assertEqual(audit["report"]["model_calls"], 0)
            self.assertEqual(audit["report"]["external_service_calls"], 0)

    def test_source_omission_and_adapter_omission_are_distinguished(self):
        with tempfile.TemporaryDirectory() as directory:
            first = "Independent evidence provides a detailed description of society and its institutions."
            second = "A separate passage discusses regional change, economic reform and competing political arguments."
            pdf = make_pdf(Path(directory)/"passages.pdf", [[first, second]])
            ocr_loss = build_text_audit(pdf, content([first]), [first])["report"]
            adapter_loss = build_text_audit(pdf, content([first+"\n"+second]), [first])["report"]
            self.assertEqual(ocr_loss["summary"]["review_pages"], [1])
            self.assertEqual(ocr_loss["summary"]["adapter_missing_tokens"], 0)
            self.assertGreater(adapter_loss["summary"]["adapter_missing_tokens"], 8)
            self.assertEqual(adapter_loss["document_text_layer_vs_ocr"]["missing_tokens"], 0)

    def test_cross_page_merged_paragraph_is_identified(self):
        with tempfile.TemporaryDirectory() as directory:
            first = "One independent passage examines governance and local political institutions in detail."
            second = "Another independent passage explains economic reform and social change through historical examples."
            pdf = make_pdf(Path(directory)/"merged.pdf", [[first], [second]])
            audit = build_text_audit(pdf, content([first+" "+second, ""]), [first+" "+second, ""])["report"]
            self.assertEqual(audit["document_text_layer_vs_ocr"]["missing_tokens"], 0)
            self.assertIn(2, audit["summary"]["boundary_shift_pages"])
            self.assertEqual(audit["summary"]["review_pages"], [])

    def test_graph_and_furniture_regions_are_excluded_but_notes_are_not(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = make_pdf(Path(directory)/"regions.pdf", [["Article body remains visible.", "Graph label 9000", "Footnote author Example 2024"]])
            # A4: first baseline y=780, second y=755, third y=730.
            items = [
                {"type": "text", "text": "Article body remains visible.", "page_idx": 0},
                {"type": "chart", "img_path": "images/chart.jpg", "bbox": [0, 87, 1000, 112], "page_idx": 0},
                {"type": "page_footnote", "text": "Footnote author Example 2024", "page_idx": 0},
            ]
            report = build_text_audit(pdf, items, ["Article body remains visible.\nFootnote author Example 2024"])["report"]
            self.assertEqual(report["document_text_layer_vs_ocr"]["missing_tokens"], 0)
            missing_note = build_text_audit(pdf, items[:-1], ["Article body remains visible."])["report"]
            self.assertIn("2024", missing_note["pages"][0]["numeric_difference_candidates"])

    def test_format_check_catches_new_plain_prose_code_and_accepts_code_signatures(self):
        with tempfile.TemporaryDirectory() as directory:
            text = "The working class needs access to public services. A method is public void run()."
            pdf = make_pdf(Path(directory)/"format.pdf", [[text]])
            markdown = text.replace("working class", "`working class`").replace("public void run()", "`public void run()`")
            report = build_text_audit(pdf, content([text]), [markdown])["report"]
            self.assertEqual(report["document_text_layer_vs_ocr"]["missing_tokens"], 0)
            self.assertEqual(report["summary"]["suspicious_inline_code"], 1)
            self.assertEqual(report["pages"][0]["suspicious_inline_code"][0]["span"], "working class")

    def test_empty_or_unreliable_text_layer_is_not_declared_an_ocr_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = make_pdf(Path(directory)/"scan.pdf", [[]])
            report = build_text_audit(pdf, content(["Recognized scanned content."]), ["Recognized scanned content."])["report"]
            self.assertEqual(report["summary"]["noncomparable_pages"], [1])
            self.assertEqual(report["summary"]["review_pages"], [])
            self.assertEqual(_native_quality("\ufffd"*30, None), "unreliable_encoding")
            self.assertEqual(_native_quality("(cid:1)(cid:2)(cid:3)", None), "unreliable_encoding")

    def test_mechanical_simplification_is_batched_and_source_neutral(self):
        self.assertEqual(_simplify_many(["國家與社會", "国家与社会", "English 2024"]), ["国家与社会", "国家与社会", "English 2024"])

    def test_repeated_rotated_watermark_is_excluded_by_geometry_not_its_words(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory)/"watermark.pdf"
            document = canvas.Canvas(str(pdf), pagesize=A4)
            for _ in range(4):
                document.drawString(50, 780, "Independent source body.")
                document.saveState()
                document.translate(200, 300)
                document.rotate(45)
                document.drawString(0, 0, "Arbitrary Repeated Decoration")
                document.restoreState()
                document.showPage()
            document.save()
            bodies = ["Independent source body."]*4
            report = build_text_audit(pdf, content(bodies), bodies)["report"]
            self.assertGreater(report["rotated_watermark_character_signatures"], 0)
            self.assertEqual(report["document_text_layer_vs_ocr"]["missing_tokens"], 0)

    def test_small_caps_font_sizes_do_not_split_source_words(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory)/"smallcaps.pdf"
            document = canvas.Canvas(str(pdf), pagesize=A4)
            line = document.beginText(50, 780)
            line.setFont("Times-Roman", 12)
            line.textOut("D")
            line.setFont("Times-Roman", 10)
            line.textOut("EMOCRATIC ")
            line.setFont("Times-Roman", 12)
            line.textOut("I")
            line.setFont("Times-Roman", 10)
            line.textOut("NSTITUTIONS")
            document.drawText(line)
            document.save()
            text = "Democratic institutions"
            report = build_text_audit(pdf, content([text]), [text])["report"]
            self.assertEqual(report["document_text_layer_vs_ocr"]["missing_tokens"], 0)

    def test_decimal_number_differences_are_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = make_pdf(Path(directory)/"decimal.pdf", [["Measured value is 123.45 units."]])
            text = "Measured value is 123.54 units."
            report = build_text_audit(pdf, content([text]), [text])["report"]
            self.assertEqual(report["pages"][0]["numeric_difference_candidates"], {"123.45": 1})

    def test_a_dropped_duplicate_passage_is_not_excused_as_relocation(self):
        with tempfile.TemporaryDirectory() as directory:
            text = "Repeated source passage contains several distinct historical examples and policy arguments."
            pdf = make_pdf(Path(directory)/"duplicate.pdf", [[text], [text]])
            report = build_text_audit(pdf, content([text, ""]), [text, ""])["report"]
            self.assertGreater(report["document_text_layer_vs_ocr"]["missing_tokens"], 8)
            self.assertIn(2, report["summary"]["review_pages"])

    def test_formal_import_records_audit_files_without_adding_model_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, result_dir = _fixture(root)
            package = root/"package"
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                build_package(source, package, language="en", content_profile="natural_language", mineru_result_dir=result_dir)
            manifest = json.loads((package/"manifest.json").read_text(encoding="utf-8"))
            request = json.loads((package/"request.json").read_text(encoding="utf-8"))
            source_record = json.loads((package/"source.json").read_text(encoding="utf-8"))
            report = json.loads((package/"pdf-source-audit/comparison.json").read_text(encoding="utf-8"))
            self.assertIn("local_audits", source_record)
            self.assertNotIn("local_audits", request["source_metadata"])
            self.assertEqual(report["model_calls"], 0)
            self.assertEqual(sum(file["path"].startswith("pdf-source-audit/") for file in manifest["files"]), 4)


if __name__ == "__main__":
    unittest.main()
