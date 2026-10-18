// AI 오피스 v0.7 — 단톡방 하나. 참여자 = 연결한 AI. 나 + AI 들이 한 타임라인에서 대화한다.
//  · "모두에게": 연결된 AI 전부에게 동시에 (각자 답변 말풍선)
//  · "팀장에게": 팀장 AI 가 받아서 팀원에게 나누고(② 작업) 종합(③)
//  · "@클로드 …" 처럼 이름을 부르면 그 AI 에게만
const $=s=>document.querySelector(s);
let state={user:null,lead:null,adapters:[],messages:[],files:[],budget:null,memory:null};
let route='all';            // 'all' | 'lead'
const partials={};          // 메시지 id → {partial, bytes, elapsedMs}
const attached=new Set();   // 이번 메시지에 첨부할 파일 이름
let es=null;

const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ad=id=>state.adapters.find(a=>a.id===id);
const label=id=>ad(id)?.label??id;
const color=id=>ad(id)?.color??'#888';
const initial=a=>(a.label??a.id??'?').replace(/\s*\(.*\)/,'').trim()[0]?.toUpperCase()??'?';
const connected=a=>a.auth?.state==='subscription';
const ERR={setup_code_invalid:'설정 코드가 맞지 않습니다 — 서버 로그(또는 data/setup-code)의 코드를 넣으세요',persist_failed:'답은 받았지만 저장에 실패했습니다 (서버 디스크 확인)',interrupted:'서버가 재시작되어 중단됨',body_too_large:'요청이 너무 큽니다',login_required:'로그인이 필요합니다',login_invalid:'비밀번호가 맞지 않습니다',too_many_attempts:'실패가 많아 15분간 잠겼습니다',password_too_short:'비밀번호는 10자 이상',already_set:'이미 비밀번호가 있습니다',login_already_running:'이미 연결 진행 중',login_not_configured:'이 AI 는 화면 연결 명령이 아직 없습니다',budget_exceeded:'이번 달 토큰 상한에 도달 — 메뉴 > 토큰 예산에서 조정',workers_required:'팀원이 될 AI 가 더 연결돼야 합니다',lead_required:'팀장 AI 를 먼저 지정하세요',plan_parse_failed:'팀장이 계획을 JSON 으로 내지 않아 분배를 멈췄습니다',budget_invalid:'상한은 0 이상의 숫자',cancelled:'취소됨',text_too_long:'글자 수 상한 초과',file_too_large:'파일 크기 상한 초과',state_corrupt:'대화 저장 파일이 손상됨',state_unreadable:'대화 저장 파일을 읽을 수 없음',not_logged_in:'아직 연결되지 않음 — 참여자에서 연결하세요',api_key_auth_detected:'API 키 모드라 차단됨 (구독 로그인만 허용)',third_party_auth_detected:'서드파티 인증이라 차단됨',auth_unverified:'인증 상태를 확인할 수 없어 차단됨',cli_not_found:'CLI 가 서버에 설치돼 있지 않음',cli_timeout:'시간 초과',all_tasks_failed:'팀원 작업이 전부 실패해 종합을 건너뜀'};
const msg=e=>ERR[e]??e;
const AUTH_KO={subscription:'연결됨',api_key:'API 키 모드 — 차단',third_party:'서드파티 — 차단',not_logged_in:'연결 필요',unverified:'확인 안 됨'};

async function api(path,opts={}){
  const r=await fetch(path,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...opts});
  const v=await r.json().catch(()=>({}));
  if(r.status===401&&path!=='/api/me'){showGate({});}
  if(!r.ok)throw Error(v.error||'request_failed');return v;
}
const toast=t=>{document.querySelectorAll('.toast').forEach(x=>x.remove());const d=document.createElement('div');d.className='sys toast';d.textContent=t;d.style.cssText='position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:50;box-shadow:0 4px 14px rgba(0,0,0,.2)';document.body.append(d);setTimeout(()=>d.remove(),2600);};

