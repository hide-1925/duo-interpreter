'use strict';
// Runs in the registered HTML's MAIN world. Audio is consumed there, so the
// existing STT engines and their stop/session guards remain the owners.
function configureHtmlTabAudio(expectedUrl, enabled) {
  const here=new URL(location.href);here.hash='';
  if(here.href!==expectedUrl||typeof window.getDisplayAudioForStt!=='function')throw Error('登録したHTML本体ではありません');
  if(enabled&&window.__duoTabAudio?.isActive?.())return {ok:true,enabled:true};
  if(!enabled&&window.S?.running)throw Error('HTML本体で認識を停止してから音声経路を変更してください');
  window.__duoTabAudio?.dispose();
  if(!enabled)return {ok:true,enabled:false};
  const original=window.getDisplayAudioForStt,pending=new Map(),live=new Set();
  let disposed=false,serial=0,epoch=0;
  function reply(event){
    let r;try{r=JSON.parse(event.detail);}catch(_){return;}
    const job=pending.get(r.id);if(!job)return;
    pending.delete(r.id);clearTimeout(job.timer);r.ok?job.resolve(r.streamId):job.reject(Error(r.error||'タブ音声を取得できません'));
  }
  function stop(){
    epoch++;
    for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error('タブ音声の取得を取り消しました'));}pending.clear();
    for(const close of [...live])close();
  }
  function control(event){if(event.detail==='stop')stop();if(event.detail==='dispose')dispose();}
  function dispose(){
    if(disposed)return;disposed=true;stop();
    window.removeEventListener('duo-html-audio-reply',reply);window.removeEventListener('duo-html-audio-control',control);window.removeEventListener('pagehide',dispose);
    if(window.getDisplayAudioForStt===acquire)window.getDisplayAudioForStt=original;
  }
  async function acquire(){
    if(disposed)throw Error('アドオンの音声接続を設定し直してください');
    if(window.overlaySession?.activeAudioTrack())throw Error('HTMLの画面共有を停止してから、アドオンの音声取得を開始してください');
    const generation=window.sessionGen,requestEpoch=epoch,id=Date.now()+'-'+(++serial);
    const streamId=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('タブ音声取得がタイムアウトしました。動画タブでアドオンを開き直してください'));},10000);
      pending.set(id,{resolve,reject,timer});
      window.dispatchEvent(new CustomEvent('duo-html-audio-request',{detail:JSON.stringify({id})}));
    });
    if(disposed||epoch!==requestEpoch||window.sessionGen!==generation)throw Error('認識が停止・再開されたため音声取得を中止しました');
    const stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:streamId}}});
    let context=null,timer=null,closed=false;
    function close(){if(closed)return;closed=true;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());if(context)context.close().catch(()=>{});live.delete(close);}
    live.add(close);
    try{
      const track=stream.getAudioTracks()[0];
      if(disposed||epoch!==requestEpoch||window.sessionGen!==generation||!track||track.readyState!=='live')throw Error('認識停止、または対象タブの音声を取得できませんでした');
      // tabCapture mutes the source tab. Restore exactly one local monitor.
      context=new AudioContext();
      const monitorGain=context.createGain();monitorGain.gain.value=0;
      context.createMediaStreamSource(stream).connect(monitorGain);monitorGain.connect(context.destination);await context.resume();
      if(context.state!=='running')throw Error('元動画の音声を再生できません。HTML本体をクリックしてから再開してください');
      if(disposed||closed||epoch!==requestEpoch||window.sessionGen!==generation||track.readyState!=='live')throw Error('認識停止により音声取得を中止しました');
      monitorGain.gain.setValueAtTime(0,context.currentTime);monitorGain.gain.linearRampToValueAtTime(1,context.currentTime+.05);
      track.addEventListener('ended',close,{once:true});
      // Track.stop() does not emit ended; release the monitor after engine stop.
      timer=setInterval(()=>{if(track.readyState!=='live')close();},250);
      window.dlog?.('audio','addon-tab-audio',{videoTracks:stream.getVideoTracks().length,monitor:context.state,monitorFadeInMs:50});
      return {track,stream,ownsStream:true,fromOverlay:false};
    }catch(error){close();throw error;}
  }
  window.addEventListener('duo-html-audio-reply',reply);window.addEventListener('duo-html-audio-control',control);window.addEventListener('pagehide',dispose);
  window.getDisplayAudioForStt=acquire;window.__duoTabAudio={dispose,isActive:()=>!disposed&&window.getDisplayAudioForStt===acquire};
  return {ok:true,enabled:true};
}
async function setHtmlTabAudio(enabled){
  const state=await getState();if(!state.htmlTabId||!state.targetTabId)throw Error('先に字幕対象とHTML本体を接続してください');
  const url=await getHtmlSourceUrl();
  const result=await chrome.scripting.executeScript({target:{tabId:state.htmlTabId,...(state.htmlDocumentId?{documentIds:[state.htmlDocumentId]}:{})},world:'MAIN',func:configureHtmlTabAudio,args:[url,enabled]});
  if(!result[0]?.result?.ok)throw Error('HTMLの音声経路を設定できません');
  await setState({htmlTabAudio:!!enabled});return {ok:true};
}
async function getHtmlTabAudioId(sender){
  const state=await getState(),url=await getHtmlSourceUrl();
  if(!state.htmlTabAudio||!state.targetTabId||sender.tab?.id!==state.htmlTabId||sender.frameId!==0||sender.documentId!==state.htmlDocumentId||canonicalHtmlUrl(sender.url||'')!==url)throw Error('登録したHTML本体からの音声要求ではありません');
  if(state.targetTabId===state.htmlTabId)throw Error('HTML本体自身の音声は取得できません');
  const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:state.targetTabId,consumerTabId:state.htmlTabId});
  const latest=await getState();
  if(!latest.htmlTabAudio||latest.targetTabId!==state.targetTabId||latest.htmlDocumentId!==state.htmlDocumentId)throw Error('音声の接続先が変更されました');
  return {ok:true,streamId};
}
