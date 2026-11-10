"""Source-bound, resumable mathematical lectures over the existing Codex transport.

This is a document transformation, not a queue, service, scheduler or agent host.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
POLICY = "mathematical-lecture/nested-lossless-v1"


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else encode(value)).hexdigest()


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def save(file, value, *, frozen=False):
    file = Path(file)
    data = value.encode("utf-8") if isinstance(value, str) else encode(value)
    file.parent.mkdir(parents=True, exist_ok=True)
    if frozen:
        if file.exists():
            if file.read_bytes() != data:
                raise ValueError("frozen_input_changed: " + str(file))
        else:
            with file.open("xb") as stream:
                stream.write(data)
        return
    temporary = file.with_name(file.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, file)


@contextmanager
def run_lock(root):
    file = Path(root) / ".run.lock"
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("a+b") as stream:
        stream.seek(0, 2)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def parse_json(text):
    text = text.strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("model_json_object_required")
    return value


def span_indices(spans):
    result = []
    for span in spans:
        if (not isinstance(span, list) or len(span) != 2
                or any(type(v) is not int for v in span) or span[0] < 0 or span[1] < span[0]):
            raise ValueError("invalid_inclusive_source_range")
        result.extend(range(span[0], span[1] + 1))
    return result


def parse_selection(text, *, minimum=0):
    values = []
    for token in text.split(','):
        match = re.fullmatch(r"(\d+)(?:-(\d+))?", token)
        if not match:
            raise ValueError("invalid_selection_range")
        start, end = int(match[1]), int(match[2] or match[1])
        if start < minimum or end < start:
            raise ValueError("invalid_selection_range")
        values.extend(range(start, end + 1))
    if values != sorted(set(values)):
        raise ValueError("selection_must_be_unique_and_ordered")
    return values


def board_fragment_map(plan, material):
    """Split mixed OCR text at unique source quotes, never model-counted offsets."""
    units = {u["id"] for u in plan["units"]}
    original = {b["index"]: b for b in material["board_blocks"]}
    result = {}
    for row in plan.get("board_splits", []):
        index = row.get("index")
        if index not in original or index in result:
            raise ValueError("board_split_index_invalid")
        block = original[index]
        text = block.get("text", "")
        pieces = row.get("pieces", [])
        if block.get("type") == "image" or block.get("img_path") or not isinstance(text, str) or not text or len(pieces) < 2:
            raise ValueError(f"board_split_requires_mixed_text: {index} ({block.get('type')})")
        starts = []
        for n, piece in enumerate(pieces):
            if piece.get("unit") not in units:
                raise ValueError("board_split_unknown_unit")
            quote = piece.get("at")
            if n == 0:
                if quote is not None:
                    raise ValueError("board_split_must_start_at_origin")
                starts.append(0)
            elif not isinstance(quote, str) or not quote or text.count(quote) != 1:
                raise ValueError("board_split_quote_not_unique")
            else:
                starts.append(text.index(quote))
        if starts != sorted(set(starts)) or starts[-1] >= len(text):
            raise ValueError("board_split_order_invalid")
        owners = {p["unit"] for p in pieces}
        owner = next(u["id"] for u in plan["units"] if index in span_indices(u["board_ranges"]))
        if owner not in owners:
            raise ValueError("board_split_owner_mismatch")
        result[index] = [{"unit": piece["unit"], "block": {**block,
                          "text": text[start:starts[n + 1] if n + 1 < len(starts) else len(text)],
                          "source_text_range": [start, starts[n + 1] if n + 1 < len(starts) else len(text)]}}
                         for n, (piece, start) in enumerate(zip(pieces, starts))]
    return result


def source_board_blocks(plan, material, unit):
    indices = set(span_indices(unit["board_ranges"]))
    splits = board_fragment_map(plan, material)
    blocks = []
    for block in material["board_blocks"]:
        if block["index"] in splits:
            blocks.extend(p["block"] for p in splits[block["index"]] if p["unit"] == unit["id"])
        elif block["index"] in indices:
            blocks.append(block)
    return blocks


def validate_plan(plan, material):
    if not isinstance(plan.get("title"), str) or not plan["title"].strip():
        raise ValueError("plan_title_required")
    chapters = plan.get("chapters", [])
    units = plan.get("units", [])
    chapter_ids = [c.get("id") for c in chapters]
    ids = [u.get("id") for u in units]
    if (not chapters or len(set(chapter_ids)) != len(chapter_ids) or not units
            or len(set(ids)) != len(ids) or any(not re.fullmatch(r"u[0-9]{3,}", str(i)) for i in ids)):
        raise ValueError("unique_plan_identifiers_required")
    parts = {p["part"]: p for p in material["transcripts"]}
    cue_coverage = {p: [] for p in parts}
    board_coverage, order = [], []
    for unit in units:
        if unit.get("chapter") not in chapter_ids or unit.get("part") not in parts or not unit.get("title"):
            raise ValueError("unknown_unit_chapter_or_part")
        cue_coverage[unit["part"]] += span_indices([[unit.get("start"), unit.get("end")]])
        board_coverage += span_indices(unit.get("board_ranges", []))
        order.append((list(parts).index(unit["part"]), unit["start"]))
    if order != sorted(order):
        raise ValueError("unit_source_order_changed")
    for part, indices in cue_coverage.items():
        if indices != list(range(len(parts[part]["cues"]))):
            raise ValueError(f"subtitle_coverage_gap_or_overlap: {part}")
    if sorted(board_coverage) != list(range(len(material["board_blocks"]))):
        raise ValueError("board_coverage_gap_or_overlap")
    used = [u["chapter"] for u in units]
    compressed = [v for i, v in enumerate(used) if i == 0 or used[i - 1] != v]
    if compressed != chapter_ids:
        raise ValueError("chapter_order_or_contiguity_invalid")
    board_fragment_map(plan, material)
    return plan


def compile_plan(plan, material):
    """Only semantic starts are model decisions; source lengths determine ends."""
    plan = json.loads(json.dumps(plan))
    sizes = {p["part"]: len(p["cues"]) for p in material["transcripts"]}
    units = plan.get("units", [])
    for i, unit in enumerate(units):
        if unit.get("part") not in sizes:
            raise ValueError("unknown_plan_part")
        following = units[i + 1] if i + 1 < len(units) else None
        unit["end"] = (following["start"] - 1 if following and following["part"] == unit["part"]
                       else sizes[unit["part"]] - 1)
    if "board_owners" in plan:
        owners = plan.pop("board_owners")
        count = len(material["board_blocks"])
        starts = [row.get("start") for row in owners]
        if (count and (not starts or starts[0] != 0)
                or any(type(i) is not int or i < 0 or i >= count for i in starts)
                or starts != sorted(set(starts)) or (not count and starts)):
            raise ValueError("invalid_board_owner_boundaries")
        by_id = {u["id"]: u for u in units}
        for unit in units:
            unit["board_ranges"] = []
        for i, row in enumerate(owners):
            if row.get("unit") not in by_id:
                raise ValueError("unknown_board_owner")
            end = owners[i + 1]["start"] - 1 if i + 1 < len(owners) else count - 1
            by_id[row["unit"]]["board_ranges"].append([row["start"], end])
    return validate_plan(plan, material)


def apply_boundary_patch(plan, proposal, material, selected):
    """Repartition source ownership only within explicitly selected units."""
    selected = set(selected)
    original = {u["id"]: u for u in plan["units"]}
    rows = proposal.get("units", [])
    if (not selected or selected - original.keys() or len(rows) != len(selected)
            or {r.get("id") for r in rows} != selected):
        raise ValueError("boundary_repair_scope_invalid")
    patches = {r["id"]: r for r in rows}
    if any(not {"id", "start", "board_ranges"}.issubset(r) or set(r) - {"id", "start", "board_ranges", "title"}
           or ("title" in r and (not isinstance(r["title"], str) or not r["title"].strip())) for r in rows):
        raise ValueError("boundary_repair_may_only_change_source_ranges")
    candidate = json.loads(json.dumps(plan))
    for unit in candidate["units"]:
        if unit["id"] in selected:
            unit.update(patches[unit["id"]])
    candidate = compile_plan(candidate, material)
    if any(u != original[u["id"]] for u in candidate["units"] if u["id"] not in selected):
        raise ValueError("boundary_repair_changed_unselected_unit")
    return candidate


def prepare(inventory_file, board_file, page_template, output, selected_pages=None, relative_ocr_pages=False,
            ocr_pages=None, selected_blocks=None):
    inventory_file, board_file = Path(inventory_file).resolve(), Path(board_file).resolve()
    inventory = read_json(inventory_file)
    board = read_json(board_file)
    transcripts, files = [], []
    for record in inventory["parts"]:
        file = Path(record["transcript"]).resolve()
        raw = file.read_bytes()
        if digest(raw) != record["sha256"]:
            raise ValueError("original_transcript_changed: " + str(file))
        source = json.loads(raw.decode("utf-8-sig"))
        if source["cid"] != record["cid"] or not source["video_id"].endswith("_p" + str(record["part"])):
            raise ValueError("source_part_identity_changed")
        transcripts.append({"part": record["part"], "title": record["title"],
                            "cues": [[i, s["text"]] for i, s in enumerate(source["segments"])]})
        files.append({"path": str(file), "sha256": digest(raw)})
    pdf = Path(inventory["board"]["path"])
    if digest(pdf.read_bytes()) != inventory["board"]["sha256"]:
        raise ValueError("original_board_changed")
    files += [{"path": str(pdf), "sha256": digest(pdf.read_bytes())},
              {"path": str(board_file), "sha256": digest(board_file.read_bytes())}]
    if selected_pages is None:
        selected_pages = list(range(1, inventory["board"]["pages"] + 1))
    if (selected_pages != sorted(set(selected_pages)) or not selected_pages
            or selected_pages[0] < 1 or selected_pages[-1] > inventory["board"]["pages"]):
        raise ValueError("invalid_selected_board_pages")
    blocks, images, pages = [], [], {}
    ocr_pages = ocr_pages or selected_pages
    if selected_blocks is not None and (not selected_blocks or selected_blocks != sorted(set(selected_blocks))
            or selected_blocks[0] < 0 or selected_blocks[-1] >= len(board)):
        raise ValueError("invalid_selected_board_blocks")
    for i, block in enumerate(board):
        if selected_blocks is not None and i not in selected_blocks:
            continue
        if relative_ocr_pages:
            if not 0 <= block["page_idx"] < len(ocr_pages):
                raise ValueError("ocr_page_outside_selected_range")
            page = ocr_pages[block["page_idx"]]
        else:
            page = block["page_idx"] + 1
        if page not in selected_pages:
            continue
        i = len(blocks)
        item = {"index": i, "page": page, **{k: v for k, v in block.items()
                if k not in ("page_idx", "bbox")}}
        if block.get("img_path"):
            file = (board_file.parent / block["img_path"]).resolve()
            media_id = f"img{i:04d}"
            image = {"id": media_id, "page": page, "block": i, "path": str(file),
                     "sha256": digest(file.read_bytes()), "link": f"images/{media_id}{file.suffix.lower()}"}
            images.append(image)
            item["image_id"] = media_id
        blocks.append(item)
        if page not in pages:
            file = Path(page_template.format(page=page)).resolve()
            pages[page] = {"page": page, "path": str(file), "sha256": digest(file.read_bytes())}
    if sorted(pages) != selected_pages:
        raise ValueError("board_page_coverage_incomplete")
    material = {"policy": POLICY, "transcripts": transcripts, "board_blocks": blocks,
                "images": images, "pages": list(pages.values()), "files": files,
                "source_video": inventory["source_video"], "inventory": str(inventory_file)}
    if selected_blocks is not None or ocr_pages != selected_pages:
        material["board_selection"] = {"physical_pages": selected_pages,
            "ocr_physical_pages": ocr_pages, "original_ocr_block_indices": selected_blocks}
    save(Path(output) / "material.json", material, frozen=True)
    return material


def verify_sources(material):
    for item in material["files"] + material["images"] + material["pages"]:
        if digest(Path(item["path"]).read_bytes()) != item["sha256"]:
            raise ValueError("source_evidence_changed: " + item["path"])


def validate_body(body, allowed_links, require_mermaid=False):
    if not body.strip() or not body.lstrip().startswith("- "):
        raise ValueError("nested_lecture_body_required")
    if re.search(r"^\s*#{1,6}\s", body, re.M):
        raise ValueError("unit_must_not_add_headings")
    if re.search(r"阅读前置卡|核心洞察|(?:原板书|原字幕)(?:此处|中)|OCR识别错误|已(?:作出|进行)修正", body):
        raise ValueError("reader_body_contains_processing_commentary")
    links = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", body)
    if any(link not in allowed_links for link in links):
        raise ValueError("unapproved_or_formula_image")
    if set(allowed_links) - set(links):
        raise ValueError("required_source_diagram_missing")
    if require_mermaid and not re.search(r"^\s*(?:-\s+)?```mermaid\s*$", body, re.M):
        raise ValueError("source_diagram_relation_not_preserved")
    for diagram in re.findall(r"```mermaid\s*\n(.*?)```", body, re.S):
        if re.search(r"^\s*linkStyle[^\n]*#[0-9A-Fa-f]{3,8}", diagram, re.M):
            raise ValueError("mermaid_link_style_requires_named_color")
        for label in re.findall(r'"([^"\n]*)"', diagram):
            if "$" not in label and re.search(r"[A-Za-z0-9]\s*[=≠<>≤≥∈]", label):
                raise ValueError("diagram_formula_requires_latex_or_adjacent_body")
    fence = None
    for line in body.splitlines():
        match = re.match(r"^\s*(?:-\s+)?(`{3,}|~{3,})(.*)$", line)
        if match:
            if fence is None:
                fence = match[1]
            elif match[1] == fence and not match[2].strip():
                fence = None
    if fence:
        raise ValueError("unclosed_markdown_fence")
    return body.strip() + "\n"


def math_expressions(body):
    text = re.sub(r"(?ms)^\s*(?:-\s+)?(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$", "", body)
    rows = []
    def display(match):
        rows.append({"tex": match[1], "display": True})
        return ""
    text = re.sub(r"\$\$([\s\S]+?)\$\$", display, text)
    rows += [{"tex": m[1], "display": False}
             for m in re.finditer(r"(?<!\\)\$(?!\$)([^\n$]+?)(?<!\\)\$", text)]
    return rows


def validate_math_syntax(body):
    expressions = math_expressions(body)
    if not expressions:
        return []
    library = os.environ.get("PR_KATEX_LIBRARY", "D:/Caches/ProgressiveReading/render-assets/katex-0.16.11.min.js")
    if not Path(library).is_file():
        raise RuntimeError("math_syntax_runtime_unavailable: configure PR_KATEX_LIBRARY")
    result = subprocess.run([os.environ.get("PR_READING_NODE", "node"), str(HERE / "validate-math.mjs"), library],
        input=json.dumps(expressions, ensure_ascii=False), text=True, encoding="utf-8", capture_output=True,
        timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError("math_syntax_validation_failed")
    return json.loads(result.stdout)


def compose_lecture(plan, bodies):
    lines = ["# " + plan["title"], ""]
    for chapter in plan["chapters"]:
        promote = len(plan["chapters"]) == 1 and chapter["title"].strip() == plan["title"].strip()
        if not promote:
            lines += ["- " + chapter["title"]]
        units = [u for u in plan["units"] if u["chapter"] == chapter["id"]]
        for unit in units:
            indent = (2 if len(units) == 1 else 4) - (2 if promote else 0)
            if len(units) > 1:
                lines += [(" " * (indent - 2)) + "- " + unit["title"]]
            lines += [(" " * indent + line) if line else "" for line in bodies[unit["id"]].splitlines()]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def requires_mermaid(payload):
    return any(i.get("diagram_required") and not i.get("reconstructed_diagram") for i in payload["mixed_images"])


def catalog_only_change(previous, saved_source, payload, visual):
    if saved_source.get("fingerprint") != previous["source_fingerprint"]:
        return False
    old = {"payload": saved_source["payload"], "visual": saved_source["images"], "policy": POLICY}
    if digest(old) != previous["source_fingerprint"]:
        return False
    def own_source(p, images):
        return {"payload": {k: v for k, v in p.items() if k != "course_units"}, "visual": images, "policy": POLICY}
    return digest(own_source(saved_source["payload"], saved_source["images"])) == digest(own_source(payload, visual))


class Engine:
    def __init__(self, output, client=None, model=None, syntax_checker=validate_math_syntax):
        self.root = Path(output).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        if client is None:
            location = REPO / "standard-preprocessing" / "batch_transport.py"
            spec = importlib.util.spec_from_file_location("lecture_batch_transport", location)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            client = module.BatchClient(model=model)
        self.client = client
        self.syntax_checker = syntax_checker
        self.calls = 0
        self.count_lock = threading.Lock()

    def prompt(self, name):
        return (HERE / "prompts" / (name + ".md")).read_text(encoding="utf-8")

    def call(self, stage, payload, images=()):
        prompt = self.prompt(stage)
        identity = {"stage": stage, "system": prompt, "payload": payload,
                    "images": [{"path": i["path"], "sha256": i["sha256"]} for i in images],
                    "producer": self.client.identity, "policy": POLICY}
        key = digest(identity)
        folder = self.root / "calls" / stage / key
        save(folder / "request.json", identity, frozen=True)
        response = folder / "response.json"
        if response.exists():
            raw = read_json(response)
        else:
            attempts = list(folder.glob("attempt-*.json"))
            attempt = folder / f"attempt-{len(attempts) + 1:03d}.json"
            save(attempt, {"status": "running", "started_at": time.time()})
            with self.count_lock:
                self.calls += 1
            print(json.dumps({"stage": stage, "unit": payload.get("unit", {}).get("id"),
                              "status": "running", "model": self.client.model}, ensure_ascii=False), flush=True)
            stopped = threading.Event()
            def heartbeat():
                while not stopped.wait(30):
                    print(json.dumps({"stage": stage, "unit": payload.get("unit", {}).get("id"),
                                      "status": "waiting"}), flush=True)
            thread = threading.Thread(target=heartbeat, daemon=True)
            thread.start()
            try:
                raw = self.client.raw([{"role": "system", "content": prompt},
                                       {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
                                      images=[{"path": i["path"]} for i in images], max_tokens=24000)
                save(response, raw, frozen=True)
                save(attempt, {"status": "response_received", "completed_at": time.time()})
            except Exception as error:
                save(attempt, {"status": "failed", "error": str(error), "completed_at": time.time()})
                raise
            finally:
                stopped.set()
                thread.join()
        if raw.get("provider") != "codex_exec" or raw.get("model") != self.client.model:
            raise ValueError("unexpected_producer_identity")
        if images and raw.get("image_count") != len(images):
            raise ValueError("actual_visual_input_count_mismatch")
        choice = raw["choices"][0]
        if choice.get("finish_reason") != "stop" or not choice["message"].get("content", "").strip():
            raise ValueError("incomplete_model_response")
        return choice["message"]["content"].strip(), {"request_key": key, "response": str(response),
                "provider": raw["provider"], "model": raw["model"], "usage": raw.get("usage")}

    def plan(self, material):
        file = self.root / "plan.json"
        fingerprint = digest({k: material[k] for k in ("transcripts", "board_blocks", "policy")})
        if file.exists():
            saved = read_json(file)
            if saved["source_fingerprint"] != fingerprint:
                raise ValueError("plan_inputs_changed_requires_new_material_scope")
            return validate_plan(saved["plan"], material)
        text, receipt = self.call("plan", {"transcripts": material["transcripts"], "board_blocks": material["board_blocks"]})
        plan = compile_plan(parse_json(text), material)
        findings = None
        review_file = self.root / "plan-review.json"
        if review_file.exists() and read_json(review_file)["review"].get("verdict") == "fail":
            findings = read_json(review_file)["review"].get("issues", [])
        for revision in range(3):
            alignment_receipt = None
            if material["board_blocks"]:
                payload = {"units": [{k: v for k, v in u.items() if k != "board_ranges"} for u in plan["units"]],
                           "transcripts": material["transcripts"], "board_blocks": material["board_blocks"]}
                if findings is not None:
                    payload["review_findings"] = findings
                align_text, alignment_receipt = self.call("align", payload)
                try:
                    candidate = compile_plan({**plan, "board_splits": [], **parse_json(align_text)}, material)
                except ValueError as error:
                    findings = [{"kind": "alignment_format", "description": str(error)}]
                    save(self.root / "alignment-errors" / (alignment_receipt["request_key"] + ".json"),
                         {"issues": findings, "receipt": alignment_receipt}, frozen=True)
                    if revision == 2:
                        raise
                    continue
                plan = candidate
            source_units = []
            for unit in plan["units"]:
                transcript = next(t for t in material["transcripts"] if t["part"] == unit["part"])
                source_units.append({"unit": unit, "transcript": transcript["cues"][unit["start"]:unit["end"] + 1],
                    "board_blocks": source_board_blocks(plan, material, unit)})
            review_text, review_receipt = self.call("plan-review", {"plan": plan, "source_units": source_units})
            review = parse_json(review_text)
            save(review_file, {"review": review, "receipt": review_receipt})
            if review.get("verdict") == "pass" and review.get("issues") == []:
                break
            if not material["board_blocks"] or revision == 2:
                raise ValueError("plan_semantic_review_failed: " + json.dumps(review.get("issues", []), ensure_ascii=False))
            findings = review.get("issues", [])
        save(file, {"plan": plan, "source_fingerprint": fingerprint, "receipt": receipt,
                    "alignment_receipt": alignment_receipt, "review_receipt": review_receipt}, frozen=True)
        return plan

    def repair_boundaries(self, material, plan, selected):
        selected = set(selected)
        units = [u for u in plan["units"] if u["id"] in selected]
        if not selected or len(units) != len(selected):
            raise ValueError("boundary_repair_scope_invalid")
        integration = read_json(self.root / "integration-review.json")
        findings = [i for i in integration["review"].get("issues", [])
                    if selected.intersection(i.get("unit_ids", []))]
        if integration["review"].get("verdict") != "fail" or not findings:
            raise ValueError("boundary_repair_requires_localized_failure")
        cue_indices = {}
        board_indices = set()
        for unit in units:
            cue_indices.setdefault(unit["part"], set()).update(range(unit["start"], unit["end"] + 1))
            board_indices.update(span_indices(unit["board_ranges"]))
        payload = {"units": units, "chapters": plan["chapters"], "review_findings": findings,
                   "transcripts": [{"part": p["part"], "cues": [c for n, c in enumerate(p["cues"])
                                    if n in cue_indices[p["part"]]]}
                                   for p in material["transcripts"] if p["part"] in cue_indices],
                   "board_blocks": [b for b in material["board_blocks"] if b["index"] in board_indices]}
        text, receipt = self.call("repair-boundaries", payload)
        candidate = apply_boundary_patch(plan, parse_json(text), material, selected)
        source_units = []
        for unit in candidate["units"]:
            if unit["id"] not in selected:
                continue
            part = next(p for p in material["transcripts"] if p["part"] == unit["part"])
            source_units.append({"unit": unit, "transcript": part["cues"][unit["start"]:unit["end"] + 1],
                "board_blocks": source_board_blocks(candidate, material, unit)})
        review_text, review_receipt = self.call("plan-review", {"plan": candidate, "source_units": source_units})
        review = parse_json(review_text)
        record = {"receipt": receipt, "review": review, "review_receipt": review_receipt,
                  "before": digest(plan), "after": digest(candidate), "selected": sorted(selected)}
        save(self.root / "boundary-repairs" / (receipt["request_key"] + ".json"), record, frozen=True)
        if review.get("verdict") != "pass" or review.get("issues") != []:
            raise ValueError("boundary_repair_review_failed: " + json.dumps(review.get("issues", []), ensure_ascii=False))
        file = self.root / "plan.json"
        previous = read_json(file)
        if previous["plan"] != plan:
            raise ValueError("boundary_repair_plan_changed")
        save(self.root / "plan-history" / (digest(previous) + ".json"), previous, frozen=True)
        changed = [u["id"] for u, old in zip(candidate["units"], plan["units"]) if u != old]
        save(file, {**previous, "plan": candidate, "boundary_repair_receipt": receipt,
                    "review_receipt": review_receipt})
        for key in changed:
            save(self.root / "units" / key / "state.json", {"status": "pending", "reason": "source_boundary_repaired"})
        return {"status": "boundaries_repaired", "changed_units": changed, "model_calls_this_run": self.calls}

    def merge_units(self, material, plan, selected):
        selected = list(selected)
        ids = [u["id"] for u in plan["units"]]
        if len(selected) < 2 or len(selected) != len(set(selected)) or any(k not in ids for k in selected):
            raise ValueError("unit_merge_scope_invalid")
        positions = [ids.index(k) for k in selected]
        if positions != list(range(positions[0], positions[0] + len(positions))):
            raise ValueError("unit_merge_requires_adjacent_units_in_order")
        units = [plan["units"][n] for n in positions]
        if len({u["part"] for u in units}) != 1 or len({u["chapter"] for u in units}) != 1:
            raise ValueError("unit_merge_requires_same_part_and_chapter")
        failure = read_json(self.root / "integration-review.json")["review"]
        if failure.get("verdict") != "fail" or not any(set(selected).issubset(i.get("unit_ids", [])) for i in failure.get("issues", [])):
            raise ValueError("unit_merge_requires_localized_integration_failure")
        candidate = json.loads(json.dumps(plan))
        kept, retired = selected[0], set(selected[1:])
        merged = candidate["units"][positions[0]]
        indices = sorted(n for u in units for n in span_indices(u["board_ranges"]))
        ranges = []
        for n in indices:
            if ranges and n == ranges[-1][1] + 1:
                ranges[-1][1] = n
            else:
                ranges.append([n, n])
        merged["board_ranges"] = ranges
        candidate["units"] = [u for u in candidate["units"] if u["id"] not in retired]
        splits = []
        for split in candidate.get("board_splits", []):
            pieces = []
            for piece in split["pieces"]:
                piece = {**piece, "unit": kept if piece["unit"] in retired else piece["unit"]}
                if not pieces or piece["unit"] != pieces[-1]["unit"]:
                    pieces.append(piece)
            if len(pieces) > 1:
                splits.append({**split, "pieces": pieces})
        if "board_splits" in candidate:
            candidate["board_splits"] = splits
        candidate = compile_plan(candidate, material)
        previous_units = {u["id"]: u for u in plan["units"]}
        if any(u != previous_units[u["id"]] for u in candidate["units"] if u["id"] != kept):
            raise ValueError("unit_merge_changed_unselected_source")
        file = self.root / "plan.json"
        previous = read_json(file)
        if previous["plan"] != plan:
            raise ValueError("unit_merge_plan_changed")
        save(self.root / "plan-history" / (digest(previous) + ".json"), previous, frozen=True)
        event = {"kept": kept, "retired": sorted(retired), "previous_plan_sha256": digest(previous),
                 "integration_issue": [i for i in failure["issues"] if set(selected).issubset(i.get("unit_ids", []))]}
        save(file, {**previous, "plan": candidate, "unit_merges": previous.get("unit_merges", []) + [event]})
        save(self.root / "units" / kept / "state.json", {"status": "pending", "reason": "adjacent_source_units_merged"})
        for key in retired:
            save(self.root / "units" / key / "state.json", {"status": "merged", "into": kept})
        return {"status": "source_units_merged", "regenerate": kept, "retired": sorted(retired),
                "preserved_units": [u["id"] for u in candidate["units"] if u["id"] != kept]}

    def media(self, material):
        if not material["images"]:
            return []
        payload = {"images": [{k: i[k] for k in ("id", "page", "block")} for i in material["images"]]}
        text, receipt = self.call("media", payload, material["images"])
        rows = parse_json(text).get("images", [])
        if sorted(i.get("id", "") for i in rows) != sorted(i["id"] for i in material["images"]):
            raise ValueError("media_classification_coverage_invalid")
        if any(i.get("action") not in ("keep_diagram", "transcribe") for i in rows):
            raise ValueError("unsupported_media_action")
        if any(type(i.get("diagram_required")) is not bool for i in rows):
            raise ValueError("media_diagram_disposition_missing")
        save(self.root / "media-review.json", {"images": rows, "receipt": receipt})
        return rows

    def unit_payload(self, material, plan, unit, media):
        part = next(p for p in material["transcripts"] if p["part"] == unit["part"])
        indices = set(span_indices(unit["board_ranges"]))
        blocks = source_board_blocks(plan, material, unit)
        pages = {b["page"] for b in blocks}
        owned_images = [i for i in material["images"] if i["block"] in indices]
        actions = {r["id"]: r["action"] for r in media}
        allowed = [i for i in owned_images if actions[i["id"]] == "keep_diagram"]
        classifications = {r["id"]: r for r in media}
        mixed = [{**i, "diagram_required": classifications[i["id"]].get("diagram_required", False),
                  "diagram_description": classifications[i["id"]].get("diagram_description", "")}
                 for i in owned_images if actions[i["id"]] == "transcribe"]
        reconstructed = []
        reconstruction_file = self.root / "diagram-reconstructions.json"
        if reconstruction_file.exists():
            rows = read_json(reconstruction_file).get("images", [])
            ids = [r["source_image_id"] for r in rows]
            if len(ids) != len(set(ids)) or set(ids) - {i["id"] for i in material["images"]}:
                raise ValueError("diagram_reconstruction_scope_invalid")
            for image in mixed:
                row = next((r for r in rows if r["source_image_id"] == image["id"]), None)
                if row is None:
                    continue
                receipt_file = Path(row["receipt"])
                if digest(receipt_file.read_bytes()) != row["receipt_sha256"]:
                    raise ValueError("diagram_reconstruction_receipt_changed")
                receipt = read_json(receipt_file)
                if (receipt.get("source_image_id") != image["id"] or receipt.get("source_sha256") != image["sha256"]
                        or receipt.get("renderer") != "MathTopicPipeline/diagrams"):
                    raise ValueError("diagram_reconstruction_source_mismatch")
                if digest(Path(receipt["plan_path"]).read_bytes()) != receipt["plan_sha256"]:
                    raise ValueError("diagram_reconstruction_plan_changed")
                if digest(Path(receipt["path"]).read_bytes()) != receipt["hashes"]["png"]:
                    raise ValueError("diagram_reconstruction_asset_changed")
                if not receipt.get("checks") or any(c.get("passed") is not True for c in receipt["checks"]):
                    raise ValueError("diagram_reconstruction_constraints_not_passed")
                asset = {"id": "reconstructed-" + image["id"], "page": image["page"], "block": image["block"],
                         "path": receipt["path"], "sha256": receipt["hashes"]["png"],
                         "link": "images/reconstructed-" + image["id"] + ".png",
                         "source_image_id": image["id"], "plan_sha256": receipt["plan_sha256"],
                         "receipt_sha256": row["receipt_sha256"]}
                allowed.append(asset)
                reconstructed.append(asset)
                image["reconstructed_diagram"] = {"id": asset["id"], "link": asset["link"]}
        payload = {"course_title": plan["title"], "chapters": plan["chapters"],
                   "course_units": [{k: u[k] for k in ("id", "chapter", "title")} for u in plan["units"]],
                   "unit": unit, "transcript": part["cues"][unit["start"]:unit["end"] + 1],
                   "board_blocks": blocks, "allowed_images": allowed, "mixed_images": mixed}
        visual = [i for i in material["pages"] if i["page"] in pages] + owned_images + reconstructed
        context_file = self.root / "unit-context.json"
        if context_file.exists():
            references = read_json(context_file).get("units", {}).get(unit["id"], [])
            order = [u["id"] for u in plan["units"]]
            contexts = []
            if len(references) != len(set(references)):
                raise ValueError("duplicate_lecture_context")
            for key in references:
                if key not in order or order.index(key) >= order.index(unit["id"]):
                    raise ValueError("lecture_context_must_be_previously_defined")
                context_unit = next(u for u in plan["units"] if u["id"] == key)
                context_payload, context_visual = self.unit_payload(material, plan, context_unit, media)
                folder = self.root / "units" / key
                if read_json(folder / "state.json").get("status") != "accepted":
                    raise ValueError("lecture_context_not_accepted")
                record = read_json(folder / "accepted.json")
                context_fingerprint = digest({"payload": context_payload, "visual": context_visual, "policy": POLICY})
                if record["source_fingerprint"] != context_fingerprint and not catalog_only_change(
                        record, read_json(folder / "source.json"), context_payload, context_visual):
                    raise ValueError("lecture_context_source_changed")
                for kind in ("lecture", "review", "math_review"):
                    if digest(Path(record[kind + "_file"]).read_bytes()) != record[kind + "_sha256"]:
                        raise ValueError("lecture_context_evidence_changed")
                self.validate_review(read_json(record["review_file"]))
                self.validate_math_review(read_json(record["math_review_file"]))
                contexts.append({"unit_id": key, "title": context_unit["title"],
                    "body": Path(record["lecture_file"]).read_text(encoding="utf-8"),
                    "sha256": record["lecture_sha256"], "own_source_identity": digest({
                        "payload": {k: v for k, v in context_payload.items() if k != "course_units"},
                        "visual": context_visual, "policy": POLICY})})
            if contexts:
                payload["previous_lecture_context"] = contexts
        return payload, visual

    def math_review(self, body, folder):
        text, receipt = self.call("math-review", {"candidate_lecture": body})
        review = parse_json(text)
        file = folder / ("math-review-" + receipt["request_key"][:16] + ".json")
        save(file, review, frozen=True)
        return review, {"math_review_file": str(file), "math_review_sha256": digest(file.read_bytes()),
                        "math_review_receipt": receipt}

    @staticmethod
    def validate_math_review(review):
        if (review.get("verdict") != "pass" or review.get("issues") != []
                or any(review.get("checked", {}).get(k) is not True
                       for k in ("witness_substitution", "signs_domains", "algebra"))):
            raise ValueError("independent_math_review_failed: " + json.dumps(review.get("issues", []), ensure_ascii=False))

    def unit(self, material, plan, unit, media, *, refresh=False, revisions=0, verify_board=False, recheck_math=False):
        payload, visual = self.unit_payload(material, plan, unit, media)
        fingerprint = digest({"payload": payload, "visual": visual, "policy": POLICY})
        folder = self.root / "units" / unit["id"]
        accepted = folder / "accepted.json"
        state_file = folder / "state.json"
        state = read_json(state_file) if state_file.exists() else {"status": "accepted"}
        findings = None
        if accepted.exists() and not refresh and state.get("status") == "accepted":
            previous = read_json(accepted)
            rebind = None
            if previous["source_fingerprint"] != fingerprint and previous["policy"] == POLICY and (folder / "source.json").exists():
                saved_source = read_json(folder / "source.json")
                if catalog_only_change(previous, saved_source, payload, visual):
                    rebind = saved_source
            if (previous["source_fingerprint"] == fingerprint or rebind is not None) and previous["policy"] == POLICY:
                body = Path(previous["lecture_file"]).read_text(encoding="utf-8")
                if digest(body.encode()) != previous["lecture_sha256"]:
                    raise ValueError("accepted_body_modified: " + unit["id"])
                structure_issues = []
                try:
                    validate_body(body, {i["link"] for i in payload["allowed_images"]},
                                  requires_mermaid(payload))
                except ValueError as error:
                    structure_issues = [{"kind": "structure", "description": str(error)}]
                review = read_json(previous["review_file"])
                if digest(Path(previous["review_file"]).read_bytes()) != previous["review_sha256"]:
                    raise ValueError("accepted_review_modified: " + unit["id"])
                self.validate_review(review)
                syntax_issues = structure_issues or self.syntax_checker(body)
                if syntax_issues:
                    math_check, math_receipt = {"verdict": "fail", "issues": syntax_issues}, None
                elif previous.get("math_review_file") and not recheck_math:
                    file = Path(previous["math_review_file"])
                    if digest(file.read_bytes()) != previous["math_review_sha256"]:
                        raise ValueError("accepted_math_review_modified: " + unit["id"])
                    self.validate_math_review(read_json(file))
                    math_check, math_receipt = {"verdict": "pass"}, None
                else:
                    math_check, math_receipt = self.math_review(body, folder)
                if math_check.get("verdict") == "pass":
                    if math_receipt:
                        self.validate_math_review(math_check)
                        previous.update(math_receipt)
                    if rebind is not None:
                        old_fingerprint = previous["source_fingerprint"]
                        save(folder / ("source-history-" + old_fingerprint + ".json"), rebind, frozen=True)
                        save(folder / "source.json", {"fingerprint": fingerprint, "payload": payload, "images": visual})
                        previous.update(source_fingerprint=fingerprint, context_rebinding={
                            "previous_source_fingerprint": old_fingerprint, "changed_field": "course_units",
                            "own_source_verified_unchanged": True, "global_context_requires_integration_review": True})
                        save(folder / ("acceptance-" + digest(previous)[:16] + ".json"), previous, frozen=True)
                        save(state_file, {"status": "accepted", "source_fingerprint": fingerprint,
                                          "lecture_sha256": previous["lecture_sha256"]})
                    if math_receipt or rebind is not None:
                        save(accepted, previous)
                    print(json.dumps({"unit": unit["id"], "status": "reused_accepted"}), flush=True)
                    return previous
                findings = math_check.get("issues", [])
        integration_file = self.root / "integration-review.json"
        if integration_file.exists():
            integration = read_json(integration_file).get("review", {})
            if integration.get("verdict") == "fail":
                local_findings = [i for i in integration.get("issues", [])
                                  if unit["id"] in i.get("unit_ids", [])]
                if local_findings:
                    findings = (findings or []) + local_findings
        save(state_file, {"status": "pending", "source_fingerprint": fingerprint})
        save(folder / "source.json", {"fingerprint": fingerprint, "payload": payload, "images": visual})
        if verify_board and payload["board_blocks"]:
            text, source_receipt = self.call("source", payload, visual)
            verified = parse_json(text)
            if (sorted(b.get("index") for b in verified.get("blocks", []))
                    != sorted(b["index"] for b in payload["board_blocks"]) or verified.get("ambiguities")):
                raise ValueError("board_transcription_coverage_or_ambiguity")
            save(folder / ("verified-board-" + source_receipt["request_key"][:16] + ".json"),
                 {"transcription": verified, "receipt": source_receipt}, frozen=True)
            payload = {**payload, "verified_board": verified}
        strong_prompt = (REPO / "standard-preprocessing" / "prompts" / "强结构化整理.md").read_text(encoding="utf-8")
        outline, outline_receipt = self.call("outline", {**payload, "original_structuring_prompt": strong_prompt}, visual)
        outline_file = folder / ("outline-" + outline_receipt["request_key"][:16] + ".md")
        save(outline_file, outline + "\n", frozen=True)
        for revision in range(revisions + 1):
            generation = {**payload, "strong_outline": outline}
            if findings is not None:
                generation["review_findings"] = findings
            body, body_receipt = self.call("lecture", generation, visual)
            body = body.strip() + "\n"
            body_file = folder / ("lecture-" + body_receipt["request_key"][:16] + ".md")
            save(body_file, body, frozen=True)
            review = {"issues": []}
            try:
                validate_body(body, {i["link"] for i in payload["allowed_images"]},
                              requires_mermaid(payload))
                syntax_issues = self.syntax_checker(body)
                if syntax_issues:
                    review = {"issues": syntax_issues}
                    save(folder / ("syntax-" + body_receipt["request_key"][:16] + ".json"), review, frozen=True)
                    raise ValueError("lecture_math_syntax_invalid")
                text, review_receipt = self.call("review", {**payload, "candidate_lecture": body}, visual)
                review = parse_json(text)
                review_file = folder / ("review-" + review_receipt["request_key"][:16] + ".json")
                save(review_file, review, frozen=True)
                self.validate_review(review)
                math_check, math_receipt = self.math_review(body, folder)
                try:
                    self.validate_math_review(math_check)
                except ValueError:
                    review = math_check
                    raise
                break
            except ValueError as error:
                if revision == revisions:
                    raise
                findings = review.get("issues", []) or [{"kind": "structure", "description": str(error)}]
                print(json.dumps({"unit": unit["id"], "status": "regenerating_from_sources",
                                  "revision": revision + 1}), flush=True)
        result = {"status": "accepted", "policy": POLICY, "unit_id": unit["id"],
                  "source_fingerprint": fingerprint, "lecture_file": str(body_file),
                  "lecture_sha256": digest(body.encode()), "review_file": str(review_file),
                  "review_sha256": digest(review_file.read_bytes()),
                  "outline_receipt": outline_receipt, "lecture_receipt": body_receipt,
                  "review_receipt": review_receipt, **math_receipt, "accepted_at": time.time()}
        save(folder / ("acceptance-" + digest(result)[:16] + ".json"), result, frozen=True)
        save(accepted, result)
        save(state_file, {"status": "accepted", "source_fingerprint": fingerprint,
                          "lecture_sha256": result["lecture_sha256"]})
        print(json.dumps({"unit": unit["id"], "status": "accepted"}), flush=True)
        return result

    @staticmethod
    def validate_review(review):
        if (review.get("verdict") != "pass" or review.get("issues") != []
                or any(review.get("checked", {}).get(k) is not True for k in ("transcript", "board", "math", "media"))):
            raise ValueError("independent_unit_review_failed: " + json.dumps(review.get("issues", []), ensure_ascii=False))

    def run(self, material, plan, media, *, selected=None, workers=2, refresh=False, revisions=0, verify_board=False, recheck_math=False):
        selected = set(selected or [u["id"] for u in plan["units"]])
        if selected - {u["id"] for u in plan["units"]}:
            raise ValueError("unknown_selected_unit")
        results, failures = {}, {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            jobs = {pool.submit(self.unit, material, plan, unit, media, refresh=refresh, revisions=revisions,
                                verify_board=verify_board, recheck_math=recheck_math): unit["id"]
                    for unit in plan["units"] if unit["id"] in selected}
            for future in as_completed(jobs):
                key = jobs[future]
                try:
                    results[key] = future.result()
                except Exception as error:
                    failures[key] = str(error)
                    save(self.root / "units" / key / "state.json", {"status": "failed", "error": str(error)})
                    print(json.dumps({"unit": key, "status": "failed", "error": str(error)}, ensure_ascii=False), flush=True)
        receipt = {"status": "failed" if failures else "accepted", "selected": sorted(selected),
                   "accepted": sorted(results), "failures": failures, "model_calls_this_run": self.calls}
        save(self.root / "last-run.json", receipt)
        return receipt

    def assemble(self, material, plan, media, *, split_chapters=False):
        accepted, bodies, assets = {}, {}, {}
        for unit in plan["units"]:
            state_file = self.root / "units" / unit["id"] / "state.json"
            if state_file.exists() and read_json(state_file).get("status") != "accepted":
                raise ValueError("unit_pending_revalidation: " + unit["id"])
            file = self.root / "units" / unit["id"] / "accepted.json"
            record = read_json(file)
            payload, visual = self.unit_payload(material, plan, unit, media)
            assets.update({i["link"]: i for i in payload["allowed_images"]})
            if record["source_fingerprint"] != digest({"payload": payload, "visual": visual, "policy": POLICY}):
                raise ValueError("accepted_source_changed: " + unit["id"])
            body = Path(record["lecture_file"]).read_text(encoding="utf-8")
            if digest(body.encode()) != record["lecture_sha256"]:
                raise ValueError("accepted_body_modified: " + unit["id"])
            validate_body(body, {i["link"] for i in payload["allowed_images"]},
                          requires_mermaid(payload))
            if self.syntax_checker(body):
                raise ValueError("accepted_math_syntax_invalid: " + unit["id"])
            if digest(Path(record["review_file"]).read_bytes()) != record["review_sha256"]:
                raise ValueError("accepted_review_modified: " + unit["id"])
            self.validate_review(read_json(record["review_file"]))
            if digest(Path(record["math_review_file"]).read_bytes()) != record["math_review_sha256"]:
                raise ValueError("accepted_math_review_modified: " + unit["id"])
            self.validate_math_review(read_json(record["math_review_file"]))
            accepted[unit["id"]], bodies[unit["id"]] = record, body
        markdown = compose_lecture(plan, bodies)
        text, receipt = self.call("integration", {"title": plan["title"], "chapters": plan["chapters"],
            "units": [{"id": u["id"], "title": u["title"], "chapter": u["chapter"], "body": bodies[u["id"]]}
                      for u in plan["units"]]})
        review = parse_json(text)
        save(self.root / "integration-review.json", {"review": review, "receipt": receipt})
        if review.get("verdict") != "pass" or review.get("issues") != []:
            raise ValueError("integration_review_failed: " + json.dumps(review.get("issues", []), ensure_ascii=False))
        destination = self.root / "lecture"
        file = destination / "lecture.md"
        previous = read_json(self.root / "publication.json") if (self.root / "publication.json").exists() else None
        if file.exists() and digest(file.read_bytes()) not in {digest(markdown.encode()), (previous or {}).get("sha256")}:
            raise ValueError("published_lecture_modified_refuse_overwrite")
        documents = []
        split_chapters = split_chapters or bool((previous or {}).get("documents"))
        previous_documents = {d["path"]: d for d in (previous or {}).get("documents", [])}
        if split_chapters:
            for n, chapter in enumerate(plan["chapters"], 1):
                units = [u for u in plan["units"] if u["chapter"] == chapter["id"]]
                scoped = {"title": chapter["title"], "chapters": [chapter], "units": units}
                body = compose_lecture(scoped, bodies)
                target = destination / f"chapter-{n:02d}.md"
                identity = digest(body.encode())
                if target.exists() and digest(target.read_bytes()) not in {
                        identity, previous_documents.get(str(target), {}).get("sha256")}:
                    raise ValueError("published_chapter_modified_refuse_overwrite: " + chapter["id"])
                documents.append({"chapter": chapter["id"], "title": chapter["title"], "path": str(target),
                                  "sha256": identity, "unit_ids": [u["id"] for u in units], "body": body})
        used = set(re.findall(r"!\[[^\]]*\]\(([^)]+)\)", markdown))
        if used - assets.keys():
            raise ValueError("publication_contains_unapproved_media")
        for link in used:
            target = destination / link
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and digest(target.read_bytes()) != assets[link]["sha256"]:
                raise ValueError("publication_image_changed")
            shutil.copyfile(assets[link]["path"], target)
        save(file, markdown)
        for document in documents:
            save(document["path"], document["body"])
        publication = {"status": "content_accepted_render_pending", "path": str(file),
                       "sha256": digest(markdown.encode()), "units": len(accepted), "parts": len(material["transcripts"]),
                       "images": sorted(used), "integration_receipt": receipt, "policy": POLICY,
                       "image_sources": {link: assets[link]["sha256"] for link in sorted(used)},
                       "reading_guide": "disabled", "video_capture_calls": 0,
                       "material_sha256": digest((self.root / "material.json").read_bytes()),
                       "plan_sha256": digest((self.root / "plan.json").read_bytes()),
                       "unit_sources": {key: {field: record[field] for field in
                           ("source_fingerprint", "lecture_sha256", "review_sha256", "math_review_sha256")}
                           for key, record in accepted.items()}}
        if documents:
            publication.update(delivery_mode="chapters", documents=[{k: v for k, v in d.items() if k != "body"}
                                                                    for d in documents])
        save(self.root / "publication.json", publication)
        return publication


def verify_delivery(root):
    root = Path(root).resolve()
    publication = read_json(root / "publication.json")
    markdown = Path(publication["path"])
    if digest(markdown.read_bytes()) != publication["sha256"]:
        raise ValueError("publication_modified_before_render")
    for link, identity in publication.get("image_sources", {}).items():
        if digest((markdown.parent / link).read_bytes()) != identity:
            raise ValueError("published_image_modified_before_render: " + link)
    for field, filename in [("material_sha256", "material.json"), ("plan_sha256", "plan.json")]:
        if digest((root / filename).read_bytes()) != publication.get(field):
            raise ValueError("publication_source_binding_changed")
    plan = read_json(root / "plan.json")["plan"]
    if set(publication["unit_sources"]) != {u["id"] for u in plan["units"]}:
        raise ValueError("publication_unit_coverage_changed")
    models = set()
    bodies = {}
    for key, identity in publication["unit_sources"].items():
        folder = root / "units" / key
        if (folder / "state.json").exists() and read_json(folder / "state.json").get("status") != "accepted":
            raise ValueError("unit_pending_revalidation: " + key)
        record = read_json(folder / "accepted.json")
        if any(record.get(field) != value for field, value in identity.items()):
            raise ValueError("publication_unit_changed: " + key)
        for kind in ("lecture", "review", "math_review"):
            if digest(Path(record[kind + "_file"]).read_bytes()) != record[kind + "_sha256"]:
                raise ValueError("accepted_evidence_modified: " + key)
        Engine.validate_review(read_json(record["review_file"]))
        Engine.validate_math_review(read_json(record["math_review_file"]))
        models.add(record["math_review_receipt"]["model"])
        bodies[key] = Path(record["lecture_file"]).read_text(encoding="utf-8")
    if publication.get("documents"):
        documents = publication["documents"]
        if ([key for d in documents for key in d["unit_ids"]] != [u["id"] for u in plan["units"]]
                or [d["chapter"] for d in documents] != [c["id"] for c in plan["chapters"]]):
            raise ValueError("chapter_document_coverage_changed")
        for document, chapter in zip(documents, plan["chapters"]):
            scoped = {"title": chapter["title"], "chapters": [chapter],
                      "units": [u for u in plan["units"] if u["chapter"] == chapter["id"]]}
            if (digest(compose_lecture(scoped, bodies).encode()) != document["sha256"]
                    or digest(Path(document["path"]).read_bytes()) != document["sha256"]):
                raise ValueError("chapter_document_modified_or_source_changed: " + chapter["id"])
    output = root / "render"
    python = os.environ.get("PROGRESSIVE_READING_VIDEO_PYTHON", "D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe")
    subprocess.run([python, str(REPO / "video-workflow" / "verify-rendering.py"),
                    "--markdown", str(markdown), "--output", str(output)], check=True, timeout=360)
    rendering = read_json(output / "render-verification.json")
    if rendering.get("status") != "passed" or rendering.get("errors"):
        raise ValueError("lecture_rendering_failed")
    acceptance = {"status": "passed", "lecture": str(markdown), "sha256": publication["sha256"],
                  "preview": str(output / "preview.html"), "units": publication["units"],
                  "parts": publication["parts"], "source_binding_verified": True,
                  "independent_source_review": True, "independent_math_review": True,
                  "math_review_models": sorted(models), "rendering": rendering,
                  "reading_guide": "disabled", "video_capture_calls": 0}
    if publication.get("documents"):
        accepted_documents = []
        for n, document in enumerate(publication["documents"], 1):
            chapter_output = output / f"chapter-{n:02d}"
            subprocess.run([python, str(REPO / "video-workflow" / "verify-rendering.py"),
                            "--markdown", document["path"], "--output", str(chapter_output)], check=True, timeout=360)
            chapter_rendering = read_json(chapter_output / "render-verification.json")
            if chapter_rendering.get("status") != "passed" or chapter_rendering.get("errors"):
                raise ValueError("chapter_rendering_failed: " + document["chapter"])
            accepted_documents.append({**document, "preview": str(chapter_output / "preview.html"),
                                       "rendering": chapter_rendering})
        acceptance.update(delivery_mode="chapters", documents=accepted_documents)
    save(root / "acceptance.json", acceptance)
    return acceptance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "plan", "repair-boundaries", "merge-units", "run", "assemble", "verify", "status"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", help="Explicit per-run Codex model; omitted preserves the existing transport default")
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--board-content", type=Path)
    parser.add_argument("--page-template")
    parser.add_argument("--board-pages", help="Original physical PDF pages, e.g. 3-13 or 3,5-8")
    parser.add_argument("--relative-ocr-pages", action="store_true", help="OCR renumbered selected pages from zero")
    parser.add_argument("--ocr-pages", help="Physical pages of the complete OCR run when selecting a narrower subset")
    parser.add_argument("--board-blocks", help="Explicit original zero-based OCR block indices for a partial page")
    parser.add_argument("--units", help="Comma-separated stable unit IDs; omitted means all units")
    parser.add_argument("--workers", type=int, default=2, choices=range(1, 5))
    parser.add_argument("--revisions", type=int, default=2, choices=range(0, 5), help="Per-unit source regeneration after failed independent review")
    parser.add_argument("--verify-board-transcription", action="store_true", help="Resolve concrete handwriting/OCR errors from actual board images before authoring")
    parser.add_argument("--recheck-math", action="store_true", help="Review accepted mathematics with the current reviewer; preserve the body when it passes")
    parser.add_argument("--refresh", action="store_true", help="Reopen explicitly selected units after a general prompt repair")
    parser.add_argument("--split-chapters", action="store_true", help="Deliver long parts as complete chapter files, preserving unit boundaries")
    args = parser.parse_args()
    if args.refresh and not args.units:
        parser.error("--refresh requires --units; entire-lecture regeneration is not implicit")
    if args.command in ("repair-boundaries", "merge-units") and not args.units:
        parser.error(args.command + " requires --units")
    if args.command == "prepare":
        if not args.inventory or not args.board_content or not args.page_template:
            parser.error("prepare requires --inventory, --board-content and --page-template")
        selected_pages = None
        if args.board_pages:
            selected_pages = parse_selection(args.board_pages, minimum=1)
        ocr_pages = parse_selection(args.ocr_pages, minimum=1) if args.ocr_pages else None
        selected_blocks = parse_selection(args.board_blocks) if args.board_blocks else None
        material = prepare(args.inventory, args.board_content, args.page_template, args.output,
                           selected_pages, args.relative_ocr_pages, ocr_pages, selected_blocks)
        print(json.dumps({"status": "prepared", "parts": len(material["transcripts"]), "pages": len(material["pages"])}))
        return 0
    material = read_json(args.output / "material.json")
    verify_sources(material)
    if args.command == "status":
        plan = read_json(args.output / "plan.json")["plan"] if (args.output / "plan.json").exists() else {"units": []}
        print(json.dumps({"parts": len(material["transcripts"]), "units": [{"id": u["id"], "title": u["title"],
            "accepted": (args.output / "units" / u["id"] / "accepted.json").exists()
            and (not (args.output / "units" / u["id"] / "state.json").exists()
                 or read_json(args.output / "units" / u["id"] / "state.json").get("status") == "accepted")
            } for u in plan["units"]]}, ensure_ascii=False, indent=2))
        return 0
    with run_lock(args.output):
        if args.command == "verify":
            print(json.dumps(verify_delivery(args.output), ensure_ascii=False, indent=2))
            return 0
        engine = Engine(args.output, model=args.model)
        plan = engine.plan(material)
        if args.command == "plan":
            print(json.dumps(plan, ensure_ascii=False, indent=2))
            return 0
        if args.command == "repair-boundaries":
            print(json.dumps(engine.repair_boundaries(material, plan, args.units.split(",")), ensure_ascii=False, indent=2))
            return 0
        if args.command == "merge-units":
            print(json.dumps(engine.merge_units(material, plan, args.units.split(",")), ensure_ascii=False, indent=2))
            return 0
        media = engine.media(material)
        if args.command == "run":
            result = engine.run(material, plan, media, selected=args.units.split(",") if args.units else None,
                                workers=args.workers, refresh=args.refresh, revisions=args.revisions,
                                verify_board=args.verify_board_transcription, recheck_math=args.recheck_math)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1 if result["failures"] else 0
        print(json.dumps(engine.assemble(material, plan, media, split_chapters=args.split_chapters), ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
