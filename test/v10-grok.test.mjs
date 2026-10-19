// v0.10 Grok Build CLI 추가: 결과 파서 · 인증 판정(키 이름만) · 프롬프트 임시 파일 · 배포 config/이미지
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,mkdir,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {PARSERS,AUTH_PARSERS,runAdapter,buildArgs,loadConfig,ROOT} from '../src/adapters/index.mjs';

test('grok-json 파서: 문서의 json 객체 → 본문·세션·사용량(캐시·추론 포함), 오류 객체는 실패', ()=>{
  const ok=JSON.stringify({text:'요즘 X 에서 뜨는 키워드는…',stopReason:'end_turn',sessionId:'abc123',requestId:'r',cwd:'/w',num_turns:3,usage:{input_tokens:700,cache_read_input_tokens:4000,cache_creation_input_tokens:0,output_tokens:180,reasoning_tokens:40,total_tokens:4920}});
  const r=PARSERS['grok-json']('경고 한 줄\n'+ok+'\n');
  assert.equal(r.text,'요즘 X 에서 뜨는 키워드는…');assert.equal(r.session,'abc123');
  assert.deepEqual({input:r.usage.input,output:r.usage.output},{input:4700,output:220});
  assert.throws(()=>PARSERS['grok-json']('{"type":"error","message":"Not signed in"}'),/^Error: grok_error$/);
  assert.throws(()=>PARSERS['grok-json']('그냥 글자'),/grok_result_missing/);
});

test('grok 인증: auth.json 의 세션 토큰 키 → 구독, api_key 만 → 차단, config.toml 의 api_key → 차단, 없음 → 미로그인 (값은 출력 안 함)', async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'v10g-'));const g=path.join(home,'.grok');await mkdir(g);
  const run=()=>{const r=spawnSync(process.execPath,[path.join(ROOT,'src/adapters/grok-auth-status.mjs')],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});return {raw:r.stdout,...AUTH_PARSERS['grok-json'](r.stdout)};};
  assert.equal(run().state,'not_logged_in');
  await writeFile(path.join(g,'auth.json'),JSON.stringify({'grok.com':{access_token:'SECRET-AT',refresh_token:'SECRET-RT',expires_at:1}}));
  let r=run();assert.equal(r.state,'subscription');assert.equal(r.subscriptionType,'x-subscription');assert.ok(!r.raw.includes('SECRET'),'토큰 값이 출력에 없음');
  await writeFile(path.join(g,'auth.json'),JSON.stringify({api_key:'xai-SECRET'}));
  r=run();assert.equal(r.state,'api_key');assert.ok(!r.raw.includes('SECRET'));
  await writeFile(path.join(g,'auth.json'),JSON.stringify({'grok.com':{access_token:'a'}}));
  await writeFile(path.join(g,'config.toml'),'[model.grok-4]\napi_key = "xai-x"\n');
  assert.equal(run().state,'api_key');
});

test("promptVia 'file': 프롬프트를 사용자 임시 폴더의 0600 파일로 넘기고 끝나면 지운다", async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'v10p-'));
  const script=`const fs=require('fs');const p=process.argv[process.argv.indexOf('--prompt-file')+1];const st=fs.statSync(p);process.stdout.write(JSON.stringify({text:fs.readFileSync(p,'utf8')+'|'+(st.mode&0o777).toString(8),sessionId:'s9'}))`;
  const a={id:'g',command:process.execPath,args:['-e',script,'--','--prompt-file','{promptFile}'],promptVia:'file',parse:'grok-json'};
  const big='가'.repeat(150000);   // 인자로 넘기면 Linux 한 인자 상한(128KB)을 넘는 길이
  const r=await runAdapter(a,{prompt:big,cwd:tmp,parentEnv:{PATH:process.env.PATH},extraEnv:{TMPDIR:tmp}});
  assert.equal(r.text,big+'|600');assert.equal(r.session,'s9');
  assert.deepEqual(await readdir(tmp),[],'임시 파일 삭제');
  assert.ok(!buildArgs(a,{prompt:'비밀 프롬프트',promptFile:'/x/p.txt'}).join(' ').includes('비밀'),'프롬프트가 인자에 안 실림');
});

test('배포 config: Grok 은 구독 로그인(기기 코드)·삭제/과금 차단 규칙·역할 설명·아바타, 이미지에 고정 버전 설치', async()=>{
  const cfg=await loadConfig();const g=cfg.adapters.find(a=>a.id==='grok');
  assert.ok(g&&g.enabled);assert.equal(g.promptVia,'file');assert.equal(g.parse,'grok-json');
  assert.deepEqual(g.login.args,['login','--device-auth']);
  assert.ok(g.args.includes('--always-approve'));assert.ok(g.args.includes('--no-auto-update'));
  const deny=g.args.flatMap((x,i)=>x==='--deny'?[g.args[i+1]]:[]);
  for(const must of ['Bash(rm*)','Bash(git reset --hard*)','Bash(railway*)','Bash(stripe*)'])assert.ok(deny.includes(must),must);
  assert.deepEqual(g.resumeArgs,['-r','{session}']);
  assert.equal(g.runTimeoutMs,1800000,'v0.10.1: Grok 만 30분');assert.equal(g.args[g.args.indexOf('--max-turns')+1],'40');
  for(const id of ['claude','codex','gemini'])assert.equal(cfg.adapters.find(a=>a.id===id).runTimeoutMs,undefined,'다른 AI 는 기본 15분');
  assert.equal(cfg.timeoutMs,900000);
  assert.match(g.roleHint,/트렌드/);assert.equal(g.avatar,'avatar-grok.jpg');
  await readFile(path.join(ROOT,'public/avatar-grok.jpg'));
  const docker=await readFile(path.join(ROOT,'Dockerfile'),'utf8');
  assert.match(docker,/@xai-official\/grok@1\.0\.62/);assert.match(docker,/grok --version/);
  const app=await readFile(path.join(ROOT,'public/app.js'),'utf8');assert.match(app,/grok:\['그록','grok'/);
});
