// v0.8.7: 코딩·검수 환경 보완 — 2026-10-18 실배포에서 다섯 작업이 전부 '완료' 로 표시됐지만 결과물이 없었던 사례의 회귀 테스트.
//  1) Codex 샌드박스(bwrap)가 컨테이너에서 못 떠 명령이 하나도 실행되지 않았는데 exit 0 → sandbox_failed 로 실패 처리
//  2) exit 0 + 형식은 맞지만 본문이 빈 답변(agy 도구 승인 거부) → empty_result 로 실패 처리
//  3) 파서가 던진 고정 오류 코드는 그대로 전달, 원본 예외 문구는 parse_failed 로 뭉갬
//  4) 배포 config: 세 CLI 모두 비대화형 자동 승인 플래그를 갖는다 (없으면 코딩 작업이 읽기만 하고 끝남)
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {PARSERS,runAdapter,loadConfig,buildArgs} from '../src/adapters/index.mjs';
import {readFile} from 'node:fs/promises';

test('server: every prompt starts with the behaviour rules (no deletion, no spending → stop and write [승인 요청]); approval mark is flagged on done answers',async()=>{
  const src=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(src,/export const APPROVAL_MARK='\[승인 요청\]'/);
  assert.match(src,/p\+=`\\n\\n`\+RULES_NOTE\.trimEnd\(\);[^\n]*\n\s*return p;/,'composePrompt must end every prompt with RULES_NOTE');
  assert.match(src,/### HUB:TASK \$\{i\+1\}\/\$\{parsed\.tasks\.length\} — \$\{t\.title\}\\n\$\{t\.prompt\}\$\{envNote\}\$\{fileNote\}\\n\\n\$\{RULES_NOTE\.trimEnd\(\)\}/,'worker task prompts must end with RULES_NOTE');
  assert.match(src,/approvalRequested=r\.text\.trimStart\(\)\.startsWith\(APPROVAL_MARK\)/);
  assert.match(src,/RULES_NOTE=`\[행동 규칙[\s\S]*삭제[\s\S]*과금[\s\S]*\$\{APPROVAL_MARK\}/);
});

const line=o=>JSON.stringify(o)+'\n';

test('codex-jsonl: bwrap namespace failure inside command_execution → sandbox_failed even though the model still "answered"',()=>{
  const out=line({type:'thread.started',thread_id:'t1'})
    +line({type:'item.completed',item:{id:'i1',type:'command_execution',command:'cat subtitle_proofreader.py',aggregated_output:'bwrap: Creating new namespace failed: Permission denied\n',exit_code:1,status:'failed'}})
    +line({type:'item.completed',item:{id:'i2',type:'agent_message',text:'파일을 읽을 수 없어 작업을 수행하지 못했습니다.'}})
    +line({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}});
  assert.throws(()=>PARSERS['codex-jsonl'](out),/^Error: sandbox_failed$/);
  // 샌드박스가 정상이면(명령 성공) 같은 모양이 그대로 답변이 된다
  const ok=out.replace('bwrap: Creating new namespace failed: Permission denied\\n','import json\\n').replace('"exit_code":1,"status":"failed"','"exit_code":0,"status":"completed"');
  assert.equal(PARSERS['codex-jsonl'](ok).text,'파일을 읽을 수 없어 작업을 수행하지 못했습니다.');
});

test('runAdapter: exit 0 with an empty answer body is empty_result, not done; a fixed parser error code passes through, raw messages collapse to parse_failed',async()=>{
  const run=(script,parse)=>runAdapter({id:'t',command:process.execPath,args:['-e',script],parse},{cwd:os.tmpdir(),prompt:'x',parentEnv:{PATH:process.env.PATH}}).catch(e=>e);
  // agy: status SUCCESS 인데 response 가 빈 문자열 (도구 승인이 전부 거부된 뒤)
  const agy=await run(`process.stdout.write(${JSON.stringify(line({event:'result',result:{status:'SUCCESS',response:'',conversation_id:'c1',usage:{input_tokens:1,output_tokens:0}}}))})`,'agy-stream-json');
  assert.equal(agy.message,'empty_result');assert.equal(agy.exitCode,0);assert.equal(agy.session,'c1');
  // claude: result 가 공백만
  const cl=await run(`process.stdout.write(JSON.stringify({result:'  \\n',session_id:'s1'}))`,'claude-json');
  assert.equal(cl.message,'empty_result');
  // 정상 본문은 그대로 성공
  const ok=await run(`process.stdout.write(JSON.stringify({result:'OK',session_id:'s1'}))`,'claude-json');
  assert.equal(ok.text,'OK');
  // 고정 코드(agy_status_error)는 그대로, JSON.parse 의 원문 예외는 parse_failed
  const st=await run(`process.stdout.write(${JSON.stringify(line({event:'result',result:{status:'ERROR',response:'x'}}))})`,'agy-stream-json');
  assert.equal(st.message,'agy_status_error');assert.equal(st.parseFailed,true);
  const bad=await run(`process.stdout.write('not json at all')`,'claude-json');
  assert.equal(bad.message,'parse_failed');
});

test('deployed adapters.json: every real CLI runs non-interactively with tool approvals bypassed (coding tasks must be able to write files and run commands)',async()=>{
  const cfg=await loadConfig();
  const by=Object.fromEntries(cfg.adapters.map(a=>[a.id,a]));
  const codex=buildArgs(by.codex,{prompt:'p',session:null}),codexResume=buildArgs(by.codex,{prompt:'p',session:'S'});
  for(const args of [codex,codexResume]){
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'),'codex must not use its own bwrap sandbox inside the container: '+args.join(' '));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.equal(args.at(-1),'-','prompt still comes from stdin');
  }
  assert.equal(codexResume[1],'resume');assert.equal(codexResume[2],'S');
  // Claude: 편집 자동 승인 + 셸 허용, 단 삭제·과금 명령은 거부 목록 (사용자 지시: 파일 삭제·추가 과금은 허락을 받을 것)
  const claude=buildArgs(by.claude,{prompt:'p',session:null});
  const pm=claude.indexOf('--permission-mode');assert.ok(pm>=0);assert.equal(claude[pm+1],'acceptEdits');
  assert.ok(!claude.includes('bypassPermissions'),'bypassPermissions would also allow rm and paid CLIs');
  const allowed=claude.slice(claude.indexOf('--allowedTools')+1,claude.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('Bash'));
  const denied=claude.slice(claude.indexOf('--disallowedTools')+1);
  for(const must of ['Bash(rm:*)','Bash(rmdir:*)','Bash(git reset --hard:*)','Bash(git push --force:*)','Bash(railway:*)','Bash(aws:*)','Bash(gcloud:*)','Bash(npm publish:*)'])assert.ok(denied.includes(must),'missing deny rule '+must);
  assert.ok(denied.every(d=>/^Bash\(.+\)$/.test(d)),'deny list must be Bash(...) rules only: '+denied.join(' '));
  assert.ok(claude.includes('-p')&&claude.includes('json'));
  const agy=buildArgs(by.gemini,{prompt:'p',session:null});
  assert.ok(agy.includes('--dangerously-skip-permissions'));
  assert.ok(agy.includes('stream-json'));
});
