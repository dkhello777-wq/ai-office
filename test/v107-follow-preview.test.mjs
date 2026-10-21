// v0.10.7 따라가기 스크롤(↓ 새 글 버튼) · 첨부 파일 미리보기 카드 (화면 코드 고정)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const ROOT=new URL('..',import.meta.url).pathname;

test('따라가기: follow 플래그로 맨 아래 판단, 새 글·늘어나는 답·이미지 로드에 따라 내려가고, 위를 보면 ↓ 새 글 버튼', async()=>{
  const app=await readFile(ROOT+'public/app.js','utf8');
  assert.match(app,/let follow=true,unseen=0;/);
  assert.match(app,/function scrollBottom\(\)\{follow=true;unseen=0;const c=\$\('#chat'\);c\.scrollTop=c\.scrollHeight;requestAnimationFrame\(/);
  assert.match(app,/const atBottom=follow;/,'거리 계산 대신 follow (content-visibility 때문에 scrollHeight 가 부정확)');
  assert.match(app,/\$\('#chat'\)\.addEventListener\('scroll',\(\)=>\{const was=follow;follow=nearBottom\(\);/);
  assert.match(app,/if\(isNew\)\{if\(follow\)scrollBottom\(\);else\{unseen\+\+;renderJump\(\);\}\}/);
  assert.match(app,/if\(t&&p\.partial\)\{t\.textContent=p\.partial;if\(g\)g\.textContent=prog;if\(follow\)scrollBottom\(\);\}/);
  assert.match(app,/\$\('#timeline'\)\.addEventListener\('load',\(\)=>\{if\(follow\)scrollBottom\(\);\},true\)/);
  assert.match(app,/follow=false;   \/\/ 위를 보려는 것이니/,'이전 대화 더 보기는 따라가기 끔');
  const html=await readFile(ROOT+'public/index.html','utf8');assert.match(html,/<button id="jump" class="jump" hidden>/);
});

test('첨부 미리보기: 글·코드는 앞부분(Range 600자), 영상은 플레이어, 그 밖은 아이콘 카드; 입력창 위 첨부 줄도 같은 카드', async()=>{
  const app=await readFile(ROOT+'public/app.js','utf8');
  assert.match(app,/function fileCardHtml\(n,\{rm=false\}=\{\}\)/);
  assert.match(app,/headers:\{range:'bytes=0-599'\}/);
  assert.match(app,/const files='';   \/\/ v0\.10\.7/);
  assert.match(app,/docs\.length\?`<div class="fcards me-files">\$\{docs\.map\(f=>fileCardHtml\(f\)\)\.join\(''\)\}<\/div>`/);
  assert.match(app,/vids\.map\(f=>`<video src="\/files\/\$\{encodeURIComponent\(f\)\}" controls playsinline preload="none"><\/video>`\)/);
  assert.match(app,/bindActions\(el\);fillPreviews\(el\);return el;/,'v0.10.8: 새 노드마다 미리보기·버튼 바인딩');
  assert.match(app,/:fileCardHtml\(n,\{rm:true\}\)\)\.join\(''\);fillPreviews\(row\);/);
  const css=await readFile(ROOT+'public/style.css','utf8');
  for(const sel of ['.fcard{','.fcard .fprev{','.attach-row .fcard{','.jump{'])assert.ok(css.includes(sel),sel);
});

test('v0.10.10 이미지 크게 보기: 새 탭 대신 앱 안 라이트박스(저장·원본·닫기, 이미지 탭은 안 닫힘), 쿠키는 SameSite=Lax', async()=>{
  const app=await readFile(ROOT+'public/app.js','utf8');
  assert.match(app,/function openLightbox\(url,name\)/);assert.match(app,/const a=e\.target\.closest\('\.media a'\);if\(!a\|\|!a\.querySelector\('img'\)\)return;e\.preventDefault\(\);openLightbox/);
  assert.match(app,/if\(e\.target\.closest\('\.lb-close'\)\|\|e\.target===e\.currentTarget\)closeLightbox\(\);\}\);/);
  const html=await readFile(ROOT+'public/index.html','utf8');assert.match(html,/<div id="lightbox" class="lightbox" hidden><img alt=""><div class="lb-bar">.*lb-dl" download>저장<\/a>.*lb-open" target="_blank".*lb-close">닫기/);
  const srv=await readFile(ROOT+'src/server.mjs','utf8');assert.match(srv,/hub=\$\{token\}; Path=\/; HttpOnly; SameSite=Lax;/);assert.doesNotMatch(srv,/SameSite=Strict/);
});

test('v0.10.13 실패 이유를 쉬운 말로: 무슨 일·원인 추정·다음 할 일, 원래 오류 출력은 접어 둠', async()=>{
  const app=await readFile(ROOT+'public/app.js','utf8');
  assert.match(app,/function failureInfo\(m\)/);assert.match(app,/function failureHtml\(m,icon\)/);
  assert.match(app,/else if\(m\.status==='blocked'\)body=failureHtml\(m,'🚫'\);/);assert.match(app,/else body=failureHtml\(m,'⚠️'\);/);
  for(const code of ['cli_timeout','interrupted','quota_exhausted','not_logged_in','sandbox_failed','plan_parse_failed','budget_exceeded'])assert.ok(app.includes(`    ${code}:[`),code);
  assert.match(app,/429\|rate\.\?limit\|too many requests/);assert.match(app,/<details><summary>자세한 오류 출력<\/summary>/);
  const srv=await readFile(ROOT+'src/server.mjs','utf8');assert.match(srv,/runTimeoutMs:Number\.isSafeInteger\(a\.runTimeoutMs\)&&a\.runTimeoutMs>0\?a\.runTimeoutMs:config\.timeoutMs\}\)\)/);
});
