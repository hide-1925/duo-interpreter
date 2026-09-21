(() => {
  'use strict';
  const previous=window.__duoHtmlSource;
  if(previous?.version==='1.4.6'){previous.refresh();return;}
  if(previous?.dispose)previous.dispose();
  if(!window.CFG||!Array.isArray(window.S?.entries)||!document.getElementById('feedA'))throw new Error('Duo HTML本体を確認できません');
  let revision=0,queued=false,disposed=false,reset=true,lastProfile='',lastRunning=null;
  const sent=new Map();
  const str=(v,n=4000)=>String(v??'').slice(0,n);
  const num=(v,f)=>Number.isFinite(Number(v))?Number(v):f;
  function snapshot(){
    if(disposed)return;
    const c=window.CFG,s=window.S,entries=[],removed=[],ids=new Set();
    for(const e of s.entries.slice(-200)){
      if(!e||!e.id||!(e.srcText||e.rtWindow&&e.dstText)||(e.interim&&!c.interimOn))continue;
      const row={id:str(e.id,80),seat:e.seat==='B'?'B':'A',srcText:str(e.srcText),dstText:str(e.dstText),
        srcLang:str(e.srcLang,20),dstLang:str(e.dstLang,20),time:str(e.time,30),interim:!!e.interim,
        translationSkipped:e.rtWindow?false:!!e.translationSkipped||c.provider==='none'};
      ids.add(row.id);const sig=JSON.stringify(row);
      if(sent.get(row.id)!==sig){entries.push(row);sent.set(row.id,sig);}
    }
    for(const id of sent.keys())if(!ids.has(id)){removed.push(id);sent.delete(id);}
    const profile={layout:c.ovCapLayout,width:num(c.ovCapWidth,28),freeWidth:num(c.ovCapFreeWidth,28),freeHeight:num(c.ovCapFreeHeight,55),
      sideHeight:num(c.ovCapSideHeight,80),bottomWidth:num(c.ovCapBottomWidth,80),bottomHeight:num(c.ovCapBottomHeight,42),x:num(c.ovCapX,68),y:num(c.ovCapY,18),
      items:num(c.ovCapItems,4),hold:num(c.ovCapHold,18),font:num(c.ovCapFont,26),line:num(c.ovCapLine,1.35),itemWidth:num(c.ovCapItemWidth,100),
      textA:c.ovCapTextA,textB:c.ovCapTextB,srcA:c.ovCapSrcA,srcB:c.ovCapSrcB,bg:c.ovCapBg,
      textOpacity:num(c.ovCapTextOpacity,92),bgOpacity:num(c.ovCapBgOpacity,35),shadow:!!c.ovCapShadow,outline:!!c.ovCapOutline,round:!!c.ovCapRound,showSrc:!!c.showSrc};
    const sig=JSON.stringify(profile),changed=sig!==lastProfile;
    if(!reset&&!entries.length&&!removed.length&&!changed&&lastRunning===!!s.running)return;
    lastProfile=sig;lastRunning=!!s.running;
    const payload={revision:++revision,reset,entries,removed,profile:changed||reset?profile:null,
      running:!!s.running,sourceBuild:str(window.APP_BUILD,100),sentAt:Date.now()};
    reset=false;
    window.dispatchEvent(new CustomEvent('duo-html-source-data',{detail:JSON.stringify(payload)}));
  }
  function schedule(){if(queued||disposed)return;queued=true;queueMicrotask(()=>{queued=false;snapshot();});}
  const observer=new MutationObserver(schedule);
  for(const id of ['feedA','feedB']){const feed=document.getElementById(id);if(feed)observer.observe(feed,{subtree:true,childList:true,characterData:true});}
  document.addEventListener('change',schedule);document.addEventListener('input',schedule);
  // Low frequency check covers programmatic configuration changes; speech DOM changes
  // use MutationObserver, so background timer throttling does not delay captions.
  const timer=setInterval(schedule,2000);
  function command(event){
    let data;try{data=JSON.parse(event.detail);}catch(_){return;}
    if(data.action==='caption-window-status'){
      if(typeof window.dlog==='function')window.dlog('extension','caption-window',data.status||{});
      return;
    }
    if(data.action==='font'){
      const value=Number(data.font);if(Number.isFinite(value)&&typeof window.setOverlayFont==='function')window.setOverlayFont(Math.max(12,Math.min(64,value)));
    }else if(data.action==='settings'){
      window.openDrawer?.(true);document.querySelector('.tabs button[data-tab="p4"]')?.click();
      document.getElementById('overlaySettingsMain')?.scrollIntoView({block:'start'});
    }else if(data.action==='refresh'){sent.clear();lastProfile='';reset=true;}
    else if(data.action==='dispose'){dispose();return;}
    schedule();
  }
  window.addEventListener('duo-html-source-command',command);
  function dispose(){disposed=true;observer.disconnect();clearInterval(timer);document.removeEventListener('change',schedule);document.removeEventListener('input',schedule);window.removeEventListener('duo-html-source-command',command);window.removeEventListener('pagehide',dispose);delete window.__duoHtmlSource;}
  window.addEventListener('pagehide',dispose,{once:true});
  window.__duoHtmlSource={version:'1.4.6',dispose,refresh(){sent.clear();lastProfile='';reset=true;schedule();}};
  schedule();
})();
