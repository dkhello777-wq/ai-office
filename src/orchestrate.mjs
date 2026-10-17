// v0.5 오케스트레이터 보조: 팀장 AI 의 답변 본문에서 계획 JSON 을 뽑는다. (서버와 테스트가 함께 쓰므로 별도 모듈)
// 허용 형식: {"tasks":[{"worker":"<id>","title":"...","prompt":"..."}],"note":"...","answer":null}
// ```json 펜스 안, 또는 본문의 첫 '{' ~ 마지막 '}' 를 시도. worker 가 허용 목록에 없거나 prompt 가 비면 그 작업은 버리되 dropped 로 센다. 남는 작업도 answer 도 없으면 null (계획 실패).
export function extractPlan(text,workerIds,maxTasks=6){
  const candidates=[];
  for(const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))candidates.push(m[1]);   // 펜스가 여럿이면 전부 후보 (Gemini FAIL1-3)
  const first=text.indexOf('{'),last=text.lastIndexOf('}');if(first>=0&&last>first)candidates.push(text.slice(first,last+1));
  for(const c of candidates){
    let d;try{d=JSON.parse(c);}catch{continue;}
    if(!d||typeof d!=='object'||!Array.isArray(d.tasks))continue;
    const tasks=d.tasks.filter(t=>t&&typeof t==='object'&&typeof t.prompt==='string'&&t.prompt.trim()&&workerIds.includes(t.worker)).slice(0,maxTasks).map(t=>({worker:t.worker,title:String(t.title??'').slice(0,120),prompt:t.prompt}));
    const answer=typeof d.answer==='string'&&d.answer.trim()?d.answer:null;
    // 작업이 하나도 안 남았는데 answer 도 없으면 "직접 답함"이 아니라 잘못된 계획이다 (GPT R06 / Gemini FAIL1-1,2). 버린 작업 수는 알려 준다.
    if(tasks.length===0&&!answer)continue;
    const dropped=d.tasks.length-Math.min(d.tasks.length,tasks.length);
    return {tasks,answer,note:typeof d.note==='string'?d.note:null,dropped,requested:d.tasks.length};
  }
  return null;
}
