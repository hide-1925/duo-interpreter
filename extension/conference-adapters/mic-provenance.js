/* Track microphone provenance without classifying arbitrary audio as a mic.
 * Tracks, not device labels, are followed across clone() and Web Audio graphs.
 * This module is loaded in the same MAIN world as the Teams media code. */
(() => {
  'use strict';
  if(window.DuoMicProvenance)return;
  const physical=new WeakSet(),parents=new WeakMap(),destinations=new WeakMap();
  const sources=new WeakMap(),edges=new WeakMap();
  const stats={getUserMediaCalls:0,getUserMediaSuccesses:0,getUserMediaFailures:0,physicalTracks:0,trackClones:0,streamClones:0};
  let lastError='';
  const nodeInputs=node=>edges.get(node)||[];
  function walkNode(node,seen,seenTracks){
    if(seen.has(node))return {mic:false,unknown:true};
    const next=new Set(seen);next.add(node);
    const tracks=sources.get(node);
    if(tracks){const results=tracks.map(t=>inspect(t,new Set(seenTracks)));return {mic:results.some(r=>r.mic),unknown:!results.length||results.some(r=>!r.mic)};}
    const incoming=nodeInputs(node);
    if(!incoming.length)return {mic:false,unknown:true};
    const results=incoming.map(e=>walkNode(e.source,next,seenTracks));
    return {mic:results.some(r=>r.mic),unknown:results.some(r=>r.unknown)};
  }
  function inspect(track,seen=new Set()){
    if(!track||track.kind!=='audio')return {mic:false,reason:'not-audio'};
    if(seen.has(track))return {mic:false,reason:'cycle'};
    seen.add(track);
    if(physical.has(track))return {mic:true,reason:'get-user-media'};
    if(parents.has(track)){const r=inspect(parents.get(track),seen);return {mic:r.mic,reason:r.mic?'microphone-clone':r.reason};}
    const node=destinations.get(track);
    if(node){const r=walkNode(node,new Set(),seen);return {mic:r.mic&&!r.unknown,reason:r.mic&&!r.unknown?'microphone-web-audio':'unproven-web-audio'};}
    return {mic:false,reason:'unobserved-origin'};
  }
  const media=navigator.mediaDevices;
  if(media?.getUserMedia){const original=media.getUserMedia;media.getUserMedia=async function(...args){
    stats.getUserMediaCalls++;
    try{const stream=await original.apply(this,args);stats.getUserMediaSuccesses++;stream.getAudioTracks().forEach(t=>{physical.add(t);stats.physicalTracks++;});return stream;}
    catch(error){stats.getUserMediaFailures++;lastError=String(error.name||'Error');throw error;}
  };}
  const trackProto=window.MediaStreamTrack?.prototype;
  if(trackProto?.clone){const original=trackProto.clone;trackProto.clone=function(...args){const clone=original.apply(this,args);parents.set(clone,this);stats.trackClones++;return clone;};}
  const streamProto=window.MediaStream?.prototype;
  if(streamProto?.clone){const original=streamProto.clone;streamProto.clone=function(...args){const clone=original.apply(this,args);const before=this.getTracks(),after=clone.getTracks();after.forEach((t,i)=>{if(before[i]&&t.kind===before[i].kind)parents.set(t,before[i]);});stats.streamClones++;return clone;};}
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
  function source(node,stream){if(stream)sources.set(node,stream.getAudioTracks());return node;}
  function destination(node){node.stream?.getAudioTracks().forEach(t=>destinations.set(t,node));return node;}
  const ctxProto=window.AudioContext?.prototype;
  for(const [name,record] of [['createMediaStreamSource',(n,args)=>source(n,args[0])],['createMediaStreamDestination',n=>destination(n)],['createMediaStreamTrackSource',(n,args)=>{sources.set(n,[args[0]]);return n;}]]){
    if(ctxProto?.[name]){const original=ctxProto[name];ctxProto[name]=function(...args){return record(original.apply(this,args),args);};}
  }
  for(const [name,record] of [['MediaStreamAudioSourceNode',(n,args)=>source(n,args[1]?.mediaStream)],['MediaStreamAudioDestinationNode',n=>destination(n)],['MediaStreamTrackAudioSourceNode',(n,args)=>{sources.set(n,[args[1]?.mediaStreamTrack]);return n;}]]){
    const Native=window[name];if(Native)window[name]=new Proxy(Native,{construct(target,args,newTarget){return record(Reflect.construct(target,args,newTarget),args);}});
  }
  window.DuoMicProvenance={inspect,isMic:track=>inspect(track).mic,diagnostics:()=>({...stats,lastGetUserMediaError:lastError})};
})();
