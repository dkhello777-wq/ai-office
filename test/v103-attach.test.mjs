// v0.10.3 첨부: 끌어다 놓기 · 붙여넣기 · 미리보기 (화면 코드 고정)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('끌어다 놓기·붙여넣기·📎 가 한 업로드 함수를 쓰고, 붙여넣은 스크린샷 이름이 겹치지 않는다', async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/async function uploadFiles\(list\)/);
  assert.match(app,/\$\('#upload'\)\.onchange=async e=>\{await uploadFiles\(e\.target\.files\)/);
  // v0.10.4 폰: label+hidden input 대신 버튼이 input.click()
  assert.match(app,/\$\('#attach-btn'\)\.onclick=\(\)=>\{const u=\$\('#upload'\);u\.value='';u\.click\(\);\}/);
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/<button type="button" id="attach-btn" class="icon round"/);
  assert.match(html,/<input id="upload" class="sr" type="file" multiple/);assert.ok(!/id="upload"[^>]*hidden/.test(html),'display:none 아님');
  assert.match(app,/addEventListener\('paste',e=>\{const fs=\[\.\.\.\(e\.clipboardData\?\.items\?\?\[\]\)\]\.filter\(x=>x\.kind==='file'\)/);
  assert.match(app,/if\(!fs\.length\)return;e\.preventDefault\(\);uploadFiles\(fs\)/,'글자만 붙여넣으면 평소처럼');
  assert.match(app,/document\.addEventListener\('drop',e=>\{if\(!hasFiles\(e\)\)return;e\.preventDefault\(\)/);
  assert.match(app,/\^\(image\|blob\|clipboard\)/);assert.match(app,/붙여넣기-\$\{stamp\(\)\}/);
  // 붙여넣기 이름 규칙 확인
  const stamp=()=>'20261019214200';const files=[1,2];
  const nameOf=(f,i)=>{const ext=(f.name?.match(/\.[\w]+$/)?.[0])||('.'+(f.type.split('/')[1]||'bin').replace('jpeg','jpg'));return !f.name||/^(image|blob|clipboard)(\.\w+)?$/i.test(f.name)?`붙여넣기-${stamp()}${files.length>1?'-'+(i+1):''}${ext}`:f.name;};
  assert.equal(nameOf({name:'image.png',type:'image/png'},0),'붙여넣기-20261019214200-1.png');
  assert.equal(nameOf({name:'',type:'image/jpeg'},1),'붙여넣기-20261019214200-2.jpg');
  assert.equal(nameOf({name:'보고서.pdf',type:'application/pdf'},0),'보고서.pdf');
  const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
  assert.match(css,/body\.dragging::after/);assert.match(css,/\.att-img/);
});
