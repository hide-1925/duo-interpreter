/* Track microphone provenance without classifying arbitrary audio as a mic.
 * Tracks, not device labels, are followed across clone() and Web Audio graphs.
 * This module is loaded in the same MAIN world as the Teams media code. */
(() => {
  'use strict';
  if(window.DuoMicProvenance)return;
  const physical=new WeakSet(),external=new WeakMap(),micFamilies=new Map(),displayFamilies=new Map(),parents=new WeakMap(),destinations=new WeakMap();
  const sources=new WeakMap(),edges=new WeakMap();
  const stats={getUserMediaCalls:0,getUserMediaSuccesses:0,getUserMediaFailures:0,physicalTracks:0,trackClones:0,streamClones:0};
  let lastError='';
  const nodeInputs=node=>edges.get(node)||[];
  function walkNode(node,seen,seenTracks){
    if(seen.has(node))return {mic:false,micEvidence:false,unknown:true,external:true,externalReasons:['graph-cycle'],reasons:['graph-cycle']};
    const next=new Set(seen);next.add(node);
    const tracks=sources.get(node);
    if(tracks){const results=tracks.map(t=>inspect(t,new Set(seenTracks)));return {mic:results.some(r=>r.mic),micEvidence:results.some(r=>r.mic||r.micEvidence),unknown:!results.length||results.some(r=>!r.mic),external:results.some(r=>r.externalEvidence),externalReasons:[...new Set(results.flatMap(r=>r.externalReasons||[]))],reasons:[...new Set(results.flatMap(r=>r.sourceReasons||[r.reason]))]};}
    const incoming=nodeInputs(node);
    if(!incoming.length){const generated=['OscillatorNode','AudioBufferSourceNode','ConstantSourceNode','MediaElementAudioSourceNode'].includes(node.constructor?.name);
      return {mic:false,micEvidence:false,unknown:true,external:generated,externalReasons:generated?['generated-audio']:[],reasons:['node-without-observed-input']};}
    const results=incoming.map(e=>walkNode(e.source,next,seenTracks));
    return {mic:results.some(r=>r.mic),micEvidence:results.some(r=>r.mic||r.micEvidence),unknown:results.some(r=>r.unknown),external:results.some(r=>r.external),externalReasons:[...new Set(results.flatMap(r=>r.externalReasons||[]))],reasons:[...new Set(results.flatMap(r=>r.reasons||[]))]};
  }
  function inspect(track,seen=new Set()){
    if(!track||track.kind!=='audio')return {mic:false,reason:'not-audio'};
    if(seen.has(track))return {mic:false,reason:'cycle'};
    seen.add(track);
    if(external.has(track))return {mic:false,reason:external.get(track),externalEvidence:true,externalReasons:[external.get(track)]};
    if(physical.has(track))return {mic:true,micEvidence:true,reason:'get-user-media'};
    if(parents.has(track)){const r=inspect(parents.get(track),seen);return {...r,reason:r.mic?'microphone-clone':r.reason};}
    const node=destinations.get(track);
    if(node){const r=walkNode(node,new Set(),seen);return {mic:r.mic&&!r.unknown,reason:r.mic&&!r.unknown?'microphone-web-audio':'unproven-web-audio',processed:true,micEvidence:!!(r.mic||r.micEvidence),externalEvidence:!!r.external,externalReasons:r.externalReasons||[],sourceReasons:r.reasons||[],nodeTypes:graphTypes(node)};}
    return {mic:false,reason:'unobserved-origin'};
  }
  const media=navigator.mediaDevices;
  if(media?.getUserMedia){const original=media.getUserMedia;media.getUserMedia=async function(...args){
    stats.getUserMediaCalls++;
    try{const stream=await original.apply(this,args);stats.getUserMediaSuccesses++;stream.getAudioTracks().forEach(t=>{physical.add(t);micFamilies.set(t,new Set([t]));stats.physicalTracks++;});return stream;}
    catch(error){stats.getUserMediaFailures++;lastError=String(error.name||'Error');throw error;}
  };}
  if(media?.getDisplayMedia){const original=media.getDisplayMedia;media.getDisplayMedia=async function(...args){const stream=await original.apply(this,args);stream.getTracks().forEach(t=>{displayFamilies.set(t,new Set([t]));external.set(t,'display-capture');});return stream;};}
  function graphTypes(node){const visited=new Set(),types=new Set();function visit(n){if(visited.has(n)||visited.size>=64)return;visited.add(n);types.add(n.constructor?.name||'AudioNode');nodeInputs(n).forEach(e=>visit(e.source));}visit(node);return [...types];}
  function linkClone(clone,original){parents.set(clone,original);let root=original;const seen=new Set();while(parents.has(root)&&!seen.has(root)){seen.add(root);root=parents.get(root);}if(micFamilies.has(root))micFamilies.get(root).add(clone);if(displayFamilies.has(root))displayFamilies.get(root).add(clone);}
  const trackProto=window.MediaStreamTrack?.prototype;
  if(trackProto?.clone){const original=trackProto.clone;trackProto.clone=function(...args){const clone=original.apply(this,args);linkClone(clone,this);stats.trackClones++;return clone;};}
  const streamProto=window.MediaStream?.prototype;
  if(streamProto?.clone){const original=streamProto.clone;streamProto.clone=function(...args){const clone=original.apply(this,args);const before=this.getTracks(),after=clone.getTracks();after.forEach((t,i)=>{if(before[i]&&t.kind===before[i].kind)linkClone(t,before[i]);});stats.streamClones++;return clone;};}
  // Keep exact connection edges, including disconnect() overloads. A processed
  // stream qualifies only when every upstream leaf is a proven microphone.
  const outgoing=new WeakMap(),nodeProto=window.AudioNode?.prototype;
  if(nodeProto?.connect&&nodeProto?.disconnect){
    const connect=nodeProto.connect,disconnect=nodeProto.disconnect;
    nodeProto.connect=function(destination,output=0,input=0){const result=connect.apply(this,arguments);
      if(destination instanceof window.AudioNode){const list=outgoing.get(this)||[];if(!list.some(e=>e.destination===destination&&e.output===output&&e.input===input)){const e={source:this,destination,output,input};list.push(e);outgoing.set(this,list);edges.set(destination,[...nodeInputs(destination),e]);}}
      return result;};
    nodeProto.disconnect=function(...args){const result=disconnect.apply(this,args);const list=outgoing.get(this)||[];
      const removed=e=>!args.length||(typeof args[0]==='number'?e.output===args[0]:e.destination===args[0]&&(args.length<2||e.output===args[1])&&(args.length<3||e.input===args[2]));
      for(const e of list.filter(removed))edges.set(e.destination,nodeInputs(e.destination).filter(x=>x!==e));outgoing.set(this,list.filter(e=>!removed(e)));return result;};
  }
  // A MediaStreamAudioSourceNode reads exactly one track: the spec orders the
  // stream's audio tracks by id and takes the first. Recording every track in the
  // stream invents upstream sources the node never reads, which is enough to
  // stamp a pure microphone graph with someone else's provenance.
  function source(node,stream){if(stream){const audio=stream.getAudioTracks().slice().sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);sources.set(node,audio.slice(0,1));}return node;}
  function destination(node){node.stream?.getAudioTracks().forEach(t=>destinations.set(t,node));return node;}
  const ctxProto=window.AudioContext?.prototype;
  for(const [name,record] of [['createMediaStreamSource',(n,args)=>source(n,args[0])],['createMediaStreamDestination',n=>destination(n)],['createMediaStreamTrackSource',(n,args)=>{sources.set(n,[args[0]]);return n;}]]){
    if(ctxProto?.[name]){const original=ctxProto[name];ctxProto[name]=function(...args){return record(original.apply(this,args),args);};}
  }
  for(const [name,record] of [['MediaStreamAudioSourceNode',(n,args)=>source(n,args[1]?.mediaStream)],['MediaStreamAudioDestinationNode',n=>destination(n)],['MediaStreamTrackAudioSourceNode',(n,args)=>{sources.set(n,[args[1]?.mediaStreamTrack]);return n;}]]){
    const Native=window[name];if(Native)window[name]=new Proxy(Native,{construct(target,args,newTarget){return record(Reflect.construct(target,args,newTarget),args);}});
  }
  window.DuoMicProvenance={inspect,isMic:track=>inspect(track).mic,markRemote(track){if(track)external.set(track,'remote-receiver');},diagnostics:()=>{
    for(const [root,family] of micFamilies){for(const t of family)if(t.readyState==='ended')family.delete(t);if(!family.size)micFamilies.delete(root);}
    for(const [root,family] of displayFamilies){for(const t of family)if(t.readyState==='ended')family.delete(t);if(!family.size)displayFamilies.delete(root);}
    return {...stats,livePhysicalTracks:micFamilies.size,activeDisplayTracks:displayFamilies.size,lastGetUserMediaError:lastError};
  }};
})();