// ---- 게이트: 최초 비밀번호 설정 / 로그인 ----
let setupMode=false;
function showGate(info){
  setupMode=!!info.setupRequired;
  es?.close();es=null;   // 검수 V01: 게이트로 나가면 스트림도 닫는다
  $('#gate').hidden=false;$('#app').hidden=true;
  $('#gate-title').textContent=setupMode?'AI 오피스 만들기':'AI 오피스';
  $('#gate-hint').textContent=setupMode?'서버 로그(콘솔)에 찍힌 설정 코드와 주인 비밀번호를 넣으세요. 이 비밀번호로만 들어올 수 있습니다.':'';
  $('#f-password2').hidden=!setupMode;$('#f-code').hidden=!setupMode;$('#gate-form input[name=password]').autocomplete=setupMode?'new-password':'current-password';
  $('#gate-form button').textContent=setupMode?'만들고 들어가기':'들어가기';$('#gate-msg').textContent='';
}
$('#gate-form').onsubmit=async e=>{
  e.preventDefault();const f=new FormData(e.target);const password=f.get('password');
  if(setupMode&&password!==f.get('password2')){$('#gate-msg').textContent='비밀번호 확인이 다릅니다';return;}
  try{await api(setupMode?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify(setupMode?{password,code:String(f.get('code')??'').trim()}:{password})});e.target.reset();await boot();}
  catch(x){$('#gate-msg').textContent=msg(x.message);}
};

