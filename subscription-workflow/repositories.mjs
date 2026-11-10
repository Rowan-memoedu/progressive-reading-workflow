import {loadConfig} from './config.mjs';
import {repositoryHead} from '../site-import/repository.mjs';

// Reuse the application's persistent site-import requests and their recovery IDs.
export async function scanRepositories(root,cycle,{fetchImpl=globalThis.fetch,headFn=repositoryHead,endpoint=process.env.PROGRESSIVE_READING_ENDPOINT || 'http://127.0.0.1:37829'}={}) {
  const config=await loadConfig(root),results=[],errors=[];
  async function api(route,input){
    const response=await fetchImpl(endpoint+route,input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(45000)}:{signal:AbortSignal.timeout(45000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'repository_import_api_'+response.status);return data;
  }
  for(const source of config?.subscriptions.filter(s=>s.enabled&&s.kind==='github_repository')||[]){
    try{
      const head=await headFn(source.repository),listing=await api('/api/site-imports');
      let site=listing.sources.find(s=>s.repository?.url===source.repository.url&&s.repository?.branch===source.repository.branch&&s.repository?.content_root===source.repository.content_root);
      if(!site){const saved=await api('/api/site-imports/source',{revision:listing.revision,source:{name:source.name,url:source.repository.public_base,scope:'documents',destination:source.destination,processing_mode:'original_text',generate_guide:false,generate_index:false,repository:source.repository}});site=saved.source;}
      const run=await api('/api/site-imports/start',{source_id:site.id,client_request_id:`repository-${source.id}-${head.sha}`});
      const failed=['failed','completed_with_failures'].includes(run.phase);
      if(failed){errors.push({subscription_id:source.id,url:source.url,error:run.error||'仓库导入仍有失败项；可在导入管理重试'});}
      results.push({subscription_id:source.id,commit:head.sha,run_id:run.id,phase:run.phase,counts:run.counts});
    }catch(error){errors.push({subscription_id:source.id,url:source.url,error:error.message});}
  }
  return {results,errors};
}
