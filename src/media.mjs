// v0.10.2 AI 가 만든 이미지·영상을 방에 올리기.
// AI(특히 Grok 의 이미지·영상 도구, Claude·Codex 의 python 스크립트)는 결과 파일을 아무 데나 저장한다(작업 폴더 하위, 임시 폴더, ~/.grok 아래 등).
// 실행이 끝나면 그 실행 동안 새로 생긴 미디어 파일을 찾아 파일함(shared/)에 복사하고 답변에 붙인다 → 화면이 말풍선 아래에 바로 보여 준다.
// 우선순위: ① 답변·출력에 경로가 적힌 파일 ② 실행 중에 생긴 파일(수정 시각 ≥ 시작). SVG 는 스크립트를 품을 수 있어 제외(다운로드만).
import {readdir,stat,copyFile,realpath} from 'node:fs/promises';
import path from 'node:path';

export const MEDIA_EXT={'.png':'image','.jpg':'image','.jpeg':'image','.gif':'image','.webp':'image','.mp4':'video','.webm':'video','.mov':'video','.m4v':'video'};
const SKIP_DIRS=new Set(['.git','node_modules','.venv','venv','__pycache__','.cache','logs','memtrace','log','installed-plugins','docs','.npm','site-packages']);
export const MEDIA_MAX_BYTES=100*1024*1024;
const MEDIA_MAX_FILES=12;

const kindOf=p=>MEDIA_EXT[path.extname(p).toLowerCase()]??null;

// 텍스트에서 미디어 파일 경로 후보를 뽑는다 ("saved to /a/b.png", "`shared/x.jpg`", "./out/img.webp")
export function mentionedPaths(text,{cwd}){
  const out=new Set();const t=String(text??'');const EXT='png|jpe?g|gif|webp|mp4|webm|mov|m4v';
  const add=p=>{p=p.trim().replace(/^~(?=\/)/,process.env.HOME??'~');if(!p)return;if(!path.isAbsolute(p))p=path.resolve(cwd,p);out.add(path.normalize(p));};
  // 절대 경로: 공백이 든 이름도 ("saved to /a/out 1.png")
  for(const m of t.matchAll(new RegExp(`(?:^|[\\s"'\`(\\[<:=])(~?\\/[^\\n"'\`<>|]*?\\.(?:${EXT}))(?=$|[\\s"'\`)\\]>,.;:!?])`,'gim')))add(m[1]);
  // 상대 경로·이름: 공백 없이 ("shared/포스터.webp", "./v/clip.mp4")
  for(const m of t.matchAll(new RegExp(`(?:^|[\\s"'\`(\\[<:=])((?:\\.{1,2}\\/)?[^\\s"'\`<>()\\[\\]/][^\\s"'\`<>()\\[\\]]*?\\.(?:${EXT}))(?=$|[\\s"'\`)\\]>,.;:!?])`,'gim')))add(m[1]);
  return [...out];
}

async function walk(dir,depth,since,acc,seen){
  if(depth<0||acc.length>200)return;
  let ents;try{ents=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const e of ents){
    const p=path.join(dir,e.name);
    if(e.isDirectory()){if(!SKIP_DIRS.has(e.name))await walk(p,depth-1,since,acc,seen);continue;}
    if(!e.isFile()||!kindOf(p))continue;
    let st;try{st=await stat(p);}catch{continue;}
    if(st.mtimeMs>=since&&st.size>0&&st.size<=MEDIA_MAX_BYTES&&!seen.has(p)){seen.add(p);acc.push({path:p,mtimeMs:st.mtimeMs,size:st.size});}
  }
}

// roots: [{dir, depth}]. allowed: 이 폴더들 밖의 경로는 언급돼도 받지 않는다(다른 사용자·시스템 파일 차단).
export async function findNewMedia({roots,allowed,since,text='',cwd,claimed=new Set()}){
  const inside=async p=>{let r;try{r=await realpath(p);}catch{return null;}return allowed.some(a=>r===a||r.startsWith(a+path.sep))?r:null;};
  const picked=[],seen=new Set();
  for(const p of mentionedPaths(text,{cwd})){
    if(!kindOf(p))continue;const r=await inside(p);if(!r||seen.has(r)||claimed.has(r))continue;
    let st;try{st=await stat(r);}catch{continue;}
    if(!st.isFile()||st.size<=0||st.size>MEDIA_MAX_BYTES||st.mtimeMs<since-60000)continue;   // 언급됐어도 이번 실행 전(1분 여유)에 있던 오래된 파일은 다시 올리지 않는다
    seen.add(r);picked.push({path:r,mtimeMs:st.mtimeMs,size:st.size,mentioned:true});
  }
  const found=[];
  for(const {dir,depth} of roots)await walk(dir,depth,since,found,new Set());
  for(const f of found.sort((a,b)=>a.mtimeMs-b.mtimeMs)){const r=await inside(f.path);if(r&&!seen.has(r)&&!claimed.has(r)){seen.add(r);picked.push({...f,path:r});}}
  return picked.slice(0,MEDIA_MAX_FILES);
}

// 파일함(shared)에 복사(이미 shared 안이면 그대로) → 답변에 붙일 목록
export async function collectMedia(files,{shared,prefix,safeName}){
  const out=[];const sharedReal=await realpath(shared).catch(()=>shared);
  for(const f of files){
    const kind=kindOf(f.path);if(!kind)continue;
    let name;
    if(path.dirname(f.path)===sharedReal)name=path.basename(f.path);
    else{
      const base=safeName(path.basename(f.path));
      name=safeName(`${prefix}-${base}`);
      try{await copyFile(f.path,path.join(shared,name));}catch{continue;}
    }
    out.push({name,kind,bytes:f.size});
  }
  return out;
}
