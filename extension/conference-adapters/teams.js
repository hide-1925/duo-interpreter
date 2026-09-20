/* Teams-specific sender discovery and restoration. Loaded before Teams scripts. */
(() => {
  'use strict';
  if(window.DuoTeamsAdapter)return;
  const NativePC=window.RTCPeerConnection, senderProto=window.RTCRtpSender?.prototype;
  if(!NativePC||!senderProto)return;
  const nativeReplace=senderProto.replaceTrack,peers=new Set(),records=new Map(),clones=new WeakMap(),internalPeers=new WeakSet();
  const provenance=window.DuoMicProvenance;if(!provenance)return;const isMic=track=>provenance.isMic(track);
  const enabledDescriptor=Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype,'enabled');
  let activeTrack=null,report=()=>{},epoch=0,mode='tts-only',micLevel=.7,ttsLevel=1;
  function disposeMix(m){if(!m)return;m.sources.forEach(s=>s.disconnect());m.destination.stream.getTracks().forEach(t=>t.stop());m.ctx.close().catch(()=>{});}
  async function output(r){
    if(mode==='original-only')return {track:r.original,mix:null};
    if(mode==='tts-only')return {track:activeTrack.clone(),mix:null};
    const ctx=new AudioContext(),destination=ctx.createMediaStreamDestination(),limiter=ctx.createDynamicsCompressor();
    limiter.threshold.value=-3;limiter.knee.value=0;limiter.ratio.value=20;limiter.attack.value=.003;limiter.release.value=.1;limiter.connect(destination);
    const mic=ctx.createGain(),tts=ctx.createGain();mic.gain.value=micLevel;tts.gain.value=ttsLevel;mic.connect(limiter);tts.connect(limiter);
    const a=ctx.createMediaStreamSource(new MediaStream([r.original])),b=ctx.createMediaStreamSource(new MediaStream([activeTrack]));a.connect(mic);b.connect(tts);
    const mix={ctx,destination,mic,tts,sources:[a,b]};await ctx.resume();if(ctx.state!=='running'){disposeMix(mix);throw Error('Teamsタブで音声を許可してから再接続してください');}
    return {track:destination.stream.getAudioTracks()[0],mix};
  }
  function log(result,r,error){report({kind:'diagnostic',conferenceAdapter:'teams',replaceTrackResult:result,originalMicTrackId:r?.original?.id||null,conferenceMicTrackId:r?.replacement?.id||null,error:error?String(error.message||error):''});}
  function enqueue(r,fn){const task=r.chain.then(fn);r.chain=task.catch(()=>{});return task;}
  function discover(sender){
    if(!sender?.track||sender.track.kind!=='audio'||!isMic(sender.track))return null;
    let r=records.get(sender);if(!r){r={sender,original:sender.track,replacement:null,chain:Promise.resolve(),desiredVersion:0};records.set(sender,r);}
    return r;
  }
  function syncMute(r){if(r.replacement){const on=!!(r.original&&r.original.readyState==='live'&&r.original.enabled&&!r.original.muted);enabledDescriptor.set.call(r.replacement,on);}}
  // Teams can mute by changing track.enabled without replacing the sender.
  if(enabledDescriptor?.configurable)Object.defineProperty(MediaStreamTrack.prototype,'enabled',{
    ...enabledDescriptor,set(value){enabledDescriptor.set.call(this,value);const owner=clones.get(this);if(owner?.original)enabledDescriptor.set.call(owner.original,!!value);
      for(const r of records.values())if(r.original===this||r.replacement===this)syncMute(r);}
  });
  async function apply(r){
    if(!activeTrack||!r.original||r.original.readyState!=='live'||!isMic(r.original))return;
    const version=++r.desiredVersion,requestEpoch=epoch;
    return enqueue(r,async()=>{
      if(version!==r.desiredVersion||requestEpoch!==epoch||!activeTrack)return;
      const result=await output(r),clone=result.track;
      if(version!==r.desiredVersion||requestEpoch!==epoch||!activeTrack){if(clone!==r.original)clone.stop();disposeMix(result.mix);return;}
      if(clone!==r.original)clones.set(clone,r);const previous=r.replacement,oldMix=r.mix;r.replacement=clone===r.original?null:clone;r.mix=result.mix;syncMute(r);
      try{await nativeReplace.call(r.sender,clone);if(previous)previous.stop();disposeMix(oldMix);log('replaced',r);report({kind:'diagnostic',event:'conference-route-'+mode,conferenceAdapter:'teams',at:Date.now()});}
      catch(error){if(clone!==r.original)clone.stop();disposeMix(result.mix);r.replacement=previous;r.mix=oldMix;log('failed',r,error);throw error;}
    });
  }
  senderProto.replaceTrack=function(track){
    let r=records.get(this);
    if(!r&&track?.kind==='audio'&&isMic(track)){r={sender:this,original:track,replacement:null,chain:Promise.resolve(),desiredVersion:0};records.set(this,r);}
    if(!r)return nativeReplace.call(this,track);
    r.original=track;
    if(!activeTrack||!track||track.kind!=='audio'||!isMic(track)){
      ++r.desiredVersion;
      return enqueue(r,async()=>{await nativeReplace.call(r.sender,track);if(r.replacement){r.replacement.stop();r.replacement=null;}disposeMix(r.mix);r.mix=null;log('host-track',r);});
    }
    return apply(r);
  };
  function capture(pc){if(internalPeers.has(pc)||peers.has(pc))return;if(activeTrack)fail(Error('Teamsが再接続しました。会議マイク送出をもう一度選択してください'));peers.add(pc);
    pc.addEventListener('connectionstatechange',()=>{if(activeTrack&&['closed','failed','disconnected'].includes(pc.connectionState))fail(Error('Teamsの接続が切れました。再接続後に会議マイク送出を選択してください'));if(pc.connectionState==='closed'){peers.delete(pc);for(const s of pc.getSenders()){const r=records.get(s);if(r?.replacement)r.replacement.stop();records.delete(s);}}});
  }
  for(const name of ['addTrack','addTransceiver','getSenders']){
    const native=NativePC.prototype[name];if(!native)continue;
    NativePC.prototype[name]=function(...args){capture(this);const result=native.apply(this,args);
      if(name!=='getSenders'&&!internalPeers.has(this)){const r=discover(name==='addTrack'?result:result.sender);if(r&&activeTrack)apply(r).catch(fail);}return result;};
  }
  function snapshot(){const senders=[];
    for(const pc of peers){if(pc.connectionState==='closed')continue;for(const sender of pc.getSenders()){
      const track=records.get(sender)?.original||sender.track;
      senders.push({kind:track?.kind||null,readyState:track?.readyState||null,enabled:track?.enabled??null,...provenance.inspect(track),connectionState:pc.connectionState});
    }}
    return {adapterVersion:'1.4.1',peerCount:[...peers].filter(p=>p.connectionState!=='closed').length,audioSenderCount:senders.filter(s=>s.kind==='audio').length,eligibleCount:senders.filter(s=>s.mic&&s.readyState==='live').length,senders,...provenance.diagnostics()};
  }
  window.RTCPeerConnection=new Proxy(NativePC,{construct(target,args,newTarget){const pc=Reflect.construct(target,args,newTarget);capture(pc);return pc;}});
  function fail(error){report({kind:'error',error:String(error.message||error)});stop().catch(()=>{});}
  async function stop(){activeTrack=null;++epoch;const tasks=[];
    for(const r of records.values()){++r.desiredVersion;if(r.replacement)enabledDescriptor.set.call(r.replacement,false);
      tasks.push(enqueue(r,async()=>{if(!r.replacement)return;const clone=r.replacement;
        try{await nativeReplace.call(r.sender,r.original?.readyState==='live'?r.original:null);r.replacement=null;log('restored',r);}
        catch(error){log('restore-failed',r,error);throw error;}finally{clone.stop();disposeMix(r.mix);r.mix=null;}
      }));}
    const results=await Promise.allSettled(tasks);if(results.some(x=>x.status==='rejected'))throw Error('元マイクの復帰に失敗しました。Teamsのマイクを選び直してください');
  }
  const timer=setInterval(()=>{for(const r of records.values()){syncMute(r);if(activeTrack&&r.replacement&&(r.original?.readyState==='ended'||!isMic(r.original)))fail(Error('元のマイクが終了、または音声の経路が変更されました'));}},100);
  window.DuoTeamsAdapter={NativePC,createRelayPeer(config){const pc=new NativePC(config);internalPeers.add(pc);return pc;},
    async start(track,callback){await stop();mode='tts-only';report=callback;activeTrack=track;++epoch;
      for(const pc of peers)for(const sender of pc.getSenders())discover(sender);
      report({kind:'diagnostic',event:'microphone-discovery',...snapshot()});
      const eligible=[...records.values()].filter(r=>r.original?.readyState==='live'&&isMic(r.original));
      if(!eligible.length){activeTrack=null;const d=snapshot();throw Error(!d.peerCount?'Teamsの会議接続を検出できません。Teamsタブを再読み込みして会議へ参加してください':!d.audioSenderCount?'Teamsの送信音声がありません。Teamsでマイクを選択してください':'Teamsの送信音声をマイク由来と確認できません（診断JSONに検出結果を記録しました）');}
      try{await Promise.all(eligible.map(apply));}catch(error){await stop().catch(()=>{});throw error;}
    },
    async setMode(next,levels={}){if(!activeTrack||!['tts-only','original-plus-tts','original-only'].includes(next))throw Error('会議音声モードが無効です');mode=next;this.setGains(levels);await Promise.all([...records.values()].filter(r=>r.original?.readyState==='live'&&isMic(r.original)).map(apply));return mode;},
    setGains(levels){if(Number.isFinite(levels.micGain))micLevel=Math.max(0,Math.min(1,levels.micGain));if(Number.isFinite(levels.ttsGain))ttsLevel=Math.max(0,Math.min(1,levels.ttsGain));for(const r of records.values())if(r.mix){r.mix.mic.gain.value=micLevel;r.mix.tts.gain.value=ttsLevel;}},
    stop,discovery:snapshot,diagnostics:()=>[...records.values()].map(r=>({originalMicTrackId:r.original?.id,conferenceMicTrackId:r.replacement?.id,mode}))};
  addEventListener('pagehide',()=>{clearInterval(timer);stop().catch(()=>{});},{once:true});
})();
