"""Read-only standalone CommonMark/Mermaid/KaTeX render verification, not an Obsidian session."""
import argparse,hashlib,html,json,re,subprocess,sys,urllib.request
from pathlib import Path

def render(markdown_file,output):
    from markdown_it import MarkdownIt
    source=markdown_file.read_text('utf-8');text=re.sub(r'^---\n[\s\S]*?\n---\n','',source,count=1)
    code={};prefix='PRRENDER'+hashlib.sha256(source.encode()).hexdigest()[:12]
    # Protect literal code from the audit renderer's math tokenization.
    lines=text.splitlines(keepends=True);parts=[];i=0
    while i<len(lines):
        opening=re.match(r'^\s*(?:-\s+)?(`{3,}|~{3,})([^\n]*)',lines[i])
        if not opening:parts.append(lines[i]);i+=1;continue
        start=i;i+=1
        while i<len(lines) and not re.fullmatch(r'\s*'+re.escape(opening[1][0])+r'{'+str(len(opening[1]))+r',}\s*',lines[i]):i+=1
        if i==len(lines):raise ValueError('unclosed_source_fence')
        i+=1;key=prefix+'CODE'+str(len(code))+'END';code[key]=''.join(lines[start:i]);parts.append(key+'\n')
    text=''.join(parts);math=[]
    def store(match,display=False):
        key=prefix+'MATH'+str(len(math))+'END';math.append({'key':key,'tex':match[1],'display':display});return key
    text=re.sub(r'\$\$([\s\S]+?)\$\$',lambda m:store(m,True),text)
    text=re.sub(r'(?<!\\)\$(?!\$)([^\n$]+?)(?<!\\)\$',store,text)
    for key,value in code.items():text=text.replace(key,value)
    md=MarkdownIt('commonmark',{'html':False});native=md.renderer.rules['fence']
    def fence(tokens,idx,options,env):
        token=tokens[idx]
        if token.info.strip()=='mermaid':return '<pre class="mermaid">'+html.escape(token.content)+'</pre>\n'
        return native(tokens,idx,options,env)
    md.renderer.rules['fence']=fence
    body=md.render(text)
    for idx,row in enumerate(math):body=body.replace(row['key'],'<span class="source-math" data-math="'+str(idx)+'"></span>')
    cache=Path(r'D:\Caches\ProgressiveReading\render-assets');cache.mkdir(parents=True,exist_ok=True)
    libs={'mermaid-10.6.1.min.js':'https://cdn.jsdelivr.net/npm/mermaid@10.6.1/dist/mermaid.min.js','katex-0.16.11.min.js':'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js'}
    for name,url in libs.items():
        file=cache/name
        if not file.is_file():
            print(json.dumps({'stage':'render_dependency','library':name}),flush=True)
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(req,timeout=90) as response:file.write_bytes(response.read())
    payload=json.dumps(math,ensure_ascii=False).replace('<','\\u003c')
    document='''<!doctype html><html><head><meta charset="utf-8"><base href="BASE"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"><style>body{max-width:1050px;margin:35px auto;font:18px/1.65 Arial,"Microsoft YaHei",sans-serif;color:#17212b}img{max-width:100%;height:auto}li{margin:.45em 0}.katex-display{overflow-x:auto}pre{white-space:pre-wrap}svg{max-width:100%;height:auto}</style></head><body>BODY<script src="MERMAID"></script><script src="KATEX"></script><script type="application/json" id="math-input">PAYLOAD</script><script>
window.renderErrors=[];window.auditDone=false;(async()=>{try{
const formulas=JSON.parse(document.getElementById('math-input').textContent);
for(const node of document.querySelectorAll('[data-math]')){const i=Number(node.dataset.math),f=formulas[i];try{katex.render(f.tex,node,{displayMode:f.display,throwOnError:true,strict:'error'});}catch(e){renderErrors.push({kind:'math',index:i,formula:f.tex,error:String(e)});}}
mermaid.initialize({startOnLoad:false,securityLevel:'strict'});try{await mermaid.run({nodes:[...document.querySelectorAll('.mermaid')]});}catch(e){renderErrors.push({kind:'mermaid',error:String(e)});}
await Promise.all([...document.images].map(async image=>{try{await image.decode();}catch(e){renderErrors.push({kind:'image',src:image.getAttribute('src')});}}));await document.fonts.ready;
}catch(e){renderErrors.push({kind:'runtime',error:String(e)});}window.auditDone=true;})();</script></body></html>'''
    for key,value in [('BASE',markdown_file.parent.as_uri()+'/'),('BODY',body),('MERMAID',(cache/'mermaid-10.6.1.min.js').as_uri()),('KATEX',(cache/'katex-0.16.11.min.js').as_uri()),('PAYLOAD',payload)]:document=document.replace(key,value)
    output.mkdir(parents=True,exist_ok=True);file=output/'preview.html';file.write_text(document,'utf-8')
    python=r'D:\Caches\ProgressiveReading\videobook-python\Scripts\python.exe'
    subprocess.run([python,str(Path(__file__).resolve()),'--browser',str(file),'--output',str(output)],check=True)

def browser(file,output):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='chrome',headless=True)
        try:
            page=browser.new_page(viewport={'width':1440,'height':1100},device_scale_factor=1)
            page.goto(file.as_uri(),wait_until='load',timeout=120000);page.wait_for_function('window.auditDone===true',timeout=180000)
            result=page.evaluate('''()=>({errors:renderErrors,images:[...document.images].map(i=>({src:i.getAttribute('src'),width:i.naturalWidth,height:i.naturalHeight,complete:i.complete})),mermaid_blocks:document.querySelectorAll('.mermaid').length,rendered_diagrams:document.querySelectorAll('.mermaid svg').length,math_blocks:document.querySelectorAll('[data-math]').length,rendered_math:document.querySelectorAll('[data-math] .katex').length})''')
            page.screenshot(path=str(output/'reading-preview.png'))
            if result['images']:page.locator('img').first.scroll_into_view_if_needed();page.screenshot(path=str(output/'body-preview.png'))
            result.update(status='passed' if not result['errors'] and result['rendered_diagrams']==result['mermaid_blocks'] and result['rendered_math']==result['math_blocks'] else 'failed',renderer='standalone CommonMark + Mermaid 10.6.1 + KaTeX 0.16.11',native_obsidian_session=False,markdown_modified=False)
            (output/'render-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n','utf-8');print(json.dumps(result,ensure_ascii=False),flush=True)
            if result['status']!='passed':raise ValueError('reading_render_failed')
        finally:browser.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--markdown',type=Path);p.add_argument('--browser',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    browser(a.browser,a.output) if a.browser else render(a.markdown.resolve(),a.output.resolve())
