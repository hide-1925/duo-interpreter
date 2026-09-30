'use strict';
/* 音声を PCM16・16kHz・モノラルにする部分（STTマルチプロバイダ開発仕様書 §7）。
 * 変換の関数は app.js に1回だけ書かれ、AudioWorklet のソースはその関数の文字列から作る。
 * ここでは同じ関数を vm で動かし、長さ・振幅・周波数・折り返しの抑え方と、Worklet が
 * 1回に渡す長さ（100ms＝1,600サンプル）を確かめる。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const ctx={Math,Float32Array,Int16Array,Uint8Array,String,btoa:(s)=>Buffer.from(s,'binary').toString('base64')};
vm.createContext(ctx);
vm.runInContext([block('function sttPcmTaps('),block('function sttPcmDownsample('),block('function sttPcmToInt16('),
  block('function sttPcmWorkletSource('),block('function sttLiveB64(')].join('\n'),ctx);
const tests=[];
const test=(name,fn)=>{fn();tests.push(name);};

/* 128 サンプルずつ流す（AudioWorklet の1回と同じ長さ）。 */
function stream(inRate,seconds,fn){
  const st={},out=[];const n=Math.round(inRate*seconds);
  for(let i=0;i<n;i+=128){
    const len=Math.min(128,n-i),b=new Float32Array(len);
    for(let k=0;k<len;k++)b[k]=fn((i+k)/inRate);
    out.push(...ctx.sttPcmDownsample(b,inRate,16000,st));
  }
  return out;
}
const rms=(a)=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
const crossings=(a)=>{let n=0;for(let i=1;i<a.length;i++)if((a[i-1]<0)!==(a[i]<0))n++;return n;};

test('48 kHz becomes 16 kHz: one second in, 16000 samples out',()=>{
  const out=stream(48000,1,()=>0);assert.ok(Math.abs(out.length-16000)<=1,'got '+out.length);
});
test('44.1 kHz (not an integer ratio) also becomes 16000 samples per second',()=>{
  const out=stream(44100,1,()=>0);assert.ok(Math.abs(out.length-16000)<=1,'got '+out.length);
});
test('a 1 kHz tone keeps its level and its frequency',()=>{
  for(const rate of [48000,44100]){
    const out=stream(rate,1,(t)=>0.5*Math.sin(2*Math.PI*1000*t)).slice(200);
    assert.ok(Math.abs(rms(out)-0.5/Math.SQRT2)<0.02,rate+': rms '+rms(out));
    const hz=crossings(out)/2/(out.length/16000);
    assert.ok(Math.abs(hz-1000)<15,rate+': '+hz+' Hz');
  }
});
test('a 12 kHz tone above the new Nyquist is filtered instead of folding back as noise',()=>{
  const out=stream(48000,0.5,(t)=>0.5*Math.sin(2*Math.PI*12000*t)).slice(200);
  assert.ok(rms(out)<0.03,'aliased energy '+rms(out));
});
test('block boundaries do not click: a continuous tone stays continuous',()=>{
  const out=stream(48000,0.2,(t)=>0.5*Math.sin(2*Math.PI*440*t)).slice(100);
  let worst=0;for(let i=1;i<out.length;i++)worst=Math.max(worst,Math.abs(out[i]-out[i-1]));
  const step=0.5*2*Math.PI*440/16000;assert.ok(worst<step*1.2,'largest jump '+worst+' vs '+step);
});
test('float to PCM16: full scale, sign, rounding and clipping',()=>{
  const q=[...ctx.sttPcmToInt16(Float32Array.from([0,1,-1,0.5,-0.5,2,-2]))];
  assert.deepEqual(q,[0,32767,-32768,16384,-16384,32767,-32768]);
});
test('base64 of PCM round-trips (ElevenLabs sends audio this way)',()=>{
  const pcm=Int16Array.from([0,1,-1,1234,-32768,32767]);
  const back=new Int16Array(new Uint8Array(Buffer.from(ctx.sttLiveB64(pcm),'base64')).buffer);
  assert.deepEqual([...back],[...pcm]);
});
test('the worklet built from the same functions posts 100 ms chunks of PCM16',()=>{
  const posted=[];let Proc=null;
  const w={Math,Float32Array,Int16Array,sampleRate:48000,
    AudioWorkletProcessor:class{constructor(){this.port={postMessage:(b)=>posted.push(b),onmessage:null};}},
    registerProcessor:(name,cls)=>{assert.equal(name,'duo-stt-pcm');Proc=cls;}};
  vm.createContext(w);vm.runInContext(ctx.sttPcmWorkletSource(),w);
  assert.ok(Proc,'the processor must register');
  const p=new Proc({processorOptions:{outRate:16000,chunkMs:100}});
  const stereo=[new Float32Array(128).fill(0.25),new Float32Array(128).fill(-0.25)];
  for(let i=0;i<375;i++)assert.equal(p.process([stereo]),true);       /* 1 second of 48 kHz audio (375 × 128) */
  assert.equal(posted.length,10,'ten 100 ms chunks per second');
  assert.ok(posted.every(b=>b.byteLength===3200),'1600 samples × 2 bytes');
  assert.ok(new Int16Array(posted[5]).every(v=>Math.abs(v)<=1),'the two channels are averaged to mono');
  p.process([[]]);                                                    /* no input: silence, not a stall */
  p.port.onmessage({data:'stop'});assert.equal(p.process([stereo]),false);
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