// ---- 타임라인 ----
const KIND={plan:'① 계획',task:'② 작업',final:'③ 종합'};
const timeOf=iso=>new Date(iso).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});
const dayOf=iso=>new Date(iso).toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
function userHtml(m){
  const all=state.adapters.filter(connected).map(a=>a.id);
  const chips=m.mode==='orchestrate'?`<span class="chip-s">팀장 ${esc(label(m.lead))} → ${(m.workers??[]).map(label).map(esc).join(', ')}</span>`
    :(m.targets??[]).length&&!(m.targets.length===all.length&&m.targets.every(t=>all.includes(t)))?`<span class="chip-s">→ ${m.targets.map(label).map(esc).join(', ')}</span>`:'';
  const files=(m.files??[]).map(f=>`<span class="chip-s">📎 ${esc(f)}</span>`).join('');
  const hand=m.handoffFrom?`<span class="chip-s">↪ #${m.handoffFrom} 답변 포함</span>`:'';
  return `<div class="m me" id="m${m.id}"><div class="body"><div class="bubble">${esc(m.text)}</div>${chips||files||hand?`<div class="chips" style="justify-content:flex-end">${chips}${files}${hand}</div>`:''}<div class="meta"><span>${timeOf(m.at)}</span></div></div></div>`;
}
function aiHtml(m){
  const a=ad(m.adapter)??{id:m.adapter,label:m.adapter,color:'#888'};
  const p=m.status==='running'?partials[m.id]:null;
  let body='',cls=m.status;
  if(m.status==='running')body=p?.partial?`<span class="partial">${esc(p.partial)}</span><div class="progress">수신 중 … ${(p.bytes/1024).toFixed(1)}KB · ${(p.elapsedMs/1000).toFixed(0)}s</div>`:`<span class="dots">${m.kind==='plan'?'계획 세우는 중':m.kind==='final'?'종합하는 중':'생각 중'}</span>`;
  else if(m.status==='done')body=m.kind==='plan'?`<details class="raw"><summary>계획 원문(JSON)</summary><pre>${esc(m.text)}</pre></details>`:esc(m.text);   // 팀장의 계획 JSON 은 접어 둔다 — 화면에는 분배 요약만, 답은 ③ 종합 말풍선에
  else if(m.status==='blocked')body=`🚫 ${esc(msg(m.error))}`;
  else if(m.status==='cancelled')body='취소됨';
  else body=`⚠️ 오류: ${esc(msg(m.error))}${m.text?'\n\n'+esc(m.text):''}${m.stderrTail?`<details open><summary>CLI 오류 출력</summary><pre>${esc(m.stderrTail)}</pre></details>`:''}`;
  const kind=m.kind&&KIND[m.kind]?`<span class="kind ${m.kind}">${KIND[m.kind]}${m.taskTitle?' · '+esc(m.taskTitle):''}</span><br>`:'';
  const plan=m.kind==='plan'&&m.plan?`<div class="plan">분배: ${m.plan.tasks.length?m.plan.tasks.map(t=>`${esc(label(t.worker))} — ${esc(t.title||'(제목 없음)')}`).join(' · '):'팀원 없이 직접 답함'}${m.plan.dropped?` · 버린 작업 ${m.plan.dropped}개`:''}${m.plan.note?'<br>'+esc(m.plan.note):''}${m.orchestrateError?'<br>'+esc(msg(m.orchestrateError)):''}</div>`:'';
  const ev=m.evidence?`<details><summary>실행 증거</summary><pre>${esc(`종료 코드 ${m.exitCode??'-'}${m.signal?' / 시그널 '+m.signal:''}${m.timedOut?' / 시간 초과':''}\nstdout ${m.evidence.stdoutBytes}B · stderr ${m.evidence.stderrBytes}B\n${m.evidence.dir}`)}</pre></details>`:'';
  const auth=m.status==='blocked'&&m.authCheck?`<details><summary>인증 확인</summary><pre>${esc(`${m.authCheck.state} (${m.authCheck.reason})${m.authCheck.subscriptionType?' / 구독 '+m.authCheck.subscriptionType:''}`)}</pre></details>`:'';
  const others=state.adapters.filter(x=>x.id!==m.adapter&&connected(x));
  const acts=m.status==='done'&&m.kind!=='plan'?`<div class="acts">${others.map(x=>`<button data-handoff="${m.id}" data-to="${x.id}">→ ${esc(x.label)} 검토</button>`).join('')}<button data-memo="${m.id}">🧠 기억</button><button data-save="${m.id}">💾 저장</button><button data-copy="${m.id}">복사</button></div>`:'';
  return `<div class="m ai" id="m${m.id}" style="--ai-color:${esc(a.color)}"><div class="av">${esc(initial(a))}</div><div class="body"><div class="name">${esc(a.label)}</div><div class="bubble ${cls}">${kind}${m.kind==='plan'&&m.status==='done'?plan+body:body+plan}${auth||ev}</div>${acts}<div class="meta"><span>${timeOf(m.at)}</span>${m.status==='done'&&m.elapsedMs?`<span>${(m.elapsedMs/1000).toFixed(1)}s</span>`:''}${m.usage?`<span>${esc(usageShort(m.usage))}</span>`:''}</div></div></div>`;
}
function usageShort(u){const i=u.input??u.input_tokens??u.prompt_tokens,o=u.output??u.output_tokens??u.completion_tokens;return Number.isFinite(i)&&Number.isFinite(o)?`${i}+${o} 토큰`:'';}
function renderTimeline(){
  const tl=$('#timeline');const chat=$('#chat');const atBottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<80;
  let html='',lastDay='';
  if(!state.messages.length)html=`<div class="sys">여기는 내 AI 오피스입니다.<br>오른쪽 위 참여자에서 구독 중인 AI 를 연결하면 방에 들어옵니다.</div>`;
  for(const m of state.messages){
    const d=dayOf(m.at);if(d!==lastDay){html+=`<div class="day">${esc(d)}</div>`;lastDay=d;}
    html+=m.role==='user'?userHtml(m):aiHtml(m);
  }
  tl.innerHTML=html;
  if(atBottom)chat.scrollTop=chat.scrollHeight;
  tl.querySelectorAll('[data-handoff]').forEach(b=>b.onclick=()=>handoff(Number(b.dataset.handoff),b.dataset.to));
  tl.querySelectorAll('[data-save]').forEach(b=>b.onclick=async()=>{const name=prompt('저장할 파일 이름',`answer-${b.dataset.save}.md`);if(name){await api('/api/save',{method:'POST',body:JSON.stringify({messageId:Number(b.dataset.save),name})});toast('파일로 저장됨');}});
  tl.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{navigator.clipboard.writeText(state.messages.find(m=>m.id===Number(b.dataset.copy))?.text??'');toast('복사됨');});
  tl.querySelectorAll('[data-memo]').forEach(b=>b.onclick=async()=>{const note=prompt('메모리에 덧붙일 한 줄 설명 (비워도 됨)','');if(note===null)return;try{const r=await api('/api/memory/append',{method:'POST',body:JSON.stringify({messageId:Number(b.dataset.memo),note})});state.memory=r;renderBadges();toast('메모리에 추가됨');}catch(e){toast(msg(e.message));}});
}
function scrollBottom(){const c=$('#chat');c.scrollTop=c.scrollHeight;}

