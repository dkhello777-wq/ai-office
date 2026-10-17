// Independent v0.6 follow-up review. Expected-correctness assertions intentionally
// expose remaining defects. Local fixtures only; no provider or real credentials.
// Run: node --test test/v06-followup-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,access} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Store} from '../src/store.mjs';
import {runAdapter} from '../src/adapters/index.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const temp=()=>mkdtemp(path.join(os.tmpdir(),'hub-v06-review-'));
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
async function poll(fn,ms=6000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(25);}throw Error('fixture condition timeout');}

test('F02 control: group SIGKILL works when parent also ignores SIGTERM',async t=>{
  const d=await temp();
  const pidFile=path.join(d,'descendant-heartbeat');
  // Observe liveness through a heartbeat: executor child PID namespaces can make
  // a child's process.pid invalid in its parent's namespace. A stop file also
  // guarantees cleanup without guessing cross-namespace process IDs.
  t.after(async()=>{await writeFile(pidFile+'.stop','stop');await delay(250);await rm(d,{recursive:true,force:true});});
  const leaf=path.join(d,'leaf.cjs'),parent=path.join(d,'parent.cjs');
  await writeFile(leaf,'const fs=require("node:fs"),f=process.argv[2];process.on("SIGTERM",()=>{});const beat=()=>{if(fs.existsSync(f+".stop"))process.exit(0);fs.writeFileSync(f,String(Date.now()));};beat();setInterval(beat,100);');
  await writeFile(parent,'process.on("SIGTERM",()=>{});require("node:child_process").spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:["ignore",process.stdout,process.stderr]});setInterval(()=>{},1000);');
  const started=Date.now();
  const result=await runAdapter({id:'tree',command:process.execPath,args:[parent,leaf,pidFile],parse:'plain'},
    {cwd:d,prompt:'fixture',timeoutMs:800,parentEnv:{PATH:process.env.PATH}}).catch(e=>e);
  assert.ok(Number(await readFile(pidFile,'utf8'))>0,'Descendant fixture must have started');
  assert.equal(result.message,'cli_timeout');
  const returned=Date.now()-started;
  await delay(Math.max(0,4300-(Date.now()-started)));
  const firstHeartbeat=await readFile(pidFile,'utf8');await delay(250);
  const alive=firstHeartbeat!==await readFile(pidFile,'utf8');
  t.diagnostic('Adapter returned after '+returned+'ms; descendant still running after '+(Date.now()-started)+'ms: '+alive);
  assert.equal(alive,false,'SIGKILL grace elapsed but descendant survived');
});
