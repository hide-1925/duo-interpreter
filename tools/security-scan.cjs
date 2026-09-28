#!/usr/bin/env node
/* 公開リポジトリの秘密情報・個人情報スキャナ（依存なし）。
 *
 *   node tools/security-scan.cjs                 作業ツリー（git 管理下）+ 全履歴 + commit metadata
 *   node tools/security-scan.cjs --tree          作業ツリーだけ
 *   node tools/security-scan.cjs --history       全 ref から到達できる全 blob
 *   node tools/security-scan.cjs --metadata      author/committer と commit message
 *   node tools/security-scan.cjs --json out.json 結果を JSON で書く（値は伏せる）
 *   node tools/security-scan.cjs --text FILE...  任意のファイル（PR本文の書き出しなど）
 *
 * ZIP は入れ子も含めてメモリ上で展開して調べる（ディスクへ書かないので zip-slip は起きない）。
 * 見つけた値そのものは出力しない。規則名・場所・長さ・SHA-256 の先頭8桁だけを出す。
 *
 * 実名・勤務先・社内 ID など汎用の正規表現で拾えない語は、リポジトリ直下の
 * .audit-private-terms.txt（.gitignore 済み・1行1語・# で始まる行は注釈）に置けば
 * 大文字小文字を区別せずに文字どおり検索する。このファイルは Git に入れない。
 *
 * 終了コード: Critical/High があれば 1、なければ 0。 */
