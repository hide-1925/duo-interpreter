/* Fullscreen support stays in the isolated extension world. No player methods are replaced. */
(() => {
  'use strict';
  globalThis.DuoOverlayFullscreen = function(root, canvas, onResize) {
    let shell=null,disposed=false,lastSent=null,serial=0,error='',resizeTimer=null;
    let mountedElement, mountedVisible;
    let fallback=false,styledRoot=null,ownedSheet=null;const history=[];
    const isTop=typeof window==='undefined'||window===window.top;
    const element=()=>{
      let fs=document.fullscreenElement||document.webkitFullscreenElement||null;
      for(let i=0;i<16&&fs;i++){
        let shadow=fs.shadowRoot;
        try{shadow=shadow||chrome.dom?.openOrClosedShadowRoot(fs);}catch(_){}
        if(!shadow?.fullscreenElement)break;fs=shadow.fullscreenElement;
      }
      return fs;
    };
    function styleFullscreenRoot(fs){
      const target=fs?.getRootNode?.(),shadow=target?.host?target:null;
      if(shadow===styledRoot)return;
      if(styledRoot&&ownedSheet)styledRoot.adoptedStyleSheets=styledRoot.adoptedStyleSheets.filter(s=>s!==ownedSheet);
      styledRoot=null;ownedSheet=null;
      if(shadow&&typeof CSSStyleSheet!=='undefined'&&globalThis.DuoOverlayCssText){
        const sheet=new CSSStyleSheet();sheet.replaceSync(globalThis.DuoOverlayCssText);
        shadow.adoptedStyleSheets=[...shadow.adoptedStyleSheets,sheet];styledRoot=shadow;ownedSheet=sheet;
      }
    }
    const eligible=()=>{const fs=element();return fs?!/^(IFRAME|FRAME)$/.test(fs.tagName):isTop;};
    const visible=()=>!root.classList.contains('duo-hidden')&&eligible();
    function dimensions(){
      const rect=node=>{
        const r=node?.getBoundingClientRect?.();
        return r?{left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}:null;
      };
      const fs=element(),scope=fs||document;
      const candidates=fs?.tagName==='VIDEO'?[fs]:Array.from(scope.querySelectorAll?.('video')||[]);
      const videos=candidates.map(v=>({rect:rect(v),intrinsic:{width:v.videoWidth||0,height:v.videoHeight||0}}))
        .filter(v=>v.rect?.width>0&&v.rect?.height>0).sort((a,b)=>b.rect.width*b.rect.height-a.rect.width*a.rect.height).slice(0,4);
      return {viewport:{width:window.innerWidth||0,height:window.innerHeight||0},
        screen:{width:window.screen?.width||0,height:window.screen?.height||0},devicePixelRatio:window.devicePixelRatio||1,
        fullscreen:rect(fs),videos};
    }
    function remember(reason){history.push({at:Date.now(),reason,active:!!element(),element:element()?.tagName||null,visible:visible(),fallback,error,dimensions:dimensions()});if(history.length>30)history.shift();}
    function closeShell(){
      if(!shell)return;
      try{if(shell.matches(':popover-open'))shell.hidePopover();}catch(_){}
      shell.remove();shell=null;
    }
    function mount(){
      const fs=element();
      fallback=false;error='';
      root.classList.toggle('duo-frame-inactive',!eligible());canvas.classList.toggle('duo-frame-inactive',!eligible());
      styleFullscreenRoot(visible()?fs:null);
      if(!fs||!visible()){
        for(const node of [canvas,root])if(node.parentNode!==document.documentElement)document.documentElement.appendChild(node);
        closeShell();return;
      }
      if(typeof HTMLElement.prototype.showPopover==='function'){
        if(!shell){shell=document.createElement('div');shell.id='duo-fullscreen-layer';shell.setAttribute('popover','manual');}
        // Top-layer paint order alone does not remove Chromium fullscreen
        // inertness. Keep the controls inside the active fullscreen subtree.
        if(shell.parentNode!==fs){
          try{if(shell.matches(':popover-open'))shell.hidePopover();}catch(_){}
          fs.appendChild(shell);
        }
        for(const node of [canvas,root])if(node.parentNode!==shell)shell.appendChild(node);
        try{
          if(!shell.matches(':popover-open'))shell.showPopover();
          // Native video elements may not lay out their light-DOM children.
          // Keep captions visible via a sibling popover in that case; do not
          // replace the site's fullscreen target or steal its F/Esc shortcut.
          if(/^(VIDEO|EMBED|OBJECT)$/.test(fs.tagName)&&root.getClientRects&&root.getClientRects().length===0){
            shell.hidePopover();document.documentElement.appendChild(shell);shell.showPopover();fallback=true;
            error='動画本体の全画面では字幕表示を優先しています。字幕の位置調整は全画面を解除して行ってください。';
          }
          return;
        }catch(e){error=String(e.message||e);}
      }
      // Older engines can render children of a player container, but not of video/iframe.
      const parent=/^(VIDEO|IFRAME|EMBED|OBJECT)$/.test(fs.tagName)?document.documentElement:fs;
      for(const node of [canvas,root])if(node.parentNode!==parent)parent.appendChild(node);
      closeShell();
      if(parent===document.documentElement&&fs!==parent)error='このブラウザでは動画要素への全画面字幕を表示できません。ブラウザを更新してください。';
    }
    function notify(){
      const active=!!element(),signature=JSON.stringify([active,element()?.tagName||null,visible(),fallback]);
      if(signature===lastSent)return;
      lastSent=signature;const revision=++serial;
      chrome.runtime.sendMessage({type:'DUO_FULLSCREEN_CHANGED',active}).then(r=>{
        if(disposed||revision!==serial)return;
        if(!r?.ok){error=r?.error||'全画面の切り替えを確認できません';lastSent=null;}
        else if(!fallback)error='';
      }).catch(e=>{if(!disposed&&revision===serial){error=String(e.message||e);lastSent=null;}});
    }
    function sync(){
      if(disposed)return;
      const fs=element(),shown=visible();
      // Subtitle messages are frequent. Do not remount or reset geometry/canvas
      // on each text update while a pointer capture/drag is in progress.
      const lostLayer=fs&&shown&&shell&&(!shell.isConnected||!shell.matches(':popover-open'));
      if(fs!==mountedElement||shown!==mountedVisible||lostLayer){
        mount();mountedElement=fs;mountedVisible=shown;onResize();remember('layout');
      }
      notify();
    }
    function resized(){
      clearTimeout(resizeTimer);
      resizeTimer=setTimeout(()=>{if(!disposed)remember('viewport-settled');},650);
    }
    function changed(){remember('before-mount');sync();resized();}
    function dispose(){disposed=true;clearTimeout(resizeTimer);document.removeEventListener('fullscreenchange',changed);document.removeEventListener('webkitfullscreenchange',changed);window.removeEventListener?.('resize',resized);}
    document.addEventListener('fullscreenchange',changed);
    document.addEventListener('webkitfullscreenchange',changed);
    window.addEventListener?.('resize',resized,{passive:true});
    addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
    return {sync,snapshot(){return {active:!!element(),element:element()?.tagName||null,isTop,
      layer:!eligible()?'delegated-frame':shell?.matches(':popover-open')?fallback?'top-layer-fallback':'top-layer':element()?'container':'page',visible:visible(),error,dimensions:dimensions(),history:[...history]};}};
  };
})();
