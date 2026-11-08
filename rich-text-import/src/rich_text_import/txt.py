"""Deterministic plain-text intake; source text is data, never instructions."""

from __future__ import annotations

import codecs
import html
import re
from pathlib import Path
from typing import Any


def decode_text(data: bytes) -> tuple[str, str]:
    # Prefer explicit BOMs, including UTF-32 before its UTF-16 prefix.
    for marker, encoding in (
        (codecs.BOM_UTF32_LE, "utf-32"),
        (codecs.BOM_UTF32_BE, "utf-32"),
        (codecs.BOM_UTF16_LE, "utf-16"),
        (codecs.BOM_UTF16_BE, "utf-16"),
        (codecs.BOM_UTF8, "utf-8-sig"),
    ):
        if data.startswith(marker):
            return data.decode(encoding, errors="strict"), encoding
    try:
        return data.decode("utf-8", errors="strict"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("gb18030", errors="strict"), "gb18030"


def escape_text_line(line: str) -> str:
    # TXT syntax is literal. In particular, HTML comments and Markdown links
    # must not become hidden text or active source-layer instructions.
    line = html.escape(line, quote=False)
    line = re.sub(r"([\\`*_\[\]|$~])", r"\\\1", line)
    line = re.sub(r"^(#{1,6})(?=\s)", r"\\\1", line)
    line = re.sub(r"^([-+!])(?=\s|\[)", r"\\\1", line)
    line = re.sub(r"^(\d+)([.)])(?=\s)", r"\1\\\2", line)
    if re.fullmatch(r"-{3,}", line):
        line = "\\" + line
    return line


def extract_txt(source_path: Path, assets_dir: Path) -> dict[str, Any]:
    del assets_dir  # Plain text has no declared embedded resources.
    text, encoding = decode_text(source_path.read_bytes())
    if any(ord(char) < 32 and char not in "\t\r\n" for char in text):
        raise ValueError("txt_binary_or_control_character")
    if "\ufffd" in text:
        raise ValueError("txt_replacement_character")
    lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    nonempty = [line for line in lines if line]
    if not nonempty:
        raise ValueError("txt_empty_content")
    markdown = "\n".join(escape_text_line(line) for line in lines).strip() + "\n"
    # Whitespace normalization and Markdown escaping are the only transforms.
    restored = html.unescape(re.sub(r"\\([\\`*_\[\]|$~#+!().-])", r"\1", markdown))
    if re.sub(r"\s", "", restored) != re.sub(r"\s", "", text):
        raise ValueError("txt_content_coverage_mismatch")
    return {
        "format": "txt",
        "variant": "plain-text",
        "status": "completed",
        "extractor": "rich-text-import.txt/0.1.0",
        "markdown": markdown,
        "metadata": {
            "title": nonempty[0] if len(nonempty[0]) <= 120 else source_path.stem,
            "source_url": source_path.resolve().as_uri(),
            "source_is_original": True,
            "encoding": encoding,
        },
        "quality": {
            "nonempty_lines_total": len(nonempty),
            "nonempty_lines_extracted": len(nonempty),
            "content_coverage_complete": True,
            "clean_markdown": True,
        },
        "warnings": ["txt_encoding_fallback_gb18030"] if encoding == "gb18030" else [],
        "anchors": [],
        "assets": [],
    }
