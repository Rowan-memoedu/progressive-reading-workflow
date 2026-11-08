"""Independent readback audit of a subtitle package and final Markdown."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import runpy
from urllib.parse import unquote

literal_mermaid = runpy.run_path(str(Path(__file__).with_name("verify-book-media.py")))["literal_mermaid"]


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def canonical_body_layout(text):
    """Ignore only empty separator lines outside literal code/math blocks."""
    lines = []
    fence = None
    math = False
    for line in text.strip().splitlines():
        marker = re.match(r'^\s*(?:-\s+)?(`{3,}|~{3,})([^\r\n]*)$', line)
        if marker:
            if fence is None:
                fence = marker.group(1)
            elif marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence) and not marker.group(2).strip():
                fence = None
            lines.append(line)
            continue
        if fence is None and re.match(r'^\s*(?:-\s+)?\$\$\s*$', line):
            math = not math
        if line == '' and fence is None and not math:
            continue
        lines.append(line)
    return '\n'.join(lines)


def verify_generated_projection(refinement_dir, refinement, outline):
    """Remove audited UTF-16 insertions and recover the frozen model prose exactly."""
    projection = refinement['generated_media_projection']
    pending = refinement_dir / 'generated-media-projection'
    saved = json.loads((pending / 'projection.json').read_text(encoding='utf-8'))
    for key in ('insertions', 'prose_sha256', 'output_sha256', 'prose_unchanged'):
        assert saved[key] == projection[key]
    assert projection['prose_unchanged'] is True
    assert digest(outline) == projection['output_sha256']
    assert digest(pending / 'prose.md') == projection['prose_sha256']
    prose_receipt = json.loads((pending / 'prose-receipt.json').read_text(encoding='utf-8'))
    assert prose_receipt['response_sha256'] == refinement['response_sha256']
    assert digest(refinement_dir / 'attempt-1.response.json') == refinement['response_sha256']
    assert prose_receipt['prose_sha256'] == projection['prose_sha256']
    media_ids = [value for item in projection['insertions'] for value in item['media_ids']]
    assert sorted(media_ids) == list(range(projection['media']))
    restored = outline.read_bytes().decode('utf-8').encode('utf-16-le')
    for item in reversed(projection['insertions']):
        start = item['output_offset'] * 2
        literal = item['text'].encode('utf-16-le')
        assert restored[start:start + len(literal)] == literal
        restored = restored[:start] + restored[start + len(literal):]
    assert restored.decode('utf-16-le') == (pending / 'prose.md').read_bytes().decode('utf-8')


def verify_projection_request(request, result, refinement, original, outline):
    shared_stage=result['receipt'].get('body_refinement')
    if shared_stage:
        # Existing-book recovery runs inside the standard body stage. Its
        # request remains the source; the stage output is the restored outline.
        assert shared_stage['input_sha256']==refinement['input_sha256']
        assert shared_stage['body_sha256']==refinement['body_sha256']
        assert request['material']['markdown']==original
        assert result['receipt']['workflow_route']['plan']['body_mode']==refinement['mode']
    else:
        # Illustrated mode may complete refinement before the standard entry.
        assert request['material']['markdown']==outline
        assert not request['processing_options']['spoken_to_written']
        assert not request['processing_options']['structure_body']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    receipt = json.loads((args.run / "video-receipt.json").read_text(encoding="utf-8"))
    caption = json.loads((args.run / "caption-map.json").read_text(encoding="utf-8"))
    result = json.loads((args.run / "preprocess/result.json").read_text(encoding="utf-8"))
    subtitle = args.input / receipt["source_file"]
    assert digest(subtitle) == receipt["subtitle_sha256"] == caption["subtitle_sha256"]
    timeline = None
    if subtitle.suffix.lower() == ".json":
        source = json.loads(subtitle.read_text(encoding="utf-8"))
        source_segments = source["segments"]
        assert [(s["start"], s["text"]) for s in source_segments] == [(s["start"], s["text"]) for s in caption["segments"]]
        def seconds(value):
            h, m, s = str(value).split(":")
            return float(h) * 3600 + float(m) * 60 + float(s)
        duration = float(source.get("duration") or 0)
        end = seconds(source_segments[-1].get("end") or source_segments[-1]["start"])
        timeline = {"video_duration_seconds": duration, "first_caption_seconds": seconds(source_segments[0]["start"]),
                    "last_caption_seconds": end, "end_coverage_ratio": end / duration if duration else None}
        if duration:
            assert end <= duration + 60
            assert end >= duration * 0.8, "Clearly truncated subtitle track"
    manifest = result["artifacts"]["cleaning_manifest"]
    nodes, mappings = manifest["source_nodes"], manifest["mappings"]
    raw_transcript = "\n\n".join(p["text"] for p in caption["paragraphs"])
    processing_source = raw_transcript
    media = receipt.get("book_media")
    if media:
        source_file = args.run / "media-source.md"
        processing_source = source_file.read_bytes().decode("utf-8")
        assert digest(source_file) == media["output_sha256"]
        assert hashlib.sha256(raw_transcript.encode()).hexdigest() == media["input_sha256"]
        # JavaScript offsets count UTF-16 code units. Remove the recorded native
        # insertions independently and compare every original subtitle character.
        restored = processing_source.encode("utf-16-le")
        for insertion in reversed(media["insertions"]):
            start = insertion["output_offset"] * 2
            literal = insertion["text"].encode("utf-16-le")
            assert restored[start:start+len(literal)] == literal
            restored = restored[:start] + restored[start+len(literal):]
        assert restored.decode("utf-16-le") == raw_transcript
        if media["counts"]["images"] or media["counts"]["mermaid"]:
            assert digest(args.input / "book.md") == media["book_sha256"]
    refinement = receipt.get("refinement")
    prompt_registry_changed = False
    if refinement:
        shared_body = refinement.get("version") == "full-text-body/v1"
        refinement_dir = Path(refinement["audit_dir"]) if shared_body else args.run / "refinement"
        original = refinement_dir / "original.md"
        outline = refinement_dir / ("body.md" if shared_body else "outline.md")
        assert original.read_bytes().decode("utf-8") == processing_source
        assert digest(original) == refinement["input_sha256"]
        assert digest(outline) == refinement["body_sha256" if shared_body else "outline_sha256"]
        assert digest(refinement_dir / "prompt.md") == refinement["prompt_sha256"]
        if refinement.get("source_protocol_sha256"):
            assert digest(refinement_dir / "source-protocol.md") == refinement["source_protocol_sha256"]
            assert digest(refinement_dir / "model-prompt.md") == refinement["model_prompt_sha256"]
        # Historical runs are verified against their frozen prompt and identity.
        # A later user-authorized prompt edit must not invalidate the old response.
        identity = json.loads((refinement_dir / "input-identity.json").read_text(encoding="utf-8"))
        assert identity["prompt_sha256"] == refinement["prompt_sha256"]
        assert identity["input_sha256"] == refinement["input_sha256"]
        current_prompt = Path(refinement["prompt_path"])
        prompt_registry_changed = not current_prompt.is_file() or digest(current_prompt) != refinement["prompt_sha256"]
        response = json.loads((refinement_dir / "attempt-1.response.json").read_text(encoding="utf-8"))
        assert response["choices"][0]["finish_reason"] == "stop"
        assert refinement["api_calls_total"] == 1
        if response.get('transport',{}).get('version')=='codex-exec-document/v2':
            transport=response['transport']
            assert transport['completed_event'] is True
            assert transport['instruction_role']=='model_instructions_file' and transport['user_payload_verbatim'] is True
            assert transport['max_output_tokens_applied'] is False and transport['thinking_applied'] is False
            if 'transport_capabilities' in refinement:
                assert refinement['transport_capabilities']==transport
        else:
            assert refinement["thinking"] == "disabled"
        request = json.loads((args.run / "preprocess/request.json").read_text(encoding="utf-8"))
        if refinement.get('generated_media_projection'):
            assert shared_body
            verify_projection_request(request,result,refinement,
                                      original.read_text(encoding='utf-8'),outline.read_text(encoding='utf-8'))
            verify_generated_projection(refinement_dir, refinement, outline)
        elif shared_body:
            assert request["material"]["markdown"] == original.read_text(encoding="utf-8")
            assert result["receipt"]["workflow_route"]["plan"]["body_mode"] == refinement["mode"]
        else:
            assert request["material"]["markdown"] == outline.read_text(encoding="utf-8")
            assert not request["processing_options"]["spoken_to_written"]
            assert not request["processing_options"]["structure_body"]
        if shared_body:
            model_input = (refinement_dir / "model-input.md").read_text(encoding="utf-8")
            spans = json.loads((refinement_dir / "protected-spans.json").read_text(encoding="utf-8"))
            for token, text in spans.items():
                assert model_input.count(token) == 1
                model_input = model_input.replace(token, text)
            assert model_input == original.read_text(encoding="utf-8")
        assert canonical_body_layout(manifest["body_text"]) == canonical_body_layout(outline.read_text(encoding="utf-8")), "Standard stages changed the generated body beyond empty separator lines"
    else:
        if media and any(media["counts"].values()):
            request = json.loads((args.run / "preprocess/request.json").read_text(encoding="utf-8"))
            assert request["material"]["markdown"] == processing_source
        else:
            assert len(nodes) == len(caption["paragraphs"])
            assert [n["text"] for n in nodes] == [p["text"] for p in caption["paragraphs"]]
    assert Counter(n["id"] for n in nodes) == Counter(m["source_id"] for m in mappings)
    originals = {n["id"]: n["text"] for n in nodes}
    if refinement:
        assert all(m["status"] == "body_preserved" for m in mappings)
    elif all(m.get("status") == "body_preserved" for m in mappings):
        # Current written-input processing preserves the complete body locally;
        # its mappings contain stable destinations rather than original_text.
        assert manifest["body_text"].strip() == processing_source.strip(), "Local preservation changed the source body"
    else:
        assert all(m["original_text"] == originals[m["source_id"]] for m in mappings)
    assert not manifest.get("ai_additions"), "AI additions found in cleaning body"
    published = Path(receipt["publication"]["markdown"]["path"])
    markdown = published.read_text(encoding="utf-8")
    assert digest(published) == receipt["publication"]["markdown"]["sha256"]
    if media:
        assert Counter(literal_mermaid(processing_source)) == Counter(literal_mermaid(markdown)), "Source Mermaid changed or disappeared"
    assert not re.search(r"\[\d{2}:\d{2}:\d{2}\]|<iframe|\[SCREENSHOT:", markdown)
    folder_layout = receipt.get('attachment_layout') == 'obsidian-book-folder/v1'
    references = re.findall(r"\]\(((?:images/|_assets/source/)[^)\n]+)\)", markdown) if folder_layout else re.findall(r"\]\((_assets/[^)\n]+)\)", markdown)
    referenced_targets = {(published.parent / unquote(ref)).resolve() for ref in references}
    used = set(receipt.get("used_attachments", [record["path"] for record in receipt["attachments"]]))
    if receipt.get("attachment_layout"):
        assert not re.search(r"^#{1,6}\s+(?:来源附件|附件列表)\s*$", markdown, re.M)
        if folder_layout:
            assert not re.search(r"(?<!!)\[[^\]\n]*\]\(images/", markdown), 'Image must be embedded'
        else:
            assert not re.search(r"!\[[^\]\n]*\]\(_assets/", markdown)
    excluded = set(receipt.get("excluded_sensitive_paths", []))
    assert all(re.match(r"^(?:\.env(?:\.|$)|_?cookies?\.(?:txt|json)$|.*\.cookies\.txt$)", Path(p).name.lower()) for p in excluded)
    attachments = {p.relative_to(args.input).as_posix() for p in args.input.rglob("*") if p.is_file()
                   and p.name != "source.json" and p.relative_to(args.input).as_posix() not in excluded}
    assert attachments == {a["path"] for a in receipt["attachments"]}
    assert not any(re.match(r"^(?:\.env(?:\.|$)|_?cookies?\.(?:txt|json)$|.*\.cookies\.txt$)", Path(p).name.lower()) for p in attachments)
    for record in receipt["attachments"]:
        source = args.input / record["path"]
        if folder_layout:
            asset = next(item for item in receipt['publication']['assets'] if Path(item['source_path']).resolve() == source.resolve())
            target = Path(asset['published_path'])
            assert target.resolve().is_relative_to(published.parent.resolve())
        else:
            target = published.parent / "_assets" / published.stem / record["path"]
        assert digest(source) == digest(target) == record["sha256"]
        assert (target.resolve() in referenced_targets) == (record["path"] in used)
    if folder_layout:
        expected_targets={Path(item['published_path']).resolve() for item in receipt['publication']['assets']
                          if Path(item['source_path']).resolve().relative_to(args.input.resolve()).as_posix() in used}
    else:
        expected_targets={(published.parent / "_assets" / published.stem / name).resolve() for name in used}
    assert referenced_targets == expected_targets
    frame_content_review = None
    frame_capture_verification = None
    illustrated_file = args.run / 'illustrated-receipt.json'
    if illustrated_file.is_file():
        illustrated = json.loads(illustrated_file.read_text(encoding='utf-8'))
        if illustrated.get('output_type') == 'illustrated':
            capture = illustrated['capture']
            request_file = args.run / 'frame-review-request.json'
            timestamp_policy = capture['frame_review'].get('policy') == 'timestamp_integrity'
            review_file = args.run / ('frame-admission.json' if timestamp_policy else 'frame-review.json')
            frame_request = json.loads(request_file.read_text(encoding='utf-8'))
            frame_review = json.loads(review_file.read_text(encoding='utf-8'))
            assert capture['frame_review']['status'] == 'passed'
            assert digest(request_file) == frame_review['request_sha256'] == capture['frame_review']['request_sha256']
            assert digest(review_file) == capture['frame_review']['admission_sha256' if timestamp_policy else 'review_sha256']
            assert digest(args.run / 'capture-plan.json') == frame_request['plan_sha256']
            assert digest(subtitle) == frame_request['source_sha256']
            assert len(frame_review['frames']) == len(frame_request['frames']) == len(capture['frames'])
            assert len({item['file'] for item in frame_review['frames']}) == len(frame_review['frames'])
            for frame in frame_request['frames']:
                review = next(item for item in frame_review['frames'] if item['file'] == frame['file'])
                selected = next(item for item in capture['frames'] if item['file'] == frame['file'])
                candidate = next(item for item in frame['candidates'] if item['time'] == review['selected_candidate_time' if timestamp_policy else 'selected_time'])
                if timestamp_policy:
                    assert frame_review['policy'] == 'timestamp_integrity' and frame_review['semantic_alignment'] == 'not_required'
                    candidate_path = Path(candidate['path'])
                    assert candidate_path.resolve().is_relative_to((args.run/'frame-candidates').resolve())
                    assert digest(candidate_path) == candidate['sha256']
                    timing = json.loads(candidate_path.with_suffix('.capture.json').read_text('utf-8'))
                    assert timing['actual_seconds'] == candidate['actual_seconds'] and timing['sha256'] == candidate['sha256']
                else:
                    assert review['matches_expected'] is True and len(review['observed'].strip()) >= 4
                assert digest(args.input / 'images' / frame['file']) == review['sha256'] == candidate['sha256'] == selected['sha256']
                assert selected['actual_capture_seconds'] == candidate['actual_seconds']
                assert seconds(frame['requested_time']) - 0.1 <= candidate['actual_seconds'] <= seconds(frame['window_end']) + 0.1
            frame_capture_verification = 'passed'
            frame_content_review = 'not_required' if timestamp_policy else 'passed'
    report = {"status": "passed", "standard_input_units_mapped_once": len(nodes),
              "subtitle_paragraphs": len(caption["paragraphs"]),
              "source_lineage": "complete_subtitle_to_single_body" if refinement else "paragraph_mapping",
              "refinement_calls": refinement["api_calls_total"] if refinement else None,
              "generated_media_merge_preserves_prose": bool(refinement and refinement.get('generated_media_projection')),
              "frame_content_review": frame_content_review,
              "frame_capture_verification": frame_capture_verification,
              "prompt_registry_changed_since_generation": prompt_registry_changed,
              "subtitle_segments": len(caption["segments"]), "attachments_verified": len(attachments),
              "png_attachments": sum(p.endswith(".png") for p in attachments),
              "all_attachment_links_resolve": True, "standard_stage_body_additions": 0,
              "subtitle_to_body_semantics": "user_review_required" if refinement else "mapped_and_audited",
              "attachments_referenced_in_body": len(used), "unused_attachments_not_displayed": len(attachments - used),
              "source_book_media": media["counts"] if media else None,
              "subtitle_json_verified": timeline is not None, "timeline": timeline,
              "markdown_sha256": digest(published)}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
