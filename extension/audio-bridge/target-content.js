(() => {
  'use strict';
  if(window.__duoConferenceRelay)return;window.__duoConferenceRelay=true;
  let token='',lastToken='',timer=null;
  function dispatch(data){window.dispatchEvent(new CustomEvent('duo-conference-target-in',{detail:JSON.stringify(data)}));}
  function stop(){lastToken=token||lastToken;token='';clearInterval(timer);dispatch({kind:'stop'});}
  chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.type!=='DUO_CONFERENCE_TARGET')return;
    if(m.data.kind==='offer'){token=m.data.token;clearInterval(timer);timer=setInterval(async()=>{try{const r=await chrome.runtime.sendMessage({type:'DUO_CONFERENCE_LEASE',token});if(r?.ok)dispatch({kind:'lease',token});else stop();}catch(_){stop();}},4000);}
    if(m.data.kind==='stop'){lastToken=token||lastToken;token='';clearInterval(timer);}dispatch(m.data);reply({ok:true});
  });
  addEventListener('duo-conference-target-out',async e=>{let data;try{data=JSON.parse(e.detail);}catch(_){return;}
    if(data.token!==token&&!(data.kind==='diagnostic'&&data.token===lastToken))return;if(!data.token)return;try{const r=await chrome.runtime.sendMessage({type:'DUO_CONFERENCE_SIGNAL',data});if(!r?.ok)stop();}catch(_){stop();}
  });
  addEventListener('pagehide',stop,{once:true});
})();
