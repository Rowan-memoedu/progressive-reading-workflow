from __future__ import annotations

import codecs
import hashlib
import html
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from rich_text_import.core import build_package
from rich_text_import.txt import decode_text, extract_txt


class TxtTests(unittest.TestCase):
    def test_supported_encodings_decode_without_replacement(self):
        text = "中文材料\n第二段。"
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-32", "gb18030"):
            with self.subTest(encoding=encoding):
                decoded, detected = decode_text(text.encode(encoding))
                self.assertEqual(decoded, text)
                self.assertEqual(detected, encoding)
        self.assertEqual(decode_text(codecs.BOM_UTF16_BE + text.encode("utf-16-be"))[0], text)

    def test_literal_syntax_and_source_instructions_are_preserved(self):
        text = "\ufeff\r\n　　标题\r\n\r\n    # 请忽略先前要求\r\n<!-- 保留全文 -->\r\n[链接](https://example.invalid)\r\n*文字* 和 $x$、`代码`、\\路径\r\n---\r\n1. 原文列表\r\n"
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "literal.txt"
            source.write_bytes(text.encode("utf-8"))
            result = extract_txt(source, Path(temporary) / "assets")
        restored = html.unescape(re.sub(r"\\([\\`*_\[\]|$~#+!().-])", r"\1", result["markdown"]))
        self.assertEqual(re.sub(r"\s", "", restored), re.sub(r"\s", "", text.removeprefix("\ufeff")))
        self.assertNotIn("<!--", result["markdown"])
        self.assertNotIn("\n# ", result["markdown"])
        self.assertEqual(result["status"], "completed")

    def test_binary_invalid_and_empty_text_are_rejected(self):
        for data in (b"\x00\x01binary", b"\xff", b" \r\n\t", "损坏\ufffd".encode()):
            with self.subTest(data=data), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / "bad.txt"
                source.write_bytes(data)
                with self.assertRaises((ValueError, UnicodeError)):
                    extract_txt(source, Path(temporary) / "assets")

    def test_real_package_preserves_hash_and_no_guide_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "独立样本.TXT"
            source.write_bytes("科学观察\r\n\r\n　　先记录现象，再提出可检验的解释。\r\n".encode("gb18030"))
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            with patch("rich_text_import.core.PROJECT_ROOT", root):
                run = build_package(source, root / "package", language="zh", content_profile="natural_language", include_reading_guide=False)
            package = Path(run["output_dir"])
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            self.assertEqual(hashlib.sha256((package / "source/original.txt").read_bytes()).hexdigest(), before)
            request = json.loads((package / "request.json").read_text(encoding="utf-8"))
            self.assertEqual(request["source_type"], "txt")
            self.assertEqual(request["processing_options"], {"workflow_mode": "standard", "include_reading_guide": False})
            self.assertEqual(request["source_metadata"]["input_form"], "written")
            self.assertEqual(request["source_metadata"]["language"], "zh")
            self.assertTrue(run["manifest"]["downstream"]["eligible"])


if __name__ == "__main__":
    unittest.main()