'use strict';
const {execFileSync,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');

const ROOT=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();

/* ── 規則 ─────────────────────────────────────────────── */
const RULES=[
  // Critical: そのまま使える秘密
  {id:'private-key',sev:'Critical',re:/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g},
  {id:'anthropic-key',sev:'Critical',re:/\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_\-]{40,}/g},
  {id:'openrouter-key',sev:'Critical',re:/\bsk-or-v1-[A-Za-z0-9]{32,}/g},
  {id:'openai-key',sev:'Critical',re:/\bsk-(?:proj-|svcacct-|admin-)?(?![a-z]+-)[A-Za-z0-9_\-]{32,}/g},
  {id:'google-api-key',sev:'Critical',re:/\bAIza[0-9A-Za-z_\-]{35}\b/g},
  {id:'google-oauth-secret',sev:'Critical',re:/\bGOCSPX-[A-Za-z0-9_\-]{20,}/g},
  {id:'groq-key',sev:'Critical',re:/\bgsk_[A-Za-z0-9]{40,}/g},
  {id:'xai-key',sev:'Critical',re:/\bxai-[A-Za-z0-9]{40,}/g},
  {id:'huggingface-token',sev:'Critical',re:/\bhf_[A-Za-z0-9]{30,}/g},
  {id:'github-token',sev:'Critical',re:/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g},
  {id:'elevenlabs-key',sev:'Critical',re:/\bsk_[a-f0-9]{48}\b/g},
  {id:'aws-access-key',sev:'Critical',re:/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g},
  {id:'slack-token',sev:'Critical',re:/\bxox[abposr]-[A-Za-z0-9-]{10,}/g},
  {id:'stripe-key',sev:'Critical',re:/\b[rs]k_live_[A-Za-z0-9]{20,}/g},
  {id:'jwt',sev:'Critical',re:/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g},
  {id:'bearer-literal',sev:'Critical',re:/\bBearer\s+(?!\$\{|['"`+])[A-Za-z0-9._~+/=\-]{24,}/g},
  {id:'url-userinfo',sev:'High',re:/\bhttps?:\/\/[^\s:/@'"`]+:[^\s@/'"`]{3,}@[A-Za-z0-9.-]+/g,
    allow:v=>/@(?:[a-z0-9-]+\.)*(?:test|example|invalid|localhost)\b/i.test(v)},
  {id:'assigned-secret',sev:'High',
    re:/\b(?:api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-./+=]{24,})["'`]/gi,
    allow:v=>/(?:x{6,}|\*{3,}|your|dummy|example|placeholder|test|fake|sample|redacted)/i.test(v)},
  // High: 不要な識別子
  {id:'claude-session-url',sev:'High',re:/\bhttps?:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g},
  {id:'ai-share-url',sev:'High',re:/\bhttps?:\/\/(?:claude\.ai\/share|chatgpt\.com\/share|chat\.openai\.com\/share|g\.co\/gemini\/share|gemini\.google\.com\/share)\/[A-Za-z0-9_\-]+/g},
  // user:pass@host の userinfo はメールではない（url-userinfo が見る）
  {id:'email',sev:'High',re:/(?<![:/\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    allow:v=>/^(?:noreply@(?:anthropic|github)\.com|[^@]+@users\.noreply\.github\.com|[^@]+@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|test|invalid|localhost))$/i.test(v)},
  {id:'teams-meeting-url',sev:'High',re:/\bhttps?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)]+/g},
  // Medium: 端末・環境の fingerprint
  {id:'windows-user-path',sev:'Medium',re:/\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)(?!Public\b|Default\b|<|%|\$|\{|USERNAME\b|you\b|user\b)[^\\\/\s"'`<>]+/gi},
  {id:'unix-home-path',sev:'Medium',re:/(?:^|[\s"'`(=])(?:\/Users|\/home)\/(?!user\b|runner\b|node\b|<|\$|\{|you\b|me\b|shared\b)[a-z][a-z0-9._-]{1,}/gi},
  {id:'private-ip',sev:'Medium',re:/\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g},
  {id:'internal-host',sev:'Medium',re:/\bhttps?:\/\/[A-Za-z0-9.-]+\.(?:corp|internal|intra|lan|local)\b[^\s"'<>]*/gi},
];

/* 値そのものは出さない */
function fp(v){return crypto.createHash('sha256').update(v).digest('hex').slice(0,8)}

function loadPrivateTerms(){
  const f=path.join(ROOT,'.audit-private-terms.txt');
  if(!fs.existsSync(f))return [];
  return fs.readFileSync(f,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
}
const TERMS=loadPrivateTerms();

/* 確認済みの誤検知。値は書かず、規則名と SHA-256 の先頭8桁と理由だけを置く。 */
function loadAllow(){
  const f=path.join(__dirname,'security-scan-allow.json');
  if(!fs.existsSync(f))return new Set();
  return new Set(JSON.parse(fs.readFileSync(f,'utf8')).allow.map(a=>a.rule+':'+a.sha256_8));
}
const ALLOW=loadAllow();

function scanText(text,where,out){
  for(const r of RULES){
    r.re.lastIndex=0;let m;
    while((m=r.re.exec(text))){
      const v=(m[1]||m[0]).trim().replace(/^[\s"'`(=]+/,'');
      if(r.allow&&r.allow(v))continue;
      if(ALLOW.has(r.id+':'+fp(v)))continue;
      const line=text.slice(0,m.index).split('\n').length;
      out.push({rule:r.id,severity:r.sev,where:where+':'+line,length:v.length,sha256_8:fp(v)});
    }
  }
  if(TERMS.length){
    const low=text.toLowerCase();
    TERMS.forEach((t,i)=>{
      let at=-1;const tl=t.toLowerCase();
      while((at=low.indexOf(tl,at+1))!==-1){
        const line=text.slice(0,at).split('\n').length;
        out.push({rule:'private-term#'+(i+1),severity:'High',where:where+':'+line,length:t.length,sha256_8:fp(t)});
      }
    });
  }
}

/* ── ZIP（メモリ上で展開、入れ子も） ────────────────── */
function readZip(buf){
  let eocd=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--){if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break}}
  if(eocd<0)throw new Error('EOCD not found');
  const n=buf.readUInt16LE(eocd+10),cdOff=buf.readUInt32LE(eocd+16);
  const entries=[];let p=cdOff;
  for(let k=0;k<n;k++){
    if(buf.readUInt32LE(p)!==0x02014b50)throw new Error('bad central directory');
    const method=buf.readUInt16LE(p+10),csize=buf.readUInt32LE(p+20);
    const nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32);
    const lho=buf.readUInt32LE(p+42),name=buf.slice(p+46,p+46+nl).toString('utf8');
    p+=46+nl+el+cl;
    if(name.endsWith('/'))continue;
    const lnl=buf.readUInt16LE(lho+26),lel=buf.readUInt16LE(lho+28);
    const raw=buf.slice(lho+30+lnl+lel,lho+30+lnl+lel+csize);
    let data;
    if(method===0)data=raw;
    else if(method===8)data=zlib.inflateRawSync(raw);
    else {entries.push({name,error:'unsupported method '+method});continue}
    entries.push({name,data});
  }
  return entries;
}
const isZip=b=>b.length>4&&b.readUInt32LE(0)===0x04034b50;
const isText=b=>{const n=Math.min(b.length,8000);for(let i=0;i<n;i++)if(b[i]===0)return false;return true};
/* 実行形式・画像などのバイナリは strings 相当で拾う */
function printable(b){return b.toString('latin1').match(/[\x20-\x7e]{8,}/g)?.join('\n')||''}

function scanBlob(buf,where,out,stats,depth=0){
  if(isZip(buf)){
    stats.zips++;
    let entries;
    try{entries=readZip(buf)}catch(e){out.push({rule:'zip-unreadable',severity:'Medium',where,length:0,sha256_8:''});return}
    for(const e of entries){
      const w=where+'!'+e.name;
      if(e.error){out.push({rule:'zip-entry-unreadable',severity:'Medium',where:w,length:0,sha256_8:''});continue}
      stats.zipEntries++;
      const base=path.basename(e.name);
      if(/^\.|\.map$|\.env|\.bak$|~$|credentials|secrets|diagnostics|interpret-log|minutes-|PRIVATE/i.test(base))
        out.push({rule:'suspicious-entry-name',severity:'Medium',where:w,length:base.length,sha256_8:fp(base)});
      if(depth<4)scanBlob(e.data,w,out,stats,depth+1);
    }
    return;
  }
  scanText(isText(buf)?buf.toString('utf8'):printable(buf),where,out);
}

/* ── 対象 ─────────────────────────────────────────── */
function git(args,opts={}){return execFileSync('git',args,{cwd:ROOT,maxBuffer:1<<30,...opts})}

function scanTree(out,stats){
  const files=git(['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
  for(const f of files){
    const abs=path.join(ROOT,f);
    if(!fs.existsSync(abs)||fs.statSync(abs).isDirectory())continue;
    stats.files++;
    scanBlob(fs.readFileSync(abs),'tree:'+f,out,stats);
  }
}

/* cat-file --batch で全 blob を1回ずつ読む */
function scanHistory(out,stats){
  const lines=git(['rev-list','--all','--objects']).toString('utf8').split('\n').filter(Boolean);
  const pathsOf=new Map();
  for(const l of lines){const i=l.indexOf(' ');if(i<0)continue;const sha=l.slice(0,i),p=l.slice(i+1);
    if(!pathsOf.has(sha))pathsOf.set(sha,p)}
  const shas=[...pathsOf.keys()];
  const types=git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{input:shas.join('\n')+'\n'}).toString('utf8').split('\n');
  const blobs=types.map(t=>t.split(' ')).filter(t=>t[1]==='blob').map(t=>({sha:t[0],size:Number(t[2])}));
  // 数百MBになるので 64MB ずつ読む
  const LIMIT=64*1024*1024;let chunk=[],bytes=0;
  const flush=()=>{
    if(!chunk.length)return;
    const r=spawnSync('git',['cat-file','--batch'],{cwd:ROOT,input:chunk.map(b=>b.sha).join('\n')+'\n',maxBuffer:bytes+chunk.length*128+1024});
    const buf=r.stdout;let p=0;
    for(const {sha} of chunk){
      const nl=buf.indexOf(10,p);const size=Number(buf.slice(p,nl).toString().split(' ')[2]);
      const data=buf.slice(nl+1,nl+1+size);p=nl+1+size+1;
      stats.blobs++;
      scanBlob(data,'blob:'+sha.slice(0,10)+':'+pathsOf.get(sha),out,stats);
    }
    chunk=[];bytes=0;
  };
  for(const b of blobs){if(bytes+b.size>LIMIT)flush();chunk.push(b);bytes+=b.size}
  flush();
}

function scanMetadata(out,stats){
  const SEP='\x1e',raw=git(['log','--all','--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B'+SEP]).toString('utf8');
  for(const rec of raw.split(SEP)){
    const t=rec.replace(/^\n/,'');if(!t)continue;
    const [h,an,ae,cn,ce,body]=t.split('\x1f');stats.commits++;
    scanText('author: '+an+' <'+ae+'>\ncommitter: '+cn+' <'+ce+'>\n'+body,'commit:'+h.slice(0,10),out);
  }
}

/* ── 実行 ─────────────────────────────────────────── */
const argv=process.argv.slice(2);
const want=k=>argv.includes('--'+k);
const jsonAt=argv.indexOf('--json'),jsonOut=jsonAt>=0?argv[jsonAt+1]:null;
const textAt=argv.indexOf('--text'),textFiles=textAt>=0?argv.slice(textAt+1).filter(a=>!a.startsWith('--')):[];
const any=want('tree')||want('history')||want('metadata')||textFiles.length;
const out=[],stats={files:0,blobs:0,commits:0,zips:0,zipEntries:0,privateTerms:TERMS.length};
if(textFiles.length)for(const f of textFiles){stats.files++;scanBlob(fs.readFileSync(f),'file:'+path.basename(f),out,stats)}
if(!any||want('tree'))scanTree(out,stats);
if(!any||want('history'))scanHistory(out,stats);
if(!any||want('metadata'))scanMetadata(out,stats);

const bySev={Critical:0,High:0,Medium:0,Low:0};
for(const f of out)bySev[f.severity]=(bySev[f.severity]||0)+1;
const byRule={};for(const f of out)byRule[f.rule]=(byRule[f.rule]||0)+1;
const summary={stats,bySeverity:bySev,byRule};
if(jsonOut)fs.writeFileSync(jsonOut,JSON.stringify({summary,findings:out},null,1));
if(!argv.includes('--quiet'))for(const f of out)console.log(f.severity.padEnd(8),f.rule.padEnd(22),f.where,'len='+f.length,'fp='+f.sha256_8);
console.log(JSON.stringify(summary));
process.exitCode=(bySev.Critical||bySev.High)?1:0;
