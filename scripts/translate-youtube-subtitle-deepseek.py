from __future__ import annotations

import json
import os
from pathlib import Path
import re
import urllib.request


WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
TARGET_DIR = WORKSPACE_ROOT / "03 Outputs" / "Web Markdown Import Experiments" / "youtube" / "wsNzAuYDgy0"
VTT_PATH = TARGET_DIR / "wsNzAuYDgy0.en.vtt"
ZH_PATH = TARGET_DIR / "wsNzAuYDgy0.zh-CN.machine-translated.txt"
CONFIG_DIR = Path.home() / "Documents" / "New project"


def load_config() -> dict[str, str]:
    config_file = next(CONFIG_DIR.glob("DeepSeek API*.md"))
    config: dict[str, str] = {}
    for line in config_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("AI_PRODUCER_") and "=" in line:
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip()
    for key in ("AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"):
        if not config.get(key):
            raise RuntimeError(f"Missing {key}")
    return config


def decode_entities(text: str) -> str:
    return (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )


def parse_vtt(vtt: str) -> list[str]:
    segments: list[str] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        text = " ".join(current)
        text = re.sub(r"<[^>]+>", "", text)
        text = decode_entities(re.sub(r"\s+", " ", text).strip())
        if text and (not segments or segments[-1] != text):
            segments.append(text)
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
    return segments


def chunks(items: list[str], max_chars: int = 6500) -> list[list[str]]:
    result: list[list[str]] = []
    current: list[str] = []
    size = 0
    for item in items:
        extra = len(item) + 2
        if current and size + extra > max_chars:
            result.append(current)
            current = []
            size = 0
        current.append(item)
        size += extra
    if current:
        result.append(current)
    return result


def call_deepseek(config: dict[str, str], text: str, index: int, total: int) -> str:
    url = config["AI_PRODUCER_BASE_URL"].rstrip("/") + "/chat/completions"
    payload = {
        "model": config["AI_PRODUCER_MODEL"],
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是专业字幕翻译。把英文字幕逐段翻译为简体中文。"
                    "要求：忠实、自然、保留段落顺序；不要总结、不要增删信息、不要解释；"
                    "输出只包含中文译文，各段之间用一个空行分隔。"
                ),
            },
            {
                "role": "user",
                "content": f"这是第 {index}/{total} 段字幕批次。请翻译：\n\n{text}",
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
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"].strip()


def main() -> None:
    config = load_config()
    segments = parse_vtt(VTT_PATH.read_text(encoding="utf-8"))
    translated_parts: list[str] = []
    batches = chunks(segments)
    for idx, batch in enumerate(batches, 1):
        translated_parts.append(call_deepseek(config, "\n\n".join(batch), idx, len(batches)))
    ZH_PATH.write_text("\n\n".join(translated_parts).strip() + "\n", encoding="utf-8")
    print(json.dumps({
        "source_segments": len(segments),
        "batches": len(batches),
        "output": str(ZH_PATH),
        "output_chars": len(ZH_PATH.read_text(encoding="utf-8")),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
