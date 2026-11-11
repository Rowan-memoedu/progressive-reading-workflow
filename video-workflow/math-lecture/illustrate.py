"""Add scientific figures and Mermaid to accepted lecture text."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

from pipeline import (DIAGRAM_MARKER, HERE, POLICY, REPO, Engine, compose_lecture,
                      digest, parse_json, read_json, run_lock, save, validate_plan,
                      validate_unit_body, verify_sources)


IMAGE_LINE = re.compile(r"^(?P<prefix> *(?:- )?)!\[(?P<alt>[^\]\n]*)\]\((?P<link>[^)\n]+)\) *$", re.M)
FENCE = re.compile(r"^ *(?:- )?(`{3,}|~{3,})(.*)$")
PARAMETER_EXPRESSION = re.compile(r"[=≠≤≥<>√/^*×÷]|[+−-]\s*[A-Za-zα-ω]|[A-Za-zα-ω]\s*[+−-]|\b[fgh]\s*\(|\([A-Za-zα-ω][^()]*[,，]")


def checked_file(path, expected):
    file = Path(path)
    if os.name == "nt" and len(str(file)) >= 248:
        name = str(file.absolute())
        if not name.startswith("\\\\?\\"):
            name = "\\\\?\\UNC\\" + name[2:] if name.startswith("\\\\") else "\\\\?\\" + name
        file = Path(name)
    data = file.read_bytes()
    if digest(data) != expected:
        raise ValueError(f"file_changed: {path}")
    return data


def mark_images(body, payload):
    slots = {item["id"]: item for item in payload.get("diagram_slots", [])}
    if "diagram_slots" in payload:
        return body, slots
    by_link = {item["link"]: item for item in payload["allowed_images"]}

    def marker(match):
        asset = by_link[match["link"]]
        key = asset["id"]
        if key in slots:
            key = f"{key}-{len(slots) + 1}"
        slots[key] = {**asset, "alt": match["alt"]}
        return f'{match["prefix"]}<!-- lecture-figure:{key} -->'

    draft = IMAGE_LINE.sub(marker, body)
    if re.search(r"!\[[^\]\n]*\]\(", draft):
        raise ValueError("source_diagrams_must_have_their_own_line")
    return draft, slots


def anchors(draft):
    """Return line numbers that end outside a display formula or fenced block."""
    safe = {}
    fence = None
    display = False
    for number, line in enumerate(draft.splitlines(), 1):
        match = FENCE.match(line)
        if fence is not None:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
            continue
        if match:
            fence = match[1]
            continue
        if len(re.findall(r"(?<!\\)\$\$", line)) % 2:
            display = not display
        if not display and line.strip() and not DIAGRAM_MARKER.fullmatch(line):
            prefix = re.match(r"^ *", line)[0]
            safe[number] = prefix + ("  " if line[len(prefix):].startswith("- ") else "")
    return safe


def read_units(source, output):
    material = read_json(source / "material.json")
    verify_sources(material)
    plan = validate_plan(read_json(source / "plan.json")["plan"], material)
    units = []
    for unit in plan["units"]:
        folder = source / "units" / unit["id"]
        record = read_json(folder / "accepted.json")
        state = read_json(folder / "state.json") if (folder / "state.json").exists() else record
        bound = read_json(folder / "source.json")
        identity = digest({"payload": bound["payload"], "visual": bound["images"], "policy": POLICY})
        if (state["status"] != "accepted" or bound["payload"]["unit"] != unit
                or bound["fingerprint"] != identity or record["source_fingerprint"] != identity):
            raise ValueError(f"unit_not_bound_to_accepted_text: {unit['id']}")
        body = checked_file(record["lecture_file"], record["lecture_sha256"]).decode("utf-8")
        Engine.validate_review(json.loads(checked_file(record["review_file"], record["review_sha256"])))
        Engine.validate_math_review(json.loads(checked_file(record["math_review_file"], record["math_review_sha256"])))
        validate_unit_body(body, bound["payload"])
        draft, slots = mark_images(body, bound["payload"])
        for asset in slots.values():
            checked_file(asset["path"], asset["sha256"])
        key = digest({"draft": draft, "slots": slots})
        legacy_work = output / "units" / unit["id"] / key
        work = legacy_work if legacy_work.exists() else legacy_work.with_name(key[:20])
        save(work / "text.md", draft, frozen=True)
        units.append({"unit": unit, "body": body, "draft": draft, "slots": slots, "key": key, "work": work})
    return plan, units


def sections(plan, split):
    if not split:
        return [("lecture.md", plan)]
    return [(f"chapter-{n:02d}.md", {**plan, "title": chapter["title"], "chapters": [chapter],
            "units": [u for u in plan["units"] if u["chapter"] == chapter["id"]]})
            for n, chapter in enumerate(plan["chapters"], 1)]


def prepare(source, output, engine, split):
    plan, units = read_units(source, output)
    bodies = {item["unit"]["id"]: item["body"] for item in units}
    publication = source / "publication.json"
    if publication.exists():
        published = read_json(publication)
        if digest(compose_lecture(plan, bodies).encode()) != published["sha256"]:
            raise ValueError("published_lecture_differs_from_accepted_units")
        checked_file(published["path"], published["sha256"])
        for document in published.get("documents", []):
            checked_file(document["path"], document["sha256"])
        split = split or bool(published.get("documents"))
    else:
        raw, receipt = engine.call("integration", {"title": plan["title"], "chapters": plan["chapters"],
            "units": [{"id": u["id"], "title": u["title"], "chapter": u["chapter"], "body": bodies[u["id"]]}
                      for u in plan["units"]]})
        review = parse_json(raw)
        save(output / "integration-review.json", {"review": review, "receipt": receipt})
        if review.get("verdict") != "pass" or review.get("issues") != []:
            raise ValueError("marked_text_integration_review_failed")
    drafts = {item["unit"]["id"]: item["draft"] for item in units}
    documents = sections(plan, split)
    for name, scoped in documents:
        save(output / "text" / name, compose_lecture(scoped, drafts), frozen=True)
    return units, documents


def reused(asset):
    return bool(asset.get("source_image_id") and asset.get("receipt_sha256"))


def planning_request(items):
    images = []
    payload = []
    for item in items:
        slots = []
        for key, asset in item["slots"].items():
            if not reused(asset):
                images.append(asset)
            slots.append({"id": key, "alt": asset.get("alt", ""), "description": asset.get("diagram_description", ""),
                          "reuse_verified_plot": reused(asset), "attachment": None if reused(asset) else len(images)})
        payload.append({"id": item["unit"]["id"], "title": item["unit"]["title"], "slots": slots,
                        "lines": item["draft"].splitlines(), "eligible_after_lines": list(anchors(item["draft"]))})
    return {"units": payload}, images


def clean_label(value):
    if not isinstance(value, str) or not value.strip() or re.search(r"[\r\n`<>\[\]$\\|]", value) or len(value) > 100:
        raise ValueError("figure_label_invalid")
    return value


def mermaid(graph):
    direction = graph.get("direction", "TD")
    if direction not in {"TD", "LR"}:
        raise ValueError("mermaid_direction_invalid")
    lines = [f"flowchart {direction}"]
    nodes = {}
    for node in graph["nodes"]:
        key = node["id"]
        if not re.fullmatch(r"[A-Z][A-Z0-9]*", key) or key in nodes:
            raise ValueError("mermaid_node_invalid")
        nodes[key] = html.escape(clean_label(node["text"]), quote=True)
        lines.append(f'  {key}["{nodes[key]}"]')
    if len(nodes) < 2 or not graph["edges"]:
        raise ValueError("mermaid_requires_relationships")
    for edge in graph["edges"]:
        a, b = edge["from"], edge["to"]
        if a not in nodes or b not in nodes:
            raise ValueError("mermaid_edge_invalid")
        label = html.escape(clean_label(edge["label"]), quote=True) if edge.get("label") else None
        lines.append(f'  {a} -->|"{label}"| {b}' if label else f"  {a} --> {b}")
    return lines


def latex_label(label):
    label = re.sub(r"√(?:\(([^()]*)\)|([A-Za-z0-9]+))",
                   lambda match: r"\sqrt{" + (match[1] or match[2]) + "}", label)
    label = label.translate(str.maketrans({"−": "-", "≤": r"\le ", "≥": r"\ge ", "≠": r"\ne ",
                                         "×": r"\times ", "÷": r"\div ", "∞": r"\infty ", "±": r"\pm "}))
    for char in set(re.findall(r"[α-ω]", label)):
        name = unicodedata.name(char).split()[-1].lower()
        if name == "lamda":
            name = "lambda"
        label = label.replace(char, "\\" + name + " ")
    return re.sub(r"[\u3400-\u9fff，。；：]+", lambda match: r"\text{" + match[0] + "}", label)


def move_parameter_labels(decisions):
    """Keep necessary plot markers and typeset parameter expressions beside the figure."""
    output = deepcopy(decisions)
    for decision in output:
        plot = decision.get("plot")
        if not plot:
            continue
        elements = plot.get("scene", {}).get("elements", [])
        labels = [(element, field) for element in elements for field in ("label", "text") if element.get(field)]
        existing = {element[field] for element, field in labels}
        markers = (chr(0x2460 + n) for n in range(20) if chr(0x2460 + n) not in existing)
        legend = {}
        for element, field in labels:
            label = element[field]
            if not re.search(r"[A-Za-zα-ω]", label.replace("π", "")) or not PARAMETER_EXPRESSION.search(label):
                continue
            if label not in legend:
                legend[label] = next(markers)
            element[field] = legend[label]
        if legend:
            decision["label_note"] = "图中" + "，".join(f"{marker} 对应 ${latex_label(label)}$" for label, marker in legend.items()) + "。"
    return output


def figure_positions(item, decisions):
    lines = item["draft"].splitlines()
    marks = {m["id"]: (n, m["prefix"]) for n, line in enumerate(lines, 1) if (m := DIAGRAM_MARKER.fullmatch(line))}
    safe = anchors(item["draft"])
    seen = set()
    for decision in decisions:
        slot = decision.get("slot")
        if slot is not None:
            if slot not in marks or slot in seen or reused(item["slots"][slot]):
                raise ValueError(f"diagram_slot_invalid: {slot}")
            seen.add(slot)
            number, prefix = marks[slot]
        else:
            number = decision["after_line"]
            if type(number) is not int or number not in safe:
                raise ValueError(f"diagram_anchor_invalid: {number}")
            prefix = safe[number]
        yield number, prefix, decision
    missing = {key for key, asset in item["slots"].items() if not reused(asset)} - seen
    if missing:
        raise ValueError(f"diagram_slots_unresolved: {sorted(missing)}")
    for key, asset in item["slots"].items():
        if reused(asset):
            number, prefix = marks[key]
            yield number, prefix, {"slot": key, "reuse": asset, "alt": asset.get("alt", "")}


def render_plots(item, positioned):
    figures = []
    placements = []
    lines = item["draft"].splitlines()
    for n, (number, _, decision) in enumerate(positioned):
        if "plot" not in decision:
            continue
        key = f"plot-{n}"
        figures.append({**decision["plot"], "id": key})
        line = lines[number - 1]
        placements.append({"figure": key, "after": line, "occurrence": lines[:number].count(line),
                           "prefix": "", "context": "explanation", "alt": clean_label(decision["alt"])})
    if not figures:
        return {}
    plan = {"version": 1, "source_sha256": digest(item["draft"].encode()), "figures": figures, "placements": placements}
    path = item["work"] / ("plot-plan-" + digest(plan) + ".json")
    save(path, plan, frozen=True)
    cli = Path(os.environ.get("MATH_LECTURE_DIAGRAMS_ROOT", "D:/Projects/MathTopicPipeline/diagrams")) / "cli.cjs"
    node = os.environ.get("PR_READING_NODE", "node")
    legacy_folder = item["work"] / ("plots-" + digest(plan))
    folder = legacy_folder if legacy_folder.exists() else legacy_folder.with_name(legacy_folder.name[:26])
    if not (folder / "verification.json").exists():
        attempt = folder
        index = 0
        while attempt.exists():
            index += 1
            attempt = folder.with_name(folder.name + f"-{index}")
        invoke([node, str(cli), "build", "--source", str(item["work"] / "text.md"), "--plan", str(path), "--out", str(attempt)])
        folder = attempt
    invoke([node, str(cli), "verify", "--out", str(folder)])
    report = read_json(folder / "verification.json")
    assets = {row["key"]: row for row in report["assets"]}
    return {row["id"]: {"path": str(folder / "assets" / (row["asset"] + ".png")),
                        "sha256": assets[row["asset"]]["hashes"]["png"]} for row in report["figures"]}


def invoke(command):
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=360)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout).strip()[-4000:])
    return result.stdout


def render_unit(item, decisions):
    normalized = move_parameter_labels(decisions)
    positioned = list(figure_positions(item, normalized))
    for _, _, decision in positioned:
        if sum(key in decision for key in ("plot", "mermaid", "reuse")) != 1:
            raise ValueError("figure_requires_one_render_type")
        if "reuse" in decision and decision["reuse"] not in item["slots"].values():
            raise ValueError("unapproved_figure_reuse")
    plotted = render_plots(item, positioned)
    insertions = defaultdict(list)
    assets = {}
    added = defaultdict(int)
    for n, (number, prefix, decision) in enumerate(positioned):
        if "mermaid" in decision:
            base = prefix[:-2] + "  " if prefix.endswith("- ") else prefix
            block = [base + "```mermaid", *(base + line for line in mermaid(decision["mermaid"])), base + "```"]
            kind = "mermaid"
        else:
            asset = decision.get("reuse") or plotted[f"plot-{n}"]
            relative = f"images/{asset['sha256']}.png"
            assets[relative] = {key: asset[key] for key in ("path", "sha256")}
            alt = clean_label(decision["alt"]) if decision.get("alt") else ""
            block = [f"{prefix}![{alt}]({relative})"]
            if decision.get("label_note"):
                base = prefix[:-2] + "  " if prefix.endswith("- ") else prefix
                block.extend(["", base + decision["label_note"]])
            kind = "reuse" if "reuse" in decision else "plot"
        added[("source_" if decision.get("slot") else "new_") + kind] += 1
        insertions[number].extend(["", *block, ""])
    lines = []
    additions = []
    for n, line in enumerate(item["draft"].splitlines(), 1):
        if not DIAGRAM_MARKER.fullmatch(line):
            lines.append(line)
        if insertions[n]:
            additions.append([len(lines), len(insertions[n])])
            lines.extend(insertions[n])
    body = "\n".join(lines).rstrip() + "\n"
    end = len(body.splitlines())
    additions = [[start, min(length, end - start)] for start, length in additions]
    return {"body": body, "assets": assets, "counts": dict(added), "additions": additions,
            "rendered_plan_sha256": digest(normalized)}


def plan_groups(items):
    group = []
    for item in items:
        if group and (len(group) >= 4 or sum(len(u["draft"]) for u in group) + len(item["draft"]) > 22000
                      or sum(len(u["slots"]) for u in group) + len(item["slots"]) > 7):
            yield group
            group = []
        group.append(item)
    if group:
        yield group


def plan_call(engine, items, failure=None):
    payload, images = planning_request(items)
    if failure:
        payload["previous_failure"] = failure
    raw, receipt = engine.call("diagram-plan", payload, images)
    rows = parse_json(raw)["units"]
    if sorted(row["id"] for row in rows) != sorted(item["unit"]["id"] for item in items):
        raise ValueError("diagram_plan_unit_coverage_invalid")
    return {row["id"]: row["figures"] for row in rows}, receipt


def process_group(engine, items):
    try:
        planned, receipt = plan_call(engine, items)
        initial_failure = None
    except (KeyError, RuntimeError, TypeError, ValueError) as error:
        planned, receipt = {}, None
        initial_failure = str(error)
    failures = {}
    for item in items:
        key = item["unit"]["id"]
        failure = initial_failure
        for attempt in range(3):
            try:
                if attempt or key not in planned:
                    decisions, trace = plan_call(engine, [item], failure)
                    figures = decisions[key]
                else:
                    figures, trace = planned[key], receipt
                result = render_unit(item, figures)
                save(item["work"] / "illustrated.json", {**result, "key": item["key"], "plan": figures,
                     "plan_receipt": trace, "body_sha256": digest(result["body"].encode())})
                print(json.dumps({"unit": key, "status": "illustrated", "counts": result["counts"]}), flush=True)
                break
            except (KeyError, RuntimeError, TypeError, ValueError, subprocess.TimeoutExpired) as error:
                failure = str(error)
                save(item["work"] / f"failure-{digest(failure.encode())[:16]}.json", {"error": failure})
                print(json.dumps({"unit": key, "status": "diagram_retry", "error": failure}, ensure_ascii=False), flush=True)
        else:
            failures[key] = failure
    return failures


def load_illustration(item):
    path = item["work"] / "illustrated.json"
    if not path.exists():
        return None
    result = read_json(path)
    if result["key"] != item["key"] or digest(result["body"].encode()) != result["body_sha256"]:
        raise ValueError(f"illustrated_unit_changed: {item['unit']['id']}")
    normalized = move_parameter_labels(result["plan"])
    if "additions" not in result or result.get("rendered_plan_sha256") != digest(normalized):
        rebuilt = render_unit(item, result["plan"])
        if normalized == result["plan"] and (rebuilt["body"] != result["body"] or rebuilt["assets"] != result["assets"]):
            raise ValueError(f"illustration_receipt_cannot_be_replayed: {item['unit']['id']}")
        result.update(rebuilt, body_sha256=digest(rebuilt["body"].encode()))
        save(path, result)
    original = [line for line in item["draft"].splitlines() if not DIAGRAM_MARKER.fullmatch(line)]
    retained = result["body"].splitlines()
    for start, length in reversed(result["additions"]):
        del retained[start:start + length]
    if retained != original:
        raise ValueError(f"illustration_changed_accepted_text: {item['unit']['id']}")
    for asset in result["assets"].values():
        checked_file(asset["path"], asset["sha256"])
    return result


def deliver(output, units, documents, engine):
    bodies = {}
    counts = defaultdict(int)
    destination = output / "lecture"
    for item in units:
        result = load_illustration(item)
        bodies[item["unit"]["id"]] = result["body"]
        for key, value in result["counts"].items():
            counts[key] += value
        for link, asset in result["assets"].items():
            save_asset = destination / link
            data = checked_file(asset["path"], asset["sha256"])
            save_asset.parent.mkdir(parents=True, exist_ok=True)
            if save_asset.exists():
                checked_file(save_asset, asset["sha256"])
            else:
                save_asset.write_bytes(data)
    results = []
    acceptance = output / "acceptance.json"
    previous = {entry["path"]: entry["sha256"] for entry in read_json(acceptance)["documents"]} if acceptance.exists() else {}
    python = os.environ.get("PROGRESSIVE_READING_VIDEO_PYTHON", "D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe")
    for name, scoped in documents:
        path = destination / name
        text = compose_lecture(scoped, bodies)
        if path.exists() and digest(path.read_bytes()) not in {previous.get(str(path)), digest(text.encode())}:
            raise ValueError(f"illustrated_lecture_was_edited: {path}")
        save(path, text)
        render = output / "render" / path.stem
        invoke([python, str(REPO / "video-workflow" / "verify-rendering.py"), "--markdown", str(path), "--output", str(render)])
        audit = read_json(render / "render-verification.json")
        results.append({"title": scoped["title"], "path": str(path), "sha256": digest(path.read_bytes()),
                        "preview": str(render / "preview.html"), "rendering": audit})
    result = {"status": "passed", "units": len(units), "documents": results, "counts": dict(counts),
              "accepted_text_preserved": True,
              "model": engine.client.model, "model_calls_this_run": engine.calls}
    save(acceptance, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run"])
    parser.add_argument("--run", type=Path, required=True, help="Existing math lecture run directory")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split-chapters", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    args = parser.parse_args()
    source, output = args.run.resolve(), args.output.resolve()
    if source == output or source in output.parents:
        raise ValueError("illustration_output_must_be_separate_from_source_run")
    with run_lock(output):
        engine = Engine(output, model=args.model)
        units, documents = prepare(source, output, engine, args.split_chapters)
        if args.command == "prepare":
            print(json.dumps({"status": "text_ready", "units": len(units), "text": str(output / "text")}))
            return 0
        pending = [item for item in units if load_illustration(item) is None]
        failures = {}
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs = [pool.submit(process_group, engine, group) for group in plan_groups(pending)]
            for job in as_completed(jobs):
                failures.update(job.result())
        if failures:
            save(output / "failures.json", failures)
            return 1
        result = deliver(output, units, documents, engine)
        print(json.dumps({key: value for key, value in result.items() if key != "documents"}, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
