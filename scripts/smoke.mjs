import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const server=spawn(process.execPath,['-r','./scripts/network-shim.cjs','node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3210'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PANEL_ADMIN_PASSWORD:'',PANEL_SESSION_SECRET:'',BLOB_READ_WRITE_TOKEN:'',BLOB_STORE_ID:''}});
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server timeout')),20000);server.stdout.on('data',chunk=>{if(chunk.toString().includes('Ready')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});});
  const home=await fetch('http://127.0.0.1:3210');assert.equal(home.status,200);assert.ok((await home.text()).includes('ROIstation'));
  for(const path of ['/api/publications','/api/connections','/api/submissions','/api/integration-status']) assert.equal((await fetch('http://127.0.0.1:3210'+path)).status,503,path);
  const session=await (await fetch('http://127.0.0.1:3210/api/session')).json();assert.equal(session.configured,false);assert.equal(session.authenticated,false);
  console.log(JSON.stringify({home:'setup/login',privateAPIs:'503 until configured',unconfiguredAdmin:'locked'}));
} finally {server.kill('SIGTERM');}
