(() => {
  'use strict';
  if(window.__duoConferenceTarget)return;window.__duoConferenceTarget=true;
  let pc=null,token='',lease=0,generation=0,receiverAudio=null;
  function emit(data){window.dispatchEvent(new CustomEvent('duo-conference-target-out',{detail:JSON.stringify({...data,token:data.token||token})}));}
  async function stop(reason){const old=token;token='';generation++;clearTimeout(lease);if(pc){pc.close();pc=null;}if(receiverAudio){receiverAudio.pause();receiverAudio.srcObject=null;receiverAudio=null;}
    try{await window.DuoTeamsAdapter?.stop();}catch(error){emit({kind:'diagnostic',token:old,replaceTrackResult:'restore-failed',error:error.message});}
    if(old)emit({kind:'stopped',token:old,reason});}
  function renew(){clearTimeout(lease);lease=setTimeout(()=>stop('relay-timeout'),12000);}
  async function command(data){
    if(data.kind==='stop'){await stop('user-or-relay');return;}
    if(data.kind==='lease'&&data.token===token){renew();return;}
    if(data.token===token&&token&&data.kind==='mode'){const mode=await window.DuoTeamsAdapter.setMode(data.mode,data);emit({kind:'mode-applied',mode});return;}
    if(data.token===token&&token&&data.kind==='gain'){window.DuoTeamsAdapter.setGains(data);return;}
    if(data.kind!=='offer')return;
    await stop('new-offer');token=data.token;const gen=++generation;renew();
    const offerAt=Date.now();emit({kind:'diagnostic',event:'conference-offer-received',at:offerAt});
    const adapter=window.DuoTeamsAdapter;if(!adapter)throw Error('この会議サービスはまだ音声送出に対応していません');
    const peer=adapter.createRelayPeer({iceServers:[]});pc=peer;
    peer.ontrack=async event=>{if(gen!==generation)return;try{
      event.track.addEventListener('ended',()=>{if(gen===generation)stop('track-ended');},{once:true});
      // Keep Chromium's remote audio decoder consuming the stream. This sink is
      // muted: only the conference sender receives the decoded track.
      const audio=new Audio();audio.muted=true;audio.srcObject=new MediaStream([event.track]);receiverAudio=audio;await audio.play();
      if(gen!==generation){audio.pause();audio.srcObject=null;return;}
      await adapter.start(event.track,emit);if(gen!==generation){await adapter.stop();return;}
      emit({kind:'active'});
    }catch(error){emit({kind:'error',error:error.message});await stop('adapter-error');}};
    peer.onconnectionstatechange=()=>{if(peer!==pc)return;
      emit({kind:'diagnostic',event:'conference-bridge-state',state:peer.connectionState,sinceOfferMs:Date.now()-offerAt});
      if(['failed','disconnected','closed'].includes(peer.connectionState))stop('transport-'+peer.connectionState);};
    await peer.setRemoteDescription(data.description);if(gen!==generation)return;
    await peer.setLocalDescription(await peer.createAnswer());
    // Both peers live in this browser, so one host candidate is already enough to
    // answer with. Waiting for gathering to COMPLETE waits on mDNS registration
    // for every interface, and the caller's connection deadline has to cover this
    // wait plus its own gathering: two full gathering phases overran a 15s budget
    // and the handshake timed out with no error from either side.
    const gatherStart=Date.now();let candidates=0;
    await new Promise((resolve,reject)=>{
      if(peer.iceGatheringState==='complete')return resolve();
      let settle=0;
      const cleanup=()=>{clearTimeout(timeout);clearTimeout(settle);peer.removeEventListener('icegatheringstatechange',done);peer.removeEventListener('icecandidate',candidate);};
      const timeout=setTimeout(()=>{cleanup();reject(Error('ICE収集がタイムアウトしました'));},8000);
      function done(){if(peer.iceGatheringState==='complete'){cleanup();resolve();}}
      function candidate(event){if(!event.candidate)return;candidates++;if(!settle)settle=setTimeout(()=>{cleanup();resolve();},250);}
      peer.addEventListener('icegatheringstatechange',done);peer.addEventListener('icecandidate',candidate);
    });
    if(gen!==generation)return;
    emit({kind:'diagnostic',event:'conference-answer-sent',gatheringMs:Date.now()-gatherStart,sinceOfferMs:Date.now()-offerAt,candidates,iceGatheringState:peer.iceGatheringState,at:Date.now()});
    emit({kind:'answer',description:peer.localDescription.toJSON()});
  }
  addEventListener('duo-conference-target-in',event=>{let data;try{data=JSON.parse(event.detail);}catch(_){return;}command(data).catch(error=>{emit({kind:'error',error:error.message});stop('error');});});
  addEventListener('pagehide',()=>stop('pagehide'),{once:true});
})();
