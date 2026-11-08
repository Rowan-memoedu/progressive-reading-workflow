"""Python adapter to the existing unified reading producer. No API credentials."""
import json
import os
from pathlib import Path
import subprocess


def bridge(payload, timeout=630):
    result=subprocess.run([os.environ.get('PR_READING_NODE','node'),str(Path(__file__).with_name('producer-text.mjs'))],
        input=json.dumps(payload,ensure_ascii=False),capture_output=True,text=True,encoding='utf-8',timeout=timeout,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode:
        code=result.stderr.strip()
        if code not in ('producer_requires_codex_exec','producer_identity_changed','producer_visual_images_required','producer_codex_routing_timeout'):
            code='reading_producer_text_failed'
        raise ValueError(code)
    return json.loads(result.stdout)


class ProducerTransport:
    def __init__(self,required_provider=None):
        self.required_provider=required_provider
        self.description=bridge({'action':'identity','requiredProvider':required_provider})
        self.identity=self.description['identity']
        self.provider=self.description['provider']
        self.model=self.description['model']

    def call(self,system,user,*,max_tokens=16384,images=None,requires_visual=False):
        return bridge({'system':system,'user':user,'maxTokens':max_tokens,'images':images or [],
                       'requiresVisual':requires_visual,'requiredProvider':self.required_provider,
                       'expectedIdentity':self.identity},max(10,self.description['timeout_ms']/1000)+30)

    def frozen_call(self,directory,system,user,*,max_tokens=16384):
        """A resumed stage cannot relabel an API response as Codex output."""
        directory=Path(directory)
        directory.mkdir(parents=True,exist_ok=True)
        identity_file=directory/'transport-identity.json'
        response_file=directory/'model-response.json'
        identity={'version':'unified-reading-transport/v1','identity':self.identity}
        if response_file.exists() and not identity_file.exists():
            raise ValueError('legacy_stage_cache_requires_new_output_directory')
        if identity_file.exists():
            if json.loads(identity_file.read_text('utf-8'))!=identity:
                raise ValueError('stage_cache_producer_mismatch_requires_new_output_directory')
        else:
            with identity_file.open('x',encoding='utf-8') as handle:
                handle.write(json.dumps(identity,ensure_ascii=False,indent=2)+'\n')
        if response_file.exists():
            raw=json.loads(response_file.read_text('utf-8'))
            if raw.get('producer_identity')!=self.identity:raise ValueError('saved_response_producer_mismatch')
            return raw,True
        try:
            with (directory/'request-sent.json').open('x',encoding='utf-8') as handle:
                handle.write('{"requests_sent":1}\n')
        except FileExistsError:
            raise ValueError('stage_request_outcome_unknown; automatic_retry_disabled') from None
        raw=self.call(system,user,max_tokens=max_tokens)
        with response_file.open('x',encoding='utf-8') as handle:
            handle.write(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
        return raw,False
