// AI Hub 화면 (v0.5). PC: AI별 세로 패널 나란히 / 폰: 탭으로 전환. 계정별로 자기 대화·파일·AI 로그인만 보인다.
// v0.5: 동시 전송/오케스트레이터 모드, 메모리 편집·추가, 월 토큰 예산 표시, 부분 출력(스트리밍) 표시
const $=s=>document.querySelector(s);
let state={user:null,adapters:[],messages:[],files:[],budget:null,memory:null};
let mode='broadcast';   // 'broadcast' | 'orchestrate'
const partials={};      // 메시지 id → {partial, bytes, elapsedMs} (스트리밍 중 화면 표시용, 저장 안 함)
let active=null;
const selectedFiles=new Set();
const selectedTargets=new Set();
let es=null;

const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const label=id=>state.adapters.find(a=>a.id===id)?.label??id;
const ERR={login_required:'로그인이 필요합니다',login_invalid:'아이디 또는 비밀번호가 맞지 않습니다',too_many_attempts:'실패가 많아 15분간 잠겼습니다',invite_invalid:'초대 코드가 유효하지 않습니다(만료·사용됨·오타)',username_invalid:'아이디는 소문자·숫자·._- 로 3~32자',username_taken:'이미 있는 아이디입니다',password_too_short:'비밀번호는 10자 이상',login_already_running:'이미 로그인 진행 중',login_not_configured:'이 AI 는 화면 로그인 명령이 아직 설정되지 않았습니다',admin_required:'관리자만 가능',budget_exceeded:'이번 달 토큰 상한에 도달 — 관리자에게 상한 조정을 요청하세요',workers_required:'팀원 AI 를 하나 이상 선택하세요(팀장 제외)',lead_required:'팀장 AI 를 선택하세요',plan_parse_failed:'팀장이 계획 JSON 을 내지 않아 분배를 멈췄습니다(본문은 아래)',budget_invalid:'상한은 0 이상의 숫자',user_disabled:'계정이 중지됨',cancelled:'취소됨',text_too_long:'글자 수 상한 초과',file_too_large:'파일 크기 상한 초과',state_corrupt:'대화 저장 파일이 손상됨 — 관리자에게 복구 요청',state_unreadable:'대화 저장 파일을 읽을 수 없음'};
const msg=e=>ERR[e]??e;

async function api(path,opts={}){
  const r=await fetch(path,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...opts});
  const v=await r.json().catch(()=>({}));
  if(r.status===401&&path!=='/api/me'){showGate();}
  if(!r.ok)throw Error(v.error||'request_failed');return v;
}