// ---- 헤더 · 참여자 ----
function renderHeader(){
  const on=state.adapters.filter(connected);
  $('#room-count').textContent=on.length+1;
  $('#people-open').innerHTML=state.adapters.map(a=>`<span class="av ${connected(a)?'':'off'}" style="--ai-color:${esc(a.color)}" title="${esc(a.label)}">${esc(initial(a))}</span>`).join('')||'<span class="hint">참여자 없음</span>';
  const lead=ad(state.lead);
  $('#route-lead').textContent=lead?`팀장 ${lead.label}에게`:'팀장에게';
  $('#route-hint').textContent=route==='lead'?(lead?(on.filter(a=>a.id!==lead.id).length?`${lead.label}가 ${on.filter(a=>a.id!==lead.id).map(a=>a.label).join(', ')}에게 나눠 시킵니다`:`팀원이 없어 ${lead.label} 혼자 답합니다`):'참여자에서 팀장을 지정하세요'):(on.length?`${on.map(a=>a.label).join(', ')}에게 동시에`:'연결된 AI 가 없습니다');
}
const tailHtml=l=>l.tail?.length?`<details open><summary>CLI 마지막 출력</summary><pre>${esc(l.tail.join('\n'))}</pre></details>`:'';
function loginBoxHtml(a){
  const l=a.login;if(!l||(l.status==='done'&&connected(a)))return '';
  const urls=l.urls.map(u=>`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('');
  const codes=l.codes.map(c=>`<code>${esc(c)}</code>`).join(' ');
  const body=l.status==='running'
    ?`<div><b>1.</b> 아래 주소를 열어 <b>${esc(a.label)} 구독 계정</b>으로 로그인${codes?`<br><b>2.</b> 코드가 필요하면: ${codes}`:''}</div>${urls?`<div class="urls">${urls}</div>`:`<div class="last">주소를 기다리는 중<span class="dots"></span></div>`}${l.lastLine?`<div class="last">${esc(l.lastLine)}</div>`:''}<div class="row"><input class="login-input" placeholder="CLI 가 코드를 요구하면 여기 붙여넣기" autocomplete="off"><button class="btn small login-send">전송</button><button class="btn small login-cancel">취소</button></div>`
    :l.status==='done'?`<div>연결 명령이 끝났습니다(종료 코드 ${l.exitCode??'-'}). 상태를 다시 확인했습니다.</div>${tailHtml(l)}`
    :`<div>연결 실패: ${esc(msg(l.error))}</div>${tailHtml(l)}`;
  return `<div class="login-box ${l.status}">${body}</div>`;
}
function renderPeople(){
  const list=$('#people-list');
  list.innerHTML=state.adapters.map(a=>{
    const st=a.auth?.state;const isLead=state.lead===a.id;
    const status=!a.auth?`<span class="pstatus off">○ 확인 중<span class="dots"></span></span>`:st==='subscription'?`<span class="pstatus ok">● ${AUTH_KO[st]}${a.auth.subscriptionType?' · '+esc(a.auth.subscriptionType):''}</span>`:`<span class="pstatus ${st==='not_logged_in'?'off':'bad'}">○ ${AUTH_KO[st]??st}${a.auth.reason?` <small>(${esc(a.auth.reason)})</small>`:''}</span>`;
    const running=a.login?.status==='running';
    return `<div class="person" data-id="${a.id}" style="--ai-color:${esc(a.color)}"><div class="av ${connected(a)?'':'off'}">${esc(initial(a))}</div><div class="info"><div class="pname">${esc(a.label)}${isLead?'<span class="lead-tag">팀장</span>':''}</div><div class="prole">${esc(a.roleHint||'')}</div>${status}<div class="pacts">${a.canLogin&&!running?`<button class="btn small primary p-login">${connected(a)?'다시 연결':'연결하기'}</button>`:''}${!a.canLogin?`<span class="hint small">이 AI 는 아직 화면 연결을 지원하지 않습니다</span>`:''}${connected(a)?`<button class="btn small p-lead">${isLead?'팀장 해제':'팀장으로'}</button><button class="btn small p-reset" title="이 AI 의 이어가기 세션을 새로 시작">새 대화</button>`:''}</div><div class="login-slot">${loginBoxHtml(a)}</div></div></div>`;
  }).join('')||'<p class="hint">설정된 AI 가 없습니다 (config/adapters.json)</p>';
  list.querySelectorAll('.person').forEach(p=>{
    const id=p.dataset.id;
    p.querySelector('.p-login')?.addEventListener('click',async()=>{try{await api('/api/cli-login',{method:'POST',body:JSON.stringify({adapterId:id})});}catch(e){toast(msg(e.message));}});
    p.querySelector('.p-lead')?.addEventListener('click',async()=>{await api('/api/settings/lead',{method:'POST',body:JSON.stringify({adapterId:state.lead===id?null:id})});});
    p.querySelector('.p-reset')?.addEventListener('click',async()=>{await api('/api/reset',{method:'POST',body:JSON.stringify({adapterId:id})});toast(label(id)+' 새 대화 시작');});
    const inp=p.querySelector('.login-input');
    if(inp){const send=async()=>{if(!inp.value)return;await api('/api/cli-login/input',{method:'POST',body:JSON.stringify({adapterId:id,text:inp.value})});inp.value='';};p.querySelector('.login-send').onclick=send;inp.onkeydown=e=>{if(e.key==='Enter')send();};p.querySelector('.login-cancel').onclick=()=>api('/api/cli-login/cancel',{method:'POST',body:JSON.stringify({adapterId:id})});}
  });
}
function renderBadges(){
  const b=state.budget;if(b){const pct=b.limit?Math.round(b.tokens/b.limit*100):null;$('#budget-badge').textContent=`${b.tokens.toLocaleString()}${b.limit?` / ${b.limit.toLocaleString()} (${pct}%)`:''} · ${b.calls}회`;$('#budget-badge').style.color=b.exceeded?'var(--bad)':pct!==null&&pct>=80?'var(--warn)':'';}
  const m=state.memory;if(m)$('#memory-badge').textContent=m.chars?`${m.chars>=1000?(m.chars/1000).toFixed(1)+'k':m.chars}자${m.overLimit?' ⚠':''}`:'비어 있음';
  $('#files-badge').textContent=state.files.length?state.files.length+'개':'';
}
function renderFiles(){
  $('#filelist').innerHTML=state.files.map(f=>`<li class="${attached.has(f.name)?'on':''}" data-name="${esc(f.name)}"><span>${esc(f.name)}</span><small>${(f.bytes/1024).toFixed(1)}KB</small><a href="/files/${encodeURIComponent(f.name)}" target="_blank" title="열기">↗</a></li>`).join('')||'<li class="hint">없음 — 📎 로 올리거나 답변을 저장하세요</li>';
  $('#filelist').querySelectorAll('li[data-name]').forEach(li=>li.onclick=e=>{if(e.target.tagName==='A')return;const n=li.dataset.name;attached.has(n)?attached.delete(n):attached.add(n);renderFiles();renderAttach();});
  renderBadges();
}
function renderAttach(){const row=$('#attach-row');row.hidden=!attached.size;row.innerHTML=[...attached].map(n=>`<span class="chip-s" data-rm="${esc(n)}">📎 ${esc(n)} ✕</span>`).join('');row.querySelectorAll('[data-rm]').forEach(c=>c.onclick=()=>{attached.delete(c.dataset.rm);renderAttach();renderFiles();});}
function renderAll(){renderHeader();renderTimeline();renderPeople();renderFiles();renderBadges();}

// ---- 보내기: 멘션 → 팀장 → 모두 ----
const ALIAS={claude:['클로드','claude','클'],codex:['코덱스','codex','지피티','챗지피티','gpt','chatgpt','오픈ai','openai'],gemini:['제미나이','제미니','gemini','구글','google'],grok:['그록','grok']};
// 검수 V20: 문장 시작 또는 공백 뒤의 @만 멘션. 별칭 전체 일치 또는 별칭 + 허용된 조사(에게·한테·야·님·아·씨)만. 이메일·패키지명(@scope/x)은 걸리지 않는다.
const PARTICLES=['에게','한테','야','님','아','씨','에게도','한테도'];
function parseMentions(text){
  const ids=new Set();
  for(const m of String(text).matchAll(/(^|\s)@([^\s@,.!?:;/]+)/g)){
    const w=m[2].toLowerCase();
    for(const a of state.adapters){
      const names=[a.id,a.label,a.label.replace(/\s*\(.*\)/,''),...(ALIAS[a.id]??[])].map(x=>x.toLowerCase());
      if(names.some(n=>w===n||PARTICLES.some(p=>w===n+p)))ids.add(a.id);
    }
  }
  return [...ids];
}
async function send(){
  const text=$('#text').value;if(!text.trim())return;
  const on=state.adapters.filter(connected).map(a=>a.id);
  const mentioned=parseMentions(text);
  let body;
  if(mentioned.length)body={text,targets:mentioned,files:[...attached]};
  else if(route==='lead'){
    if(!state.lead){toast(msg('lead_required'));$('#people').showModal();return;}
    const workers=on.filter(id=>id!==state.lead);
    body=workers.length?{text,mode:'orchestrate',lead:state.lead,workers,files:[...attached]}:{text,targets:[state.lead],files:[...attached]};
  }else{
    if(!on.length){toast('먼저 참여자를 연결하세요');$('#people').showModal();return;}
    body={text,targets:on,files:[...attached]};
  }
  $('#send').disabled=true;
  try{await api('/api/send',{method:'POST',body:JSON.stringify(body)});$('#text').value='';autosize();attached.clear();renderAttach();renderFiles();scrollBottom();}
  catch(e){toast(msg(e.message));}finally{$('#send').disabled=false;$('#text').focus();}
}
async function handoff(messageId,to){
  const note=prompt(`${label(to)}에게 이 답변과 함께 보낼 요청`,'위 답변을 독립적으로 검토하고 문제점·수정안을 제시해 주세요.');
  if(!note)return;
  await api('/api/send',{method:'POST',body:JSON.stringify({text:note,targets:[to],files:[...attached],handoffFrom:messageId})});scrollBottom();
}
$('#send').onclick=send;
$('#text').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')send();});
function autosize(){const t=$('#text');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,140)+'px';}
$('#text').addEventListener('input',autosize);
$('#route-all').onclick=()=>{route='all';$('#route-all').classList.add('on');$('#route-lead').classList.remove('on');renderHeader();};
$('#route-lead').onclick=()=>{route='lead';$('#route-lead').classList.add('on');$('#route-all').classList.remove('on');renderHeader();if(!state.lead){toast('참여자에서 팀장을 지정하세요');$('#people').showModal();}};
$('#upload').onchange=async e=>{for(const f of e.target.files){const r=await fetch('/api/files?name='+encodeURIComponent(f.name),{method:'POST',credentials:'same-origin',body:f});if(r.status===401)return showGate({});const v=await r.json();if(v.name)attached.add(v.name);}e.target.value='';renderAttach();toast('올렸습니다 — 이번 메시지에 첨부됨');};

// ---- 시트 ----
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
$('#people-open').onclick=()=>{renderPeople();$('#people').showModal();};
$('#menu-open').onclick=()=>{renderBadges();$('#menu').showModal();};
const openFromMenu=(id,fn)=>()=>{$('#menu').close();fn?.();$('#'+id).showModal();};
$('#m-memory').onclick=openFromMenu('memory',async()=>{const r=await api('/api/memory');$('#memory-text').value=r.text;$('#memory-info').textContent=`${r.chars.toLocaleString()}자${r.overLimit?` — 권장 상한 ${r.maxChars.toLocaleString()}자 초과`:''}`;});
$('#memory-save').onclick=async()=>{try{const r=await api('/api/memory',{method:'POST',body:JSON.stringify({text:$('#memory-text').value})});$('#memory-info').textContent=`저장됨 · ${r.chars.toLocaleString()}자`;state.memory=r;renderBadges();}catch(e){toast(msg(e.message));}};
$('#m-files').onclick=openFromMenu('files',renderFiles);
$('#m-budget').onclick=openFromMenu('budget',()=>{const b=state.budget;$('#budget-now').textContent=b?`${b.month} 사용 ${b.tokens.toLocaleString()} 토큰 · ${b.calls}회 · 상한 ${b.limit?b.limit.toLocaleString():'무제한'}`:'';$('#budget-in').value=b?.limit||'';});
$('#budget-save').onclick=async()=>{try{const v=$('#budget-in').value;const r=await api('/api/settings/budget',{method:'POST',body:JSON.stringify({monthlyTokens:v===''?null:Number(v)})});state.budget=r.budget;renderBadges();$('#budget').close();toast('예산 저장됨');}catch(e){toast(msg(e.message));}};
$('#m-auth').onclick=async()=>{$('#menu').close();toast('확인 중…');try{await api('/api/auth-check',{method:'POST',body:'{}'});}catch(e){toast(msg(e.message));}};
$('#m-password').onclick=openFromMenu('password');
$('#password-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/api/settings/password',{method:'POST',body:JSON.stringify({current:f.get('current'),next:f.get('next')})});e.target.reset();$('#password').close();showGate({});toast('변경됨 — 다시 로그인하세요');}catch(x){$('#password-msg').textContent=msg(x.message);}};
$('#m-logout').onclick=async()=>{$('#menu').close();try{await api('/api/logout',{method:'POST',body:'{}'});}catch{}es?.close();state={user:null,lead:null,adapters:[],messages:[],files:[],budget:null,memory:null};showGate({});};

// ---- 시작 · SSE ----
function mergeSnapshot(snap){
  const byId=new Map(state.messages.map(m=>[m.id,m]));
  for(const m of snap.messages??[]){const cur=byId.get(m.id);if(cur&&newer(cur,m))continue;byId.set(m.id,m);}
  state.messages=[...byId.values()].sort((a,b)=>a.id-b.id);
  for(const id of Object.keys(partials))if(!state.messages.some(m=>m.id===Number(id)&&m.status==='running'))delete partials[id];
}
// 검수 V19: seq 가 있으면 seq 로, 없으면(옛 저장분) terminal→running 회귀만 막는다
const TERMINAL=new Set(['done','error','blocked','cancelled']);
function newer(cur,m){if(Number.isSafeInteger(cur.seq)&&Number.isSafeInteger(m.seq))return cur.seq>m.seq;return TERMINAL.has(cur.status)&&cur.status!==m.status;}   // seq 없음: 끝난 상태는 다른 상태로 되돌리지 않는다
function applyState(s){state.adapters=s.adapters??state.adapters;if(s.lead!==undefined)state.lead=s.lead;if(s.messages)mergeSnapshot(s);if(s.files)state.files=s.files;if(s.budget)state.budget=s.budget;if(s.memory)state.memory=s.memory;if(s.user)state.user=s.user;}
function connect(){
  es?.close();es=new EventSource('/api/events');
  es.onopen=async()=>{$('#conn').textContent='연결됨';$('#conn').className='conn ok';try{const snap=await api('/api/state');applyState(snap);renderAll();}catch{}};
  es.onerror=()=>{$('#conn').textContent='연결 끊김 — 재시도 중';$('#conn').className='conn bad';};
  es.addEventListener('message',e=>{const m=JSON.parse(e.data);const i=state.messages.findIndex(x=>x.id===m.id);const isNew=i<0;if(i>=0&&newer(state.messages[i],m))return;i>=0?state.messages[i]=m:state.messages.push(m);if(m.status!=='running')delete partials[m.id];renderTimeline();if(isNew)scrollBottom();});
  es.addEventListener('partial',e=>{const p=JSON.parse(e.data);partials[p.id]=p;const el=document.getElementById('m'+p.id);if(!el){renderTimeline();return;}const t=el.querySelector('.partial'),g=el.querySelector('.progress');const prog=`수신 중 … ${(p.bytes/1024).toFixed(1)}KB · ${(p.elapsedMs/1000).toFixed(0)}s`;if(t&&p.partial){t.textContent=p.partial;if(g)g.textContent=prog;}else renderTimeline();});
  es.addEventListener('budget',e=>{state.budget=JSON.parse(e.data);renderBadges();});
  es.addEventListener('memory',e=>{state.memory=JSON.parse(e.data);renderBadges();});
  es.addEventListener('files',e=>{state.files=JSON.parse(e.data);renderFiles();});
  es.addEventListener('state',e=>{applyState(JSON.parse(e.data));renderAll();});
  es.addEventListener('cli-login',e=>{const d=JSON.parse(e.data);const a=ad(d.adapterId);if(a){a.login=d.login;renderPeople();if(d.login?.status==='done')toast(a.label+' 연결 명령 완료');}});
}
async function boot(){
  const r=await fetch('/api/me',{credentials:'same-origin'});const me=await r.json().catch(()=>({}));
  if(!me.user){showGate(me);return;}
  $('#gate').hidden=true;$('#app').hidden=false;
  applyState(await api('/api/state'));renderAll();scrollBottom();connect();
  if(!state.adapters.some(connected))setTimeout(()=>{renderPeople();$('#people').showModal();},400);
}
boot().catch(e=>{$('#conn').textContent='초기화 실패: '+e.message;$('#conn').className='conn bad';});
