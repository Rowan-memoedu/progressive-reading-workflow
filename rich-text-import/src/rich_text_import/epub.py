"""Loss-aware EPUB extraction for the progressive-reading source layer.

The extractor deliberately has no OCR, network, or downstream preprocessing
behavior.  It reads an EPUB as a ZIP container, follows the OPF spine, exports
image assets, and returns a self-contained source result that callers can wrap
in the shared preprocessing request contract.
"""

from __future__ import annotations

import hashlib
import mimetypes
import posixpath
import re
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from lxml import etree


_CONTAINER_PATH = "META-INF/container.xml"
_EPUB_NS = "http://www.idpf.org/2007/ops"
EXTRACTOR_NAME = "rich-text-import.epub"
EXTRACTOR_VERSION = "0.1.0"
_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "figure",
    "figcaption",
    "footer",
    "header",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
}


def _failed(message: str, source_path: Path) -> dict[str, Any]:
    return {
        "format": "epub",
        "variant": "epub3_or_epub2",
        "status": "failed",
        "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
        "markdown": "",
        "metadata": {"source_filename": source_path.name},
        "quality": {
            "spine_items": 0,
            "chapters_extracted": 0,
            "chapters_failed": 0,
            "toc_kind": "none",
            "toc_entries": 0,
            "internal_links_total": 0,
            "internal_links_resolved": 0,
            "internal_links_out_of_scope": 0,
            "images_declared": 0,
            "images_extracted": 0,
            "structure_preserved": False,
        },
        "warnings": [message],
        "anchors": [],
        "assets": [],
    }


def _local_name(node: etree._Element) -> str:
    try:
        return etree.QName(node).localname.lower()
    except (TypeError, ValueError):
        return ""


def _safe_archive_path(path: str) -> str:
    decoded = unquote(path).replace("\\", "/")
    normalized = posixpath.normpath(decoded)
    if (
        not decoded
        or decoded.startswith("/")
        or normalized in {"", ".", ".."}
        or normalized.startswith("../")
        or re.match(r"^[A-Za-z]:", normalized)
    ):
        raise ValueError(f"unsafe EPUB archive path: {path!r}")
    return normalized


def _resolve_archive_path(base_file: str, href: str) -> str:
    parts = urlsplit(href)
    if parts.scheme or parts.netloc:
        raise ValueError(f"external URI is not an archive path: {href!r}")
    href_path = unquote(parts.path)
    if not href_path:
        return _safe_archive_path(base_file)
    joined = posixpath.join(posixpath.dirname(base_file), href_path)
    return _safe_archive_path(joined)


def _parse_xml(data: bytes, label: str) -> etree._Element:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    try:
        return etree.fromstring(data, parser=parser)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"malformed XML in {label}: {exc}") from exc


def _first_text(root: etree._Element, local_name: str) -> str | None:
    nodes = root.xpath(f"//*[local-name()='{local_name}']")
    for node in nodes:
        text = " ".join("".join(node.itertext()).split())
        if text:
            return text
    return None


def _all_text(root: etree._Element, local_name: str) -> list[str]:
    values: list[str] = []
    for node in root.xpath(f"//*[local-name()='{local_name}']"):
        text = " ".join("".join(node.itertext()).split())
        if text:
            values.append(text)
    return values


def _element_text(node: etree._Element) -> str:
    return " ".join("".join(node.itertext()).split())


def _clean_fragment(value: str) -> str:
    value = unquote(value).strip()
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "-", value).strip("-")
    return cleaned or hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _attribute(node: etree._Element, local_name: str) -> str | None:
    if local_name in node.attrib:
        return node.attrib[local_name]
    for key, value in node.attrib.items():
        try:
            if etree.QName(key).localname == local_name:
                return value
        except ValueError:
            continue
    return None


