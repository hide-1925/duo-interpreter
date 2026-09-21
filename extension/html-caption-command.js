'use strict';
// Serializable MAIN-world command. Both extension buttons call the same HTML
// function used by the native settings button; no second PiP renderer is created.
async function commandHtmlCaptionWindow(expectedUrl, action) {
  const here=new URL(location.href),expected=new URL(expectedUrl);here.hash='';expected.hash='';
  if(here.href!==expected.href||!window.CFG||!Array.isArray(window.S?.entries)||!document.getElementById('feedA'))
    return {ok:false,phase:'error',error:'登録したDuo HTML本体と異なるページです',route:'html-main'};
  const supported=typeof window.openCaptionPip==='function'&&!!window.documentPictureInPicture?.requestWindow;
  const snapshot=()=>{
    const pip=window.captionPip,w=pip?.win,open=!!(w&&!w.closed);
    return {build:'1.2.4',route:'html-main',phase:open?'open':pip?.opening?'opening':'closed',open,supported,
      width:open?Number(w.innerWidth)||0:0,height:open?Number(w.innerHeight)||0:0,
      captions:open?Number(pip.nodes?.size)||0:0,sourceCaptions:window.S.entries.length,
      textOpacity:String((Number.isFinite(Number(window.CFG.ovCapTextOpacity))?Math.max(0,Math.min(100,Number(window.CFG.ovCapTextOpacity))):92)/100),updatedAt:Date.now(),error:''};
  };
  if(action==='status')return {ok:true,...snapshot()};
  if(!supported)return {ok:false,...snapshot(),phase:'error',error:'HTML本体の字幕小窓に対応していません。小窓ボタンのあるHTML版を開いてください'};
  if(action==='guide'){
    window.openDrawer?.(true);document.querySelector('.tabs button[data-tab="p4"]')?.click();
    const button=document.getElementById('captionPipOpen');
    button?.scrollIntoView({block:'center'});button?.focus();
    window.toast?.('設定の「字幕を小窓に表示」を押してください');
    return {ok:true,...snapshot(),phase:'awaiting-click'};
  }
  if(action!=='open')return {ok:false,error:'不明な小窓操作です',route:'html-main'};
  const gesture=!!navigator.userActivation?.isActive;
  window.dlog?.('extension','html-pip-request',{route:'html-main',gesture});
  try {
    // Call before any await; the popup invokes executeScript directly in its
    // click handler. If the browser rejects activation, guide to the real button.
    await window.openCaptionPip();
    const status=snapshot();
    window.dlog?.('extension','html-pip-result',{...status,gesture});
    if(!status.open)return {ok:false,...status,phase:'error',error:'HTML本体の小窓を開けませんでした。設定ボタンからの起動へ切り替えます',gesture};
    return {ok:true,...status,gesture};
  }catch(error){return {ok:false,...snapshot(),phase:'error',error:String(error.message||error),gesture};}
}
