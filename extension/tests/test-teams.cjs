const path=require('node:path');
const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
let serial=0;
class Track{constructor(kind='audio'){this.id='t'+(++serial);this.kind=kind;this.readyState='live';this._enabled=true;this.muted=false;}get enabled(){return this._enabled;}set enabled(v){this._enabled=v;}clone(){const t=new Track(this.kind);t.enabled=this.enabled;return t;}stop(){this.readyState='ended';}}
class Sender{constructor(track){this.track=track;this.history=[];}async replaceTrack(track){this.history.push(track);if(this.fail){this.fail=false;throw Error('replace fail');}this.track=track;}}
class PC{constructor(){this.senders=[];this.connectionState='connected';}addEventListener(){}addTrack(t){const s=new Sender(t);this.senders.push(s);return s;}addTransceiver(t){return {sender:this.addTrack(t)};}getSenders(){return this.senders;}}
const media={async getUserMedia(){const tracks=[new Track()];return {getAudioTracks:()=>tracks};}},window={RTCPeerConnection:PC,RTCRtpSender:Sender},timers=[];
const c=vm.createContext({window,navigator:{mediaDevices:media},MediaStreamTrack:Track,setInterval:fn=>{timers.push(fn);return 1;},clearInterval(){},addEventListener(){},console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../conference-adapters/teams.js'),'utf8'),c);
(async()=>{
 const tests=[],adapter=window.DuoTeamsAdapter,events=[];
 const mic=(await media.getUserMedia()).getAudioTracks()[0],pc=new window.RTCPeerConnection(),sender=pc.addTrack(mic),screen=pc.addTrack(new Track()),bridge=new Track();
 await adapter.start(bridge,e=>events.push(e));assert.notEqual(sender.track,mic);assert.equal(screen.history.length,0);tests.push('Only proven microphone senders replaced; screen/remote tracks excluded');
 mic.enabled=false;assert.equal(sender.track.enabled,false);mic.enabled=true;assert.equal(sender.track.enabled,true);tests.push('Teams enabled mute mirrored synchronously');
 sender.track.enabled=false;await adapter.stop();assert.equal(sender.track,mic);assert.equal(mic.enabled,false);tests.push('Mute on replacement retained on original microphone restore');
 await adapter.start(bridge,e=>events.push(e));const mic2=(await media.getUserMedia()).getAudioTracks()[0];await sender.replaceTrack(mic2);assert.notEqual(sender.track,mic2);await adapter.stop();assert.equal(sender.track,mic2);tests.push('Host microphone changes restored to newest original');
 mic2.enabled=false;await adapter.start(bridge,e=>events.push(e));assert.equal(sender.track.enabled,false);await adapter.stop();tests.push('Activation never unmutes Teams');
 await adapter.start(bridge,e=>events.push(e));await sender.replaceTrack(null);assert.equal(sender.track,null);await adapter.stop();assert.equal(sender.track,null);tests.push('Null-track Teams mute respected');
 await sender.replaceTrack(mic2);sender.fail=true;await assert.rejects(adapter.start(bridge,e=>events.push(e)));assert.equal(sender.track,mic2);tests.push('Failed replacement fails closed');
 const starting=adapter.start(bridge,e=>events.push(e));await starting;const replacing=sender.replaceTrack(mic);const stopping=adapter.stop();await Promise.all([replacing,stopping]);assert.equal(sender.track,mic);tests.push('Concurrent host replace and disable restore serialized');
 console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

