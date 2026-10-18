// 신뢰 프록시 목록 (재검수 V26·V27). Node 내장 net.BlockList 로 판정 — IPv4-mapped IPv6(::ffff:a.b.c.d), 압축 표기, embedded IPv4 를 내장이 처리한다.
// "미설정"(빈 문자열 → 모든 peer 신뢰)과 "설정했지만 잘못됨"을 분리: 항목 하나라도 틀리면 throw → 서버는 시작 거부. 오타가 전체 신뢰로 바뀌지 않는다.
import net from 'node:net';
export function buildTrusted(raw=''){
  const text=String(raw??'').trim();
  if(text==='')return {trustAll:true,rules:[],check:ip=>net.isIP(ip)>0};
  const bl=new net.BlockList();const rules=[];
  for(const item of text.split(',')){
    const entry=item.trim();
    const m=/^([^/\s]+)(?:\/([0-9]{1,3}))?$/.exec(entry);const fam=m?net.isIP(m[1]):0;
    if(!fam)throw Object.assign(new Error('trusted_proxy_invalid'),{entry,why:'IP 아님'});
    const type=fam===4?'ipv4':'ipv6';
    if(m[2]===undefined){bl.addAddress(m[1],type);rules.push(entry);continue;}
    const bits=Number(m[2]),width=fam===4?32:128;
    if(!Number.isInteger(bits)||bits<0||bits>width)throw Object.assign(new Error('trusted_proxy_invalid'),{entry,why:`prefix 는 0~${width}`});
    bl.addSubnet(m[1],bits,type);rules.push(entry);
  }
  return {trustAll:false,rules,check:ip=>{const fam=net.isIP(ip);return fam>0&&bl.check(ip,fam===4?'ipv4':'ipv6');}};
}
