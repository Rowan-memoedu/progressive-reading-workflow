from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path
import re
import time
import urllib.request


CONFIG_DIR = Path.home() / "Documents" / "New project"


def load_config() -> dict[str, str]:
    config: dict[str, str] = {}
    for key in ("AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"):
        value = os.environ.get(key)
        if value:
            config[key] = value

    if not all(config.get(key) for key in ("AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL")):
        config_file = next(CONFIG_DIR.glob("DeepSeek API*.md"))
        for line in config_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("AI_PRODUCER_") and "=" in line:
                key, value = line.split("=", 1)
                config.setdefault(key.strip(), value.strip())

    for key in ("AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"):
        if not config.get(key):
            raise RuntimeError(f"Missing {key}")
    return config


def clean_caption_line(line: str) -> str:
    line = re.sub(r"<[^>]+>", "", line)
    line = html.unescape(line)
    line = re.sub(r"\s+", " ", line).strip()
    return line


def parse_vtt(vtt: str) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        raw_text = " ".join(current)
        # YouTube auto captions often include rolling word-level cues followed by
        # a clean cue. Keep the clean cue only to avoid repeated phrases.
        if re.search(r"<\d\d:\d\d:\d\d\.\d+>", raw_text):
            current = []
            return
        text = clean_caption_line(raw_text)
        if text and (not chunks or chunks[-1] != text):
            chunks.append(text)
        current = []

    for raw in vtt.splitlines():
        line = raw.strip()
        if not line or line == "WEBVTT" or line.startswith("Kind:") or line.startswith("Language:"):
            flush()
            continue
        if line.isdigit():
            continue
        if "-->" in line:
            flush()
            continue
        current.append(line)
    flush()
    return chunks


def normalize_auto_caption_chunks(chunks: list[str]) -> str:
    words: list[str] = []
    previous = ""
    for chunk in chunks:
        if chunk == previous:
            continue
        previous = chunk
        words.extend(chunk.split())

    deduped: list[str] = []
    for word in words:
        if deduped and deduped[-1].lower() == word.lower():
            continue
        deduped.append(word)
    text = " ".join(deduped)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def split_english_sentences(text: str) -> list[str]:
    if not text:
        return []
    protected = {
        "Mr.": "Mr<dot>",
        "Mrs.": "Mrs<dot>",
        "Ms.": "Ms<dot>",
        "Dr.": "Dr<dot>",
        "Prof.": "Prof<dot>",
        "e.g.": "e<dot>g<dot>",
        "i.e.": "i<dot>e<dot>",
    }
    for source, target in protected.items():
        text = text.replace(source, target)

    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])", text)
    sentences = [p.replace("<dot>", ".").strip() for p in parts if p.strip()]

    merged: list[str] = []
    buffer = ""
    for sentence in sentences:
        if not buffer:
            buffer = sentence
        elif len(buffer) < 45:
            buffer = f"{buffer} {sentence}"
        else:
            merged.append(buffer)
            buffer = sentence
    if buffer:
        merged.append(buffer)
    return merged


def batch_items(items: list[dict[str, str]], max_chars: int = 8500) -> list[list[dict[str, str]]]:
    batches: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    size = 0
    for item in items:
        item_size = len(item["en"]) + 30
        if current and size + item_size > max_chars:
            batches.append(current)
            current = []
            size = 0
        current.append(item)
        size += item_size
    if current:
        batches.append(current)
    return batches


def call_deepseek(config: dict[str, str], batch: list[dict[str, str]], index: int, total: int) -> list[dict[str, str]]:
    url = config["AI_PRODUCER_BASE_URL"].rstrip("/") + "/chat/completions"
    payload = {
        "model": config["AI_PRODUCER_MODEL"],
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是专业英文视频字幕译者。请把英文转成自然、准确、可阅读的简体中文。\n"
                    "要求：忠实原意，不总结，不删减，不新增信息；根据原文语气调整中文语气，避免翻译腔；"
                    "使用中文全角标点；专有名词、人名、机构名必要时保留英文；输出必须是 JSON 数组。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"这是第 {index}/{total} 批字幕句子。请逐条翻译，保持 id 不变。\n"
                    "输出格式严格为 JSON 数组：[{\"id\":\"...\",\"zh\":\"...\"}]\n\n"
                    + json.dumps(batch, ensure_ascii=False, indent=2)
                ),
            },
        ],
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['AI_PRODUCER_API_KEY']}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        data = json.loads(response.read().decode("utf-8"))
    content = data["choices"][0]["message"]["content"].strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.S)
    parsed = json.loads(content)
    if not isinstance(parsed, list):
        raise RuntimeError("Translation response is not a JSON array")
    return parsed


