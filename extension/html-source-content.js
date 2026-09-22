(() => {
  'use strict';
  window.__duoHtmlContent?.dispose?.();
  let chain=Promise.resolve(),stopped=false;
  function command(data){window.dispatchEvent(new CustomEvent('duo-html-source-command',{detail:JSON.stringify(data)}));}
  function receive(event){
    if(stopped||typeof event.detail!=='string'||event.detail.length>4000000)return;
    let data;try{data=JSON.parse(event.detail);}catch(_){return;}
    chain=chain.then(async()=>{
      if(stopped)return;
      try{
        const reply=await chrome.runtime.sendMessage({type:'DUO_HTML_DATA',data});
        if(!reply?.ok){command({action:'dispose'});dispose();}
      }catch(_){command({action:'dispose'});dispose();}
    });
  }
  async function audioRequest(event){
    if(stopped)return;let data;try{data=JSON.parse(event.detail);}catch(_){return;}
    if(typeof data.id!=='string'||data.id.length>80)return;
    let reply;try{reply=await chrome.runtime.sendMessage({type:'DUO_HTML_AUDIO_CAPTURE'});}catch(_){reply={ok:false,error:'アドオンの音声接続が切れました'};}
    if(!stopped)window.dispatchEvent(new CustomEvent('duo-html-audio-reply',{detail:JSON.stringify({id:data.id,ok:!!reply?.ok,streamId:reply?.streamId,error:reply?.error})}));
  }
  /* 判断層の往復をバックグラウンドへ渡す。ページ（MAIN world）からは chrome.* が
     見えないので、ここが唯一の通り道になる。音声の要求と同じ形。 */
  async function turnRequest(event){
    if(stopped||typeof event.detail!=='string'||event.detail.length>1000000)return;
    let data;try{data=JSON.parse(event.detail);}catch(_){return;}
    if(typeof data.id!=='string'||data.id.length>80)return;
    let reply;
    try{reply=await chrome.runtime.sendMessage({type:'DUO_TURN_FETCH',request:data.request});}
    catch(_){reply={ok:false,unreachable:true,error:'アドオンとの接続が切れました'};}
    if(stopped)return;
    turnEmit('duo-turn-reply',{id:data.id,ok:!!reply?.ok,status:reply?.status,
      text:reply?.text,error:reply?.error,unreachable:!!reply?.unreachable,
      needsSetup:!!reply?.needsSetup});
  }
  function turnEmit(name,payload){
    window.dispatchEvent(new CustomEvent(name,{detail:JSON.stringify(payload)}));
  }
  function turnHello(){if(!stopped)turnEmit('duo-turn-bridge',{ready:true});}
  function conferenceOut(event){
    let data;try{data=JSON.parse(event.detail);}catch(_){return;}
    chrome.runtime.sendMessage({type:'DUO_CONFERENCE_SIGNAL',data}).then(r=>{if(!r?.ok)conferenceIn({kind:'stop'});}).catch(()=>conferenceIn({kind:'stop'}));
  }
  function conferenceIn(data){window.dispatchEvent(new CustomEvent('duo-conference-in',{detail:JSON.stringify(data)}));}
  window.addEventListener('duo-conference-out',conferenceOut);
  window.addEventListener('duo-turn-request',turnRequest);
  window.addEventListener('duo-turn-hello',turnHello);
  function message(m,_sender,respond){
    if(m.type==='DUO_TEAMS_SPEAKERS'){window.dispatchEvent(new CustomEvent('duo-speakers-in',{detail:JSON.stringify(m.data)}));respond({ok:true});return;}
    if(m.type==='DUO_CONFERENCE_HTML'){conferenceIn(m.data);respond({ok:true});return;}

    if(m.type==='DUO_HTML_AUDIO_STOP'){window.dispatchEvent(new CustomEvent('duo-html-audio-control',{detail:'stop'}));respond({ok:true});return;}
    if(m.type==='DUO_HTML_COMMAND'){command(m.command||{});if(m.command?.action==='dispose')dispose();respond({ok:true});}
    if(m.type==='DUO_HTML_PING')respond({ok:true,version:'1.1.0'});
  }
  function dispose(){stopped=true;turnEmit('duo-turn-bridge',{ready:false});window.removeEventListener('duo-turn-request',turnRequest);window.removeEventListener('duo-turn-hello',turnHello);conferenceIn({kind:'stop'});window.removeEventListener('duo-conference-out',conferenceOut);window.removeEventListener('duo-html-audio-request',audioRequest);window.dispatchEvent(new CustomEvent('duo-html-audio-control',{detail:'dispose'}));window.removeEventListener('duo-html-source-data',receive);try{chrome.runtime.onMessage.removeListener(message);}catch(_){} }
  window.addEventListener('duo-html-source-data',receive);
  window.addEventListener('duo-html-audio-request',audioRequest);
  chrome.runtime.onMessage.addListener(message);
  /* ページ側が先に読み込まれているのが普通なので、張った時点からこちらで名乗る。 */
  turnHello();
  window.__duoHtmlContent={dispose};
})();
