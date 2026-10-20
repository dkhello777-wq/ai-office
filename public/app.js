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
// v0.9.2 캐릭터 아바타: config 의 avatar 이미지가 있으면 그림, 못 불러오면 첫 글자로 (이미지가 사라지면 아래 글자가 보인다)
// v0.9.3 '모두에게'에 들어갈 AI: 연결됨 + 빼기(quiet) 아님 + 한도 쉬는 중 아님. @이름 으로 부르면 quiet 여도 답한다.
const cooling=a=>!!(a.cooldownUntil&&Date.parse(a.cooldownUntil)>Date.now());
const inAll=a=>connected(a)&&!a.quiet&&!cooling(a);
const whenKo=iso=>new Date(iso).toLocaleString('ko-KR',{month:'numeric',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit'});
const avHtml=(a,cls='')=>`<span class="av ${cls}" style="--ai-color:${esc(a.color??'#888')}" title="${esc(a.label??a.id)}">${esc(initial(a))}${a.avatar?`<img src="/${esc(a.avatar)}" alt="" onerror="this.remove()">`:''}</span>`;
const connected=a=>a.auth?.state==='subscription';
const ERR={busy:'AI 가 답하는 중이라 비울 수 없어요 — 먼저 긴급 중지를 누르세요',push_subscription_invalid:'이 브라우저의 알림 구독을 받을 수 없어요',quota_exhausted:'사용 한도가 찼습니다',quota_cooldown:'사용 한도 소진으로 쉬는 중',quiet_invalid:'잘못된 설정',gdrive_not_configured:'서버에 구글 드라이브 설정이 없습니다',gdrive_not_connected:'구글 드라이브가 연결되지 않았습니다',gdrive_reconnect_required:'구글 드라이브 권한이 만료됐습니다 — 다시 연결하세요',gdrive_access_denied:'구글에서 허용하지 않았습니다',gdrive_code_expired:'코드 시간이 지났습니다 — 다시 연결하세요',gdrive_scope_denied:'드라이브 권한을 허용하지 않았습니다',gdrive_device_failed:'구글 연결을 시작하지 못했습니다 (클라이언트 설정 확인)',gdrive_token_failed:'구글 인증에 실패했습니다',gdrive_folder_failed:'드라이브 폴더를 만들지 못했습니다',gdrive_upload_failed:'드라이브 업로드에 실패했습니다',gdrive_file_too_large:'200MB 넘는 파일은 올릴 수 없습니다',file_not_found:'파일이 없습니다',setup_code_invalid:'설정 코드가 맞지 않습니다 — 서버 로그(또는 data/setup-code)의 코드를 넣으세요',persist_failed:'답은 받았지만 저장에 실패했습니다 (서버 디스크 확인)',interrupted:'서버가 재시작되어 중단됨',body_too_large:'요청이 너무 큽니다',login_required:'로그인이 필요합니다',login_invalid:'비밀번호가 맞지 않습니다',too_many_attempts:'실패가 많아 15분간 잠겼습니다',password_too_short:'비밀번호는 10자 이상',already_set:'이미 비밀번호가 있습니다',login_already_running:'이미 연결 진행 중',login_not_configured:'이 AI 는 화면 연결 명령이 아직 없습니다',budget_exceeded:'이번 달 토큰 상한에 도달 — 메뉴 > 토큰 예산에서 조정',workers_required:'팀원이 될 AI 가 더 연결돼야 합니다',lead_required:'팀장 AI 를 먼저 지정하세요',plan_parse_failed:'팀장이 계획을 JSON 으로 내지 않아 분배를 멈췄습니다',budget_invalid:'상한은 0 이상의 숫자',cancelled:'취소됨',text_too_long:'글자 수 상한 초과',file_too_large:'파일 크기 상한 초과',state_corrupt:'대화 저장 파일이 손상됨',state_unreadable:'대화 저장 파일을 읽을 수 없음',not_logged_in:'아직 연결되지 않음 — 참여자에서 연결하세요',api_key_auth_detected:'API 키 모드라 차단됨 (구독 로그인만 허용)',third_party_auth_detected:'서드파티 인증이라 차단됨',auth_unverified:'인증 상태를 확인할 수 없어 차단됨',cli_not_found:'CLI 가 서버에 설치돼 있지 않음',cli_timeout:'시간 초과',all_tasks_failed:'팀원 작업이 전부 실패해 종합을 건너뜀',stopped:'긴급 중지로 멈춤 — 다음 단계로 가지 않음',empty_result:'답변이 비어 있어 실패로 처리',sandbox_failed:'Codex 샌드박스가 컨테이너에서 못 떠 명령이 실행되지 않음'};
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
// v0.8.9 긴 글 접기: 7줄(또는 700자) 넘는 말풍선은 처음 7줄만 보이고 "전체 보기" 로 펼친다. 본문은 그대로 다 들어 있고(복사·저장·검토도 전문), 화면 표시만 접는다.
// 펼친 말풍선은 expanded 에 기억해 스트리밍·새 메시지로 다시 그려도 펼친 채로 둔다.
const CLIP_LINES=7,CLIP_CHARS=700;const expanded=new Set();
const clipLabel=(open,lines)=>open?'▲ 접기':`▼ 전체 보기 · ${lines}줄`;
function clip(id,text,html){
  const t=String(text??'');const lines=t.split('\n').length;
  if(lines<=CLIP_LINES&&t.length<=CLIP_CHARS)return html;
  const open=expanded.has(id);
  return `<div class="clip${open?' open':''}">${html}</div><button class="clip-btn" data-clip="${id}" data-lines="${lines}">${clipLabel(open,lines)}</button>`;
}
function userHtml(m){
  const all=state.adapters.filter(connected).map(a=>a.id);
  const chips=m.mode==='orchestrate'?`<span class="chip-s">팀장 ${esc(label(m.lead))} → ${(m.workers??[]).map(label).map(esc).join(', ')}</span>`
    :(m.targets??[]).length&&!(m.targets.length===all.length&&m.targets.every(t=>all.includes(t)))?`<span class="chip-s">→ ${m.targets.map(label).map(esc).join(', ')}</span>`:'';
  const files=(m.files??[]).filter(f=>!/\.(png|jpe?g|gif|webp)$/i.test(f)).map(f=>`<span class="chip-s">📎 ${esc(f)}</span>`).join('');
  const pics=(m.files??[]).filter(f=>/\.(png|jpe?g|gif|webp)$/i.test(f));   // v0.10.3 내가 보낸 이미지는 그림으로
  const picHtml=pics.length?`<div class="media me-media">${pics.map(f=>{const u='/files/'+encodeURIComponent(f);return `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="${esc(f)}" loading="lazy"></a>`;}).join('')}</div>`:'';
  const hand=m.handoffFrom?`<span class="chip-s">↪ #${m.handoffFrom} 답변 포함</span>`:'';
  return `<div class="m me" id="m${m.id}"><div class="body">${picHtml}<div class="bubble">${clip(m.id,m.text,esc(m.text))}</div>${chips||files||hand?`<div class="chips" style="justify-content:flex-end">${chips}${files}${hand}</div>`:''}<div class="meta"><span>${timeOf(m.at)}</span></div></div></div>`;
}
function aiHtml(m){
  const a=ad(m.adapter)??{id:m.adapter,label:m.adapter,color:'#888'};
  const p=m.status==='running'?partials[m.id]:null;
  let body='',cls=m.status;
  if(m.status==='running')body=p?.partial?`<span class="partial">${esc(p.partial)}</span><div class="progress">수신 중 … ${(p.bytes/1024).toFixed(1)}KB · ${(p.elapsedMs/1000).toFixed(0)}s</div>`:`<span class="dots">${m.kind==='plan'?'계획 세우는 중':m.kind==='final'?'종합하는 중':'생각 중'}</span>`;
  else if(m.status==='done')body=(m.approvalRequested?`<div class="approval">✋ 승인 요청 — 이 AI 가 삭제나 과금이 필요한 일 앞에서 멈췄습니다. 내용을 읽고 허락하려면 답장으로 "진행해" 라고 보내세요.</div>`:'')+(m.kind==='plan'?`<details class="raw"><summary>계획 원문(JSON)</summary><pre>${esc(m.text)}</pre></details>`:clip(m.id,m.text,esc(m.text)));   // 팀장의 계획 JSON 은 접어 둔다 — 화면에는 분배 요약만, 답은 ③ 종합 말풍선에. v0.8.7: [승인 요청] 답변은 띠로 강조
  else if(m.status==='blocked')body=`🚫 ${esc(msg(m.error))}${m.resetAt?` · ${esc(whenKo(m.resetAt))} 초기화`:''}`;
  else if(m.status==='cancelled')body='⏹ 중지됨 — 긴급 중지로 끊김'+(m.text?'\n\n'+esc(m.text):'');
  else body=`⚠️ 오류: ${esc(msg(m.error))}${m.resetAt?` · ${esc(whenKo(m.resetAt))} 초기화까지 쉬어요`:''}${m.text?'\n\n'+esc(m.text):''}${m.stderrTail?`<details open><summary>CLI 오류 출력</summary><pre>${esc(m.stderrTail)}</pre></details>`:''}`;
  const kind=m.kind&&KIND[m.kind]?`<span class="kind ${m.kind}">${KIND[m.kind]}${m.taskTitle?' · '+esc(m.taskTitle):''}</span><br>`:'';
  const plan=m.kind==='plan'&&m.plan?`<div class="plan">분배: ${m.plan.tasks.length?m.plan.tasks.map(t=>`${esc(label(t.worker))} — ${esc(t.title||'(제목 없음)')}`).join(' · '):'팀원 없이 직접 답함'}${m.plan.dropped?` · 버린 작업 ${m.plan.dropped}개`:''}${m.plan.note?'<br>'+esc(m.plan.note):''}${m.orchestrateError?'<br>'+esc(msg(m.orchestrateError)):''}</div>`:'';
  const ev=m.evidence?`<details><summary>실행 증거</summary><pre>${esc(`종료 코드 ${m.exitCode??'-'}${m.signal?' / 시그널 '+m.signal:''}${m.timedOut?' / 시간 초과':''}\nstdout ${m.evidence.stdoutBytes}B · stderr ${m.evidence.stderrBytes}B\n${m.evidence.dir}`)}</pre></details>`:'';
  const auth=m.status==='blocked'&&m.authCheck?`<details><summary>인증 확인</summary><pre>${esc(`${m.authCheck.state} (${m.authCheck.reason})${m.authCheck.subscriptionType?' / 구독 '+m.authCheck.subscriptionType:''}`)}</pre></details>`:'';
  const others=state.adapters.filter(x=>x.id!==m.adapter&&connected(x));
  // v0.10.2 AI 가 만든 이미지·영상: 답변 아래에 바로. 누르면 원본(새 탭)
  const media=(m.media??[]).length?`<div class="media">${m.media.map(f=>{const u='/files/'+encodeURIComponent(f.name);return f.kind==='video'?`<video src="${u}" controls playsinline preload="none"></video>`:`<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="${esc(f.name)}" loading="lazy"></a>`;}).join('')}</div>`:'';
  const acts=m.status==='done'&&m.kind!=='plan'?`<div class="acts">${others.map(x=>`<button data-handoff="${m.id}" data-to="${x.id}">→ ${esc(x.label)} 검토</button>`).join('')}<button data-memo="${m.id}">🧠 기억</button><button data-save="${m.id}">💾 저장</button><button data-copy="${m.id}">복사</button></div>`:'';
  const meta=`<span class="meta">${m.status==='done'&&m.elapsedMs?`<span>${(m.elapsedMs/1000).toFixed(1)}초</span>`:''}<span>${timeOf(m.at)}</span>${m.usage?`<span>${esc(usageShort(m.usage))}</span>`:''}</span>`;
  // v0.9.2 하얀 도트: 아바타·이름·시간을 한 줄 머리로, 본문은 말풍선 없이 그 아래
  return `<div class="m ai" id="m${m.id}" style="--ai-color:${esc(a.color)}"><div class="ai-head">${avHtml(a)}<span class="name">${esc(a.label)}</span>${meta}</div><div class="body"><div class="bubble ${cls}">${kind}${m.kind==='plan'&&m.status==='done'?plan+body:body+plan}${auth||ev}</div>${media}${acts}</div></div>`;
}
function usageShort(u){const i=u.input??u.input_tokens??u.prompt_tokens,o=u.output??u.output_tokens??u.completion_tokens;return Number.isFinite(i)&&Number.isFinite(o)?`${i}+${o} 토큰`:'';}
const SHOW_MAX=60,SHOW_STEP=100;let shown=SHOW_MAX;   // v0.10.6
function renderTimeline(){
  const tl=$('#timeline');const chat=$('#chat');const atBottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<80;
  // v0.9.1 읽던 자리 유지: 화면 맨 위에 걸친 말풍선과 그 위치를 기억했다가 다시 그린 뒤 같은 자리로 맞춘다 (맨 아래를 보고 있을 때만 아래로 따라감)
  const anchor=atBottom?null:readingAnchor(chat,tl);
  let html='',lastDay='';
  if(!state.messages.length)html=`<div class="sys">여기는 내 AI 오피스입니다.<br>오른쪽 위 참여자에서 구독 중인 AI 를 연결하면 방에 들어옵니다.</div>`;
  // v0.10.6 가벼운 화면: 최근 SHOW_MAX 개만 그린다(대화가 쌓이면 DOM 이 커져 글자 입력마다 렉). 위의 "이전 대화 더 보기" 로 더 꺼낸다
  const ordered=orderTimeline(state.messages);   // v0.9.1: 모두에게 보낸 답은 먼저 끝난 AI 부터 (public/order.js)
  const hidden=Math.max(0,ordered.length-shown);
  const older=hidden+(state.older??0);
  if(older)html+=`<div class="sys more-wrap"><button class="btn small" id="more-older">▲ 이전 대화 ${older}개 더 보기</button></div>`;
  for(const m of ordered.slice(hidden)){
    const d=dayOf(m.at);if(d!==lastDay){html+=`<div class="day">${esc(d)}</div>`;lastDay=d;}
    html+=m.role==='user'?userHtml(m):aiHtml(m);
  }
  tl.innerHTML=html;
  $('#more-older')?.addEventListener('click',async()=>{
    const first=tl.querySelector('.m');const top=first?.getBoundingClientRect().top;
    if(!hidden&&state.older){   // 화면에 있는 건 다 보였고 서버에 더 있음 → 100개 받아 앞에 붙인다
      const minId=Math.min(...state.messages.map(m=>m.id));
      try{const r=await api(`/api/messages?before=${minId}&limit=${SHOW_STEP}`);state.older=r.older??0;const have=new Set(state.messages.map(m=>m.id));for(const m of r.messages??[])if(!have.has(m.id))state.messages.push(m);state.messages.sort((a,b)=>a.id-b.id);shown+=(r.messages??[]).length;}catch(e){toast(msg(e.message));return;}
    }else shown+=SHOW_STEP;
    renderTimeline();if(first){const el=document.getElementById(first.id);if(el)chat.scrollTop+=el.getBoundingClientRect().top-top;}
  });
  $('#stop').hidden=!state.messages.some(m=>m.status==='running');   // v0.8.8: 돌고 있는 AI 가 있을 때만 긴급 중지 버튼
  if(atBottom)chat.scrollTop=chat.scrollHeight;
  else if(anchor){const el=document.getElementById(anchor.id);if(el)chat.scrollTop+=el.getBoundingClientRect().top-anchor.top;}
  // v0.9.1 펼치기·접기: 전체를 다시 그리지 않고 그 자리에서 바꾼다. 말풍선 위치를 고정해 펼친 곳 아래로 늘어난다 (전에는 다시 그리면서 답변 맨 아래로 내려갔다)
  tl.querySelectorAll('[data-clip]').forEach(b=>b.onclick=()=>toggleClip(b));
  tl.querySelectorAll('[data-handoff]').forEach(b=>b.onclick=()=>handoff(Number(b.dataset.handoff),b.dataset.to));
  tl.querySelectorAll('[data-save]').forEach(b=>b.onclick=async()=>{const name=prompt('저장할 파일 이름',`answer-${b.dataset.save}.md`);if(name){await api('/api/save',{method:'POST',body:JSON.stringify({messageId:Number(b.dataset.save),name})});toast('파일로 저장됨');}});
  tl.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{navigator.clipboard.writeText(state.messages.find(m=>m.id===Number(b.dataset.copy))?.text??'');toast('복사됨');});
  tl.querySelectorAll('[data-memo]').forEach(b=>b.onclick=async()=>{const note=prompt('메모리에 덧붙일 한 줄 설명 (비워도 됨)','');if(note===null)return;try{const r=await api('/api/memory/append',{method:'POST',body:JSON.stringify({messageId:Number(b.dataset.memo),note})});state.memory=r;renderBadges();toast('메모리에 추가됨');}catch(e){toast(msg(e.message));}});
}
function readingAnchor(chat,tl){
  const top=chat.getBoundingClientRect().top;
  for(const el of tl.querySelectorAll('.m')){const r=el.getBoundingClientRect();if(r.bottom>top+1)return {id:el.id,top:r.top};}
  return null;
}
function toggleClip(b){
  const id=Number(b.dataset.clip),box=b.previousElementSibling,chat=$('#chat');if(!box)return;
  const open=!expanded.has(id);open?expanded.add(id):expanded.delete(id);
  const before=box.getBoundingClientRect().top;
  box.classList.toggle('open',open);b.textContent=clipLabel(open,b.dataset.lines);
  chat.scrollTop+=box.getBoundingClientRect().top-before;   // 말풍선 윗부분을 제자리에
  if(!open){const r=box.getBoundingClientRect(),c=chat.getBoundingClientRect();if(r.top<c.top)chat.scrollTop-=c.top-r.top+8;}   // 접었는데 말풍선 머리가 화면 위로 숨었으면 보이게
}
function scrollBottom(){const c=$('#chat');c.scrollTop=c.scrollHeight;}

// ---- 헤더 · 참여자 ----
function renderHeader(){
  const on=state.adapters.filter(inAll);
  $('#room-count').textContent=state.adapters.filter(connected).length+1;
  $('#people-open').innerHTML=state.adapters.map(a=>avHtml(a,connected(a)?'':'off')).join('')||'<span class="hint">참여자 없음</span>';
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
    const extra=connected(a)?`<div class="pextra">${cooling(a)?`<span class="pstatus warn">⏸ 사용 한도 소진 · ${esc(whenKo(a.cooldownUntil))} 초기화</span><button class="btn small p-cool">지금 풀기</button>`:''}<label class="switch"><input type="checkbox" class="p-quiet" ${a.quiet?'':'checked'}><span>모두에게 포함</span></label>${a.quiet?'<span class="hint small">@이름 으로 부를 때만 답해요</span>':''}</div>`:'';
    return `<div class="person" data-id="${a.id}" style="--ai-color:${esc(a.color)}">${avHtml(a,connected(a)?'':'off')}<div class="info"><div class="pname">${esc(a.label)}${isLead?'<span class="lead-tag">팀장</span>':''}</div><div class="prole">${esc(a.roleHint||'')}</div>${status}${extra}<div class="pacts">${a.canLogin&&!running?`<button class="btn small primary p-login">${connected(a)?'다시 연결':'연결하기'}</button>`:''}${!a.canLogin?`<span class="hint small">이 AI 는 아직 화면 연결을 지원하지 않습니다</span>`:''}${connected(a)?`<button class="btn small p-lead">${isLead?'팀장 해제':'팀장으로'}</button><button class="btn small p-reset" title="이 AI 의 이어가기 세션을 새로 시작">새 대화</button>`:''}</div><div class="login-slot">${loginBoxHtml(a)}</div></div></div>`;
  }).join('')||'<p class="hint">설정된 AI 가 없습니다 (config/adapters.json)</p>';
  list.querySelectorAll('.person').forEach(p=>{
    const id=p.dataset.id;
    p.querySelector('.p-login')?.addEventListener('click',async()=>{try{await api('/api/cli-login',{method:'POST',body:JSON.stringify({adapterId:id})});}catch(e){toast(msg(e.message));}});
    p.querySelector('.p-quiet')?.addEventListener('change',async e=>{try{await api('/api/settings/quiet',{method:'POST',body:JSON.stringify({adapterId:id,quiet:!e.target.checked})});}catch(x){toast(msg(x.message));}});
    p.querySelector('.p-cool')?.addEventListener('click',async()=>{if(!confirm('한도 쉬는 시간을 풀까요? 실제 한도가 남아 있지 않으면 다시 실패합니다.'))return;try{await api('/api/settings/cooldown-clear',{method:'POST',body:JSON.stringify({adapterId:id})});}catch(x){toast(msg(x.message));}});
    p.querySelector('.p-lead')?.addEventListener('click',async()=>{await api('/api/settings/lead',{method:'POST',body:JSON.stringify({adapterId:state.lead===id?null:id})});});
    p.querySelector('.p-reset')?.addEventListener('click',async()=>{await api('/api/reset',{method:'POST',body:JSON.stringify({adapterId:id})});toast(label(id)+' 새 대화 시작');});
    const inp=p.querySelector('.login-input');
    if(inp){const send=async()=>{if(!inp.value)return;await api('/api/cli-login/input',{method:'POST',body:JSON.stringify({adapterId:id,text:inp.value})});inp.value='';};p.querySelector('.login-send').onclick=send;inp.onkeydown=e=>{if(e.key==='Enter')send();};p.querySelector('.login-cancel').onclick=()=>api('/api/cli-login/cancel',{method:'POST',body:JSON.stringify({adapterId:id})});}
  });
}
function renderBadges(){
  if($('#push-badge'))mySub().then(x=>{$('#push-badge').textContent=x?'켜짐':'';}).catch(()=>{});
  const b=state.budget;if(b){const pct=b.limit?Math.round(b.tokens/b.limit*100):null;$('#budget-badge').textContent=`${b.tokens.toLocaleString()}${b.limit?` / ${b.limit.toLocaleString()} (${pct}%)`:''} · ${b.calls}회`;$('#budget-badge').style.color=b.exceeded?'var(--bad)':pct!==null&&pct>=80?'var(--warn)':'';}
  const m=state.memory;if(m)$('#memory-badge').textContent=m.chars?`${m.chars>=1000?(m.chars/1000).toFixed(1)+'k':m.chars}자${m.overLimit?' ⚠':''}`:'비어 있음';
  $('#files-badge').textContent=state.files.length?state.files.length+'개':'';
}
// v0.9.2 파일함 + 구글 드라이브로 보내기: 연결돼 있으면 파일마다 '드라이브로' 버튼. 연결은 기기 코드(폰에서 코드 입력) — 서버가 drive.file 권한으로 "AI 오피스" 폴더에만 올린다.
let gdrive=null,gdrivePoll=null;
function renderFiles(){
  const up=gdrive?.connected;
  $('#filelist').innerHTML=state.files.map(f=>`<li class="${attached.has(f.name)?'on':''}" data-name="${esc(f.name)}"><span>${esc(f.name)}</span><small>${(f.bytes/1024).toFixed(1)}KB</small>${up?`<button class="btn small gd-up" data-up="${esc(f.name)}">드라이브로</button>`:''}<a href="/files/${encodeURIComponent(f.name)}" target="_blank" title="열기">↗</a></li>`).join('')||'<li class="hint">없음 — + 로 올리거나 답변을 저장하세요</li>';
  $('#filelist').querySelectorAll('li[data-name]').forEach(li=>li.onclick=e=>{if(e.target.closest('a,button'))return;const n=li.dataset.name;attached.has(n)?attached.delete(n):attached.add(n);renderFiles();renderAttach();});
  $('#filelist').querySelectorAll('[data-up]').forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent='올리는 중…';try{const r=await api('/api/gdrive/upload',{method:'POST',body:JSON.stringify({name:b.dataset.up})});b.textContent='올림 ✓';toast('드라이브에 올렸습니다 — '+r.name);}catch(e){b.disabled=false;b.textContent='드라이브로';toast(msg(e.message));if(/reconnect|not_connected/.test(e.message))loadGdrive();}});
  renderGdrive();renderBadges();
}
function renderGdrive(){
  const el=$('#gdrive-bar');if(!el)return;const g=gdrive;
  if(!g||!g.configured){el.innerHTML='<span class="hint">구글 드라이브로 보내기: 서버에 GDRIVE_CLIENT_ID·GDRIVE_CLIENT_SECRET 를 넣으면 켜집니다</span>';return;}
  if(g.connected){el.innerHTML=`<span class="gd-on">● 구글 드라이브 연결됨</span>${g.folderUrl?`<a href="${esc(g.folderUrl)}" target="_blank" rel="noopener">AI 오피스 폴더 열기</a>`:''}<button class="btn small" id="gd-off">연결 해제</button>`;$('#gd-off').onclick=async()=>{if(!confirm('구글 드라이브 연결을 해제할까요? 이미 올린 파일은 드라이브에 그대로 남습니다.'))return;gdrive=await api('/api/gdrive/disconnect',{method:'POST',body:'{}'});renderFiles();};return;}
  if(g.pending){el.innerHTML=`<div><b>1.</b> <a href="${esc(g.pending.verificationUrl)}" target="_blank" rel="noopener">${esc(g.pending.verificationUrl)}</a> 를 열고<br><b>2.</b> 코드 <code>${esc(g.pending.userCode)}</code> 입력 → 허용</div><span class="hint">허용하면 자동으로 연결됩니다<span class="dots"></span></span><button class="btn small" id="gd-cancel">취소</button>`;$('#gd-cancel').onclick=async()=>{gdrive=await api('/api/gdrive/cancel',{method:'POST',body:'{}'});renderGdrive();};return;}
  el.innerHTML=`<span class="hint">파일을 구글 드라이브 "AI 오피스" 폴더로 보낼 수 있어요${g.lastError?` · 지난 시도: ${esc(msg(g.lastError))}`:''}</span><button class="btn small primary" id="gd-on">드라이브 연결</button>`;
  $('#gd-on').onclick=async()=>{try{gdrive=await api('/api/gdrive/connect',{method:'POST',body:'{}'});renderGdrive();watchGdrive();}catch(e){toast(msg(e.message));}};
}
async function loadGdrive(){try{gdrive=await api('/api/gdrive');}catch{gdrive=null;}renderFiles();}
function watchGdrive(){clearInterval(gdrivePoll);gdrivePoll=setInterval(async()=>{if(!$('#files').open){clearInterval(gdrivePoll);return;}const was=gdrive?.connected;await loadGdrive();if(!gdrive?.pending){clearInterval(gdrivePoll);if(!was&&gdrive?.connected)toast('구글 드라이브 연결됨');}},3000);}
function renderAttach(){const row=$('#attach-row');row.hidden=!attached.size;row.innerHTML=[...attached].map(n=>IMG_RE.test(n)?`<span class="att-img" data-rm="${esc(n)}" title="${esc(n)} — 눌러서 빼기"><img src="/files/${encodeURIComponent(n)}" alt=""><b>✕</b></span>`:`<span class="chip-s" data-rm="${esc(n)}">📎 ${esc(n)} ✕</span>`).join('');row.querySelectorAll('[data-rm]').forEach(c=>c.onclick=()=>{attached.delete(c.dataset.rm);renderAttach();renderFiles();});}
function renderAll(){renderHeader();renderTimeline();renderPeople();renderFiles();renderBadges();}