def _extract_nav_toc(
    root: etree._Element, nav_path: str, chapter_anchor_by_path: dict[str, str]
) -> list[dict[str, Any]]:
    nav_nodes = root.xpath("//*[local-name()='nav']")
    toc_nav: etree._Element | None = None
    for node in nav_nodes:
        epub_type = node.get(f"{{{_EPUB_NS}}}type") or _attribute(node, "type") or ""
        role = node.get("role", "")
        if "toc" in epub_type.split() or role == "doc-toc":
            toc_nav = node
            break
    if toc_nav is None:
        return []

    entries: list[dict[str, Any]] = []
    for anchor in toc_nav.xpath(".//*[local-name()='a'][@href]"):
        href = anchor.get("href", "")
        depth = len(anchor.xpath("ancestor::*[local-name()='ol']"))
        entry: dict[str, Any] = {
            "label": _element_text(anchor),
            "href": href,
            "depth": max(depth, 1),
        }
        try:
            target_path = _resolve_archive_path(nav_path, href)
            entry["source_path"] = target_path
            if target_path in chapter_anchor_by_path:
                entry["chapter_anchor"] = chapter_anchor_by_path[target_path]
        except ValueError:
            pass
        entries.append(entry)
    return entries


def _extract_ncx_toc(
    root: etree._Element, ncx_path: str, chapter_anchor_by_path: dict[str, str]
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for point in root.xpath("//*[local-name()='navPoint']"):
        labels = point.xpath("./*[local-name()='navLabel']/*[local-name()='text']")
        content = point.xpath("./*[local-name()='content']/@src")
        if not content:
            continue
        href = str(content[0])
        entry: dict[str, Any] = {
            "label": _element_text(labels[0]) if labels else "",
            "href": href,
            "depth": len(point.xpath("ancestor::*[local-name()='navPoint']")) + 1,
        }
        if point.get("playOrder"):
            entry["play_order"] = point.get("playOrder")
        try:
            target_path = _resolve_archive_path(ncx_path, href)
            entry["source_path"] = target_path
            if target_path in chapter_anchor_by_path:
                entry["chapter_anchor"] = chapter_anchor_by_path[target_path]
        except ValueError:
            pass
        entries.append(entry)
    return entries


class _MarkdownRenderer:
    def __init__(
        self,
        chapter_path: str,
        chapter_anchor_by_path: dict[str, str],
        known_spine_paths: set[str],
        element_anchor_by_key: dict[tuple[str, str], str],
        asset_by_path: dict[str, dict[str, Any]],
        warnings: list[str],
    ) -> None:
        self.chapter_path = chapter_path
        self.chapter_anchor_by_path = chapter_anchor_by_path
        self.known_spine_paths = known_spine_paths
        self.element_anchor_by_key = element_anchor_by_key
        self.asset_by_path = asset_by_path
        self.warnings = warnings
        self.internal_links_total = 0
        self.internal_links_resolved = 0
        self.internal_links_out_of_scope = 0

    def _anchor_markup(self, node: etree._Element) -> str:
        source_id = node.get("id") or node.get("name")
        if not source_id:
            return ""
        anchor = self.element_anchor_by_key.get((self.chapter_path, source_id))
        return f'<a id="{anchor}"></a>\n' if anchor else ""

    def _rewrite_link(self, href: str) -> str:
        parts = urlsplit(href)
        if parts.scheme or parts.netloc or href.startswith("//"):
            return href
        self.internal_links_total += 1
        try:
            target_path = _resolve_archive_path(self.chapter_path, href)
        except ValueError:
            self.warnings.append(
                f"unsafe internal link in {self.chapter_path}: {href!r}"
            )
            return href

        fragment = unquote(parts.fragment)
        if fragment:
            target = self.element_anchor_by_key.get((target_path, fragment))
            if target:
                self.internal_links_resolved += 1
                return f"#{target}"
        elif target_path in self.chapter_anchor_by_path:
            self.internal_links_resolved += 1
            return f"#{self.chapter_anchor_by_path[target_path]}"

        if (
            target_path in self.known_spine_paths
            and target_path not in self.chapter_anchor_by_path
        ):
            self.internal_links_out_of_scope += 1
            return href

        self.warnings.append(
            f"unresolved internal link in {self.chapter_path}: {href!r}"
        )
        return href

    def _inline(self, node: etree._Element) -> str:
        tag = _local_name(node)
        prefix = node.text or ""
        children = "".join(self._render_inline_child(child) for child in node)
        content = prefix + children
        if tag == "a":
            href = node.get("href")
            if not href:
                return content
            label = " ".join(content.split()) or href
            return f"[{label}]({self._rewrite_link(href)})"
        if tag in {"strong", "b"}:
            return f"**{content.strip()}**"
        if tag in {"em", "i"}:
            return f"*{content.strip()}*"
        if tag == "code":
            return f"`{content.strip()}`"
        if tag == "br":
            return "  \n" + content
        if tag == "img":
            return self._image_markdown(node)
        return content

    def _render_inline_child(self, child: etree._Element) -> str:
        rendered = self._inline(child)
        return rendered + (child.tail or "")

    def _image_markdown(self, node: etree._Element) -> str:
        src = node.get("src", "")
        alt = " ".join(node.get("alt", "").split())
        try:
            image_path = _resolve_archive_path(self.chapter_path, src)
        except ValueError:
            self.warnings.append(f"unsafe image reference in {self.chapter_path}: {src!r}")
            return f"![{alt}]({src})"
        asset = self.asset_by_path.get(image_path)
        if asset:
            return f"![{alt}]({asset['markdown_path']})"
        self.warnings.append(f"missing image asset in {self.chapter_path}: {src!r}")
        return f"![{alt}]({src})"

    def _list_item(self, node: etree._Element, ordered: bool, index: int) -> str:
        text_parts: list[str] = []
        nested_parts: list[str] = []
        if node.text:
            text_parts.append(node.text)
        for child in node:
            if _local_name(child) in {"ol", "ul"}:
                nested_parts.append(self._block(child).strip())
            else:
                text_parts.append(self._inline(child))
            if child.tail:
                text_parts.append(child.tail)
        text = " ".join("".join(text_parts).split())
        marker = f"{index}." if ordered else "-"
        rendered = f"{marker} {text}"
        if nested_parts:
            nested = "\n".join(nested_parts).replace("\n", "\n  ")
            rendered += f"\n  {nested}"
        return rendered

    def _block(self, node: etree._Element) -> str:
        tag = _local_name(node)
        anchor = self._anchor_markup(node)
        if tag in {f"h{level}" for level in range(1, 7)}:
            level = int(tag[1])
            return f"{anchor}{'#' * level} {_element_text(node)}\n\n"
        if tag == "p":
            body = self._inline(node).strip()
            return f"{anchor}{body}\n\n" if body or anchor else ""
        if tag == "figure":
            parts = [anchor]
            for child in node:
                child_tag = _local_name(child)
                if child_tag == "img":
                    parts.append(self._image_markdown(child) + "\n")
                elif child_tag == "figcaption":
                    parts.append(f"*{_element_text(child)}*\n")
                else:
                    parts.append(self._block(child))
            return "".join(parts).rstrip() + "\n\n"
        if tag == "img":
            return f"{anchor}{self._image_markdown(node)}\n\n"
        if tag in {"ul", "ol"}:
            lines = [anchor.rstrip()] if anchor else []
            items = [child for child in node if _local_name(child) == "li"]
            lines.extend(
                self._list_item(item, tag == "ol", index)
                for index, item in enumerate(items, start=1)
            )
            return "\n".join(lines).strip() + "\n\n"
        if tag == "blockquote":
            text = _element_text(node)
            quoted = "\n".join(f"> {line}" for line in text.splitlines())
            return f"{anchor}{quoted}\n\n"
        if tag == "pre":
            return f"{anchor}```\n{''.join(node.itertext()).rstrip()}\n```\n\n"
        if tag == "aside":
            epub_type = node.get(f"{{{_EPUB_NS}}}type") or _attribute(node, "type") or ""
            label = "Footnote" if "footnote" in epub_type.split() else "Aside"
            body = self._inline(node).strip()
            return f"{anchor}> **{label}:** {body}\n\n"
        if tag == "figcaption":
            return f"{anchor}*{_element_text(node)}*\n\n"

        parts = [anchor]
        if node.text and node.text.strip():
            parts.append(node.text.strip() + "\n\n")
        for child in node:
            child_tag = _local_name(child)
            if child_tag in _BLOCK_TAGS or child_tag.startswith("h"):
                parts.append(self._block(child))
            else:
                inline = self._inline(child).strip()
                if inline:
                    parts.append(inline + "\n\n")
            if child.tail and child.tail.strip():
                parts.append(child.tail.strip() + "\n\n")
        return "".join(parts)

    def render(self, root: etree._Element) -> str:
        bodies = root.xpath("//*[local-name()='body']")
        body = bodies[0] if bodies else root
        return self._block(body).strip()


def extract_epub(
    source_path: Path,
    assets_dir: Path,
    chapter_selection: str = "all",
    spine_index: int | None = None,
) -> dict[str, Any]:
    """Extract an EPUB into Markdown plus traceable structural metadata.

    Malformed containers and EPUBs without a usable OPF/spine fail closed.
    Recoverable omissions (for example a missing TOC or one broken chapter)
    produce ``partial`` with explicit warnings.
    """

    source_path = Path(source_path)
    assets_dir = Path(assets_dir)
    warnings: list[str] = []
    anchors: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []

    try:
        if chapter_selection not in {"all", "last"}:
            return _failed(
                f"unsupported EPUB chapter selection: {chapter_selection!r}",
                source_path,
            )
        if spine_index is not None and spine_index < 1:
            return _failed("EPUB spine index must be positive", source_path)
        if spine_index is not None and chapter_selection != "all":
            return _failed("EPUB chapter selection is ambiguous", source_path)
        if not source_path.is_file():
            return _failed(f"EPUB source does not exist: {source_path}", source_path)
        if not zipfile.is_zipfile(source_path):
            return _failed("source is not a valid ZIP-based EPUB", source_path)

        with zipfile.ZipFile(source_path, "r") as archive:
            names = set(archive.namelist())
            if "mimetype" not in names:
                return _failed("EPUB mimetype entry is missing", source_path)
            if archive.read("mimetype").strip() != b"application/epub+zip":
                return _failed("EPUB mimetype entry is invalid", source_path)
            if _CONTAINER_PATH not in names:
                return _failed("EPUB container.xml is missing", source_path)

            container = _parse_xml(archive.read(_CONTAINER_PATH), _CONTAINER_PATH)
            rootfiles = container.xpath("//*[local-name()='rootfile']/@full-path")
            if not rootfiles:
                return _failed("EPUB container.xml has no rootfile", source_path)
            opf_path = _safe_archive_path(str(rootfiles[0]))
            if opf_path not in names:
                return _failed(f"EPUB OPF is missing: {opf_path}", source_path)
            opf = _parse_xml(archive.read(opf_path), opf_path)

            package_version = opf.get("version") or "unknown"
            metadata: dict[str, Any] = {
                "source_filename": source_path.name,
                "package_version": package_version,
                "opf_path": opf_path,
                "title": _first_text(opf, "title"),
                "creators": _all_text(opf, "creator"),
                "language": _first_text(opf, "language"),
                "identifier": _first_text(opf, "identifier"),
            }
            for required in ("title", "language", "identifier"):
                if not metadata[required]:
                    warnings.append(f"EPUB metadata is missing {required}")

            manifest: dict[str, dict[str, str]] = {}
            for item in opf.xpath("//*[local-name()='manifest']/*[local-name()='item']"):
                item_id = item.get("id")
                href = item.get("href")
                if not item_id or not href:
                    warnings.append("EPUB manifest contains an item without id or href")
                    continue
                try:
                    archive_path = _resolve_archive_path(opf_path, href)
                except ValueError as exc:
                    warnings.append(str(exc))
                    continue
                manifest[item_id] = {
                    "id": item_id,
                    "href": href,
                    "archive_path": archive_path,
                    "media_type": item.get("media-type", ""),
                    "properties": item.get("properties", ""),
                }

            spine_nodes = opf.xpath("//*[local-name()='spine']")
            if not spine_nodes:
                return _failed("EPUB OPF has no spine", source_path)
            spine = spine_nodes[0]
            spine_entries: list[dict[str, Any]] = []
            for index, itemref in enumerate(
                spine.xpath("./*[local-name()='itemref']"), start=1
            ):
                idref = itemref.get("idref")
                item = manifest.get(idref) if idref else None
                spine_entries.append(
                    {"index": index, "idref": idref, "item": item}
                )
                if item is None:
                    warnings.append(f"EPUB spine has unresolved idref: {idref!r}")
            if not spine_entries:
                return _failed("EPUB spine has no content items", source_path)
            resolved_spine_entries = [
                entry for entry in spine_entries if entry["item"] is not None
            ]
            if not resolved_spine_entries:
                return _failed("EPUB spine has no resolvable content items", source_path)

            selection_mode = "spine_index" if spine_index is not None else chapter_selection
            if spine_index is not None:
                if spine_index > len(spine_entries):
                    return _failed(
                        f"EPUB spine index is out of range: {spine_index}",
                        source_path,
                    )
                selected_entries = [spine_entries[spine_index - 1]]
            elif chapter_selection == "last":
                selected_entries = [spine_entries[-1]]
            else:
                selected_entries = resolved_spine_entries

            unresolved_selected = [
                entry for entry in selected_entries if entry["item"] is None
            ]
            if unresolved_selected:
                entry = unresolved_selected[0]
                return _failed(
                    "selected EPUB spine item is unresolved: "
                    f"index={entry['index']},idref={entry['idref']!r}",
                    source_path,
                )
            selected_spine_items = [
                (entry["index"], entry["item"]) for entry in selected_entries
            ]
            spine_items = [entry["item"] for entry in resolved_spine_entries]
            selected_paths = {
                item["archive_path"] for _, item in selected_spine_items
            }
            chapter_anchor_by_path = {
                item["archive_path"]: f"epub-chapter-{index:04d}"
                for index, item in selected_spine_items
            }

            parsed_chapters: list[tuple[int, dict[str, str], etree._Element]] = []
            chapter_failures = 0
            for index, item in selected_spine_items:
                chapter_path = item["archive_path"]
                if chapter_path not in names:
                    warnings.append(f"spine content is missing: {chapter_path}")
                    chapter_failures += 1
                    continue
                try:
                    root = _parse_xml(archive.read(chapter_path), chapter_path)
                except ValueError as exc:
                    warnings.append(str(exc))
                    chapter_failures += 1
                    continue
                parsed_chapters.append((index, item, root))
                chapter_anchor = chapter_anchor_by_path[chapter_path]
                anchors.append(
                    {
                        "kind": "chapter",
                        "id": chapter_anchor,
                        "spine_index": index,
                        "source_href": item["href"],
                        "source_path": chapter_path,
                    }
                )

            if not parsed_chapters:
                return _failed("no spine chapter could be parsed", source_path)

            element_anchor_by_key: dict[tuple[str, str], str] = {}
            for index, item, root in parsed_chapters:
                chapter_path = item["archive_path"]
                chapter_anchor = chapter_anchor_by_path[chapter_path]
                for node in root.xpath("//*[@id or @name]"):
                    source_id = node.get("id") or node.get("name")
                    if not source_id:
                        continue
                    generated = f"{chapter_anchor}--{_clean_fragment(source_id)}"
                    key = (chapter_path, source_id)
                    if key in element_anchor_by_key:
                        warnings.append(
                            f"duplicate element anchor in {chapter_path}: {source_id!r}"
                        )
                        continue
                    element_anchor_by_key[key] = generated
                    anchors.append(
                        {
                            "kind": "element",
                            "id": generated,
                            "chapter_anchor": chapter_anchor,
                            "source_id": source_id,
                            "source_path": chapter_path,
                            "spine_index": index,
                        }
                    )

            all_image_items = [
                item
                for item in manifest.values()
                if item["media_type"].startswith("image/")
            ]
            referenced_image_paths: set[str] = set()
            for _, chapter_item, root in parsed_chapters:
                for node in root.xpath("//*[local-name()='img'][@src]"):
                    try:
                        referenced_image_paths.add(
                            _resolve_archive_path(
                                chapter_item["archive_path"], node.get("src", "")
                            )
                        )
                    except ValueError as exc:
                        warnings.append(str(exc))
            image_items = (
                all_image_items
                if selection_mode == "all"
                else [
                    item
                    for item in all_image_items
                    if item["archive_path"] in referenced_image_paths
                ]
            )
            asset_by_path: dict[str, dict[str, Any]] = {}
            for item in image_items:
                archive_path = item["archive_path"]
                if archive_path not in names:
                    warnings.append(f"manifest image is missing: {archive_path}")
                    continue
                data = archive.read(archive_path)
                digest = hashlib.sha256(data).hexdigest()
                original_name = PurePosixPath(archive_path).name
                stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(original_name).stem).strip("-")
                stem = stem or "image"
                suffix = Path(original_name).suffix
                if not suffix:
                    suffix = mimetypes.guess_extension(item["media_type"]) or ""
                output_name = f"{stem}-{digest[:10]}{suffix.lower()}"
                assets_dir.mkdir(parents=True, exist_ok=True)
                output_path = assets_dir / output_name
                output_path.write_bytes(data)
                asset = {
                    "kind": "image",
                    "source_href": item["href"],
                    "source_path": archive_path,
                    "media_type": item["media_type"],
                    "sha256": digest,
                    "output_path": str(output_path.resolve()),
                    "markdown_path": f"{assets_dir.name}/{output_name}",
                }
                assets.append(asset)
                asset_by_path[archive_path] = asset

            toc_kind = "none"
            toc_entries: list[dict[str, Any]] = []
            nav_items = [
                item
                for item in manifest.values()
                if "nav" in item["properties"].split()
            ]
            if nav_items:
                nav_item = nav_items[0]
                nav_path = nav_item["archive_path"]
                if nav_path in names:
                    try:
                        nav_root = _parse_xml(archive.read(nav_path), nav_path)
                        toc_entries = _extract_nav_toc(
                            nav_root, nav_path, chapter_anchor_by_path
                        )
                        if toc_entries:
                            toc_kind = "nav"
                        else:
                            warnings.append("EPUB NAV document has no TOC entries")
                    except ValueError as exc:
                        warnings.append(str(exc))
                else:
                    warnings.append(f"EPUB NAV document is missing: {nav_path}")

            if not toc_entries:
                ncx_id = spine.get("toc")
                ncx_item = manifest.get(ncx_id, {}) if ncx_id else {}
                if not ncx_item:
                    ncx_item = next(
                        (
                            item
                            for item in manifest.values()
                            if item["media_type"] == "application/x-dtbncx+xml"
                        ),
                        {},
                    )
                if ncx_item:
                    ncx_path = ncx_item["archive_path"]
                    if ncx_path in names:
                        try:
                            ncx_root = _parse_xml(archive.read(ncx_path), ncx_path)
                            toc_entries = _extract_ncx_toc(
                                ncx_root, ncx_path, chapter_anchor_by_path
                            )
                            if toc_entries:
                                toc_kind = "ncx"
                            else:
                                warnings.append("EPUB NCX document has no TOC entries")
                        except ValueError as exc:
                            warnings.append(str(exc))
                    else:
                        warnings.append(f"EPUB NCX document is missing: {ncx_path}")

            if not toc_entries:
                warnings.append("EPUB has no usable NAV or NCX table of contents")
            else:
                if selection_mode != "all":
                    toc_entries = [
                        entry
                        for entry in toc_entries
                        if entry.get("source_path") in selected_paths
                    ]
                unresolved_toc = [
                    entry.get("href", "")
                    for entry in toc_entries
                    if "chapter_anchor" not in entry
                ]
                if unresolved_toc:
                    warnings.append(
                        "EPUB TOC contains unresolved chapter targets: "
                        + ", ".join(repr(item) for item in unresolved_toc)
                    )
            metadata["toc_kind"] = toc_kind
            metadata["toc"] = toc_entries
            metadata["selected_chapter_has_toc_entry"] = bool(toc_entries)
            metadata["chapter_selection"] = selection_mode
            if spine_index is not None:
                metadata["requested_spine_index"] = spine_index
            metadata["spine"] = [
                {
                    "index": entry["index"],
                    "id": entry["item"]["id"] if entry["item"] else entry["idref"],
                    "href": entry["item"]["href"] if entry["item"] else None,
                    "source_path": (
                        entry["item"]["archive_path"] if entry["item"] else None
                    ),
                    "selected": entry["index"] in {
                        selected[0] for selected in selected_spine_items
                    },
                    "chapter_anchor": (
                        chapter_anchor_by_path.get(entry["item"]["archive_path"])
                        if entry["item"]
                        else None
                    ),
                }
                for entry in spine_entries
            ]

            markdown_chapters: list[str] = []
            internal_links_total = 0
            internal_links_resolved = 0
            internal_links_out_of_scope = 0
            known_spine_paths = {
                item["archive_path"] for item in spine_items
            }
            for index, item, root in parsed_chapters:
                chapter_path = item["archive_path"]
                renderer = _MarkdownRenderer(
                    chapter_path,
                    chapter_anchor_by_path,
                    known_spine_paths,
                    element_anchor_by_key,
                    asset_by_path,
                    warnings,
                )
                body = renderer.render(root)
                internal_links_total += renderer.internal_links_total
                internal_links_resolved += renderer.internal_links_resolved
                internal_links_out_of_scope += renderer.internal_links_out_of_scope
                chapter_anchor = chapter_anchor_by_path[chapter_path]
                markdown_chapters.append(
                    f'<a id="{chapter_anchor}"></a>\n\n{body}'.rstrip()
                )

            quality = {
                "spine_items": len(spine_entries),
                "selected_spine_items": len(selected_spine_items),
                "selection_mode": selection_mode,
                "chapters_extracted": len(parsed_chapters),
                "chapters_failed": chapter_failures,
                "toc_kind": toc_kind,
                "toc_entries": len(toc_entries),
                "internal_links_total": internal_links_total,
                "internal_links_resolved": internal_links_resolved,
                "internal_links_out_of_scope": internal_links_out_of_scope,
                "images_declared": len(all_image_items),
                "images_selected": len(image_items),
                "images_extracted": len(assets),
                "metadata_complete": all(
                    metadata.get(field) for field in ("title", "language", "identifier")
                ),
                "structure_preserved": not warnings,
            }
            return {
                "format": "epub",
                "variant": "epub3_or_epub2",
                "status": "partial" if warnings else "completed",
                "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
                "markdown": "\n\n---\n\n".join(markdown_chapters).strip() + "\n",
                "metadata": metadata,
                "quality": quality,
                "warnings": warnings,
                "anchors": anchors,
                "assets": assets,
            }
    except (OSError, zipfile.BadZipFile, KeyError, ValueError) as exc:
        return _failed(f"EPUB extraction failed: {exc}", source_path)
