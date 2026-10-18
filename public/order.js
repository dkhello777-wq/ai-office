// v0.9.1 답변 순서: "모두에게" 로 보낸 질문의 답변들은 고정 순서(Claude→ChatGPT→Gemini)가 아니라 먼저 끝난 AI 부터 위에 놓는다.
// 아직 답하는 중인 말풍선은 끝난 답변들 아래에 모아 둔다 → 위에서부터 읽는 동안 위쪽 말풍선이 갑자기 커져 읽던 곳이 밀리는 일이 없다.
// 팀장 모드(①계획·②작업·③종합)는 단계 순서가 의미라 건드리지 않는다. 브라우저(app.js)와 테스트가 같은 함수를 쓴다.
(function(){
  const finishKey=m=>{
    const f=Date.parse(m.finishedAt??'');if(Number.isFinite(f))return f;   // 서버가 끝난 시각을 기록 (v0.9.1 부터)
    const a=Date.parse(m.at??'');return (Number.isFinite(a)?a:0)+(Number.isFinite(m.elapsedMs)?m.elapsedMs:0);   // 옛 기록: 시작 시각 + 걸린 시간
  };
  const groupable=m=>m.role==='assistant'&&m.replyTo!=null&&(m.kind==null||m.kind==='answer');
  function orderTimeline(messages){
    const out=[],groups=new Map();
    for(const m of messages){
      if(!groupable(m)){out.push(m);continue;}
      let g=groups.get(m.replyTo);
      if(!g){g=[];groups.set(m.replyTo,g);out.push(g);}   // 무리의 자리는 첫 답변이 있던 자리
      g.push(m);
    }
    return out.flatMap(x=>Array.isArray(x)?[
      ...x.filter(m=>m.status!=='running').sort((a,b)=>finishKey(a)-finishKey(b)||a.id-b.id),
      ...x.filter(m=>m.status==='running').sort((a,b)=>a.id-b.id),
    ]:[x]);
  }
  globalThis.orderTimeline=orderTimeline;
})();