// ---- 보내기: 멘션 → 팀장 → 모두 ----
const ALIAS={claude:['클로드','claude','클'],codex:['코덱스','codex','지피티','챗지피티','gpt','chatgpt','오픈ai','openai'],gemini:['제미나이','제미니','gemini','구글','google'],grok:['그록','grok','그로크','grk']};
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
  const on=state.adapters.filter(inAll).map(a=>a.id);   // v0.9.3: 빼 둔 AI·한도 쉬는 AI 제외
  const mentioned=parseMentions(text);
  let body;
  if(mentioned.length)body={text,targets:mentioned,files:[...attached]};
  else if(route==='lead'){
    if(!state.lead){toast(msg('lead_required'));$('#people').showModal();return;}
    const workers=on.filter(id=>id!==state.lead);
    body=workers.length?{text,mode:'orchestrate',lead:state.lead,workers,files:[...attached]}:{text,targets:[state.lead],files:[...attached]};
  }else{
    if(!on.length){toast(state.adapters.some(connected)?'모두에게에 들어간 AI 가 없습니다 — @이름 으로 부르거나 참여자에서 켜세요':'먼저 참여자를 연결하세요');$('#people').showModal();return;}
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
// v0.8.8 긴급 중지: 확인창 없이 즉시 (급할 때 누르는 버튼). 서버가 돌고 있는 CLI 전부를 끊고 대기열도 비운다.
$('#stop').onclick=async()=>{const b=$('#stop');b.disabled=true;try{const r=await api('/api/stop',{method:'POST',body:'{}'});toast(r.stopped?`긴급 중지 — 실행 ${r.stopped}건 끊음`:'돌고 있는 작업이 없습니다');}catch(e){toast(msg(e.message));}finally{b.disabled=false;}};
// v0.8.6: Enter = 전송, Shift+Enter = 줄바꿈 (Ctrl/Cmd+Enter 도 전송). 한글 IME 조합 중(isComposing)의 Enter 는 무시해 마지막 글자가 두 번 들어가거나 조합이 끊기지 않게.
$('#text').addEventListener('keydown',e=>{if(e.key!=='Enter'||e.isComposing||e.keyCode===229)return;if(e.shiftKey)return;e.preventDefault();send();});
function autosize(){const t=$('#text');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,140)+'px';}
$('#text').addEventListener('input',autosize);
$('#route-all').onclick=()=>{route='all';$('#route-all').classList.add('on');$('#route-lead').classList.remove('on');renderHeader();};
$('#route-lead').onclick=()=>{route='lead';$('#route-lead').classList.add('on');$('#route-all').classList.remove('on');renderHeader();if(!state.lead){toast('참여자에서 팀장을 지정하세요');$('#people').showModal();}};
// v0.10.3 첨부 한 곳으로: 📎 선택 · 끌어다 놓기 · 붙여넣기(Ctrl/Cmd+V) 모두 여기로
const IMG_RE=/\.(png|jpe?g|gif|webp)$/i;
const stamp=()=>new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);
async function uploadFiles(list){
  const files=[...list].filter(f=>f&&f.size>0);if(!files.length){if([...list].length)toast('빈 파일이라 올리지 않았어요');return;}
  const max=state.limits?.uploadBytes??50*1024*1024;let n=0;
  for(const [i,f] of files.entries()){
    if(f.size>max){toast(`${f.name||'파일'}: ${(max/1048576)|0}MB 넘는 파일은 올릴 수 없어요`);continue;}
    // 붙여넣은 스크린샷은 이름이 image.png 처럼 같아서 겹친다 → 시각을 붙인다
    const ext=(f.name?.match(/\.[\w]+$/)?.[0])||('.'+(f.type.split('/')[1]||'bin').replace('jpeg','jpg'));
    const name=!f.name||/^(image|blob|clipboard)(\.\w+)?$/i.test(f.name)?`붙여넣기-${stamp()}${files.length>1?'-'+(i+1):''}${ext}`:f.name;
    try{
      const r=await fetch('/api/files?name='+encodeURIComponent(name),{method:'POST',credentials:'same-origin',body:f});
      if(r.status===401)return showGate({});
      let v={};try{v=await r.json();}catch{}
      if(v.name){attached.add(v.name);n++;}else toast(`${msg(v.error||'upload_failed')} (${r.status})`);
    }catch(e){toast(`올리지 못했어요 — 연결을 확인하세요 (${e?.name||'error'})`);console.warn('upload',e);}
  }
  renderAttach();if(n)toast(n>1?`${n}개 올렸어요 — 이번 메시지에 첨부됨`:'올렸어요 — 이번 메시지에 첨부됨');
}
// v0.10.4 📎 는 진짜 버튼 + 숨긴 input.click(): 폰(안드로이드 크롬·홈 화면 앱)에서 label 로 감싼 display:none 입력이 선택창을 못 열던 문제
$('#attach-btn').onclick=()=>{const u=$('#upload');u.value='';u.click();};
$('#upload').onchange=async e=>{await uploadFiles(e.target.files);e.target.value='';};
// 붙여넣기: 파일(이미지 포함)이 있으면 첨부로, 글자만이면 평소처럼 입력칸에
$('#text').addEventListener('paste',e=>{const fs=[...(e.clipboardData?.items??[])].filter(x=>x.kind==='file').map(x=>x.getAsFile()).filter(Boolean);if(!fs.length)return;e.preventDefault();uploadFiles(fs);});
// 끌어다 놓기: 화면 어디에 놓아도 첨부. 파일을 끌 때만 안내 띠를 보인다
let dragDepth=0;
const hasFiles=e=>[...(e.dataTransfer?.types??[])].includes('Files');
document.addEventListener('dragenter',e=>{if(!hasFiles(e)||$('#app').hidden)return;e.preventDefault();dragDepth++;document.body.classList.add('dragging');});
document.addEventListener('dragover',e=>{if(!hasFiles(e)||$('#app').hidden)return;e.preventDefault();e.dataTransfer.dropEffect='copy';});
document.addEventListener('dragleave',e=>{if(!hasFiles(e))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.body.classList.remove('dragging');});
document.addEventListener('drop',e=>{if(!hasFiles(e))return;e.preventDefault();dragDepth=0;document.body.classList.remove('dragging');if(!$('#app').hidden)uploadFiles(e.dataTransfer.files);});