// ---- 계정 화면 ----
let gateMode='login';
function showGate(info={}){
  $('#gate').hidden=false;$('#panels').hidden=true;$('#files').hidden=true;$('#composer').hidden=true;
  for(const b of ['#auth-check','#admin-open','#logout','#memory-open','#budget'])$(b).hidden=true;$('#who').textContent='';
  if(info.firstRun){gateMode='signup';$('#gate-hint').textContent='아직 계정이 없습니다. 서버 콘솔(또는 data/bootstrap-invite)에 있는 초대 코드로 첫 관리자 계정을 만드세요.';}
  renderGate();
}
function hideGate(){$('#gate').hidden=true;$('#panels').hidden=false;$('#files').hidden=false;$('#composer').hidden=false;}
function renderGate(){
  document.querySelectorAll('.gate-tabs button').forEach(b=>b.classList.toggle('on',b.dataset.mode===gateMode));
  $('#f-invite').hidden=gateMode!=='signup';
  $('#gate-form input[name=password]').autocomplete=gateMode==='signup'?'new-password':'current-password';
  $('#gate-form button[type=submit]').textContent=gateMode==='signup'?'가입하고 들어가기':'들어가기';
  $('#gate-msg').textContent='';
}
document.querySelectorAll('.gate-tabs button').forEach(b=>b.onclick=()=>{gateMode=b.dataset.mode;$('#gate-hint').textContent='';renderGate();});
$('#gate-form').onsubmit=async e=>{
  e.preventDefault();const f=new FormData(e.target);
  const body={username:f.get('username'),password:f.get('password'),...(gateMode==='signup'?{invite:f.get('invite')}:{})};
  try{await api(gateMode==='signup'?'/api/signup':'/api/login',{method:'POST',body:JSON.stringify(body)});e.target.reset();await boot();}
  catch(x){$('#gate-msg').textContent=msg(x.message);}
};
$('#logout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}catch{}es?.close();state={user:null,adapters:[],messages:[],files:[],budget:null,memory:null};$('#panels').innerHTML='';showGate();};

// ---- 메인 화면 ----
function renderTargets(){
  $('#targets').innerHTML=state.adapters.map(a=>`<label class="${selectedTargets.has(a.id)?'on':''}" style="--ai:${a.color}"><input type="checkbox" data-id="${a.id}" ${selectedTargets.has(a.id)?'checked':''}>${esc(a.label)}</label>`).join('');
  $('#targets').querySelectorAll('input').forEach(i=>i.onchange=()=>{i.checked?selectedTargets.add(i.dataset.id):selectedTargets.delete(i.dataset.id);renderTargets();});
}
function renderTabs(){
  $('#tabs').innerHTML=state.adapters.map(a=>`<button data-id="${a.id}" style="--ai:${a.color}" class="${a.id===active?'active':''}">${esc(a.label)}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{active=b.dataset.id;renderTabs();renderPanels();});
}
function renderFiles(){
  $('#filelist').innerHTML=state.files.map(f=>`<li class="${selectedFiles.has(f.name)?'on':''}" data-name="${esc(f.name)}"><span>${esc(f.name)}</span><small>${(f.bytes/1024).toFixed(1)}KB</small><a href="/files/${encodeURIComponent(f.name)}" target="_blank" title="열기">↗</a></li>`).join('')||'<li style="border:0;color:var(--mute)">없음 — 업로드하거나 답변을 "파일로 저장"하세요</li>';
  $('#filelist').querySelectorAll('li[data-name]').forEach(li=>li.onclick=e=>{if(e.target.tagName==='A')return;const n=li.dataset.name;selectedFiles.has(n)?selectedFiles.delete(n):selectedFiles.add(n);renderFiles();renderAttach();});
}
function renderAttach(){$('#attach').textContent=selectedFiles.size?'첨부(작업 폴더 경로로 전달): '+[...selectedFiles].join(', '):'파일을 클릭하면 이번 메시지에 첨부됩니다';}

function messageHtml(m){
  if(m.role==='user'){
    const chips=(m.mode==='orchestrate'?`<span class="chip">🧭 팀장 ${esc(label(m.lead))} → 팀원 ${(m.workers??[]).map(label).map(esc).join(', ')}</span>`:(m.targets??[]).map(t=>`<span class="chip">→ ${esc(label(t))}</span>`).join(''))+(m.files??[]).map(f=>`<span class="chip">📎 ${esc(f)}</span>`).join('')+(m.handoffFrom?`<span class="chip">↪ #${m.handoffFrom} 답변 포함</span>`:'');
    return `<div class="msg user" id="m${m.id}">${esc(m.text)}<div class="meta">${chips}<span>${new Date(m.at).toLocaleTimeString()}</span></div></div>`;
  }
  const status=m.status==='running'?'응답 대기 중…':m.status==='error'?`오류: ${esc(msg(m.error))}`:m.status==='blocked'?`호출 안 함: ${esc(msg(m.error))}`:m.status==='cancelled'?'취소됨 (계정 중지)':'';
  const others=state.adapters.filter(a=>a.id!==m.adapter);
  const actions=m.status==='done'?others.map(a=>`<button data-handoff="${m.id}" data-to="${a.id}">→ ${esc(a.label)}에게 검토 요청</button>`).join('')+`<button data-save="${m.id}">파일로 저장</button><button data-memo="${m.id}" title="이 답변 전문을 memory.md 에 덧붙임">메모리에 추가</button><button data-copy="${m.id}">복사</button>`:'';
  const KIND={plan:'① 계획',task:'② 작업',final:'③ 종합'};
  const kindTag=m.kind&&KIND[m.kind]?`<span class="kind">${KIND[m.kind]}${m.taskTitle?' · '+esc(m.taskTitle):''}</span><br>`:'';
  const planInfo=m.kind==='plan'&&m.plan?`<div class="plan">분배: ${m.plan.tasks.length?m.plan.tasks.map(t=>`${esc(label(t.worker))}: ${esc(t.title||'(제목 없음)')}`).join(' · '):'팀원 없이 직접 답함'}${m.plan.dropped?` · 버린 작업 ${m.plan.dropped}개(팀원 id 오류·빈 지시)`:''}${m.plan.note?' — '+esc(m.plan.note):''}${m.orchestrateError==='all_tasks_failed'?'<br>모든 팀원 작업이 실패·차단되어 종합을 건너뜀':''}</div>`:'';
  const p=m.status==='running'?partials[m.id]:null;
  const running=m.status==='running'?(p?.partial?`<span class="partial">${esc(p.partial)}</span><div class="progress">수신 중 … ${(p.bytes/1024).toFixed(1)}KB · ${(p.elapsedMs/1000).toFixed(0)}s</div>`:p?`<div class="progress">수신 중 … ${(p.bytes/1024).toFixed(1)}KB · ${(p.elapsedMs/1000).toFixed(0)}s</div>`:''):'';
  const ev=m.evidence?`<details><summary>실행 증거</summary><pre>${esc(`종료 코드 ${m.exitCode??'-'}${m.signal?' / 시그널 '+m.signal:''}${m.timedOut?' / 시간 초과':''}${m.parseFailed?'\n파싱 실패 (원본 예외는 로컬 meta.json)':''}${m.unstoredAnswer?'\n증거 저장 실패 — 본문은 상태에만 보존':''}\nstdout ${m.evidence.stdoutBytes}B sha256 ${m.evidence.stdoutSha256}\nstderr ${m.evidence.stderrBytes}B sha256 ${m.evidence.stderrSha256}\n원문 전체: ${m.evidence.dir}\n차단한 환경변수: ${(m.envBlockedNames??[]).join(', ')||'없음'}`)}</pre></details>`:'';
  const detail=m.status==='blocked'&&m.authCheck?`<details><summary>인증 확인 결과</summary><pre>${esc(`${m.authCheck.state} (${m.authCheck.reason})${m.authCheck.authMethod?'\n방식 '+m.authCheck.authMethod:''}${m.authCheck.apiProvider?' / 제공자 '+m.authCheck.apiProvider:''}${m.authCheck.subscriptionType?' / 구독 '+m.authCheck.subscriptionType:''}`)}</pre></details>`:ev;
  const budgetNote=m.status==='blocked'&&m.error==='budget_exceeded'?`<details><summary>예산</summary><pre>${esc(`${m.budget.month} 사용 ${m.budget.tokens.toLocaleString()} / 상한 ${m.budget.limit.toLocaleString()} 토큰`)}</pre></details>`:'';
  return `<div class="msg assistant ${m.status} ${m.kind?'kind-'+m.kind:''}" id="m${m.id}">${kindTag}${m.status==='running'&&running?running:esc(m.text||status)}${planInfo}${budgetNote||detail}<div class="meta">${m.status==='done'?`<span>${((m.elapsedMs??0)/1000).toFixed(1)}s</span>`:`<span>${status}</span>`}${m.usage?`<span>usage ${esc(JSON.stringify(m.usage)).slice(0,80)}</span>`:''}${actions}</div></div>`;
}
const AUTH_KO={subscription:'구독 로그인 확인',api_key:'API 키 모드 — 차단',third_party:'서드파티 — 차단',not_logged_in:'로그인 안 됨',unverified:'미확인 — 차단'};
function loginBoxHtml(a){
  const l=a.login;
  if(!l)return '';
  const urls=l.urls.map(u=>`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('<br>');
  const codes=l.codes.map(c=>`<code>${esc(c)}</code>`).join(' ');
  const body=l.status==='running'
    ?`<div>로그인 진행 중 — 아래 주소를 <b>내 브라우저</b>에서 열어 로그인하세요.${codes?` 코드: ${codes}`:''}</div>${urls?`<div class="urls">${urls}</div>`:''}${l.lastLine?`<div class="last">${esc(l.lastLine)}</div>`:''}<div class="row"><input class="login-input" placeholder="CLI 가 코드를 요구하면 여기 붙여넣기" autocomplete="off"><button class="login-send">전송</button><button class="login-cancel">취소</button></div>`
    :l.status==='done'?`<div>로그인 명령이 끝났습니다. 인증 상태를 다시 확인했습니다.</div>`
    :`<div>로그인 실패: ${esc(msg(l.error))}</div>`;
  return `<div class="login-box ${l.status}">${body}</div>`;
}
function renderPanels(){
  const panels=$('#panels');
  for(const a of state.adapters){
    let p=document.getElementById('p-'+a.id);
    if(!p){p=document.createElement('section');p.className='panel';p.id='p-'+a.id;p.style.setProperty('--ai',a.color);p.innerHTML=`<div class="panel-head"><span class="dot"></span><span class="name">${esc(a.label)}</span><span class="session"></span><button class="cli-login" title="이 사용자 계정으로 이 AI 에 로그인">CLI 로그인</button><button class="reset" title="이 AI의 이어가기 세션을 새로 시작">새 대화</button></div><div class="login-slot"></div><div class="log"></div>`;
      p.querySelector('.reset').onclick=()=>api('/api/reset',{method:'POST',body:JSON.stringify({adapterId:a.id})});
      p.querySelector('.cli-login').onclick=async()=>{try{await api('/api/cli-login',{method:'POST',body:JSON.stringify({adapterId:a.id})});}catch(e){alert(msg(e.message));}};
      panels.append(p);}
    p.classList.toggle('active',a.id===active);
    p.querySelector('.cli-login').hidden=!a.canLogin||a.login?.status==='running';
    p.querySelector('.session').textContent=(a.auth?`${AUTH_KO[a.auth.state]??a.auth.state} · `:'인증 미확인 · ')+(a.session?'세션 '+a.session:'새 세션');
    const slot=p.querySelector('.login-slot');slot.innerHTML=loginBoxHtml(a);
    const inp=slot.querySelector('.login-input');
    if(inp){const send=async()=>{if(!inp.value)return;await api('/api/cli-login/input',{method:'POST',body:JSON.stringify({adapterId:a.id,text:inp.value})});inp.value='';};slot.querySelector('.login-send').onclick=send;inp.onkeydown=e=>{if(e.key==='Enter')send();};slot.querySelector('.login-cancel').onclick=()=>api('/api/cli-login/cancel',{method:'POST',body:JSON.stringify({adapterId:a.id})});}
    const log=p.querySelector('.log');const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<40;
    const mine=state.messages.filter(m=>(m.role==='user'&&(m.targets?.includes(a.id)||m.workers?.includes(a.id)))||(m.role==='assistant'&&m.adapter===a.id));
    log.innerHTML=mine.map(messageHtml).join('');
    if(atBottom)log.scrollTop=log.scrollHeight;
  }
  document.querySelectorAll('[data-handoff]').forEach(b=>b.onclick=()=>handoff(Number(b.dataset.handoff),b.dataset.to));
  document.querySelectorAll('[data-save]').forEach(b=>b.onclick=async()=>{const name=prompt('저장할 파일 이름',`answer-${b.dataset.save}.txt`);if(name)await api('/api/save',{method:'POST',body:JSON.stringify({messageId:Number(b.dataset.save),name})});});
  document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>navigator.clipboard.writeText(state.messages.find(m=>m.id===Number(b.dataset.copy))?.text??''));
  document.querySelectorAll('[data-memo]').forEach(b=>b.onclick=async()=>{const note=prompt('메모리에 덧붙일 한 줄 설명(비워도 됨)','');if(note===null)return;try{const r=await api('/api/memory/append',{method:'POST',body:JSON.stringify({messageId:Number(b.dataset.memo),note})});b.textContent='메모리에 추가됨';renderBudgetMemory({memory:r});}catch(e){alert(msg(e.message));}});
}

// ---- v0.5 모드 / 예산 / 메모리 ----
function renderMode(){
  $('#mode-broadcast').classList.toggle('on',mode==='broadcast');$('#mode-orch').classList.toggle('on',mode==='orchestrate');
  $('#orch-opts').hidden=mode!=='orchestrate';
  $('#text').placeholder=mode==='orchestrate'?'목표… (팀장이 쪼개서 팀원에게 나누고, 결과를 종합합니다)':'메시지… (선택한 AI 전부에게 동시에 보냄)';
  const lead=$('#lead');const cur=lead.value;
  lead.innerHTML=state.adapters.map(a=>`<option value="${a.id}" ${a.id===cur?'selected':''}>${esc(a.label)}${a.roleHint?' — '+esc(a.roleHint):''}</option>`).join('');
  if(!lead.value&&state.adapters[0])lead.value=state.adapters[0].id;
}
$('#mode-broadcast').onclick=()=>{mode='broadcast';renderMode();};$('#mode-orch').onclick=()=>{mode='orchestrate';renderMode();};
function renderBudgetMemory({budget,memory}={}){
  if(budget)state.budget=budget;if(memory)state.memory=memory;
  const b=state.budget;const el=$('#budget');
  if(b){el.hidden=false;const pct=b.limit?Math.round(b.tokens/b.limit*100):null;el.textContent=`${b.month} 토큰 ${b.tokens.toLocaleString()}${b.limit?` / ${b.limit.toLocaleString()} (${pct}%)`:' / 무제한'} · ${b.calls}회`;el.className='budget'+(b.exceeded?' over':pct!==null&&pct>=80?' warn':'');}
  const m=state.memory;if(m)$('#memory-open').textContent=m.chars?`메모리 ${m.chars>=1000?(m.chars/1000).toFixed(1)+'k':m.chars+'자'}${m.overLimit?' ⚠':''}`:'메모리';
}
$('#memory-open').onclick=async()=>{const r=await api('/api/memory');$('#memory-text').value=r.text;$('#memory-info').textContent=`${r.chars.toLocaleString()}자${r.overLimit?` — 권장 상한 ${r.maxChars.toLocaleString()}자 초과(주입은 계속되지만 비용이 늘어납니다)`:''}`;$('#memory').showModal();};
$('#memory-close').onclick=()=>$('#memory').close();
$('#memory-save').onclick=async()=>{try{const r=await api('/api/memory',{method:'POST',body:JSON.stringify({text:$('#memory-text').value})});$('#memory-info').textContent=`저장됨 · ${r.chars.toLocaleString()}자`;renderBudgetMemory({memory:r});}catch(e){alert(msg(e.message));}};

async function handoff(messageId,to){
  const note=prompt(`${label(to)}에게 이 답변 전문과 함께 보낼 요청`, '위 답변을 독립적으로 검토하고 문제점·수정안을 제시해 주세요.');
  if(!note)return;
  await api('/api/send',{method:'POST',body:JSON.stringify({text:note,targets:[to],files:[...selectedFiles],handoffFrom:messageId})});
  active=to;renderTabs();renderPanels();
}
async function send(){
  const text=$('#text').value;if(!text.trim())return;
  let body;
  if(mode==='orchestrate'){
    const lead=$('#lead').value;const workers=[...selectedTargets].filter(id=>id!==lead);
    if(!workers.length){alert('팀장 외에 팀원 AI 를 하나 이상 선택하세요');return;}
    body={text,mode:'orchestrate',lead,workers,files:[...selectedFiles]};active=lead;renderTabs();
  }else{
    if(!selectedTargets.size){alert('보낼 AI를 하나 이상 선택하세요');return;}
    body={text,targets:[...selectedTargets],files:[...selectedFiles]};
  }
  $('#send').disabled=true;
  try{await api('/api/send',{method:'POST',body:JSON.stringify(body)});$('#text').value='';selectedFiles.clear();renderFiles();renderAttach();}
  catch(e){alert(msg(e.message));}finally{$('#send').disabled=false;}
}
$('#send').onclick=send;
$('#auth-check').onclick=async()=>{$('#auth-check').disabled=true;try{await api('/api/auth-check',{method:'POST',body:'{}'});}finally{$('#auth-check').disabled=false;}};
$('#text').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')send();});
$('#upload').onchange=async e=>{for(const f of e.target.files){const r=await fetch('/api/files?name='+encodeURIComponent(f.name),{method:'POST',credentials:'same-origin',body:f});if(r.status===401)showGate();}e.target.value='';};

// ---- 관리자 ----
async function renderAdmin(){
  const [{invites},{users,budgetDefault}]=await Promise.all([api('/api/admin/invites'),api('/api/admin/users')]);
  const ST={open:'미사용',used:'사용됨',expired:'만료',revoked:'취소'};
  $('#inv-table').innerHTML='<tr><th>상태</th><th>역할</th><th>발급</th><th>만료</th><th>사용자</th><th></th></tr>'+invites.slice().reverse().map(i=>`<tr><td>${ST[i.state]}</td><td>${i.role}</td><td>${new Date(i.createdAt).toLocaleString()}</td><td>${new Date(i.expiresAt).toLocaleString()}</td><td>${i.usedBy??''}</td><td>${i.state==='open'?`<button data-revoke="${i.id}">취소</button>`:''}</td></tr>`).join('');
  $('#user-table').innerHTML='<tr><th>ID</th><th>아이디</th><th>역할</th><th>가입</th><th>상태</th><th>월 토큰 상한</th><th></th></tr>'+users.map(u=>`<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${u.role}</td><td>${new Date(u.createdAt).toLocaleString()}</td><td>${u.disabled?'중지':'사용 중'}</td><td><input class="budget-in" data-budget="${u.id}" type="number" min="0" step="1000" placeholder="기본 ${budgetDefault||'무제한'}" value="${u.budget?u.budget.monthlyTokens:''}"> <button data-budget-save="${u.id}">저장</button></td><td>${u.id===state.user.id?'':`<button data-disable="${u.id}" data-to="${u.disabled?0:1}">${u.disabled?'다시 허용':'중지'}</button>`}</td></tr>`).join('');
  document.querySelectorAll('[data-budget-save]').forEach(b=>b.onclick=async()=>{const v=document.querySelector(`[data-budget="${b.dataset.budgetSave}"]`).value;try{await api('/api/admin/users/budget',{method:'POST',body:JSON.stringify({userId:Number(b.dataset.budgetSave),monthlyTokens:v===''?null:Number(v)})});b.textContent='저장됨';}catch(e){alert(msg(e.message));}});
  document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{await api('/api/admin/invites/revoke',{method:'POST',body:JSON.stringify({id:b.dataset.revoke})});renderAdmin();});
  document.querySelectorAll('[data-disable]').forEach(b=>b.onclick=async()=>{await api('/api/admin/users/disable',{method:'POST',body:JSON.stringify({userId:Number(b.dataset.disable),disabled:b.dataset.to==='1'})});renderAdmin();});
}
async function newInvite(role){
  const r=await api('/api/admin/invites',{method:'POST',body:JSON.stringify({role})});
  $('#inv-new').hidden=false;$('#inv-new').innerHTML=`새 ${role==='admin'?'관리자':'사용자'} 초대 코드 (지금만 표시됩니다, 7일 유효, 1회용): <code>${esc(r.code)}</code> <button id="inv-copy">복사</button>`;
  $('#inv-copy').onclick=()=>navigator.clipboard.writeText(r.code);
  renderAdmin();
}
$('#admin-open').onclick=()=>{$('#inv-new').hidden=true;$('#admin').showModal();renderAdmin();};
$('#admin-close').onclick=()=>$('#admin').close();
$('#inv-user').onclick=()=>newInvite('user');$('#inv-admin').onclick=()=>newInvite('admin');

// ---- 시작 ----
async function load(){
  state={...state,...await api('/api/state')};
  if(!active)active=state.adapters[0]?.id??null;
  if(!selectedTargets.size)state.adapters.forEach(a=>selectedTargets.add(a.id));
  $('#who').textContent=state.user.username+(state.user.role==='admin'?' (관리자)':'');
  $('#auth-check').hidden=false;$('#logout').hidden=false;$('#admin-open').hidden=state.user.role!=='admin';$('#memory-open').hidden=false;
  renderTargets();renderTabs();renderFiles();renderAttach();renderPanels();renderMode();renderBudgetMemory();
}
// SSE 가 (재)연결될 때마다 서버 스냅샷을 다시 읽어 끊긴 동안 놓친 완료·예산을 맞춘다 (GPT R12).
// 스냅샷은 id 로 병합한다: 로컬이 이미 끝난(done/error/blocked) 메시지를 스냅샷의 running 이 덮지 않게.
function mergeSnapshot(snap){
  const byId=new Map(state.messages.map(m=>[m.id,m]));
  for(const m of snap.messages??[]){const cur=byId.get(m.id);if(cur&&cur.status&&cur.status!=='running'&&m.status==='running')continue;byId.set(m.id,m);}
  state.messages=[...byId.values()].sort((a,b)=>a.id-b.id);
  for(const id of Object.keys(partials))if(!state.messages.some(m=>m.id===Number(id)&&m.status==='running'))delete partials[id];
}
function connect(){
  es?.close();es=new EventSource('/api/events');
  es.onopen=async()=>{$('#conn').textContent='연결됨';$('#conn').className='conn ok';try{const snap=await api('/api/state');mergeSnapshot(snap);state.adapters=snap.adapters??state.adapters;state.files=snap.files??state.files;if(snap.budget)state.budget=snap.budget;if(snap.memory)state.memory=snap.memory;if(typeof renderPanels==='function'){renderPanels();renderFiles();renderBudgetMemory();}}catch{}};
  es.onerror=()=>{$('#conn').textContent='연결 끊김 — 재시도 중';$('#conn').className='conn bad';};
  es.addEventListener('message',e=>{const m=JSON.parse(e.data);const i=state.messages.findIndex(x=>x.id===m.id);i>=0?state.messages[i]=m:state.messages.push(m);if(m.status!=='running')delete partials[m.id];renderPanels();});
  es.addEventListener('partial',e=>{const p=JSON.parse(e.data);partials[p.id]=p;const el=document.getElementById('m'+p.id);if(!el){renderPanels();return;}const t=el.querySelector('.partial'),g=el.querySelector('.progress');const prog=`수신 중 … ${(p.bytes/1024).toFixed(1)}KB · ${(p.elapsedMs/1000).toFixed(0)}s`;if(t&&p.partial){t.textContent=p.partial;if(g)g.textContent=prog;}else renderPanels();});
  es.addEventListener('budget',e=>renderBudgetMemory({budget:JSON.parse(e.data)}));
  es.addEventListener('memory',e=>renderBudgetMemory({memory:JSON.parse(e.data)}));
  es.addEventListener('files',e=>{state.files=JSON.parse(e.data);renderFiles();});
  es.addEventListener('state',e=>{const s=JSON.parse(e.data);state.adapters=s.adapters;if(s.messages)mergeSnapshot(s);if(s.budget)state.budget=s.budget;if(s.memory)state.memory=s.memory;renderPanels();renderBudgetMemory();});
  es.addEventListener('cli-login',e=>{const d=JSON.parse(e.data);const a=state.adapters.find(x=>x.id===d.adapterId);if(a){a.login=d.login;renderPanels();}});
}
async function boot(){
  const r=await fetch('/api/me',{credentials:'same-origin'});const me=await r.json().catch(()=>({}));
  if(!me.user){showGate(me);$('#conn').textContent='로그인 필요';$('#conn').className='conn bad';return;}
  hideGate();await load();connect();
}
boot().catch(e=>{$('#conn').textContent='초기화 실패: '+e.message;$('#conn').className='conn bad';});
