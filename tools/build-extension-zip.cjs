#!/usr/bin/env node
/* 拡張の配布 zip を、git に登録された extension/ から作る（依存なし）。
 *
 *   node tools/build-extension-zip.cjs          dist/duo-interpreter-chrome-v<版>.zip と
 *                                               duo-interpreter-chrome.zip を書く
 *   node tools/build-extension-zip.cjs --check  duo-interpreter-chrome.zip の中身が
 *                                               extension/ の登録済みファイルと一致するか調べる
 *
 * 同じ中身からは同じバイト列になる（名前順、時刻は APP_BUILD の日付に固定、UTF-8 の名前）。
 * 入るのは git ls-files extension の結果だけなので、生成物やローカルのファイルは入らない。
 * zip の SHA-256 を出すので、リリースノートに書けばどの commit から作ったかを辿れる。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.join(__dirname,'..');

function trackedExtensionFiles(){
  return execFileSync('git',['ls-files','-z','extension'],{cwd:ROOT}).toString('utf8').split('\0').filter(Boolean)
    .filter(f=>fs.existsSync(path.join(ROOT,f)))
    .map(f=>({name:f.slice('extension/'.length),data:fs.readFileSync(path.join(ROOT,f))}))
    .sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
}
function buildDate(){
  const src=fs.readFileSync(path.join(ROOT,'extension/app.js'),'utf8');
  const m=/var APP_BUILD = '(\d{4})(\d{2})(\d{2})-/.exec(src);
  if(!m)throw new Error('APP_BUILD not found');
  return {date:((+m[1]-1980)<<9)|(+m[2]<<5)|(+m[3]),time:0};
}
function zip(files){
  const {date,time}=buildDate(),locals=[],central=[];let offset=0;
  for(const f of files){
    const name=Buffer.from(f.name,'utf8'),crc=zlib.crc32(f.data);
    let body=zlib.deflateRawSync(f.data,{level:9}),method=8;
    if(body.length>=f.data.length){body=f.data;method=0;}
    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0x0800,6);lh.writeUInt16LE(method,8);
    lh.writeUInt16LE(time,10);lh.writeUInt16LE(date,12);lh.writeUInt32LE(crc,14);
    lh.writeUInt32LE(body.length,18);lh.writeUInt32LE(f.data.length,22);lh.writeUInt16LE(name.length,26);lh.writeUInt16LE(0,28);
    const ch=Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(0x0800,8);ch.writeUInt16LE(method,10);
    ch.writeUInt16LE(time,12);ch.writeUInt16LE(date,14);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(body.length,20);
    ch.writeUInt32LE(f.data.length,24);ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(offset,42);
    locals.push(lh,name,body);central.push(ch,name);
    offset+=lh.length+name.length+body.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,end]);
}
/* 中身の比較用。名前の文字コード（UTF-8 フラグの有無）には左右されない */
function readEntries(buf){
  let e=-1;for(let i=buf.length-22;i>=0;i--)if(buf.readUInt32LE(i)===0x06054b50){e=i;break}
  const n=buf.readUInt16LE(e+10);let p=buf.readUInt32LE(e+16);const out=new Map();
  for(let k=0;k<n;k++){
    const m=buf.readUInt16LE(p+10),cs=buf.readUInt32LE(p+20),nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),lho=buf.readUInt32LE(p+42);
    const flags=buf.readUInt16LE(p+8),raw=buf.slice(p+46,p+46+nl);p+=46+nl+el+cl;
    const name=flags&0x0800?raw.toString('utf8'):raw.toString('latin1');
    if(name.endsWith('/'))continue;
    const lnl=buf.readUInt16LE(lho+26),lel=buf.readUInt16LE(lho+28),body=buf.slice(lho+30+lnl+lel,lho+30+lnl+lel+cs);
    out.set(name,m===8?zlib.inflateRawSync(body):body);
  }
  return out;
}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

if(process.argv.includes('--check')){
  const files=trackedExtensionFiles(),entries=readEntries(fs.readFileSync(path.join(ROOT,'duo-interpreter-chrome.zip')));
  const bad=[];
  for(const f of files){const d=entries.get(f.name);if(!d)bad.push('missing '+f.name);else if(!d.equals(f.data))bad.push('differs '+f.name);entries.delete(f.name);}
  for(const n of entries.keys())bad.push('extra '+n);
  console.log(JSON.stringify({files:files.length,mismatches:bad.length,details:bad.slice(0,20)}));
  process.exitCode=bad.length?1:0;
}else{
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'extension/manifest.json'),'utf8'));
  const buf=zip(trackedExtensionFiles());
  const dist=path.join('dist','duo-interpreter-chrome-v'+manifest.version+'.zip');
  fs.writeFileSync(path.join(ROOT,dist),buf);fs.writeFileSync(path.join(ROOT,'duo-interpreter-chrome.zip'),buf);
  console.log(JSON.stringify({version:manifest.version,files:readEntries(buf).size,bytes:buf.length,sha256:sha(buf),wrote:[dist,'duo-interpreter-chrome.zip']}));
}