// ---- 시트 ----
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
$('#people-open').onclick=()=>{renderPeople();$('#people').showModal();};
$('#menu-open').onclick=()=>{renderBadges();storageBadge();$('#menu').showModal();};
const openFromMenu=(id,fn)=>()=>{$('#menu').close();fn?.();$('#'+id).showModal();};
$('#m-memory').onclick=openFromMenu('memory',async()=>{const r=await api('/api/memory');$('#memory-text').value=r.text;$('#memory-info').textContent=`${r.chars.toLocaleString()}자${r.overLimit?` — 권장 상한 ${r.maxChars.toLocaleString()}자 초과`:''}`;});
$('#memory-save').onclick=async()=>{try{const r=await api('/api/memory',{method:'POST',body:JSON.stringify({text:$('#memory-text').value})});$('#memory-info').textContent=`저장됨 · ${r.chars.toLocaleString()}자`;state.memory=r;renderBadges();}catch(e){toast(msg(e.message));}};
$('#m-files').onclick=openFromMenu('files',()=>{renderFiles();loadGdrive().then(()=>{if(gdrive?.pending)watchGdrive();});});
$('#m-budget').onclick=openFromMenu('budget',()=>{const b=state.budget;$('#budget-now').textContent=b?`${b.month} 사용 ${b.tokens.toLocaleString()} 토큰 · ${b.calls}회 · 상한 ${b.limit?b.limit.toLocaleString():'무제한'}`:'';$('#budget-in').value=b?.limit||'';});
$('#budget-save').onclick=async()=>{try{const v=$('#budget-in').value;const r=await api('/api/settings/budget',{method:'POST',body:JSON.stringify({monthlyTokens:v===''?null:Number(v)})});state.budget=r.budget;renderBadges();$('#budget').close();toast('예산 저장됨');}catch(e){toast(msg(e.message));}};
const roomBadge=()=>{$('#room-badge').textContent=state.user?.roomShare===false?'꺼짐':'켜짐 — AI 들이 서로의 말을 봅니다';};
$('#m-room').onclick=async()=>{const next=state.user?.roomShare===false;try{await api('/api/settings/room',{method:'POST',body:JSON.stringify({share:next})});state.user={...(state.user??{}),roomShare:next};roomBadge();toast(next?'방 대화 공유 켬':'방 대화 공유 끔');}catch(e){toast(msg(e.message));}};
// v0.9.0 저장 공간: 사용률 표시 + 지금 정리 (자동 정리와 같은 규칙 — 오래된 실행 기록·CLI 대화 기록만, 작업 파일·대화·로그인은 지우지 않음)
const fmtGB=b=>(b/1073741824).toFixed(2)+'GB';
async function storageBadge(){try{const s=await api('/api/storage');if(s.usage)$('#storage-badge').textContent=`${s.usage.pct}%`;return s;}catch{return null;}}
$('#m-storage').onclick=async()=>{
  const s=await storageBadge();if(!s?.usage){toast('저장 공간을 읽지 못했습니다');return;}
  const l=s.last;const last=l?`\n마지막 정리: ${new Date(l.at).toLocaleString('ko-KR')} · ${l.deleted}개 삭제 · ${(l.freedBytes/1048576).toFixed(1)}MB 확보`:'\n아직 정리한 적 없음';
  const text=`사용 중 ${fmtGB(s.usage.used)} / ${fmtGB(s.usage.total)} (${s.usage.pct}%)\n\n자동 정리 규칙\n· ${s.highPct}% 넘으면 ${s.lowPct}% 아래가 될 때까지 오래된 기록부터 삭제\n· ${s.maxAgeDays}일 지난 기록은 항상 삭제\n· 지우는 것: 실행 증거, AI 프로그램의 대화 기록 파일\n· 지우지 않는 것: 작업 파일, 메모리, 이 방의 대화, 로그인 정보${last}\n\n지금 규칙대로 정리할까요?`;
  if(!confirm(text))return;
  try{const r=await api('/api/storage/cleanup',{method:'POST',body:'{}'});const x=r.result;toast(x?(x.deleted?`${x.deleted}개 정리 · ${(x.freedBytes/1048576).toFixed(1)}MB 확보 · ${x.after.pct}%`:'지울 대상이 없습니다 (규칙에 맞는 오래된 기록 없음)'):'정리 실패');storageBadge();}catch(e){toast(msg(e.message));}
};
$('#m-clear').onclick=async()=>{$('#menu').close();if(state.messages.some(m=>m.status==='running')){toast(ERR.busy);return;}if(!confirm('방의 대화를 모두 지울까요?\n\n• 화면의 메시지가 전부 사라집니다 (되돌릴 수 없음)\n• AI 들도 새 대화로 시작합니다 (이전 맥락을 잊음)\n• 파일함·메모리·토큰 예산은 그대로'))return;try{const r=await api('/api/clear',{method:'POST',body:'{}'});toast(r.removed?`${r.removed}개 메시지를 지웠어요 — 새 방처럼 시작`:'이미 비어 있어요');}catch(e){toast(msg(e.message));}};
$('#m-auth').onclick=async()=>{$('#menu').close();toast('확인 중…');try{await api('/api/auth-check',{method:'POST',body:'{}'});}catch(e){toast(msg(e.message));}};
$('#m-password').onclick=openFromMenu('password');
$('#password-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/api/settings/password',{method:'POST',body:JSON.stringify({current:f.get('current'),next:f.get('next')})});e.target.reset();$('#password').close();showGate({});toast('변경됨 — 다시 로그인하세요');}catch(x){$('#password-msg').textContent=msg(x.message);}};
$('#m-logout').onclick=async()=>{$('#menu').close();try{await api('/api/logout',{method:'POST',body:'{}'});}catch{}es?.close();state={user:null,lead:null,adapters:[],messages:[],files:[],budget:null,memory:null};showGate({});};

