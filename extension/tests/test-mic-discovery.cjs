const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
let serial=0;
function environment(buggyExternalClassification=false,legacyExternalVeto=false,topLevelMicEvidenceOnly=false){
 class Track {constructor(kind='audio'){this.kind=kind;this.id='track-'+ ++serial;this.readyState='live';this._enabled=true;this.muted=false;}get enabled(){return this._enabled;}set enabled(v){this._enabled=!!v;}clone(){const t=new Track(this.kind);t.enabled=this.enabled;return t;}stop(){this.readyState='ended';}}
 class Stream {constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks.slice();}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}clone(){return new Stream(this.tracks.map(t=>new Track(t.kind)));}}
 class Sender {constructor(track){this.track=track;this.calls=0;}async replaceTrack(track){this.calls++;if(this.failWith)throw Error(this.failWith);this.track=track;}}
 class PC {constructor(){this.senders=[];this.receivers=[];this.events=new Map();this.connectionState='connected';}addTrack(track){const s=new Sender(track);this.senders.push(s);return s;}addTransceiver(t){return {sender:this.addTrack(typeof t==='string'?null:t)};}getSenders(){return this.senders;}getReceivers(){return this.receivers;}addEventListener(type,fn){this.events.set(type,fn);}receive(track){this.receivers.push({track});this.events.get('track')?.({track});} }
 class AudioNode {connect(d){return d;}disconnect(){}}
 class Param {constructor(v){this.value=v;}}
 class Gain extends AudioNode {constructor(){super();this.gain=new Param(1);}}
 class Comp extends AudioNode {constructor(){super();for(const k of ['threshold','knee','ratio','attack','release'])this[k]=new Param(0);}}
 class Source extends AudioNode {constructor(ctx,{mediaStream}={}){super();this.mediaStream=mediaStream;}}
 class Destination extends AudioNode {constructor(){super();this.stream=new Stream([new Track()]);}}
 const contexts={created:[],closed:[],resumeTo:'running'};
 class Context {constructor(){this.state='running';contexts.created.push(this);}
  createMediaStreamSource(s){return new Source(this,{mediaStream:s});}
  createMediaStreamDestination(){return new Destination();}
  createGain(){return new Gain();}
  createDynamicsCompressor(){return new Comp();}
  async resume(){this.state=contexts.resumeTo;}
  async close(){this.state='closed';contexts.closed.push(this);}}
 Object.defineProperty(Source,'name',{value:'MediaStreamAudioSourceNode'});Object.defineProperty(Destination,'name',{value:'MediaStreamAudioDestinationNode'});
 const media={getUserMedia:async()=>new Stream([new Track()]),getDisplayMedia:async()=>new Stream([new Track('video'),new Track()])};
 const window={MediaStreamTrack:Track,MediaStream:Stream,RTCPeerConnection:PC,RTCRtpSender:Sender,AudioContext:Context,AudioNode,MediaStreamAudioSourceNode:Source,MediaStreamAudioDestinationNode:Destination};
 const sandbox={window,navigator:{mediaDevices:media},MediaStreamTrack:Track,MediaStream:Stream,AudioContext:Context,setInterval(){return 1;},clearInterval(){},addEventListener(){}};
 const c=vm.createContext(sandbox);
 for(const name of ['mic-provenance','teams']){let source=fs.readFileSync(path.join(__dirname,'../conference-adapters/'+name+'.js'),'utf8');
  if(name==='mic-provenance'&&buggyExternalClassification)source=source.replace('external:results.some(r=>r.externalEvidence)','external:results.some(r=>!r.mic)');
  // Restore the pre-1.4.4 behaviour: a source node claimed every track in the
  // stream, and any external evidence vetoed the slot outright.
  if(legacyExternalVeto&&name==='mic-provenance')source=source.replace('sources.set(node,audio.slice(0,1));','sources.set(node,audio);');
  if(legacyExternalVeto&&name==='teams')source=source.replace(/const micMix=unique[^;]*;/,'const micMix=false;');
  // Restore the 1.4.4 build: micEvidence was read off the proof flag at the top
  // of the graph, so a microphone one nesting level down went unseen.
  if(topLevelMicEvidenceOnly&&name==='mic-provenance'){
   source=source.replace('micEvidence:results.some(r=>r.mic||r.micEvidence),','');
   source=source.replace('micEvidence:!!(r.mic||r.micEvidence)','micEvidence:!!r.mic');
  }
  vm.runInContext(source,c);}
 return {window,Track,Stream,PC,Context,media,contexts,adapter:window.DuoTeamsAdapter,provenance:window.DuoMicProvenance};
}
const passed=[];
async function test(name,fn){await fn(environment());passed.push(name);}
(async()=>{
 await test('Direct microphone and cloned track connect and restore to the Teams track',async e=>{
  const t=(await e.media.getUserMedia()).getAudioTracks()[0].clone().clone(),s=new e.window.RTCPeerConnection().addTrack(t);
  assert.equal(e.provenance.inspect(t).reason,'microphone-clone');await e.adapter.start(new e.Track(),()=>{});assert.notEqual(s.track,t);await e.adapter.stop();assert.equal(s.track,t);
 });
 await test('Native MediaStream.clone internal copies retain microphone provenance',async e=>{
  const t=(await e.media.getUserMedia()).clone().getAudioTracks()[0],s=new e.window.RTCPeerConnection().addTrack(t);
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(s.track,t);await e.adapter.stop();assert.equal(s.track,t);
 });
 await test('Gain-processed microphone and its clone qualify',async e=>{
  const ctx=new e.window.AudioContext(),src=ctx.createMediaStreamSource(await e.media.getUserMedia()),gain=ctx.createGain(),dst=ctx.createMediaStreamDestination();src.connect(gain);gain.connect(dst);
  const t=dst.stream.getAudioTracks()[0].clone(),s=new e.window.RTCPeerConnection().addTrack(t);assert(e.provenance.isMic(t));
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(s.track,t);await e.adapter.stop();assert.equal(s.track,t);
 });
 await test('Web Audio constructor syntax also retains proven microphone lineage',async e=>{
  const ctx=new e.window.AudioContext(),src=new e.window.MediaStreamAudioSourceNode(ctx,{mediaStream:await e.media.getUserMedia()}),dst=new e.window.MediaStreamAudioDestinationNode(ctx);src.connect(dst);assert(e.provenance.isMic(dst.stream.getAudioTracks()[0]));
 });
 await test('Mixed remote audio is rejected; selective disconnect restores provenance',async e=>{
  const ctx=new e.window.AudioContext(),mic=ctx.createMediaStreamSource(await e.media.getUserMedia()),remote=ctx.createMediaStreamSource(new e.Stream([new e.Track()])),dst=ctx.createMediaStreamDestination();mic.connect(dst);remote.connect(dst);
  const t=dst.stream.getAudioTracks()[0];assert.equal(e.provenance.isMic(t),false);remote.disconnect(dst);assert.equal(e.provenance.isMic(t),true);mic.disconnect(0);assert.equal(e.provenance.isMic(t),false);
 });
 await test('Screenshare/remote clones and arbitrary generated audio never qualify',async e=>{
  const pc=new e.window.RTCPeerConnection();pc.addTrack(new e.Track().clone());pc.addTrack(new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]);
  await assert.rejects(e.adapter.start(new e.Track(),()=>{}),/マイク由来/);assert.equal(e.adapter.discovery().eligibleCount,0);
 });
 await test('Cached constructor and existing peer with later addTrack are observed',async e=>{
  const pc=new e.PC(),t=(await e.media.getUserMedia()).getAudioTracks()[0],s=pc.addTrack(t);await e.adapter.start(new e.Track(),()=>{});assert.notEqual(s.track,t);await e.adapter.stop();assert.equal(s.track,t);
 });
 await test('Receiver relay peer stays excluded from Teams connection discovery',async e=>{
  const relay=e.adapter.createRelayPeer({});relay.getSenders();assert.equal(e.adapter.discovery().peerCount,0);
 });
 await test('Microphone muted while using a clone remains muted after restoration',async e=>{
  const t=(await e.media.getUserMedia()).clone().getAudioTracks()[0],s=new e.window.RTCPeerConnection().addTrack(t);await e.adapter.start(new e.Track(),()=>{});t.enabled=false;assert.equal(s.track.enabled,false);await e.adapter.stop();assert.equal(s.track.enabled,false);
 });
 await test('Discovery produces actionable counts without labels, conversation or device IDs',async e=>{
  const pc=new e.window.RTCPeerConnection();pc.addTrack((await e.media.getUserMedia()).getAudioTracks()[0]);pc.addTrack(new e.Track());const d=e.adapter.discovery();assert.equal(d.peerCount,1);assert.equal(d.audioSenderCount,2);assert.equal(d.eligibleCount,1);assert.equal(d.getUserMediaSuccesses,1);assert(!JSON.stringify(d).includes('track-'));
 });
 await test('Feedback through a destination stream is rejected without recursion overflow',async e=>{
  const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination(),src=ctx.createMediaStreamSource(dst.stream);src.connect(dst);assert.equal(e.provenance.isMic(dst.stream.getAudioTracks()[0]),false);
 });

 await test('Observed Teams case: unique opaque processed sender connects, mutes, and restores',async e=>{
  await e.media.getUserMedia();const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
  const original=dst.stream.getAudioTracks()[0],pc=new e.window.RTCPeerConnection(),sender=pc.addTrack(original);
  assert.equal(e.provenance.isMic(original),false);assert.equal(e.adapter.discovery().selectionMethod,'unique-processed-sender');
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(sender.track,original);original.enabled=false;assert.equal(sender.track.enabled,false);
  await e.adapter.setMode('original-only');assert.equal(sender.track,original);await e.adapter.setMode('tts-only');assert.notEqual(sender.track,original);assert.equal(sender.track.enabled,false);
  await e.adapter.stop();assert.equal(sender.track,original);assert.equal(sender.track.enabled,false);
 });
 await test('Opaque slot still works when the original capture is stopped but microphone clones survive',async e=>{
  const stream=await e.media.getUserMedia(),clone=stream.clone();stream.getAudioTracks()[0].stop();
  const t=new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0],s=new e.window.RTCPeerConnection().addTrack(t);
  assert.equal(e.provenance.diagnostics().livePhysicalTracks,1);await e.adapter.start(new e.Track(),()=>{});assert.notEqual(s.track,t);await e.adapter.stop();clone.getAudioTracks()[0].stop();assert.equal(e.provenance.diagnostics().livePhysicalTracks,0);
 });
 await test('Unknown sender with active display capture is never selected by the fallback',async e=>{
  await e.media.getUserMedia();const display=await e.media.getDisplayMedia();new e.window.RTCPeerConnection().addTrack(new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]);
  assert.equal(e.adapter.discovery().eligibleCount,0);await assert.rejects(e.adapter.start(new e.Track(),()=>{}));const clone=display.clone();display.getTracks().forEach(t=>t.stop());assert.equal(e.adapter.discovery().eligibleCount,0);clone.getTracks().forEach(t=>t.stop());assert.equal(e.adapter.discovery().eligibleCount,1);
 });
 await test('Multiple opaque audio senders are rejected without guessing',async e=>{
  await e.media.getUserMedia();const pc=new e.window.RTCPeerConnection();for(let i=0;i<2;i++)pc.addTrack(new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]);
  assert.equal(e.adapter.discovery().eligibleCount,0);await assert.rejects(e.adapter.start(new e.Track(),()=>{}));
 });
 await test('Single processed remote stream is excluded even when a microphone is acquired',async e=>{
  await e.media.getUserMedia();const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination(),remote=new e.Track(),pc=new e.window.RTCPeerConnection();pc.receive(remote);ctx.createMediaStreamSource(new e.Stream([remote.clone()])).connect(dst);pc.addTrack(dst.stream.getAudioTracks()[0]);
  assert.equal(e.adapter.discovery().eligibleCount,0);await assert.rejects(e.adapter.start(new e.Track(),()=>{}));
 });
 await test('Fallback requires a connected peer and exactly one active microphone family',async e=>{
  await e.media.getUserMedia();const pc=new e.window.RTCPeerConnection();pc.addTrack(new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]);pc.connectionState='new';assert.equal(e.adapter.discovery().eligibleCount,0);pc.connectionState='connected';await e.media.getUserMedia();assert.equal(e.adapter.discovery().eligibleCount,0);
 });

 await test('Actual v1.4.2 log topology reproduces the rejection; corrected predicate connects and restores',async()=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/teams-v142-discovery.json'),'utf8'));
  async function setup(e){const mic=await e.media.getUserMedia();for(let i=0;i<fixture.streamClones;i++)mic.clone();const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(new e.Stream([new e.Track()])).connect(dst);const pc=new e.window.RTCPeerConnection(),original=dst.stream.getAudioTracks()[0],sender=pc.addTrack(original);for(let i=1;i<fixture.senders.length;i++)pc.addTransceiver('video');return {original,sender};}
  const old=environment(true);await setup(old);const before=old.adapter.discovery();
  for(const key of ['audioSenderCount','eligibleCount','getUserMediaCalls','getUserMediaSuccesses','livePhysicalTracks','activeDisplayTracks','streamClones','trackClones'])assert.equal(before[key],fixture[key]);
  assert.deepEqual(Array.from(before.senders[0].nodeTypes),fixture.senders[0].nodeTypes);assert.equal(before.senders[0].externalEvidence,true);await assert.rejects(old.adapter.start(new old.Track(),()=>{}),/マイク由来/);
  const fixed=environment(),{original,sender}=await setup(fixed),after=fixed.adapter.discovery();assert.equal(after.senders[0].mic,false);assert.equal(after.senders[0].externalEvidence,false);assert.equal(after.selectionMethod,'unique-processed-sender');assert.equal(after.eligibleCount,1);
  await fixed.adapter.start(new fixed.Track(),()=>{});assert.notEqual(sender.track,original);original.enabled=false;assert.equal(sender.track.enabled,false);await fixed.adapter.stop();assert.equal(sender.track,original);assert.equal(sender.track.enabled,false);
 });
 await test('Receiver scan labels an existing remote track even without a track event',async e=>{
  await e.media.getUserMedia();const pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receivers.push({track:remote});const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(new e.Stream([remote])).connect(dst);pc.addTrack(dst.stream.getAudioTracks()[0]);assert.equal(e.adapter.discovery().eligibleCount,0);assert.equal(e.provenance.inspect(remote).reason,'remote-receiver');
 });
 await test('Unknown stream is distinct from positively identified display audio',async e=>{
  const unknown=new e.Track();assert.equal(e.provenance.inspect(unknown).reason,'unobserved-origin');assert(!e.provenance.inspect(unknown).externalEvidence);const display=await e.media.getDisplayMedia(),clone=display.clone().getAudioTracks()[0];assert.equal(e.provenance.inspect(clone).reason,'display-capture');assert.equal(e.provenance.inspect(clone).externalEvidence,true);
 });
 // --- v1.4.4: the microphone sits in the same graph as a far-end receiver ---
 // Real Teams (duo-subtitle-interaction (15).json, extension 1.4.3) reported
 // sourceReasons ["get-user-media","remote-receiver"] on the only audio sender,
 // so both selection paths rejected it and eligibleCount stayed 0.
 await test('Observed v1.4.3 log topology: microphone mixed with a far-end receiver connects, mutes, and restores',async()=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/teams-v143-discovery.json'),'utf8'));
  async function setup(e){
   const mic=(await e.media.getUserMedia()).getAudioTracks()[0];for(let i=0;i<fixture.streamClones;i++)new e.Stream([mic]).clone();
   const pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receive(remote);
   const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
   ctx.createMediaStreamSource(new e.Stream([mic])).connect(dst);
   ctx.createMediaStreamSource(new e.Stream([remote])).connect(dst);
   const original=dst.stream.getAudioTracks()[0],sender=pc.addTrack(original);
   for(let i=0;i<fixture.nonAudioSenderCount;i++)pc.addTransceiver('video');
   return {original,sender};
  }
  // The build the user ran reproduces the recorded rejection exactly.
  const old=environment(false,true);await setup(old);const before=old.adapter.discovery();
  for(const key of ['peerCount','audioSenderCount','eligibleCount','selectionMethod','getUserMediaCalls','getUserMediaSuccesses','livePhysicalTracks','activeDisplayTracks','streamClones','trackClones'])assert.equal(before[key],fixture[key],key);
  const b0=before.senders.find(x=>x.kind==='audio');
  assert.equal(b0.reason,fixture.senders[0].reason);assert.equal(b0.externalEvidence,true);
  assert.deepEqual([...b0.sourceReasons].sort(),[...fixture.senders[0].sourceReasons].sort());
  assert.deepEqual([...b0.nodeTypes].sort(),[...fixture.senders[0].nodeTypes].sort());
  await assert.rejects(old.adapter.start(new old.Track(),()=>{}),/マイク由来/);
  const e=environment(),{original,sender}=await setup(e);
  const d=e.adapter.discovery(),s0=d.senders.find(x=>x.kind==='audio');
  assert.deepEqual([...s0.sourceReasons].sort(),['get-user-media','remote-receiver']);
  assert.equal(s0.micEvidence,true);assert.equal(s0.externalEvidence,true);
  assert.deepEqual(Array.from(s0.externalReasons),['remote-receiver']);
  assert.equal(d.selectionMethod,'mic-in-processed-mix');assert.equal(d.eligibleCount,1);
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(sender.track,original);
  // usable() must keep accepting the slot, or the 100ms watchdog tears it down.
  await e.adapter.setMode('original-only');assert.equal(sender.track,original);
  await e.adapter.setMode('tts-only');assert.notEqual(sender.track,original);
  original.enabled=false;assert.equal(sender.track.enabled,false);
  await e.adapter.stop();assert.equal(sender.track,original);assert.equal(sender.track.enabled,false);
 });
 await test('A source node reads one track, so extra tracks in the stream no longer forge provenance',async e=>{
  const mic=(await e.media.getUserMedia()).getAudioTracks()[0],pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receive(remote);
  const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
  const tracks=[mic,remote].sort((a,b)=>String(a.id)<String(b.id)?-1:1);
  ctx.createMediaStreamSource(new e.Stream(tracks)).connect(dst);
  const original=dst.stream.getAudioTracks()[0],sender=pc.addTrack(original);
  const d=e.adapter.discovery(),s0=d.senders.find(x=>x.kind==='audio');
  // Only the track the node actually consumes counts.
  assert.deepEqual(Array.from(s0.sourceReasons),[e.provenance.inspect(tracks[0]).reason]);
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(sender.track,original);
  await e.adapter.stop();assert.equal(sender.track,original);
 });
 await test('Screen capture mixed into the microphone graph is still rejected',async e=>{
  const mic=(await e.media.getUserMedia()).getAudioTracks()[0],display=await e.media.getDisplayMedia();
  const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new e.Stream([mic])).connect(dst);
  ctx.createMediaStreamSource(new e.Stream([display.getAudioTracks()[0]])).connect(dst);
  new e.window.RTCPeerConnection().addTrack(dst.stream.getAudioTracks()[0]);
  const d=e.adapter.discovery();assert.equal(d.eligibleCount,0);assert.equal(d.selectionMethod,'none');
  assert(d.senders.find(x=>x.kind==='audio').externalReasons.includes('display-capture'));
  await assert.rejects(e.adapter.start(new e.Track(),()=>{}),/画面共有/);
 });
 await test('Generated audio mixed into the microphone graph is still rejected',async e=>{
  const mic=(await e.media.getUserMedia()).getAudioTracks()[0];
  const Osc=class extends e.window.AudioNode{};Object.defineProperty(Osc,'name',{value:'OscillatorNode'});
  const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new e.Stream([mic])).connect(dst);new Osc().connect(dst);
  new e.window.RTCPeerConnection().addTrack(dst.stream.getAudioTracks()[0]);
  const d=e.adapter.discovery();assert.equal(d.eligibleCount,0);assert.equal(d.selectionMethod,'none');
  assert.deepEqual(Array.from(d.senders.find(x=>x.kind==='audio').externalReasons),['generated-audio']);
  await assert.rejects(e.adapter.start(new e.Track(),()=>{}),/マイク由来/);
 });
 await test('A far-end mix with no microphone evidence is still rejected',async e=>{
  await e.media.getUserMedia();const pc=new e.window.RTCPeerConnection(),a=new e.Track(),b=new e.Track();pc.receive(a);pc.receive(b);
  const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new e.Stream([a])).connect(dst);ctx.createMediaStreamSource(new e.Stream([b])).connect(dst);
  pc.addTrack(dst.stream.getAudioTracks()[0]);
  const d=e.adapter.discovery();assert.equal(d.eligibleCount,0);assert.equal(d.selectionMethod,'none');
  assert.equal(d.senders.find(x=>x.kind==='audio').micEvidence,false);
  await assert.rejects(e.adapter.start(new e.Track(),()=>{}),/マイク由来/);
 });
 await test('The far-end mix slot still requires a single audio sender and one live capture',async e=>{
  const mic=(await e.media.getUserMedia()).getAudioTracks()[0],pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receive(remote);
  const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new e.Stream([mic])).connect(dst);ctx.createMediaStreamSource(new e.Stream([remote])).connect(dst);
  pc.addTrack(dst.stream.getAudioTracks()[0]);
  assert.equal(e.adapter.discovery().eligibleCount,1);
  pc.addTrack(new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]);
  assert.equal(e.adapter.discovery().eligibleCount,0);  // two audio senders
  pc.senders.pop();assert.equal(e.adapter.discovery().eligibleCount,1);
  await e.media.getUserMedia();assert.equal(e.adapter.discovery().eligibleCount,0);  // two live captures
 });
 // --- v1.4.5: Teams chains its outgoing graph through an intermediate stream ---
 // Real Teams (duo-subtitle-interaction (16).json, extension 1.4.4) reported
 // micEvidence false while sourceReasons still named get-user-media: the mic sits
 // one MediaStreamAudioDestinationNode further upstream, and a nested processed
 // track reports mic:false the moment anything beside it is unproven.
 await test('Observed v1.4.4 log topology: a chained graph keeps the microphone visible as evidence',async()=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/teams-v144-discovery.json'),'utf8'));
  async function setup(e){
   const mic=(await e.media.getUserMedia()).getAudioTracks()[0];for(let i=0;i<fixture.streamClones;i++)new e.Stream([mic]).clone();
   const pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receive(remote);
   const ctx=new e.window.AudioContext(),inner=ctx.createMediaStreamDestination();
   ctx.createMediaStreamSource(new e.Stream([mic])).connect(inner);
   ctx.createMediaStreamSource(new e.Stream([remote])).connect(inner);
   const outer=ctx.createMediaStreamDestination();
   ctx.createMediaStreamSource(inner.stream).connect(outer);
   const original=outer.stream.getAudioTracks()[0],sender=pc.addTrack(original);
   for(let i=0;i<fixture.nonAudioSenderCount;i++)pc.addTransceiver('video');
   return {original,sender};
  }
  // The 1.4.4 build the user ran reproduces the recorded rejection exactly.
  const old=environment(false,false,true);await setup(old);const before=old.adapter.discovery();
  for(const key of ['peerCount','audioSenderCount','eligibleCount','selectionMethod','livePhysicalTracks','activeDisplayTracks','streamClones'])assert.equal(before[key],fixture[key],key);
  const b0=before.senders.find(x=>x.kind==='audio');
  assert.equal(b0.micEvidence,false);assert.equal(b0.externalEvidence,true);
  assert.deepEqual([...b0.sourceReasons].sort(),[...fixture.senders[0].sourceReasons].sort());
  assert.deepEqual([...b0.externalReasons],[...fixture.senders[0].externalReasons]);
  assert.deepEqual([...b0.nodeTypes].sort(),[...fixture.senders[0].nodeTypes].sort());
  await assert.rejects(old.adapter.start(new old.Track(),()=>{}),/マイク由来/);
  // Current build: evidence survives the nesting, so the slot is selected.
  const e=environment(),{original,sender}=await setup(e),d=e.adapter.discovery(),s0=d.senders.find(x=>x.kind==='audio');
  assert.equal(s0.micEvidence,true);assert.deepEqual([...s0.externalReasons],['remote-receiver']);
  assert.equal(d.selectionMethod,'mic-in-processed-mix');assert.equal(d.eligibleCount,1);
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(sender.track,original);
  await e.adapter.setMode('original-only');assert.equal(sender.track,original);
  await e.adapter.setMode('tts-only');assert.notEqual(sender.track,original);
  original.enabled=false;assert.equal(sender.track.enabled,false);
  await e.adapter.stop();assert.equal(sender.track,original);assert.equal(sender.track.enabled,false);
 });
 await test('A chained graph carrying only the microphone is still proven, not merely evidenced',async e=>{
  const ctx=new e.window.AudioContext(),inner=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(await e.media.getUserMedia()).connect(inner);
  const outer=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(inner.stream).connect(outer);
  const original=outer.stream.getAudioTracks()[0],sender=new e.window.RTCPeerConnection().addTrack(original);
  assert.equal(e.provenance.inspect(original).reason,'microphone-web-audio');
  assert.equal(e.adapter.discovery().selectionMethod,'microphone-provenance');
  await e.adapter.start(new e.Track(),()=>{});assert.notEqual(sender.track,original);
  await e.adapter.stop();assert.equal(sender.track,original);
 });
 await test('Nesting does not smuggle screen capture or generated audio past the mix slot',async e=>{
  for(const contaminate of ['display','generated']){
   const f=environment();
   const mic=(await f.media.getUserMedia()).getAudioTracks()[0];
   const ctx=new f.window.AudioContext(),inner=ctx.createMediaStreamDestination();
   ctx.createMediaStreamSource(new f.Stream([mic])).connect(inner);
   if(contaminate==='display'){const disp=await f.media.getDisplayMedia();ctx.createMediaStreamSource(new f.Stream([disp.getAudioTracks()[0]])).connect(inner);}
   else {const Osc=class extends f.window.AudioNode{};Object.defineProperty(Osc,'name',{value:'OscillatorNode'});new Osc().connect(inner);}
   const outer=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(inner.stream).connect(outer);
   new f.window.RTCPeerConnection().addTrack(outer.stream.getAudioTracks()[0]);
   const d=f.adapter.discovery();
   assert.equal(d.eligibleCount,0,contaminate);assert.equal(d.selectionMethod,'none',contaminate);
   await assert.rejects(f.adapter.start(new f.Track(),()=>{}));
  }
 });
 // --- mix mode (original-plus-tts) had no adapter-level coverage at all ---
 await test('Mix mode blends the original slot with TTS, tracks mute, and frees every mixer',async e=>{
  const mic=(await e.media.getUserMedia()).getAudioTracks()[0];
  const pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receive(remote);
  const ctx=new e.window.AudioContext(),inner=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new e.Stream([mic])).connect(inner);
  ctx.createMediaStreamSource(new e.Stream([remote])).connect(inner);
  const outer=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(inner.stream).connect(outer);
  const original=outer.stream.getAudioTracks()[0],sender=pc.addTrack(original),tts=new e.Track();
  const before=e.contexts.created.length;
  await e.adapter.start(tts,()=>{});
  const ttsOnly=sender.track;assert.notEqual(ttsOnly,original);assert.notEqual(ttsOnly,tts);
  assert.equal(await e.adapter.setMode('original-plus-tts',{micGain:.7,ttsGain:1}),'original-plus-tts');
  const mixed=sender.track;
  assert.notEqual(mixed,original);assert.notEqual(mixed,tts);assert.notEqual(mixed,ttsOnly);
  assert.equal(e.contexts.created.length-before,1);
  // Teams mutes by flipping enabled on the slot it owns; the blend must follow.
  original.enabled=false;assert.equal(mixed.enabled,false);
  original.enabled=true;assert.equal(mixed.enabled,true);
  e.adapter.setGains({micGain:.2,ttsGain:.9});
  // Churning modes must not strand an AudioContext per switch.
  for(let i=0;i<3;i++){await e.adapter.setMode('tts-only');await e.adapter.setMode('original-plus-tts',{micGain:.7,ttsGain:1});}
  assert.equal(e.contexts.created.length-before,4);assert.equal(e.contexts.closed.length,3);
  await e.adapter.stop();
  assert.equal(sender.track,original);assert.equal(original.readyState,'live');
  assert.equal(e.contexts.closed.length,4);
 });
 await test('A blend that cannot start audio leaves the previous routing intact',async e=>{
  const t=(await e.media.getUserMedia()).getAudioTracks()[0],s=new e.window.RTCPeerConnection().addTrack(t);
  await e.adapter.start(new e.Track(),()=>{});
  const ttsOnly=s.track;assert.notEqual(ttsOnly,t);
  e.contexts.resumeTo='suspended';
  const opened=e.contexts.created.length;
  await assert.rejects(e.adapter.setMode('original-plus-tts',{micGain:.7,ttsGain:1}),/音声を許可/);
  // The half-built mixer is torn down, and the sender keeps what it had.
  assert.equal(e.contexts.closed.length,e.contexts.created.length-opened);
  assert.equal(s.track,ttsOnly);
  e.contexts.resumeTo='running';
  await e.adapter.stop();assert.equal(s.track,t);assert.equal(t.readyState,'live');
 });
 // --- v1.4.6: duo-subtitle-interaction (17).json ---
 // Real Teams, extension 1.4.5: after the first switch to mix, four further mode
 // changes emitted mode-applied with the new mode while the sender kept the mix
 // track d32d594c. The speaker button read "on" while Teams still received the
 // original microphone at 70%.
 await test('Every mode change replaces the sender, not just the first',async e=>{
  const mic=(await e.media.getUserMedia()).getAudioTracks()[0];
  const pc=new e.window.RTCPeerConnection(),remote=new e.Track();pc.receive(remote);
  const ctx=new e.window.AudioContext(),inner=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new e.Stream([mic])).connect(inner);
  ctx.createMediaStreamSource(new e.Stream([remote])).connect(inner);
  const outer=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(inner.stream).connect(outer);
  const original=outer.stream.getAudioTracks()[0],sender=pc.addTrack(original);
  await e.adapter.start(new e.Track(),()=>{});
  const seen=[];
  for(const mode of ['original-plus-tts','original-only','tts-only','original-plus-tts','original-only','tts-only']){
   assert.equal(await e.adapter.setMode(mode,{micGain:.7,ttsGain:1}),mode);
   seen.push({mode,track:sender.track});
  }
  // original-only hands the slot back; the other two must each install a fresh track.
  for(const {mode,track} of seen){
   if(mode==='original-only')assert.equal(track,original,mode);
   else assert.notEqual(track,original,mode);
  }
  const blends=seen.filter(x=>x.mode==='original-plus-tts').map(x=>x.track);
  assert.notEqual(blends[0],blends[1]);           // not the stale first mix
  const ttsOnly=seen.filter(x=>x.mode==='tts-only').map(x=>x.track);
  assert.notEqual(ttsOnly[0],ttsOnly[1]);
  assert(!blends.includes(ttsOnly[0])&&!blends.includes(ttsOnly[1]));
  await e.adapter.stop();assert.equal(sender.track,original);
 });
 await test('A mode change that can replace nothing fails loudly instead of reporting success',async e=>{
  const t=(await e.media.getUserMedia()).getAudioTracks()[0],pc=new e.window.RTCPeerConnection(),s=pc.addTrack(t);
  const events=[];await e.adapter.start(new e.Track(),d=>events.push(d));
  assert.equal(await e.adapter.setMode('original-plus-tts',{micGain:.7,ttsGain:1}),'original-plus-tts');
  const blend=s.track;
  t.stop();  // the slot the adapter drives goes away
  await assert.rejects(e.adapter.setMode('tts-only'),/切り替えられませんでした/);
  const skip=events.filter(x=>x.event==='conference-mode-skipped').pop();
  assert(skip,'a skipped mode change must be reported');
  assert.equal(skip.requestedMode,'tts-only');
  assert.equal(skip.appliedMode,'original-plus-tts');   // never claims the new mode
  assert(skip.reasons.length);
  assert.equal(s.track,blend);                          // sender untouched, not silently stale-labelled
  await e.adapter.stop().catch(()=>{});
 });
 await test('A restore against a closed peer connection settles instead of retrying forever',async e=>{
  const t=(await e.media.getUserMedia()).getAudioTracks()[0],pc=new e.window.RTCPeerConnection(),s=pc.addTrack(t);
  const events=[];await e.adapter.start(new e.Track(),d=>events.push(d));
  assert.notEqual(s.track,t);
  const before=s.calls;
  s.failWith="Failed to execute 'replaceTrack' on 'RTCRtpSender': The peer connection is closed.";
  await e.adapter.stop();                       // the call is gone: not a restore failure
  assert.equal(s.calls-before,1);
  assert(events.some(x=>x.replaceTrackResult==='peer-closed'));
  assert(!events.some(x=>x.replaceTrackResult==='restore-failed'));
  await e.adapter.stop();await e.adapter.stop();
  assert.equal(s.calls-before,1,'a dead replacement must not be retried on every later stop');
 });
 await test('A genuine restore failure is still reported, once per stop',async e=>{
  const t=(await e.media.getUserMedia()).getAudioTracks()[0],pc=new e.window.RTCPeerConnection(),s=pc.addTrack(t);
  const events=[];await e.adapter.start(new e.Track(),d=>events.push(d));
  const before=s.calls;
  s.failWith='InvalidModificationError';
  await assert.rejects(e.adapter.stop(),/元マイクの復帰に失敗/);
  assert.equal(s.calls-before,1);
  assert.equal(events.filter(x=>x.replaceTrackResult==='restore-failed').length,1);
  await e.adapter.stop();   // nothing left to retry
  assert.equal(s.calls-before,1);
  assert.equal(events.filter(x=>x.replaceTrackResult==='restore-failed').length,1);
 });
 console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
