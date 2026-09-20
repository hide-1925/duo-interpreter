const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
let serial=0;
function environment(){
 class Track {constructor(kind='audio'){this.kind=kind;this.id='track-'+ ++serial;this.readyState='live';this._enabled=true;this.muted=false;}get enabled(){return this._enabled;}set enabled(v){this._enabled=!!v;}clone(){const t=new Track(this.kind);t.enabled=this.enabled;return t;}stop(){this.readyState='ended';}}
 class Stream {constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks.slice();}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}clone(){return new Stream(this.tracks.map(t=>new Track(t.kind)));}}
 class Sender {constructor(track){this.track=track;}async replaceTrack(track){this.track=track;}}
 class PC {constructor(){this.senders=[];this.connectionState='connected';}addTrack(track){const s=new Sender(track);this.senders.push(s);return s;}addTransceiver(t){return {sender:this.addTrack(typeof t==='string'?null:t)};}getSenders(){return this.senders;}addEventListener(){} }
 class AudioNode {connect(d){return d;}disconnect(){}}
 class Source extends AudioNode {constructor(ctx,{mediaStream}={}){super();this.mediaStream=mediaStream;}}
 class Destination extends AudioNode {constructor(){super();this.stream=new Stream([new Track()]);}}
 class Context {createMediaStreamSource(s){return new Source(this,{mediaStream:s});}createMediaStreamDestination(){return new Destination();}createGain(){return new AudioNode();}}
 const media={getUserMedia:async()=>new Stream([new Track()]),getDisplayMedia:async()=>new Stream([new Track('video'),new Track()])};
 const window={MediaStreamTrack:Track,MediaStream:Stream,RTCPeerConnection:PC,RTCRtpSender:Sender,AudioContext:Context,AudioNode,MediaStreamAudioSourceNode:Source,MediaStreamAudioDestinationNode:Destination};
 const sandbox={window,navigator:{mediaDevices:media},MediaStreamTrack:Track,MediaStream:Stream,AudioContext:Context,setInterval(){return 1;},clearInterval(){},addEventListener(){}};
 const c=vm.createContext(sandbox);
 for(const name of ['mic-provenance','teams'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../conference-adapters/'+name+'.js'),'utf8'),c);
 return {window,Track,Stream,PC,Context,media,adapter:window.DuoTeamsAdapter,provenance:window.DuoMicProvenance};
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
  await e.media.getUserMedia();const ctx=new e.window.AudioContext(),dst=ctx.createMediaStreamDestination();ctx.createMediaStreamSource(new e.Stream([new e.Track()])).connect(dst);new e.window.RTCPeerConnection().addTrack(dst.stream.getAudioTracks()[0]);
  assert.equal(e.adapter.discovery().eligibleCount,0);await assert.rejects(e.adapter.start(new e.Track(),()=>{}));
 });
 await test('Fallback requires a connected peer and exactly one active microphone family',async e=>{
  await e.media.getUserMedia();const pc=new e.window.RTCPeerConnection();pc.addTrack(new e.window.AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]);pc.connectionState='new';assert.equal(e.adapter.discovery().eligibleCount,0);pc.connectionState='connected';await e.media.getUserMedia();assert.equal(e.adapter.discovery().eligibleCount,0);
 });
 console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