// ---- v0.10 푸시 알림: 서비스 워커 등록 · 이 기기 구독 · 화면 보고 있음 신호 ----
const isIOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const pushOK=()=>'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
let swReg=null;
async function swReady(){if(!('serviceWorker' in navigator))return null;try{swReg=swReg??await navigator.serviceWorker.register('/sw.js');return swReg;}catch(e){console.warn('sw',e);return null;}}
async function mySub(){const r=await swReady();return r?await r.pushManager.getSubscription():null;}
const u8=b64=>{const s=atob(b64.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-b64.length%4)%4));return Uint8Array.from(s,c=>c.charCodeAt(0));};
async function renderPush(){
  const el=$('#push-body');
  if(!pushOK()){el.innerHTML=isIOS&&!standalone()?`<p>아이폰은 <b>홈 화면에 추가</b>한 앱에서만 알림을 받을 수 있어요.</p><ol class="hint"><li>사파리 아래 공유 버튼 → <b>홈 화면에 추가</b></li><li>홈 화면의 AI 오피스로 열기</li><li>여기서 다시 <b>알림 받기</b></li></ol>`:'<p class="hint">이 브라우저는 알림을 지원하지 않아요. 크롬·사파리 최신판에서 열어 주세요.</p>';return;}
  const sub=await mySub();let st={};try{st=await api('/api/push'+(sub?'?endpoint='+encodeURIComponent(sub.endpoint):''));}catch{}
  const on=!!(sub&&st.thisDevice);const denied=Notification.permission==='denied';
  el.innerHTML=`<div class="gdrive">${on?'<span class="gd-on">● 이 기기에서 알림 받는 중</span><button class="btn small" id="push-test">테스트 보내기</button><button class="btn small" id="push-off">끄기</button>':denied?'<span class="hint">알림이 차단돼 있어요 — 브라우저(또는 휴대폰) 설정에서 이 사이트 알림을 허용해 주세요</span>':'<span class="hint">AI 가 답을 다 했거나 허락을 기다릴 때 알려 드려요</span><button class="btn small primary" id="push-on">이 기기에서 알림 받기</button>'}</div>
  <label class="switch row-line"><input type="checkbox" id="pp-done" ${st.prefs?.done!==false?'checked':''}><span>작업이 끝났을 때</span></label>
  <label class="switch row-line"><input type="checkbox" id="pp-ask" ${st.prefs?.ask!==false?'checked':''}><span>AI 가 허락을 기다릴 때 (✋ 승인 요청)</span></label>
  <p class="hint small">알림 받는 기기 ${st.devices??0}대 · 이 방 화면을 보고 있을 때는 보내지 않아요</p>`;
  $('#push-on')?.addEventListener('click',async()=>{
    try{
      if(await Notification.requestPermission()!=='granted'){toast('알림을 허용해야 받을 수 있어요');renderPush();return;}
      const r=await swReady();const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(st.publicKey)});
      await api('/api/push/subscribe',{method:'POST',body:JSON.stringify({subscription:s.toJSON(),label:navigator.userAgent.slice(0,80)})});toast('이 기기에서 알림을 받아요');renderPush();renderBadges();
    }catch(e){toast(msg(e.message));}
  });
  $('#push-off')?.addEventListener('click',async()=>{const s=await mySub();if(s){await api('/api/push/unsubscribe',{method:'POST',body:JSON.stringify({endpoint:s.endpoint})}).catch(()=>{});await s.unsubscribe().catch(()=>{});}toast('이 기기 알림을 껐어요');renderPush();renderBadges();});
  $('#push-test')?.addEventListener('click',async()=>{const r=await api('/api/push/test',{method:'POST',body:'{}'});toast(r.sent?'보냈어요 — 잠시 뒤 알림이 와요':'보낼 기기가 없어요');});
  for(const k of ['done','ask'])$('#pp-'+k).onchange=async e=>{await api('/api/push/prefs',{method:'POST',body:JSON.stringify({[k]:e.target.checked})});};
}
$('#m-push').onclick=openFromMenu('push',renderPush);
// 화면을 보고 있으면 30초마다 알림 — 서버는 45초 안에 신호가 있으면 푸시를 보내지 않는다
let presenceTimer=null;
function presence(){const v=document.visibilityState==='visible';fetch('/api/presence',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({visible:v}),keepalive:true}).catch(()=>{});clearInterval(presenceTimer);if(v)presenceTimer=setInterval(presence,30000);}
document.addEventListener('visibilitychange',presence);
// 알림을 눌러 들어오면 그 답변으로
function jumpToHash(){const id=location.hash.slice(1);if(!/^m\d+$/.test(id))return;if(!document.getElementById(id)&&state.messages.some(m=>'m'+m.id===id)){shown=state.messages.length;renderTimeline();}setTimeout(()=>document.getElementById(id)?.scrollIntoView({block:'start'}),120);}
navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.type==='open'){const u=new URL(e.data.url);if(u.hash){history.replaceState(null,'',u.hash);jumpToHash();}}});

