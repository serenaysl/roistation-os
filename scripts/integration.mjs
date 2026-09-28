import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
// Isolated service fixture. The app uses the REAL Blob SDK against these endpoints.
// Per-record layout: every pathname is an independent object with its own ETag.
const token='vercel_blob_rw_qastore_QAOnlySecret';const root='roistation-master/';const legacyStatePath=`${root}v1/state.json`;
const blobs=new Map();let writes=0,conflicts=0,failReads=false,legacyWrites=0;
const legacyPublicationId=randomUUID();const legacyNow=new Date().toISOString();
// Legacy shared snapshot: must be migrated once, then never read or written again.
blobs.set(legacyStatePath,{snapshot:JSON.stringify({schema:1,revision:7,publications:{[legacyPublicationId]:{id:legacyPublicationId,version:1,document:{id:legacyPublicationId,title:'Legacy publication',kind:'content',createdAt:legacyNow,updatedAt:'2020-01-01T00:00:00.000Z',targets:{'mavi-koy-turizm':{status:'draft',payload:{title:'Legacy',body:'Legacy body'}}},events:[{at:legacyNow,action:'created',siteIds:['mavi-koy-turizm']}]}}},connections:{},submissions:{},rates:{},generations:{}}),etag:'"legacy-1"',uploadedAt:new Date().toISOString()});
const isolatedMutable=pathname=>[`${root}connections/`,`${root}rate-limit/`,`${root}generation-fingerprints/`,`${root}vercel/credentials.json`,`${root}vercel/sync-state.json`].some(prefix=>pathname.startsWith(prefix));
const fixture=createServer(async(req,res)=>{
  const error=(status,code,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{code,message}}));};
  const json=(body)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  try {
    if(req.headers.authorization!==`Bearer ${token}`) return error(403,'forbidden','No private access');
    const requestUrl=new URL(req.url,'http://fixture.test');let raw='';for await(const part of req) raw+=part;
    if(req.method==='POST' && requestUrl.pathname.endsWith('/delete')) {
      const {urls=[]}=JSON.parse(raw || '{}');for(const value of urls) {const pathname=String(value).replace(/^https?:\/\/[^/]+\//,'');blobs.delete(pathname);}return json({});
    }
    if(req.method==='GET' && !requestUrl.searchParams.has('pathname')) {
      if(failReads) return error(403,'forbidden','Service inaccessible');
      const prefix=requestUrl.searchParams.get('prefix') || '';const limit=Number(requestUrl.searchParams.get('limit')) || 1000;const offset=Number(requestUrl.searchParams.get('cursor')) || 0;
      const all=[...blobs.keys()].filter(pathname=>pathname.startsWith(prefix)).sort();const page=all.slice(offset,offset+limit);const hasMore=offset+limit<all.length;
      return json({blobs:page.map(pathname=>{const item=blobs.get(pathname);const url=`https://qastore.private.blob.vercel-storage.com/${pathname}`;return {url,downloadUrl:url+'?download=1',pathname,size:Buffer.byteLength(item.snapshot),uploadedAt:item.uploadedAt,etag:item.etag};}),hasMore,...(hasMore ? {cursor:String(offset+limit)} : {})});
    }
    const pathname=requestUrl.searchParams.get('pathname');const current=blobs.get(pathname);
    if(req.method==='GET') {
      if(failReads) return error(403,'forbidden','Service inaccessible');
      if(!current) return error(404,'not_found','Not created');
      res.writeHead(200,{'content-type':'application/json',etag:current.etag,'content-length':Buffer.byteLength(current.snapshot),'last-modified':new Date().toUTCString()});return res.end(current.snapshot);
    }
    assert.equal(req.method,'PUT');assert.equal(req.headers['x-add-random-suffix'],'0');
    if(pathname===legacyStatePath) {legacyWrites++;throw Error('Legacy state.json must never be written');}
    const match=req.headers['x-if-match'];
    if(current && !match && req.headers['x-allow-overwrite']!=='1') {conflicts++;return error(400,'bad_request','Blob already exists');}
    if(match && match!==current?.etag) {conflicts++;return error(412,'precondition_failed','ETag changed');}
    if(current && !match && !isolatedMutable(pathname)) throw Error('Unsafe unconditional overwrite '+pathname);
    JSON.parse(raw);const nextEtag=`"revision-${++writes}"`;
    blobs.set(pathname,{snapshot:raw,etag:nextEtag,uploadedAt:new Date().toISOString()});
    const url=`https://qastore.private.blob.vercel-storage.com/${pathname}`;
    json({url,downloadUrl:url+'?download=1',pathname,contentType:'application/json',contentDisposition:'attachment',etag:nextEtag});
  } catch(error) {console.error('Fixture',error.message);res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'bad_request',message:error.message}}));}
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const dbPort=fixture.address().port;
const env={...process.env,BLOB_READ_WRITE_TOKEN:token,BLOB_STORE_ID:'',VERCEL_OIDC_TOKEN:'',VERCEL_BLOB_API_URL:`http://127.0.0.1:${dbPort}`,PANEL_ADMIN_PASSWORD:'qa-only-password',PANEL_SESSION_SECRET:'qa-only-session-secret-32-random-characters',MASTER_PUBLIC_URL:'https://master.test',ROI_TEST_FIXTURE:'1',ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',VERCEL:''};
const server=spawn(process.execPath,['-r','./scripts/network-shim.cjs','-r','./scripts/fixture-fetch.cjs','node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3210'],{env,stdio:['ignore','pipe','pipe']});
server.stderr.on('data',chunk=>process.stderr.write(chunk));
let cookie='';const base='http://127.0.0.1:3210';
async function api(path,{method='GET',body,auth=true,origin=base}={}) {
  const response=await fetch(base+path,{method,headers:{...(auth && cookie ? {cookie} : {}),...(method!=='GET' ? {'content-type':'application/json',origin} : {})},...(body!==undefined ? {body:JSON.stringify(body)} : {})});
  const data=await response.json();return {response,data};
}
async function create(kind='content',siteIds=['roistation','atlas-yapi','liman-temizlik']) {const result=await api('/api/publications',{method:'POST',body:{title:'QA publication',kind,siteIds,payload:{title:'Test content',body:'Actual body, not only summary.',...(kind==='form' ? {fields:[{id:'email',label:'E-posta',type:'email',required:true}],consentText:'QA consent text'} : {})}}});assert.equal(result.response.status,201,JSON.stringify(result.data));return result.data.publication;}
async function operate(row,action,options={}) {const result=await api('/api/publications',{method:'PATCH',body:{id:row.id,version:row.version,action,all:true,...options}});assert.equal(result.response.status,200,JSON.stringify(result.data));return result.data;}
// Everything live on a site: in-page slot items (forms, homepage content) + indexable SEO/blog pages.
async function feed(id) {const result=await api(`/api/site-content?siteId=${id}`,{auth:false});assert.equal(result.response.status,200,JSON.stringify(result.data));const pages=await api(`/api/site-pages?siteId=${id}`,{auth:false});assert.equal(pages.response.status,200,JSON.stringify(pages.data));return [...result.data.items,...pages.data.pages];}
try {
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Next start timeout')),20000);server.stdout.on('data',data=>{if(data.toString().includes('Ready')) {clearTimeout(timeout);resolve();}});server.once('exit',code=>{clearTimeout(timeout);reject(new Error('Next exited '+code));});});
  assert.equal((await api('/api/publications',{auth:false})).response.status,401);
  assert.equal((await api('/api/submissions/export',{auth:false})).response.status,401);
  const loginBurst=await Promise.all(Array.from({length:8},()=>api('/api/session',{method:'POST',auth:false,body:{password:env.PANEL_ADMIN_PASSWORD}})));
  assert.ok(loginBurst.every(result=>result.response.status===200),JSON.stringify(loginBurst.map(result=>({status:result.response.status,data:result.data}))));
  cookie=loginBurst[0].response.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('/api/publications',{method:'POST',origin:'https://attacker.test',body:{}})).response.status,403);
  const siteList=await api('/api/sites');assert.equal(siteList.response.status,200);assert.ok(siteList.data.sites.length>=8);
  const vercelStatus=await api('/api/vercel');assert.equal(vercelStatus.response.status,200);assert.equal(vercelStatus.data.configured,false);
  assert.equal((await api('/api/cron/vercel-sync',{auth:false})).response.status,401);
  const seo=await api('/api/seo');assert.equal(seo.response.status,200);assert.equal(seo.data.totals,null,'no scans yet: empty state, never sample scores');assert.ok(seo.data.sites.every(site=>site.latest===null));
  assert.equal((await api('/api/github')).data.configured,false);assert.equal((await api('/api/cron/seo-scan',{auth:false})).response.status,401);
  const migratedList=(await api('/api/publications')).data.publications;assert.ok(migratedList.some(row=>row.id===legacyPublicationId && row.document.title==='Legacy publication'),'legacy state.json records are migrated');
  assert.ok(blobs.has(`${root}migrations/state-json-v1.json`) && blobs.has(`${root}publications/${legacyPublicationId}.json`),'per-record objects and migration marker exist');
  const home=await fetch(base,{headers:{cookie}});assert.ok((await home.text()).includes('Site bağlantılarını kontrol et'));
  const blocked=await create();const failure=await operate(blocked,'publish');assert.ok(failure.results.every(result=>result.status==='failed'));assert.equal((await feed('roistation')).length,0);
  for(const [id,domain] of [['roistation','roistation.example'],['atlas-yapi','atlas-yapi.vercel.app']]) {const check=await api('/api/connections',{method:'POST',body:{siteId:id,siteUrl:`https://${domain}`}});assert.equal(check.response.status,200,JSON.stringify(check.data));assert.equal(check.data.connection.verified,true);assert.equal(check.data.connection.status,'connected-widget');}
  const parallelChecks=await Promise.all(Array.from({length:8},()=>api('/api/connections',{method:'POST',body:{siteId:'roistation',siteUrl:'https://roistation.example'}})));assert.ok(parallelChecks.every(check=>check.response.status===200 && check.data.connection.verified===true));
  const ssrf=await api('/api/connections',{method:'POST',body:{siteId:'roistation',siteUrl:'https://127.0.0.1'}});assert.equal(ssrf.response.status,400);
  const draft=await create();const published=await operate(draft,'publish');assert.deepEqual(published.results.map(r=>r.status),['published','published','failed']);assert.ok((await feed('roistation')).some(item=>item.id===draft.id));assert.ok((await feed('atlas-yapi')).some(item=>item.id===draft.id));
  const homeSlot=await api('/api/site-content?siteId=roistation',{auth:false});assert.ok(!homeSlot.data.items.some(item=>item.id===draft.id),'SEO page content is not injected into the homepage');
  const listed=(await api('/api/site-pages?siteId=roistation',{auth:false})).data.pages.find(page=>page.id===draft.id);assert.ok(listed.path.startsWith('/rehber/'));
  const seoPage=await api(`/api/site-page?siteId=roistation&slug=${listed.slug}`,{auth:false});assert.equal(seoPage.response.status,200,JSON.stringify(seoPage.data));assert.equal(seoPage.data.page.seo.canonical,listed.url);assert.ok(seoPage.data.page.jsonLd['@graph'].some(node=>node['@type']==='BreadcrumbList'));
  const sitemap=await fetch(`${base}/api/site-sitemap?siteId=roistation`);assert.ok((await sitemap.text()).includes(`<loc>${listed.url}</loc>`));
  const deleted=await operate(published.publication,'delete',{all:false,siteIds:['roistation']});assert.ok(!(await feed('roistation')).some(item=>item.id===draft.id));assert.ok((await feed('atlas-yapi')).some(item=>item.id===draft.id));assert.equal(deleted.publication.document.targets['roistation'].payload,null);
  const conflict=await api('/api/publications',{method:'PATCH',body:{id:draft.id,version:published.publication.version,action:'delete',all:true}});assert.equal(conflict.response.status,409);
  const withdrawn=await operate(deleted.publication,'withdraw');assert.ok(!(await feed('atlas-yapi')).some(item=>item.id===draft.id));assert.equal((await api(`/api/site-page?siteId=atlas-yapi&slug=${withdrawn.publication.document.targets['atlas-yapi'].slug}`,{auth:false})).response.status,404,'withdrawn SEO page returns 404');assert.ok((await api('/api/publications')).data.publications.some(row=>row.id===draft.id),'withdrawn stays in admin');assert.ok(withdrawn.publication.document.targets['atlas-yapi'].payload);
  const form=await create('form',['roistation','atlas-yapi']);const activeForm=await operate(form,'publish');const token=await api(`/api/form-token?id=${form.id}&siteId=roistation`,{auth:false});assert.equal(token.response.status,200);
  const body={id:randomUUID(),publicationId:form.id,siteId:'roistation',token:token.data.token,answers:{email:'qa@example.test'},consent:true};
  assert.equal((await api('/api/submissions',{method:'POST',auth:false,body:{...body,consent:false}})).response.status,400);
  assert.equal((await api('/api/submissions',{method:'POST',auth:false,body})).response.status,201);
  assert.equal((await api('/api/submissions',{method:'POST',auth:false,body})).response.status,201);
  assert.equal((await api('/api/submissions',{auth:false})).response.status,401);
  const inbox=await api('/api/submissions');assert.equal(inbox.data.submissions.length,1);assert.equal(inbox.data.submissions[0].consent_text,'QA consent text');
  const formClosed=await operate(activeForm.publication,'withdraw',{all:false,siteIds:['roistation']});assert.equal((await api('/api/submissions',{method:'POST',auth:false,body:{...body,id:randomUUID()}})).response.status,410);assert.ok((await feed('atlas-yapi')).some(item=>item.id===form.id));
  const removedForm=await operate(formClosed.publication,'delete');assert.equal(removedForm.removed,true);assert.ok(!(await api('/api/publications?kind=form')).data.publications.some(row=>row.id===form.id),'fully deleted publication leaves the admin list');assert.ok(!blobs.has(`${root}publications/${form.id}.json`),'fully deleted publication leaves storage');assert.ok(!(await feed('atlas-yapi')).some(item=>item.id===form.id));assert.equal((await api('/api/submissions')).data.submissions.length,1);
  const scheduled=await create('content',['roistation']);const future=await operate(scheduled,'publish',{scheduleAt:new Date(Date.now()+3600000).toISOString()});assert.equal(future.results[0].status,'scheduled');assert.ok(!(await feed('roistation')).some(item=>item.id===scheduled.id));
  const scheduledPath=`${root}publications/${scheduled.id}.json`;const scheduledRow=JSON.parse(blobs.get(scheduledPath).snapshot);scheduledRow.document.targets['roistation'].scheduledAt=new Date(Date.now()-1000).toISOString();blobs.set(scheduledPath,{snapshot:JSON.stringify(scheduledRow),etag:`"revision-${++writes}"`,uploadedAt:new Date().toISOString()});assert.ok((await feed('roistation')).some(item=>item.id===scheduled.id));
  assert.equal((await api('/api/publish',{method:'POST',body:{mode:'demo',siteIds:['roistation'],payload:[]}})).response.status,400);
  assert.equal((await api('/api/publications',{method:'POST',body:{title:'Excluded',siteIds:['internal-forms'],payload:{title:'x',body:'x'}}})).response.status,400);
  const generationId=randomUUID();const automationBody={generationId,siteIds:['roistation'],sourceText:'Test original source',goal:'SEO'};
  const automation=await api('/api/automation',{method:'POST',body:automationBody});assert.equal(automation.response.status,200);assert.equal(automation.data.mode,'demo');assert.equal(automation.data.recovered,false);
  const recoveredAutomation=await api('/api/automation',{method:'POST',body:automationBody});assert.equal(recoveredAutomation.response.status,200);assert.equal(recoveredAutomation.data.recovered,true);assert.deepEqual(recoveredAutomation.data.results,automation.data.results);
  const restoredAutomation=await api(`/api/automation?generationId=${generationId}`);assert.equal(restoredAutomation.response.status,200);assert.equal(restoredAutomation.data.recovered,true);assert.deepEqual(restoredAutomation.data.results,automation.data.results);
  const publicationId=randomUUID();const publishBody={publicationId,mode:'anthropic',title:'Idempotent AI publication',siteIds:['roistation'],payload:[{siteId:'roistation',title:'Saved AI title',summary:'Saved summary',body:'Saved complete body',metaTitle:'Saved meta',metaDescription:'Saved description'}]};
  const firstPublish=await api('/api/publish',{method:'POST',body:publishBody});assert.equal(firstPublish.response.status,200,JSON.stringify(firstPublish.data));assert.equal(firstPublish.data.publication.id,publicationId);
  const secondPublish=await api('/api/publish',{method:'POST',body:publishBody});assert.equal(secondPublish.response.status,200,JSON.stringify(secondPublish.data));assert.equal(secondPublish.data.publication.id,publicationId);
  assert.equal((await api('/api/publications')).data.publications.filter(row=>row.id===publicationId).length,1);
  const parallel=await Promise.all(Array.from({length:5},()=>create('content',['roistation'])));const saved=(await api('/api/publications')).data.publications;assert.ok(parallel.every(row=>saved.some(s=>s.id===row.id)));
  const same=await create('content',['roistation']);const racing=await Promise.all(['withdraw','delete'].map(action=>api('/api/publications',{method:'PATCH',body:{id:same.id,version:same.version,action,all:true}})));assert.deepEqual(racing.map(r=>r.response.status).sort(),[200,409]);assert.ok(conflicts>0,'CAS must reject racing writes on the same publication object');
  const exported=await api('/api/submissions/export');assert.equal(exported.response.status,200);assert.equal(exported.data.submissions.length,1);
  failReads=true;assert.equal((await api('/api/site-content?siteId=roistation',{auth:false})).response.status,503);failReads=false;
  assert.equal([...blobs.keys()].filter(pathname=>pathname.startsWith(`${root}submissions/`)).length,1);assert.equal(legacyWrites,0);assert.ok(!JSON.stringify(await feed('roistation')).includes('qa@example.test'));
  const deleteLead=await api('/api/submissions',{method:'DELETE',body:{id:body.id}});assert.equal(deleteLead.response.status,200);assert.equal((await api('/api/submissions')).data.submissions.length,0);
  console.log(JSON.stringify({storage:'real Blob SDK/local service fixture',privacy:'server-only',cas:'per-object conditional writes',layout:'one Blob object per record',migration:'state.json migrated once',seoPages:'own URL + canonical + JSON-LD + sitemap',homepage:'no article injection',verification:'endpoint → widget fallback',vercel:'not configured → safe',auth:'ok',csrf:'ok',publish:'partial results',selectiveDelete:'ok',withdraw:'ok',allDelete:'ok',formSubmission:'external store/idempotent',closedForm:'rejected',schedule:'ok',revisionConflict:'409',readFailure:'fails closed',demo:'never published'}));
  if(process.env.ROI_QA_KEEP==='1') {console.log('QA_READY http://127.0.0.1:3210');await new Promise(resolve=>process.once('SIGTERM',resolve));}
} finally {server.kill('SIGTERM');await new Promise(resolve=>fixture.close(resolve));}
