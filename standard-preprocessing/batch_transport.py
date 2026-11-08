"""Local batch compatibility over the existing Codex Exec document transport.

This module never changes user environment, API clients, or application settings.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import urllib.request
from urllib.parse import urlsplit

VERSION = 'local-batch-codex/v1'
BRIDGE = Path(__file__).with_name('producer-text.mjs')


def _bridge(payload, *, timeout=630, model=None):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith('DEEPSEEK_') or key in ('AI_PRODUCER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'):
            env.pop(key)
    # Scope the route override to this one child. Software/API settings survive.
    env['AI_PRODUCER_PROVIDER'] = 'codex_exec'
    if model:
        env['AI_PRODUCER_CODEX_MODEL'] = model
    try:
        result = subprocess.run(
            [env.get('PR_READING_NODE', 'node'), str(BRIDGE)],
            input=json.dumps(payload, ensure_ascii=False), capture_output=True,
            text=True, encoding='utf-8', timeout=timeout, env=env,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.TimeoutExpired:
        raise RuntimeError('batch_codex_timeout; no API fallback') from None
    if result.returncode:
        raise RuntimeError('batch_codex_failed; no API fallback')
    raw = json.loads(result.stdout)
    if raw.get('provider') != 'codex_exec':
        raise RuntimeError('batch_codex_provider_mismatch')
    return raw


class Usage(dict):
    def model_dump(self, **_):
        return dict(self)


class BatchClient:
    """The small Chat Completions surface used by local production scripts."""
    def __init__(self, *, model=None, timeout=630, allow_empty=False, **_):
        self.timeout = max(630, timeout)
        self.description = _bridge({'action': 'identity', 'requiredProvider': 'codex_exec'}, model=model)
        self.timeout = max(self.timeout, self.description.get('timeout_ms',600000)/1000+30)
        self.model = self.description['model']
        self.allow_empty = allow_empty
        self.identity = self.description['identity']
        self.cache_identity = VERSION + ':' + json.dumps(self.identity, separators=(',', ':'))
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def raw(self, messages, *, max_tokens=16384, thinking='disabled', images=None, allow_empty=False, **requested):
        system, users, media = [], [], list(images or [])
        cache = Path('D:/Caches/ProgressiveReading/batch-images')
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            for message in messages:
                role, content = message['role'], message['content']
                if isinstance(content, list):
                    texts = []
                    for part in content:
                        if part.get('type') == 'text':
                            texts.append(part['text'])
                        elif part.get('type') == 'image_url':
                            source = part['image_url']['url']
                            if source.startswith('data:image/'):
                                header, encoded = source.split(',', 1)
                                if ';base64' not in header:
                                    raise ValueError('batch_image_requires_base64')
                                data = base64.b64decode(encoded, validate=True)
                            elif source.startswith(('https://', 'http://')):
                                url = urlsplit(source)
                                if url.username or url.password or not url.hostname:
                                    raise ValueError('batch_image_url_credentials_forbidden')
                                with urllib.request.urlopen(source, timeout=60) as response:
                                    data = response.read(32 * 1024 * 1024 + 1)
                            else:
                                raise ValueError('batch_image_source_unsupported')
                            if not data or len(data) > 32 * 1024 * 1024:
                                raise ValueError('batch_image_size_invalid')
                            extension = ('.png' if data.startswith(b'\x89PNG\r\n\x1a\n') else
                                '.jpg' if data.startswith(b'\xff\xd8\xff') else
                                '.gif' if data[:6] in (b'GIF87a', b'GIF89a') else
                                '.webp' if data[:4] == b'RIFF' and data[8:12] == b'WEBP' else None)
                            if extension is None:
                                raise ValueError('batch_image_bytes_unsupported')
                            file = Path(folder) / (str(len(media)) + extension)
                            file.write_bytes(data)
                            media.append({'path': str(file)})
                        else:
                            raise ValueError('batch_content_part_unsupported')
                    content = '\n'.join(texts)
                if not isinstance(content, str):
                    raise ValueError('batch_text_required')
                if role in ('system', 'developer'):
                    system.append(content)
                elif role == 'user':
                    users.append(content)
                elif role == 'assistant':
                    users.append('<previous_assistant_response>\n' + content + '\n</previous_assistant_response>')
                else:
                    raise ValueError('batch_message_role_unsupported')
            result = _bridge({'system': '\n\n'.join(system), 'user': '\n\n'.join(users),
                'images': media, 'requiresVisual': bool(media), 'maxTokens': max_tokens,
                'thinking': thinking, 'allowEmpty': allow_empty,
                'requiredProvider': 'codex_exec', 'expectedIdentity': self.identity},
                timeout=self.timeout, model=self.model)
        result['batch_transport'] = VERSION
        result['transport']['requested_compatibility_parameters'] = {
            k: v for k, v in requested.items()
            if k in ('temperature', 'reasoning_effort', 'response_format', 'extra_body')}
        result['transport']['compatibility_parameters_applied'] = False
        return result

    def create(self, *, messages, **kwargs):
        kwargs.setdefault('allow_empty', self.allow_empty)
        raw = self.raw(messages, **kwargs)
        return SimpleNamespace(model=raw['model'], provider=raw['provider'],
            usage=Usage(raw.get('usage') or {}), transport=raw.get('transport'),
            choices=[SimpleNamespace(finish_reason=item.get('finish_reason'),
                message=SimpleNamespace(**item['message'])) for item in raw['choices']])

    def complete_limited(self, messages, **kwargs):
        if kwargs.get('stream'):
            kwargs = dict(kwargs)
            kwargs.pop('stream')
        return self.raw(messages, **kwargs)

    def close(self):
        pass
