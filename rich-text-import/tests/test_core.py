from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from rich_text_import.core import RichTextImportError, build_package  # noqa: E402


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def completed_result() -> dict:
    return {
        "format": "pdf",
        "variant": "text",
        "status": "completed",
        "markdown": "<!-- source:pdf page=1 -->\n\n# 合成标题\n\n正文。\n",
        "metadata": {"page_count": 1},
        "quality": {"text_pages": 1, "total_pages": 1},
        "warnings": [],
        "anchors": [{"id": "pdf-page-1", "page": 1}],
        "assets": [],
        "extractor": "synthetic-pdf/1",
    }


class CorePackageTests(unittest.TestCase):
    def test_completed_package_preserves_source_and_builds_downstream_request(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "fixture.pdf"
            source.write_bytes(b"%PDF-1.7\nsynthetic")
            before = digest(source)
            output = root / "package"
            with (
                patch("rich_text_import.core.PROJECT_ROOT", root),
                patch("rich_text_import.core.extract_document", return_value=completed_result()),
            ):
                run = build_package(
                    source,
                    output,
                    user_instruction="保留术语。",
                    language="zh",
                    content_profile="natural_language",
                )

            self.assertEqual(before, digest(source))
            self.assertEqual(before, digest(output / "source" / "original.pdf"))
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            request = json.loads((output / "request.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "completed")
            self.assertTrue(manifest["downstream"]["eligible"])
            self.assertEqual(request["source_type"], "pdf")
            self.assertEqual(request["user_instruction"], "保留术语。")
            self.assertEqual(request["source_metadata"]["source_sha256"], before)
            self.assertEqual(Path(run["output_dir"]), output)

    def test_ocr_required_never_builds_downstream_request(self) -> None:
        result = completed_result()
        result.update({"status": "ocr_required", "markdown": "", "warnings": ["no_text_layer"]})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "scan.pdf"
            source.write_bytes(b"%PDF-1.7\nsynthetic")
            output = root / "package"
            with (
                patch("rich_text_import.core.PROJECT_ROOT", root),
                patch("rich_text_import.core.extract_document", return_value=result),
            ):
                build_package(source, output)
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "ocr_required")
            self.assertFalse(manifest["downstream"]["eligible"])
            self.assertFalse((output / "request.json").exists())

    def test_existing_output_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "fixture.pdf"
            source.write_bytes(b"%PDF-1.7\nsynthetic")
            output = root / "package"
            output.mkdir()
            marker = output / "keep.txt"
            marker.write_text("keep", encoding="utf-8")
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                with self.assertRaisesRegex(RichTextImportError, "output_already_exists"):
                    build_package(source, output)
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_output_outside_project_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            project.mkdir()
            source = root / "fixture.pdf"
            source.write_bytes(b"%PDF-1.7\nsynthetic")
            with patch("rich_text_import.core.PROJECT_ROOT", project):
                with self.assertRaisesRegex(RichTextImportError, "output_outside_project"):
                    build_package(source, root / "outside-package")


if __name__ == "__main__":
    unittest.main()