// ---- 시작 · SSE ----
function mergeSnapshot(snap){
  if(Number.isSafeInteger(snap.clearedBefore)&&snap.clearedBefore>0){state.messages=state.messages.filter(m=>m.id>=snap.clearedBefore);for(const id of Object.keys(partials))if(Number(id)<snap.clearedBefore)delete partials[id];}   // v0.10.5 방 비우기 뒤 옛 메시지는 버린다
  const byId=new Map(state.messages.map(m=>[m.id,m]));
  for(const m of snap.messages??[]){const cur=byId.get(m.id);if(cur&&newer(cur,m))continue;byId.set(m.id,m);}
  state.messages=[...byId.values()].sort((a,b)=>a.id-b.id);
  for(const id of Object.keys(partials))if(!state.messages.some(m=>m.id===Number(id)&&m.status==='running'))delete partials[id];
}
// 검수 V19: seq 가 있으면 seq 로, 없으면(옛 저장분) terminal→running 회귀만 막는다
const TERMINAL=new Set(['done','error','blocked','cancelled']);
function newer(cur,m){if(Number.isSafeInteger(cur.seq)&&Number.isSafeInteger(m.seq))return cur.seq>m.seq;return TERMINAL.has(cur.status)&&cur.status!==m.status;}   // seq 없음: 끝난 상태는 다른 상태로 되돌리지 않는다
function applyState(s){state.adapters=s.adapters??state.adapters;if(Number.isSafeInteger(s.older))state.older=s.older;if(s.lead!==undefined)state.lead=s.lead;if(s.messages)mergeSnapshot(s);if(s.files)state.files=s.files;if(s.budget)state.budget=s.budget;if(s.memory)state.memory=s.memory;if(s.user){state.user=s.user;try{roomBadge();}catch{}}}
function connect(){
  es?.close();es=new EventSource('/api/events');
  es.onopen=async()=>{$('#conn').textContent='연결됨';$('#conn').className='conn ok';try{const snap=await api('/api/state');applyState(snap);renderAll();}catch{}};
  es.onerror=()=>{$('#conn').textContent='연결 끊김 — 재시도 중';$('#conn').className='conn bad';};
  es.addEventListener('cleared',e=>{const d=JSON.parse(e.data);state.messages=state.messages.filter(m=>m.id>=(d.clearedBefore??Infinity));for(const k of Object.keys(partials))delete partials[k];shown=SHOW_MAX;renderTimeline();});   // v0.10.5
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
  presence();jumpToHash();swReady();   // v0.10
  if(!state.adapters.some(connected))setTimeout(()=>{renderPeople();$('#people').showModal();},400);
}
boot().catch(e=>{$('#conn').textContent='초기화 실패: '+e.message;$('#conn').className='conn bad';});
