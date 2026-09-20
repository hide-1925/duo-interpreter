'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../html-tab-audio.js'),'utf8'),passed=[];
const test=async(name,fn)=>{await fn();passed.push(name);};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness(autoReply=true){
 const events=new Map(),intervals=new Map(),contexts=[],streams=[],requests=[],logs=[];
 let mediaGate=null,resumeGate=null,resumeFail=false,timeoutFn,nextTimer=0;
 const original=()=>({original:true});
 const win={S:{running:false},sessionGen:1,getDisplayAudioForStt:original,
  addEventListener(k,f){if(!events.has(k))events.set(k,new Set());events.get(k).add(f);},
  removeEventListener(k,f){events.get(k)?.delete(f);},
  dispatchEvent(e){for(const f of [...events.get(e.type)||[]])f(e);},dlog:(...a)=>logs.push(a)};
 const c=vm.createContext({window:win,location:{href:'https://duo.test/index.html#one'},URL,
  CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},
  setTimeout:f=>{timeoutFn=f;return ++nextTimer;},clearTimeout(){},
  setInterval:f=>{const n=++nextTimer;intervals.set(n,f);return n;},clearInterval:n=>intervals.delete(n),
  navigator:{mediaDevices:{async getUserMedia(options){
   requests.push(options);if(mediaGate)await mediaGate.promise;
   const track={readyState:'live',stop(){this.readyState='ended';},addEventListener(k,f){this.ended=f;}};
   const stream={getTracks:()=>[track],getAudioTracks:()=>[track],getVideoTracks:()=>[]};streams.push(stream);return stream;
  }}},
  AudioContext:class{constructor(){this.state='suspended';this.monitors=0;contexts.push(this);}createMediaStreamSource(){return {connect:()=>this.monitors++};}async resume(){if(resumeGate)await resumeGate.promise;if(this.state==='closed')throw Error('認識停止');if(resumeFail)throw Error('autoplay');this.state='running';}async close(){this.state='closed';}}
 });vm.runInContext(source,c);
 if(autoReply)win.addEventListener('duo-html-audio-request',e=>{const {id}=JSON.parse(e.detail);win.dispatchEvent({type:'duo-html-audio-reply',detail:JSON.stringify({id,ok:true,streamId:'PRIVATE_STREAM_ID'})});});
 return {win,c,contexts,streams,requests,logs,original,enable:()=>c.configureHtmlTabAudio('https://duo.test/index.html',true),disable:()=>c.configureHtmlTabAudio('https://duo.test/index.html',false),
 stop:()=>win.dispatchEvent({type:'duo-html-audio-control',detail:'stop'}),tick:()=>[...intervals.values()].forEach(f=>f()),
 mediaGate:()=>mediaGate=deferred(),resumeGate:()=>resumeGate=deferred(),failResume:()=>resumeFail=true,timeout:()=>timeoutFn()};
}
(async()=>{
 await test('Opt-in leaves normal HTML acquisition intact; enable does not capture',()=>{const h=harness();assert.equal(h.win.getDisplayAudioForStt,h.original);h.enable();assert.equal(h.requests.length,0);});
 await test('Audio-only constraints, owned STT track, one audible local monitor, no stream token in logs',async()=>{const h=harness();h.enable();const result=await h.win.getDisplayAudioForStt();assert.equal(h.requests[0].video,false);assert.equal(h.requests[0].audio.mandatory.chromeMediaSource,'tab');assert.equal(result.ownsStream,true);assert.equal(result.fromOverlay,false);assert.equal(result.track.readyState,'live');assert.equal(h.contexts.length,1);assert.equal(h.contexts[0].monitors,1);assert.equal(h.contexts[0].state,'running');assert(!JSON.stringify(h.logs).includes('PRIVATE_STREAM_ID'));});
 await test('HTML engine track.stop releases monitor without ended event',async()=>{const h=harness();h.enable();const r=await h.win.getDisplayAudioForStt();r.track.stop();h.tick();assert.equal(h.contexts[0].state,'closed');});
 await test('Tab ended releases monitor and disable restores original route',async()=>{const h=harness();h.enable();const r=await h.win.getDisplayAudioForStt();r.track.ended();assert.equal(h.contexts[0].state,'closed');h.disable();assert.equal(h.win.getDisplayAudioForStt,h.original);});
 await test('Enable during recognition prepares the next capture; repeat enable preserves current stream',async()=>{const h=harness();h.win.S.running=true;h.enable();const r=await h.win.getDisplayAudioForStt(),acquire=h.win.getDisplayAudioForStt;h.enable();assert.equal(h.win.getDisplayAudioForStt,acquire);assert.equal(r.track.readyState,'live');assert.throws(h.disable,/停止/);assert.throws(()=>h.c.configureHtmlTabAudio('https://other.test/',true),/登録/);});
 await test('Active HTML screen share is rejected instead of mixed with another capture',async()=>{const h=harness();h.enable();h.win.overlaySession={activeAudioTrack:()=>({})};await assert.rejects(h.win.getDisplayAudioForStt(),/画面共有/);assert.equal(h.requests.length,0);});
 for(const action of ['session-stop','target-stop','disable'])await test('Late getUserMedia is discarded after '+action,async()=>{const h=harness();h.enable();const gate=h.mediaGate(),p=h.win.getDisplayAudioForStt();await flush();if(action==='session-stop')h.win.sessionGen++;else if(action==='target-stop')h.stop();else h.disable();gate.resolve();await assert.rejects(p,/停止/);assert.equal(h.streams[0].getAudioTracks()[0].readyState,'ended');assert.equal(h.contexts.length,0);});
 await test('Target stop during monitor resume cannot return a stale track',async()=>{const h=harness();h.enable();const gate=h.resumeGate(),p=h.win.getDisplayAudioForStt();await flush();h.stop();gate.resolve();await assert.rejects(p,/停止/);assert.equal(h.streams[0].getAudioTracks()[0].readyState,'ended');assert.equal(h.contexts[0].state,'closed');});
 await test('Autoplay failure releases capture instead of silently muting the original video',async()=>{const h=harness();h.enable();h.failResume();await assert.rejects(h.win.getDisplayAudioForStt(),/autoplay/);assert.equal(h.streams[0].getAudioTracks()[0].readyState,'ended');assert.equal(h.contexts[0].state,'closed');});
 await test('Isolated relay returns authorized token and disposal stops the MAIN adapter',async()=>{
  const h=harness(false),calls=[];let listener;
  h.c.chrome={runtime:{sendMessage:async m=>{calls.push(m);return {ok:true,streamId:'PRIVATE_STREAM_ID'};},onMessage:{addListener:f=>listener=f,removeListener(){}}}};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../html-source-content.js'),'utf8'),h.c);
  h.enable();const result=await h.win.getDisplayAudioForStt();await flush();assert.equal(calls[0].type,'DUO_HTML_AUDIO_CAPTURE');
  listener({type:'DUO_HTML_COMMAND',command:{action:'dispose'}},{},()=>{});
  assert.equal(result.track.readyState,'ended');assert.equal(h.win.getDisplayAudioForStt,h.original);
 });
 await test('Worker authorizes only the registered document and binds target and consumer tab',async()=>{
  let state={htmlTabAudio:true,htmlTabId:1,targetTabId:2,htmlDocumentId:'doc1'},calls=[],gate=null;
  const c=vm.createContext({URL,getState:async()=>({...state}),getHtmlSourceUrl:async()=>'https://duo.test/',canonicalHtmlUrl:u=>{const x=new URL(u);x.hash='';return x.href;},chrome:{tabCapture:{async getMediaStreamId(o){calls.push(o);if(gate)await gate.promise;return 'PRIVATE_STREAM_ID';}}}});vm.runInContext(source,c);
  const sender={tab:{id:1},frameId:0,documentId:'doc1',url:'https://duo.test/'};
  for(const patch of [{tab:{id:3}},{frameId:1},{documentId:'old'},{url:'https://evil.test/'}])await assert.rejects(c.getHtmlTabAudioId({...sender,...patch}),/登録/);
  assert.equal(calls.length,0);assert.equal((await c.getHtmlTabAudioId(sender)).ok,true);assert.equal(calls[0].targetTabId,2);assert.equal(calls[0].consumerTabId,1);
  state.htmlTabAudio=false;await assert.rejects(c.getHtmlTabAudioId(sender),/登録/);state.htmlTabAudio=true;
  gate=deferred();const p=c.getHtmlTabAudioId(sender);await flush();state.targetTabId=3;gate.resolve();await assert.rejects(p,/変更/);
 });
 console.log(JSON.stringify({passed:passed.length,checks:passed},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

