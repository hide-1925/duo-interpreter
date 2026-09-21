// audio-bridge/target.js: the Teams-side half of the local WebRTC bridge.
// duo-subtitle-interaction (18).json timed out at exactly 15s twice with no
// error from either side: the HTML deadline starts before its own ICE gathering
// and has to cover the answerer's gathering too, so two full gathering phases
// can overrun it. The answerer must not wait for gathering to COMPLETE.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

function environment(){
 const out=[];
 class Evt{constructor(type,init){this.type=type;this.detail=init&&init.detail;}}
 class Target{
  constructor(){this.listeners=new Map();}
  addEventListener(t,f){if(!this.listeners.has(t))this.listeners.set(t,[]);this.listeners.get(t).push(f);}
  removeEventListener(t,f){const l=this.listeners.get(t)||[],i=l.indexOf(f);if(i>=0)l.splice(i,1);}
  dispatchEvent(e){[...(this.listeners.get(e.type)||[])].forEach(f=>f(e));return true;}
 }
 class PC extends Target{
  constructor(){super();this.connectionState='new';this.iceGatheringState='new';this.localDescription=null;this.closed=false;}
  async setRemoteDescription(d){this.remote=d;}
  async createAnswer(){return {type:'answer',sdp:'v=0 answer'};}
  async setLocalDescription(d){this.localDescription={type:d.type,sdp:d.sdp,toJSON(){return {type:d.type,sdp:d.sdp};}};}
  close(){this.closed=true;this.connectionState='closed';}
  candidate(){this.dispatchEvent(Object.assign(new Evt('icecandidate'),{candidate:{candidate:'candidate:1 1 udp'}}));}
  gatheringComplete(){this.iceGatheringState='complete';this.dispatchEvent(new Evt('icegatheringstatechange'));}
 }
 const window=new Target();
 const peers=[];
 window.DuoTeamsAdapter={createRelayPeer(){const p=new PC();peers.push(p);return p;},
   async stop(){},async start(){ }};
 class Audio{constructor(){this.muted=false;this.srcObject=null;}async play(){}pause(){}}
 const sandbox={window,CustomEvent:Evt,Audio,MediaStream:class{constructor(t){this.tracks=t;}getTracks(){return this.tracks;}},
   setTimeout,clearTimeout,Date,JSON,
   addEventListener:(t,f)=>window.addEventListener(t,f),
   dispatchEvent:e=>window.dispatchEvent(e)};
 const c=vm.createContext(sandbox);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../audio-bridge/target.js'),'utf8'),c);
 window.addEventListener('duo-conference-target-out',e=>out.push(JSON.parse(e.detail)));
 const send=data=>window.dispatchEvent(Object.assign(new Evt('duo-conference-target-in'),{detail:JSON.stringify(data)}));
 return {window,out,peers,send,Evt};
}

const passed=[];
async function test(name,fn){await fn(environment());passed.push(name);}

(async()=>{
 await test('The offer is acknowledged before any awaiting, so a lost offer is distinguishable from a slow one',async e=>{
  e.send({kind:'offer',token:'t1',description:{type:'offer',sdp:'v=0'}});
  await wait(20);
  const first=e.out[0];
  assert.equal(first.event,'conference-offer-received');
  assert.equal(first.token,'t1');
  assert(!e.out.some(x=>x.kind==='answer'),'no answer before ICE');
 });

 await test('One ICE candidate is enough to answer; gathering need not complete',async e=>{
  e.send({kind:'offer',token:'t1',description:{type:'offer',sdp:'v=0'}});
  await wait(20);
  const pc=e.peers[0];
  assert.equal(pc.iceGatheringState,'new');
  pc.candidate();
  await wait(400);
  const answer=e.out.find(x=>x.kind==='answer');
  assert(answer,'the answer must not wait for gathering to complete');
  assert.equal(answer.description.type,'answer');
  assert.notEqual(pc.iceGatheringState,'complete');
  const sent=e.out.find(x=>x.event==='conference-answer-sent');
  assert(sent);assert.equal(sent.candidates,1);assert(sent.gatheringMs<2000);
 });

 await test('Gathering that completes first still answers immediately',async e=>{
  e.send({kind:'offer',token:'t1',description:{type:'offer',sdp:'v=0'}});
  await wait(20);
  e.peers[0].gatheringComplete();
  await wait(30);
  assert(e.out.find(x=>x.kind==='answer'));
  const sent=e.out.find(x=>x.event==='conference-answer-sent');
  assert.equal(sent.candidates,0);
  assert.equal(sent.iceGatheringState,'complete');
 });

 await test('With no candidate at all the answer is withheld rather than sent blind',async e=>{
  e.send({kind:'offer',token:'t1',description:{type:'offer',sdp:'v=0'}});
  await wait(500);
  assert(!e.out.some(x=>x.kind==='answer'));
  assert(e.out.some(x=>x.event==='conference-offer-received'));
 });

 await test('Bridge transport states are reported, and a failure stops the session',async e=>{
  e.send({kind:'offer',token:'t1',description:{type:'offer',sdp:'v=0'}});
  await wait(20);
  const pc=e.peers[0];
  pc.connectionState='connecting';pc.onconnectionstatechange();
  pc.connectionState='failed';pc.onconnectionstatechange();
  await wait(20);
  const states=e.out.filter(x=>x.event==='conference-bridge-state').map(x=>x.state);
  assert.deepEqual(states,['connecting','failed']);
  assert(e.out.some(x=>x.kind==='stopped'&&x.reason==='transport-failed'));
 });

 console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
