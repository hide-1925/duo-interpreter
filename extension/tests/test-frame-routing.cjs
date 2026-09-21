const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),tests=[];
function env(probes){const sent=[];const chrome={tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}},get:async()=>({url:'https://teams.microsoft.com/v2/'}),sendMessage:async(...a)=>{sent.push(a);return {ok:true};}},runtime:{getURL:p=>'chrome-extension://duo/'+p,sendMessage:async()=>({ok:true})},scripting:{executeScript:async q=>{assert.deepEqual(Array.from(q.target.documentIds),probes.map(p=>p.documentId));return probes;}}};
chrome.webNavigation={getAllFrames:async()=>[...probes.map(p=>({frameId:p.frameId,documentId:p.documentId,url:'https://teams.microsoft.com/v2/'})),{frameId:99,documentId:'outlook-doc',url:'https://outlook.office.com/'}]};const c=vm.createContext({chrome,crypto,console,setTimeout,clearTimeout,getState:async()=>({targetTabId:2,htmlTabId:1,htmlDocumentId:'html'}),validateOverlayFrameSender:async()=>{},sendOverlayMessage:async()=>{}});vm.runInContext(fs.readFileSync(path.join(root,'audio-bridge/controller.js'),'utf8'),c);return {c,sent};}
const probe=(frameId,count,relay=true)=>({frameId,documentId:'doc-'+frameId,result:{ready:true,relay,discovery:{eligibleCount:count,audioSenderCount:count}}});
(async()=>{
 const {c,sent}=env([probe(0,0),probe(7,1)]),popup={url:'chrome-extension://duo/popup.html'};
 try{
 await c.conferenceToggle(popup);const token=sent[0][1].data.token,html={tab:{id:1},documentId:'html',frameId:0},child={tab:{id:2},documentId:'doc-7',frameId:7};
 await c.conferenceSignal({kind:'offer',token,description:{}},html);assert.equal(sent.at(-1)[2].documentId,'doc-7');tests.push('Offer targets the unique child document containing a proven microphone');
 await assert.rejects(c.conferenceSignal({kind:'active',token},{...child,frameId:0}));await assert.rejects(c.conferenceSignal({kind:'active',token},{...child,documentId:'stale'}));await c.conferenceSignal({kind:'active',token},child);assert(c.conferencePublic().active);tests.push('Only selected document/frame may acknowledge microphone activation');
 assert((await c.conferenceLease({token},child)).ok);assert.equal((await c.conferenceLease({token},{...child,frameId:0})).ok,false);tests.push('Heartbeat binds to the exact selected child frame');
 const report=c.conferencePublic();assert(report.diagnostics.some(d=>d.event==='frame-discovery'&&d.frames.length===2));tests.push('Diagnostic output retains per-frame discovery counts');
 await c.conferenceStop('test');assert(sent.slice(-2).some(s=>s[2].documentId==='doc-7'));tests.push('Disconnect restores the selected child document');
 const ambiguous=env([probe(0,1),probe(7,1)]);await assert.rejects(ambiguous.c.conferenceToggle(popup),/複数/);assert.equal(ambiguous.sent.length,0);tests.push('Multiple eligible frames are not silently selected');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));assert.equal(manifest.version,'1.4.7');assert.deepEqual(manifest.content_scripts[0].js.slice(0,2),['conference-adapters/mic-provenance.js','conference-adapters/teams.js']);assert(manifest.content_scripts.every(s=>s.all_frames));tests.push('Package installs provenance before adapter in matched Teams frames');
 // Execute the real popup export callback and inspect its generated Blob.
 const callbacks={},nodes=new Map();let blob;
 function node(id){if(!nodes.has(id))nodes.set(id,{addEventListener:(type,fn)=>{callbacks[id+':'+type]=fn;},classList:{toggle(){}},setAttribute(){},click(){},remove(){},value:'',textContent:''});return nodes.get(id);}
 const response={ok:true,workerVersion:'1.4.7',conference:{error:'test-error',diagnostics:[{event:'microphone-discovery',eligibleCount:0}]},state:{},overlay:{}};
 const popupContext=vm.createContext({chrome:{runtime:{getManifest:()=>({version:'1.4.7'}),onMessage:{addListener(){}},sendMessage:async()=>response},tabs:{query:async()=>[]}},document:{getElementById:node,createElement:()=>node('link'),body:{appendChild(){}}},URL:{createObjectURL:b=>{blob=b;return 'blob:test';},revokeObjectURL(){}},Blob,console,setTimeout:()=>0,clearTimeout(){}});
 // Only install functions + export handler; exclude initial UI refresh.
 const popupSource=fs.readFileSync(path.join(root,'popup.js'),'utf8');
 const start=popupSource.indexOf("$('downloadInteraction').addEventListener"),end=popupSource.indexOf('function validTarget',start);
 vm.runInContext("const $=id=>document.getElementById(id);function show(){};async function send(){return chrome.runtime.sendMessage();}\n"+popupSource.slice(start,end),popupContext);
 await callbacks['downloadInteraction:click']();const exported=JSON.parse(await blob.text());assert.equal(exported.conference.error,'test-error');assert.equal(exported.conference.diagnostics[0].eligibleCount,0);tests.push('Real JSON download handler preserves conference diagnostics');
 // A frame can expose the adapter while the bridge relay is missing. Before
 // v1.4.7 that frame was accepted, the offer went out unanswered, and the only
 // symptom was a bare 15s connection timeout with no error from either side.
 {
  const e=env([probe(0,1,false)]);
  await assert.rejects(e.c.conferenceToggle({url:'chrome-extension://duo/popup.html'}),/音声ブリッジが読み込まれていません/);
  const frames=e.c.conferencePublic().diagnostics.filter(d=>d.event==='frame-discovery').pop().frames;
  assert.equal(frames[0].relay,false);
  assert.equal(frames[0].ready,true);
  tests.push('A frame exposing the adapter without the bridge relay is refused, not silently offered to');
 }
 {
  const e=env([probe(0,0,false),probe(7,1,true)]);
  await e.c.conferenceToggle({url:'chrome-extension://duo/popup.html'});
  assert.equal(e.sent[0][0],1);
  tests.push('The frame that does carry the relay is selected over one that does not');
  await e.c.conferenceStop('cleanup');
 }
 console.log(JSON.stringify({passed:tests.length,tests},null,2));
 }finally{await c.conferenceStop('cleanup');}
})().catch(e=>{console.error(e);process.exitCode=1;});
