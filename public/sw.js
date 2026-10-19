// v0.10 AI 오피스 서비스 워커: 푸시 알림만 다룬다(오프라인 캐시 없음 — 화면은 늘 서버의 최신본).
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch{d={title:'AI 오피스',body:e.data?.text()??''};}
  e.waitUntil(self.registration.showNotification(d.title||'AI 오피스',{body:d.body||'',tag:d.tag||'hub',renotify:true,icon:'/icon-192.png',badge:'/icon-192.png',data:{url:d.url||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=new URL(e.notification.data?.url||'/',self.location.origin).href;
  e.waitUntil((async()=>{
    const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of all){if(new URL(c.url).origin===self.location.origin){await c.focus();c.postMessage({type:'open',url});return;}}
    await self.clients.openWindow(url);
  })());
});
