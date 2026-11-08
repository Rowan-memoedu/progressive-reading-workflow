"""Independent, stdlib-only validation for a literary EPUB Canary run."""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET


CHAPTER = re.compile(
    r"^(?:chapter|chap\.?|chapitre|cap[ií]tulo|capitolo|kapitel|глава)\s+"
    r"(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b"
    r"|^第[^\s]{1,16}[章回节](?:\s|$)",
    re.IGNORECASE,
)
CONTROL = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]"
)
RESIDUE = re.compile(
    r"<!--|</?(?:html|head|body|div|span|p|section|article)(?:\s|>)|^\s*:::+|\{(?:#|\.|[A-Za-z][\w-]*=)",
    re.IGNORECASE | re.MULTILINE,
)
SCAFFOLD = re.compile(
    r"^#{1,6}\s*(?:阅读前置卡|导读卡|核心观点|核心洞见|难度分级|摘要|summary)\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive_path(base: str, href: str) -> str:
    path = unquote(urlsplit(href).path)
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), path))


def element_text(node: ET.Element) -> str:
    parts = [node.text or ""]
    for child in node:
        if child.tag.split("}")[-1].lower() == "br":
            parts.append(" ")
        else:
            parts.append(element_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


def toc_entries(archive: zipfile.ZipFile, opf_path: str, opf: ET.Element) -> list[dict[str, str]]:
    manifest = {
        node.attrib["id"]: node.attrib
        for node in opf.findall(".//{*}manifest/{*}item")
        if node.attrib.get("id") and node.attrib.get("href")
    }
    nav_item = next(
        (item for item in manifest.values() if "nav" in item.get("properties", "").split()),
        None,
    )
    entries: list[dict[str, str]] = []
    if nav_item:
        nav_path = archive_path(opf_path, nav_item["href"])
        nav = ET.fromstring(archive.read(nav_path))
        toc_nav = next(
            (
                node
                for node in nav.findall(".//{*}nav")
                if "toc" in (node.attrib.get("{http://www.idpf.org/2007/ops}type", "").split())
                or node.attrib.get("role") == "doc-toc"
            ),
            None,
        )
        if toc_nav is not None:
            for anchor in toc_nav.findall(".//{*}a"):
                href = anchor.attrib.get("href", "")
                if not href:
                    continue
                entries.append(
                    {
                        "label": " ".join("".join(anchor.itertext()).split()),
                        "path": archive_path(nav_path, href),
                        "fragment": unquote(urlsplit(href).fragment),
                    }
                )
    if entries:
        return entries

    spine = opf.find(".//{*}spine")
    ncx_item = manifest.get(spine.attrib.get("toc", "")) if spine is not None else None
    if not ncx_item:
        ncx_item = next(
            (
                item
                for item in manifest.values()
                if item.get("media-type") == "application/x-dtbncx+xml"
            ),
            None,
        )
    if not ncx_item:
        return []
    ncx_path = archive_path(opf_path, ncx_item["href"])
    ncx = ET.fromstring(archive.read(ncx_path))
    for point in ncx.findall(".//{*}navPoint"):
        content = point.find("./{*}content")
        label = point.find("./{*}navLabel/{*}text")
        if content is None or not content.attrib.get("src"):
            continue
        href = content.attrib["src"]
        entries.append(
            {
                "label": " ".join("".join(label.itertext()).split()) if label is not None else "",
                "path": archive_path(ncx_path, href),
                "fragment": unquote(urlsplit(href).fragment),
            }
        )
    return entries


def source_plaintext(
    archive: zipfile.ZipFile,
    start_entry: dict[str, str],
    end_entry: dict[str, str] | None,
) -> str:
    root = ET.fromstring(archive.read(start_entry["path"]))
    ids = {
        node.attrib.get("id") or node.attrib.get("name"): node
        for node in root.iter()
        if node.attrib.get("id") or node.attrib.get("name")
    }
    start = ids.get(start_entry["fragment"])
    if start is None:
        raise ValueError(f"start fragment not found: {start_entry}")
    parents = {child: parent for parent in root.iter() for child in parent}
    parent = parents[start]
    children = list(parent)
    start_index = children.index(start)
    end_index = len(children)
    if end_entry and end_entry["path"] == start_entry["path"]:
        end = ids.get(end_entry["fragment"])
        if end is None or parents.get(end) is not parent:
            raise ValueError(f"end fragment is not a sibling boundary: {end_entry}")
        end_index = children.index(end)
    return " ".join(
        " ".join(element_text(node).split()) for node in children[start_index:end_index]
    )


def markdown_plaintext(markdown: str) -> str:
    value = re.sub(r'<a id="[^"]+"></a>', " ", markdown)
    value = re.sub(r"!\[([^]]*)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"^\s{0,3}(?:#{1,6}|>)\s*", "", value, flags=re.MULTILINE)
    value = re.sub(r"[*_`~]", "", value)
    return " ".join(value.split())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--publish", required=True)
    parser.add_argument("--chapters", required=True, type=int)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()

    source = Path(args.source).resolve()
    package = Path(args.package).resolve()
    publish = Path(args.publish).resolve()
    report_path = Path(args.report).resolve()
    source_meta = json.loads((package / "source.json").read_text(encoding="utf-8"))
    extraction = json.loads((package / "extraction-result.json").read_text(encoding="utf-8"))
    markdown = publish.read_text(encoding="utf-8")

    with zipfile.ZipFile(source) as archive:
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        opf_path = container.find(".//{*}rootfile").attrib["full-path"]
        opf = ET.fromstring(archive.read(opf_path))
        toc = toc_entries(archive, opf_path, opf)
        chapters = [entry for entry in toc if CHAPTER.search(entry["label"])]
        selected = chapters[: args.chapters]
        if len(chapters) <= args.chapters:
            raise ValueError("TOC has no boundary after the requested final chapter")
        first_toc_index = toc.index(selected[0])
        prefix = next(
            (
                entry
                for entry in reversed(toc[:first_toc_index])
                if entry["path"] == selected[0]["path"] and entry["fragment"]
            ),
            selected[0],
        )
        expected_plaintext = source_plaintext(archive, prefix, chapters[args.chapters])

    actual_plaintext = markdown_plaintext(markdown)
    headings = re.findall(r"^#{1,6}\s+(.+?)\s*$", markdown, flags=re.MULTILINE)
    chapter_headings = [heading for heading in headings if CHAPTER.search(heading)]
    source_copy = package / source_meta["source_copy"]
    expected_labels = [entry["label"] for entry in selected]
    evidence_labels = [
        item.get("label") for item in extraction.get("metadata", {}).get("literature_chapters", [])
    ]
    checks = {
        "source_hash_matches_record": sha256(source) == source_meta.get("source_sha256"),
        "source_copy_hash_matches": sha256(source) == sha256(source_copy),
        "published_bytes_match_raw": sha256(publish) == sha256(package / "raw.md"),
        "toc_first_n_matches_evidence": expected_labels == evidence_labels,
        "published_chapter_headings_exact": chapter_headings == expected_labels,
        "source_text_equals_published_text": expected_plaintext == actual_plaintext,
        "next_chapter_absent": chapters[args.chapters]["label"] not in markdown,
        "no_html_oxml_pandoc_residue": not RESIDUE.search(markdown),
        "no_invisible_controls": not CONTROL.search(markdown),
        "no_generated_front_matter": not SCAFFOLD.search(markdown),
        "no_temporary_chapter_anchors": "epub-chapter-" not in markdown,
        "no_standard_preprocess_request": not (package / "request.json").exists(),
        "flat_not_reading_md": publish.parent.name == "Epub" and publish.name.lower() != "reading.md",
    }
    report = {
        "schema_version": "progressive-reading.literature-epub-independent-validation/v1",
        "status": "READY" if all(checks.values()) else "FAILED",
        "checks": checks,
        "source_sha256": sha256(source),
        "source_copy_sha256": sha256(source_copy),
        "raw_sha256": sha256(package / "raw.md"),
        "published_sha256": sha256(publish),
        "source_plaintext_sha256": hashlib.sha256(expected_plaintext.encode("utf-8")).hexdigest(),
        "published_plaintext_sha256": hashlib.sha256(actual_plaintext.encode("utf-8")).hexdigest(),
        "source_plaintext_characters": len(expected_plaintext),
        "published_plaintext_characters": len(actual_plaintext),
        "toc_entries": selected,
        "context_prefix": prefix,
        "chapter_headings": chapter_headings,
        "source_path": str(source),
        "package_path": str(package),
        "publish_path": str(publish),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "READY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
