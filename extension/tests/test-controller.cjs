const path=require('node:path');
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('crypto');
let state={htmlTabId:1,htmlDocumentId:'html-doc',targetTabId:2},sent=[];
const chrome={tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}},get:async()=>({url:'https://teams.cloud.microsoft/v2/'}),sendMessage:async(...args)=>{sent.push(args);return {ok:true};}},runtime:{getURL:p=>'chrome-extension://duo/'+p,sendMessage:async()=>({ok:true})},scripting:{executeScript:async o=>o.func.toString().includes('DuoTeamsAdapter')?[{result:{ready:true},documentId:'target-doc'}]:[{result:{ok:true,entryId:'e1'}}]}};
chrome.webNavigation={getFrame:async()=>({documentId:'target-doc'}),getAllFrames:async()=>[{frameId:0,documentId:'target-doc',url:'https://teams.cloud.microsoft/v2/'}]};
const c=vm.createContext({chrome,crypto,URL,console,setTimeout,clearTimeout,getState:async()=>state,validateOverlayFrameSender:async s=>{if(s.tab?.id!==2)throw Error('unauthorized');},sendOverlayMessage:async()=>({ok:true})});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../audio-bridge/controller.js'),'utf8'),c);
const tests=[],popup={url:'chrome-extension://duo/popup.html'},html={tab:{id:1},frameId:0,documentId:'html-doc'},target={tab:{id:2},frameId:0,documentId:'target-doc'};
async function test(n,fn){await fn();tests.push(n);}
(async()=>{
 await test('Initial and worker-reset state inactive',async()=>assert.equal(c.conferencePublic().active,false));
 await test('Unauthorized page cannot toggle',async()=>assert.rejects(c.conferenceToggle({tab:{id:9}})));
 await test('Explicit toggle starts HTML offer; cloud.microsoft Teams supported',async()=>{const r=await c.conferenceToggle(popup);assert.equal(r.pending,true);assert.equal(sent[0][0],1);assert.equal(sent[0][1].data.kind,'start');});
 const token=sent[0][1].data.token;
 await test('Only registered document/frame can send signaling',async()=>{
  await assert.rejects(c.conferenceSignal({kind:'offer',token,description:{}},{...html,documentId:'stale'}));
  await assert.rejects(c.conferenceSignal({kind:'offer',token,description:{}},{...html,frameId:3}));
  await c.conferenceSignal({kind:'offer',token,description:{type:'offer',sdp:'test'}},html);assert.equal(sent.at(-1)[0],2);
 });
 await test('Target answer relays only to registered HTML and active follows adapter success',async()=>{await c.conferenceSignal({kind:'answer',token,description:{type:'answer',sdp:'test'}},target);assert.equal(sent.at(-1)[0],1);await c.conferenceSignal({kind:'active',token},target);assert.equal(c.conferencePublic().active,true);});
 await test('Audio mode is delivered to target and acknowledgement/diagnostics return to HTML',async()=>{await c.conferenceSignal({kind:'mode',token,mode:'original-plus-tts'},html);assert.equal(sent.at(-1)[0],2);await c.conferenceSignal({kind:'mode-applied',token,mode:'original-plus-tts'},target);assert.equal(sent.at(-1)[0],1);await assert.rejects(c.conferenceSignal({kind:'mode',token,mode:'bad'},html));});
 await test('Speaker metadata accepts only selected Teams main document and needs no audio connection',async()=>{const data={session:'meeting',events:[],participants:[]},sender={...target,url:'https://teams.cloud.microsoft/v2/'};assert((await c.teamsSpeakerSignal(data,sender)).ok);assert.equal(sent.at(-1)[1].type,'DUO_TEAMS_SPEAKERS');for(const changes of [{documentId:'old'},{frameId:2},{tab:{id:9}},{url:'https://example.com/'}])assert.equal((await c.teamsSpeakerSignal(data,{...sender,...changes})).ok,false);});
 await test('Lease authorized to exact target and revoked on stop',async()=>{assert.equal((await c.conferenceLease({token},target)).ok,true);assert.equal((await c.conferenceLease({token},html)).ok,false);await c.conferenceStop('test');assert.equal(c.conferencePublic().active,false);assert.equal((await c.conferenceLease({token},target)).ok,false);assert(sent.slice(-2).every(x=>x[1].data.kind==='stop'));});
 await test('Late original-track restoration error remains visible',async()=>{await c.conferenceSignal({kind:'diagnostic',token,error:'restore failure'},target);assert.equal(c.conferencePublic().error,'restore failure');});
 await test('Text input requires registered overlay/popup, bounded text, and targets HTML document',async()=>{await assert.rejects(c.duoTextCommand({text:'hello'},{tab:{id:9}}));await assert.rejects(c.duoTextCommand({text:'x'.repeat(12001)},popup));assert.equal((await c.duoTextCommand({text:'hello',seat:'B',requestId:'r'},popup)).entryId,'e1');});
 console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(async e=>{console.error(e);await c.conferenceStop('test-failed');process.exitCode=1;});
