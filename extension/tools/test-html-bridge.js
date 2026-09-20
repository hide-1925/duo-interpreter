'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),read=n=>fs.readFileSync(path.join(root,n),'utf8');
const passed=[];
async function test(name,fn){await fn();passed.push(name);}
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
class Events{
 constructor(){this.listeners={};}
 addEventListener(k,f){(this.listeners[k]||=new Set()).add(f);}
 removeEventListener(k,f){this.listeners[k]?.delete(f);}
 dispatchEvent(e){for(const f of this.listeners[e.type]||[])f(e);}
}
function source(){
 const win=new Events(),doc=new Events(),out=[],observers=[];
 win.CFG={provider:'none',interimOn:true,showSrc:true,ovCapHold:'0',ovCapBgOpacity:'0',ovCapFont:'26',secret:'SECRET'};
 win.KEYS={api:'SECRET'};win.S={running:true,entries:[]};win.APP_BUILD='html-test';
 win.setOverlayFont=n=>win.CFG.ovCapFont=String(n);
 doc.getElementById=()=>({});
 win.addEventListener('duo-html-source-data',e=>out.push(JSON.parse(e.detail)));
 const c=vm.createContext({window:win,document:doc,queueMicrotask,setInterval:()=>1,clearInterval(){},
 MutationObserver:class{constructor(f){observers.push(f);}observe(){}disconnect(){}},
 CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}});
 vm.runInContext(read('html-source-main.js'),c);
 return {win,doc,out,c,change:()=>observers.at(-1)(),command:d=>win.dispatchEvent({type:'duo-html-source-command',detail:JSON.stringify(d)})};
}
function host(){
 let state={},local={},listener,updated;const calls=[];
 const tabs=new Map([[1,{id:1,url:'https://example.test/duo.html',title:'Duo',status:'complete',windowId:1}],[2,{id:2,url:'https://video.test/',title:'Video',status:'complete'}]]);
 let failTarget=false,permission=true;
 const chrome={permissions:{contains:async()=>permission},storage:{session:{get:async()=>({duoChromeSession:JSON.parse(JSON.stringify(state))}),set:async d=>{state=d.duoChromeSession;}},local:{get:async()=>local,set:async d=>Object.assign(local,d)}},
 runtime:{getURL:f=>'chrome-extension://duo/'+f,onMessage:{addListener:f=>listener=f}},
 tabs:{query:async()=>[...tabs.values()],get:async id=>{if(!tabs.has(id))throw Error('missing');return tabs.get(id);},
 create:async opts=>{calls.push(['create',opts]);const tab={id:3,url:opts.url,status:'complete'};tabs.set(3,tab);return tab;},
 update:async(id,opts)=>{calls.push(['focus',id,opts]);return tabs.get(id);},
 onRemoved:{addListener(){}},onActivated:{addListener(){}},onUpdated:{addListener:f=>updated=f},
 sendMessage:async(id,m)=>{calls.push(['message',id,m]);if(failTarget&&id===2)throw Error('target unavailable');return {ok:true,htmlBridgeVersion:'1.4.1'};}},
 windows:{update:async()=>{}},scripting:{insertCSS:async()=>{},executeScript:async args=>{calls.push(['inject',args]);return [{documentId:'doc-1',result:args.func?.name==='configureHtmlTabAudio'?{ok:true,enabled:true}:args.func?.name==='commandHtmlCaptionWindow'?{ok:true,route:'html-main',phase:args.args[1]==='guide'?'awaiting-click':'open',open:args.args[1]!=='guide'}:args.func?(args.func.toString().includes('build:')?{ok:true,build:'html-test'}:true):undefined}];}}};
 const c=vm.createContext({chrome,URL});c.importScripts=(...names)=>names.forEach(n=>vm.runInContext(read(n),c));vm.runInContext(read('service-worker.js'),c);
 const popup={url:'chrome-extension://duo/popup.html'};
 const sender={tab:{id:1},frameId:0,url:tabs.get(1).url,documentId:'doc-1'};
 const send=(m,s=popup)=>new Promise(r=>listener(m,s,r));
 return {send,sender,calls,tabs,updated,get state(){return state;},get local(){return local;},fail:()=>failTarget=true,recover:()=>failTarget=false,deny:()=>permission=false};
}
// Small DOM model exercises the real target render/batch/profile functions.
class Element{
 constructor(){this.children=[];this.dataset={};this.style={setProperty(k,v){this[k]=v;}};this.classList={toggle(){}};this.textContent='';this.clientHeight=160;this.scrollTop=0;}
 appendChild(n){n.remove();this.children.push(n);n.parent=this;return n;}
 remove(){if(this.parent){const a=this.parent.children;a.splice(a.indexOf(this),1);this.parent=null;}}
 set innerHTML(v){this.children=[];this.main=new Element();this.sub=new Element();}
 querySelector(s){return s==='.duo-main'?this.main:this.sub;}
 querySelectorAll(){return this.children;}
 replaceChildren(){this.children=[];}
 get firstElementChild(){return this.children[0];}
 get scrollHeight(){return this.children.length*100;}
}
function overlay(){
 const code=read('content-overlay.js'),feed=new Element(),host=new Element(),timers=new Map();let next=1;
 const c=vm.createContext({feed,root:host,entries:new Map(),timers:new Map(),htmlSeen:new Map(),htmlSourceKey:'',
 profile:{font:26,hold:0,items:4,bg:'#000000',bgOpacity:35,textOpacity:92},
 document:{createElement:()=>new Element()},setTimeout:fn=>{const id=next++;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),applyLayout(){}});
 vm.runInContext(code.slice(code.indexOf('  function rgba('),code.indexOf('  function saveGeometry('))+code.slice(code.indexOf('  function applyProfile('),code.indexOf('  function emitSpeech(')),c);
 const batch=(rows,profile={},key='source')=>c.receiveHtmlBatch({sourceKey:key,entries:rows,profile,visible:true});
 return {c,feed,host,timers,batch};
}
const row=(id,text='原文',interim=false)=>({id,srcText:text,dstText:'訳文',seat:'A',interim});
(async()=>{
 await test('Fresh browser session reconnects configured HTML already open when selecting target',async()=>{
  const h=host();h.tabs.get(1).url='https://hide-1925.github.io/duo-interpreter/';
  const reply=await h.send({type:'DUO_SET_TARGET',tabId:2});
  assert(reply.ok,reply.error);assert.equal(h.state.htmlTabId,1);assert.equal(h.state.targetTabId,2);
  assert(!h.calls.some(c=>c[0]==='create'));
  assert.equal(h.state.htmlTabAudio,true);assert(h.calls.some(c=>c[0]==='inject'&&c[1].func?.name==='configureHtmlTabAudio'));
 });
 await test('Missing HTML in this browser leaves target set without claiming source connection',async()=>{
  const h=host();h.tabs.delete(1);assert((await h.send({type:'DUO_SET_TARGET',tabId:2})).ok);
  assert(!h.state.htmlTabId);assert(!h.state.htmlLastReceived);assert.equal(h.state.overlayEnabled,true);assert.equal(h.state.htmlTabAudio,true);
  assert((await h.send({type:'DUO_OPEN_APP'})).ok);assert(h.calls.some(c=>c[0]==='inject'&&c[1].func?.name==='configureHtmlTabAudio'));
 });
 await test('Native translation-only cards cross source bridge even with cascade translation off',async()=>{
  const h=source();h.win.S.entries=[{...row('native',''),srcText:'',dstText:'日本語訳',rtWindow:{startMs:0}}];await settle();
  assert.equal(h.out[0].entries.length,1);assert.equal(h.out[0].entries[0].translationSkipped,false);assert.equal(h.out[0].entries[0].dstText,'日本語訳');
 });
 await test('Source sends only subtitle whitelist and respects zero opacity/hold',async()=>{
  const h=source();h.win.S.entries=[{...row('a'),apiKey:'SECRET'}];await settle();
  assert.equal(h.out.length,1);assert.equal(h.out[0].profile.bgOpacity,0);assert.equal(h.out[0].profile.hold,0);
  assert(!JSON.stringify(h.out).includes('SECRET'));assert(h.out[0].entries[0].translationSkipped);
 });
 await test('Interim, final and translation deltas preserve ID; delete is forwarded',async()=>{
  const h=source();await settle();h.win.S.entries=[row('a','途中',true)];h.change();await settle();
  h.win.S.entries[0]=row('a','確定');h.change();await settle();assert.equal(h.out.at(-1).entries[0].interim,false);
  h.win.S.entries[0].dstText='Translated';h.change();await settle();assert.equal(h.out.at(-1).entries[0].dstText,'Translated');
  h.change();await settle();const n=h.out.length;h.change();await settle();assert.equal(h.out.length,n);
  h.win.S.entries=[];h.change();await settle();assert.deepEqual(h.out.at(-1).removed,['a']);
 });
 await test('Font command calls HTML setter; reinjection and dispose leave speech state intact',async()=>{
  const h=source();await settle();h.command({action:'font',font:52});await settle();assert.equal(h.win.CFG.ovCapFont,'52');
  vm.runInContext(read('html-source-main.js'),h.c);await settle();assert(h.out.at(-1).reset);
  h.command({action:'dispose'});assert.equal(h.win.S.running,true);const n=h.out.length;h.change();await settle();assert.equal(h.out.length,n);
  vm.runInContext(read('html-source-main.js'),h.c);await settle();assert.equal(h.out.length,n+1);
 });
 await test('Addon open launches registered HTTPS HTML and reuses its tab',async()=>{
  const h=host();
  assert((await h.send({type:'DUO_REGISTER_HTML',tabId:1})).ok);
  assert.equal(h.local.duoHtmlSourceUrl,'https://example.test/duo.html');
  assert((await h.send({type:'DUO_OPEN_APP'})).ok);assert(!h.calls.some(c=>c[0]==='create'));
  h.tabs.delete(1);assert((await h.send({type:'DUO_OPEN_APP'})).ok);
  assert.equal(h.calls.find(c=>c[0]==='create')[1].url,'https://example.test/duo.html');
  assert(!h.calls.some(c=>JSON.stringify(c).includes('target-speech-main.js')));
 });
 await test('First launch uses default URL without registration and attaches HTML',async()=>{
  const h=host();const response=await h.send({type:'DUO_GET_STATE'});
  assert.equal(response.htmlUrl,'https://hide-1925.github.io/duo-interpreter/');
  assert((await h.send({type:'DUO_OPEN_APP'})).ok);
  assert.equal(h.calls.find(c=>c[0]==='create')[1].url,response.htmlUrl);
  assert.equal(h.state.htmlBuild,'html-test');
  assert(h.calls.some(c=>c[1]?.files?.includes('html-source-main.js')));
 });
 await test('First launch discovers an already open default HTML tab',async()=>{
  const h=host();h.tabs.get(1).url='https://hide-1925.github.io/duo-interpreter/#settings';
  assert((await h.send({type:'DUO_OPEN_APP'})).ok);
  assert.equal(h.state.htmlTabId,1);assert(!h.calls.some(c=>c[0]==='create'));
 });
 await test('Custom URL is saved for subsequent launches; URL hash is removed',async()=>{
  const h=host();assert((await h.send({type:'DUO_SAVE_HTML_URL',url:' https://custom.test/duo.html?q=1#settings '})).ok);
  assert.equal(h.local.duoHtmlSourceUrl,'https://custom.test/duo.html?q=1');
  assert((await h.send({type:'DUO_OPEN_APP'})).ok);
  assert.equal(h.calls.find(c=>c[0]==='create')[1].url,h.local.duoHtmlSourceUrl);
  assert.equal((await h.send({type:'DUO_GET_STATE'})).htmlUrl,h.local.duoHtmlSourceUrl);
 });
 await test('URL changes invalidate old source and clear old target captions',async()=>{
  const h=host();await h.send({type:'DUO_REGISTER_HTML',tabId:1});await h.send({type:'DUO_SET_TARGET',tabId:2});
  const data={revision:1,entries:[row('a')],removed:[]};
  await h.send({type:'DUO_HTML_DATA',data},h.sender);
  assert((await h.send({type:'DUO_SAVE_HTML_URL',url:'https://custom.test/new'})).ok);
  assert.equal(h.state.htmlTabId,null);assert.equal(h.state.htmlEntries.length,0);
  assert(h.calls.some(c=>c[1]===1&&c[2]?.command?.action==='dispose'));
  assert(h.calls.some(c=>c[1]===2&&c[2]?.type==='DUO_CLEAR_ENTRIES'));
  assert(!(await h.send({type:'DUO_HTML_DATA',data:{...data,revision:2}},h.sender)).ok);
 });
 await test('Invalid URL, missing permission and non-popup save do not replace existing URL',async()=>{
  const h=host();await h.send({type:'DUO_REGISTER_HTML',tabId:1});
  for(const url of ['', 'http://custom.test/', 'javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@custom.test/']){
    assert(!(await h.send({type:'DUO_SAVE_HTML_URL',url})).ok);
  }
  assert(!(await h.send({type:'DUO_SAVE_HTML_URL',url:'https://custom.test/'},h.sender)).ok);
  h.deny();assert(!(await h.send({type:'DUO_SAVE_HTML_URL',url:'https://custom.test/'})).ok);
  assert.equal(h.local.duoHtmlSourceUrl,'https://example.test/duo.html');
  assert(!(await h.send({type:'DUO_OPEN_APP'})).ok);
 });
 await test('Opening HTML clears accidental source/target collision',async()=>{
  const h=host();h.tabs.get(1).url='https://hide-1925.github.io/duo-interpreter/';
  await h.send({type:'DUO_SET_TARGET',tabId:1});
  assert((await h.send({type:'DUO_OPEN_APP'})).ok);
  assert.equal(h.state.targetTabId,null);assert.equal(h.state.htmlTabId,1);
 });
 await test('Window command queries and opens HTML main world, not target renderer',async()=>{
  const h=host();await h.send({type:'DUO_REGISTER_HTML',tabId:1});await h.send({type:'DUO_SET_TARGET',tabId:2});
  const result=await h.send({type:'DUO_OPEN_HTML_CAPTION_WINDOW'});assert(result.ok&&result.open);
  const calls=h.calls.filter(c=>c[0]==='inject'&&c[1]?.func?.name==='commandHtmlCaptionWindow');
  assert(calls.some(c=>c[1].target.tabId===1&&c[1].world==='MAIN'&&c[1].args[1]==='open'));
  assert(!calls.some(c=>c[1].target.tabId===2));
  const status=await h.send({type:'DUO_GET_STATE'});assert.equal(status.workerVersion,'1.4.1');assert(status.overlay);assert(!('captionWindow' in status));
  assert(!(await h.send({type:'DUO_OPEN_HTML_CAPTION_WINDOW'},{tab:{id:999},frameId:0})).ok);
  assert((await h.send({type:'DUO_OPEN_HTML_CAPTION_WINDOW'},{tab:{id:2},frameId:0})).ok);
 });
 await test('Target visibility and target switching do not close HTML caption window',async()=>{
  const h=host();await h.send({type:'DUO_SET_TARGET',tabId:2});
  assert((await h.send({type:'DUO_TOGGLE_OVERLAY',visible:false},{tab:{id:2}})).ok);
  await h.send({type:'DUO_SET_TARGET',tabId:1});
  assert(!h.calls.some(c=>c[2]?.type==='DUO_CLOSE_CAPTION_WINDOW'));
 });
 await test('HTML relay logs addon window separately without touching HTML PiP state',async()=>{
  const h=source(),logs=[];h.win.dlog=(...args)=>logs.push(args);
  h.command({action:'caption-window-status',status:{phase:'error',stage:'style'}});
  assert.equal(logs[0][0],'extension');assert.equal(logs[0][1],'caption-window');assert.equal(logs[0][2].stage,'style');assert.equal(h.win.S.running,true);
 });
 await test('Isolated relay preserves message order and disposes on rejected sender',async()=>{
  const win=new Events(),sent=[],commands=[];let release;
  win.addEventListener('duo-html-source-command',e=>commands.push(JSON.parse(e.detail)));
  const chrome={runtime:{onMessage:{addListener(){},removeListener(){}},sendMessage:m=>{sent.push(m);return sent.length===1?new Promise(r=>release=r):Promise.resolve({ok:false});}}};
  vm.runInNewContext(read('html-source-content.js'),{window:win,chrome,CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}}});
  for(const revision of [1,2])win.dispatchEvent({type:'duo-html-source-data',detail:JSON.stringify({revision})});
  await settle();assert.equal(sent.length,1);release({ok:true});await settle();assert.equal(sent.length,2);
  assert.equal(sent[1].data.revision,2);assert.equal(commands.at(-1).action,'dispose');
 });
 await test('Worker rejects wrong tab, document, frame and registration caller',async()=>{
  const h=host();assert(!(await h.send({type:'DUO_REGISTER_HTML',tabId:1},{url:'https://evil.test/'})).ok);
  await h.send({type:'DUO_REGISTER_HTML',tabId:1});
  const data={revision:1,entries:[row('a')],removed:[]};
  for(const patch of [{tab:{id:2}},{documentId:'old'},{frameId:1},{url:'https://example.test/other'}])assert(!(await h.send({type:'DUO_HTML_DATA',data},{...h.sender,...patch})).ok);
  assert(!(await h.send({type:'DUO_SET_TARGET',tabId:1})).ok);
 });
 await test('Worker delivers deltas, rejects stale revision and replays after target failure',async()=>{
  const h=host();await h.send({type:'DUO_REGISTER_HTML',tabId:1});await h.send({type:'DUO_SET_TARGET',tabId:2});
  const data={revision:1,reset:true,entries:[row('a')],removed:[],profile:{hold:0,bgOpacity:0,font:30},running:true};
  assert((await h.send({type:'DUO_HTML_DATA',data},h.sender)).ok);assert.equal(h.state.htmlEntries.length,1);
  assert.equal(h.state.profile.bgOpacity,0);assert.equal(h.state.profile.hold,0);
  const last=h.calls.filter(c=>c[2]?.type==='DUO_HTML_BATCH').at(-1);assert.equal(last[2].entries[0].id,'a');
  assert((await h.send({type:'DUO_HTML_DATA',data},h.sender)).ignored);
  h.fail();data.revision=2;data.entries=[row('b')];data.reset=false;
  assert((await h.send({type:'DUO_HTML_DATA',data},h.sender)).ok);assert.equal(h.state.htmlEntries.length,2);assert(h.state.htmlError);
  h.recover();await h.send({type:'DUO_SET_TARGET',tabId:2});assert.equal(h.state.htmlError,'');
  assert.equal(h.calls.filter(c=>c[2]?.type==='DUO_HTML_BATCH').at(-1)[2].entries.length,2);
  assert(!(await h.send({type:'DUO_START_TARGET_WEB_SPEECH'})).ok);
 });
 await test('Font operation routes back to HTML source',async()=>{
  const h=host();await h.send({type:'DUO_REGISTER_HTML',tabId:1});await h.send({type:'DUO_SET_TARGET',tabId:2});
  assert((await h.send({type:'DUO_SET_FONT',font:52},{tab:{id:2},frameId:0})).ok);
  assert(h.calls.some(c=>c[1]===1&&c[2]?.command?.font===52));
 });
 await test('Target updates text safely in place and preserves history scroll',()=>{
  const h=overlay(),rows=Array.from({length:8},(_,i)=>row(String(i)));
  h.batch(rows,{hold:0});assert.equal(h.feed.children.length,8);const first=h.feed.children[0];h.feed.scrollTop=25;
  rows[0].dstText='<img onerror=alert(1)>';h.batch(rows.concat(row('new')));assert.equal(h.feed.children[0],first);
  assert.equal(first.main.textContent,rows[0].dstText);assert.equal(h.feed.scrollTop,25);
  h.batch(rows.slice(1));assert(!h.c.entries.has('0'));
 });
 await test('Unchanged snapshots do not renew timers or revive expired/cleared captions',()=>{
  const h=overlay(),rows=[row('a')];h.batch(rows,{hold:5});const timer=[...h.timers.keys()][0];
  h.batch(rows,{hold:5});assert.equal([...h.timers.keys()][0],timer);h.timers.get(timer)();
  h.batch(rows,{hold:5});assert.equal(h.feed.children.length,0);
  h.batch([row('b')]);h.c.clearEntries();h.batch([row('b')]);assert.equal(h.feed.children.length,0);
  h.batch([row('b')],{},'new-source');assert.equal(h.feed.children.length,1);
 });
 await test('Target opacity 0/100, source visibility and font apply without new text',()=>{
  const h=overlay();h.batch([row('a')],{bgOpacity:0,textOpacity:0,showSrc:false,font:52});
  const el=h.feed.children[0];assert.equal(el.style.background,'rgba(0,0,0,0)');assert.equal(el.sub.style.display,'none');
  assert.equal(h.host.style['--duo-text-opacity'],'0');assert.equal(h.host.style['--duo-font'],'52px');
  h.batch([row('a')],{bgOpacity:100,showSrc:true});assert.equal(el.style.background,'rgba(0,0,0,1)');assert.equal(el.sub.style.display,'block');
 });
 console.log(JSON.stringify({ok:true,passed:passed.length,tests:passed,scope:'Node VM mocks; no real Chrome speech service test'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