def duration_string(seconds: int | None) -> str:
    if not seconds:
        return ""
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vtt", required=True)
    parser.add_argument("--info", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--translations-json", required=True)
    args = parser.parse_args()

    vtt_path = Path(args.vtt)
    info_path = Path(args.info)
    out_path = Path(args.out)
    translations_path = Path(args.translations_json)

    info = json.loads(info_path.read_text(encoding="utf-8").lstrip("\ufeff"))
    chunks = parse_vtt(vtt_path.read_text(encoding="utf-8"))
    text = normalize_auto_caption_chunks(chunks)
    sentences = split_english_sentences(text)
    items = [{"id": f"{i:04d}", "en": sentence} for i, sentence in enumerate(sentences, 1)]

    config = load_config()
    translated: dict[str, str] = {}
    if translations_path.exists():
        try:
            existing = json.loads(translations_path.read_text(encoding="utf-8").lstrip("\ufeff"))
            for item in existing:
                if item.get("id") and item.get("zh"):
                    translated[str(item["id"])] = str(item["zh"]).strip()
        except Exception:
            translated = {}

    batches = batch_items(items)
    for idx, batch in enumerate(batches, 1):
        remaining_batch = [item for item in batch if item["id"] not in translated]
        if not remaining_batch:
            print(f"batch {idx}/{len(batches)} skipped", flush=True)
            continue
        for attempt in range(1, 4):
            try:
                result = call_deepseek(config, remaining_batch, idx, len(batches))
                for item in result:
                    translated[str(item["id"])] = str(item["zh"]).strip()
                translations_path.parent.mkdir(parents=True, exist_ok=True)
                translations_path.write_text(json.dumps([
                    {"id": item["id"], "zh": translated.get(item["id"], ""), "en": item["en"]} for item in items if item["id"] in translated
                ], ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"batch {idx}/{len(batches)} translated: {len(translated)}/{len(items)}", flush=True)
                break
            except Exception as error:
                print(f"batch {idx}/{len(batches)} attempt {attempt} failed: {error}", flush=True)
                if attempt == 3:
                    raise
                time.sleep(2 * attempt)

    missing = [item["id"] for item in items if item["id"] not in translated]
    if missing:
        raise RuntimeError(f"Missing translations for ids: {', '.join(missing[:10])}")

    translations_path.write_text(json.dumps([
        {"id": item["id"], "zh": translated[item["id"]], "en": item["en"]} for item in items
    ], ensure_ascii=False, indent=2), encoding="utf-8")

    title = info.get("title") or "YouTube Transcript"
    url = info.get("webpage_url") or f"https://www.youtube.com/watch?v={info.get('id', '')}"
    channel = info.get("channel") or info.get("uploader") or ""
    duration = info.get("duration_string") or duration_string(info.get("duration"))
    lines = [
        f"# {title}",
        "",
        f"- Source: {url}",
        f"- Channel: {channel}",
        f"- Duration: {duration}",
        "- Format: 中文一句后接对应英文一句；无字幕时间戳。",
        "",
        "## 双语正文",
        "",
    ]
    for item in items:
        lines.append(translated[item["id"]])
        lines.append("")
        lines.append(item["en"])
        lines.append("")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    print(json.dumps({
        "out": str(out_path),
        "translations_json": str(translations_path),
        "caption_chunks": len(chunks),
        "sentences": len(items),
        "batches": len(batches),
        "chars": len(out_path.read_text(encoding="utf-8")),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
