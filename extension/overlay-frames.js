'use strict';
// Inject only into the selected tab and origins Chrome already permits.
// Cross-origin permission is requested by the combined target-selection button.
const overlayFrameCache=new Map(), overlayFrameQueues=new Map();
function frameOrigin(url){try{const u=new URL(url);return ['https:','blob:'].includes(u.protocol)&&u.origin.startsWith('https://')?u.origin:null;}catch(_){return null;}}
function frameError(error){return String(error.message||error).replace(/https?:\/\/[^\s'"<>]+/g,url=>{try{return new URL(url).origin+'/…';}catch(_){return '[URL]';}});}
function queueOverlayFrames(tabId,task){
  const next=(overlayFrameQueues.get(tabId)||Promise.resolve()).then(task);
  overlayFrameQueues.set(tabId,next.catch(()=>{}));return next;
}
async function inspectOverlayFrames(tabId){
  const tab=await chrome.tabs.get(tabId),topOrigin=frameOrigin(tab.url);
  const frames=chrome.webNavigation?.getAllFrames?await chrome.webNavigation.getAllFrames({tabId}):[{frameId:0,parentFrameId:-1,url:tab.url}];
  const rows=[];
  function originFor(frame,seen=new Set()){
    if(!frame||seen.has(frame.frameId))return null;seen.add(frame.frameId);
    return frameOrigin(frame.url)||(/^about:(blank|srcdoc)(?:[?#]|$)/.test(frame.url||'')?originFor(frames.find(f=>f.frameId===frame.parentFrameId),seen):null);
  }
  for(const frame of frames||[]){
    if(frame.errorOccurred||frame.documentLifecycle&&frame.documentLifecycle!=='active')continue;
    const origin=originFor(frame);
    const allowed=frame.frameId===0||!!origin&&(origin===topOrigin||await chrome.permissions.contains({origins:[origin+'/*']}));
    rows.push({frameId:frame.frameId,parentFrameId:frame.parentFrameId,documentId:frame.documentId,origin,allowed,ready:false});
  }
  if(!rows.some(f=>f.frameId===0))rows.unshift({frameId:0,parentFrameId:-1,origin:topOrigin,allowed:true,ready:false});
  return rows;
}
function frameOptions(frame){return frame.documentId?{frameId:frame.frameId,documentId:frame.documentId}:{frameId:frame.frameId};}
function ensureOverlayFrames(tabId,force=false){return queueOverlayFrames(tabId,async()=>{
  const cached=overlayFrameCache.get(tabId);
  if(!force&&cached&&Date.now()-cached.at<3000)return cached.rows;
  const rows=await inspectOverlayFrames(tabId);
  for(const row of rows){
    if(!row.allowed)continue;
    try{await injectOverlay(tabId,row.frameId,row.documentId);row.ready=true;}
    catch(error){row.error=frameError(error);if(row.frameId===0)throw error;}
  }
  overlayFrameCache.set(tabId,{at:Date.now(),rows});return rows;
});}
async function sendOverlayMessage(tabId,message){
  const rows=await ensureOverlayFrames(tabId);
  const replies=await Promise.all(rows.filter(f=>f.ready).map(async f=>{
    try{
      if(f.frameId!==0&&['DUO_HTML_BATCH','DUO_ENTRY','DUO_REMOVE_ENTRY'].includes(message.type)){
        const pong=await chrome.tabs.sendMessage(tabId,{type:'DUO_PING'},frameOptions(f));
        if(!pong?.fullscreen?.active||/^(IFRAME|FRAME)$/.test(pong.fullscreen.element||''))return {frameId:f.frameId,skipped:true};
      }
      return {frameId:f.frameId,reply:await chrome.tabs.sendMessage(tabId,message,frameOptions(f))};
    }
    catch(error){overlayFrameCache.delete(tabId);return {frameId:f.frameId,error:frameError(error)};}
  }));
  const top=replies.find(r=>r.frameId===0);
  if(!top?.reply?.ok)throw Error(top?.error||'親ページの字幕レイヤーへ接続できません');
  return top.reply;
}
async function readOverlayFrameStatus(tabId){
  const rows=await ensureOverlayFrames(tabId);
  return Promise.all(rows.map(async row=>{
    if(!row.ready)return {...row};
    try{const pong=await chrome.tabs.sendMessage(tabId,{type:'DUO_PING'},frameOptions(row));
      return {...row,ready:!!pong?.ok,version:pong?.htmlBridgeVersion||'',captions:pong?.captions||0,fullscreen:pong?.fullscreen||null,interaction:pong?.interaction||null};
    }catch(error){return {...row,ready:false,error:frameError(error)};}
  }));
}
async function validateOverlayFrameSender(sender){
  const state=await getState();
  if(sender.tab?.id!==state.targetTabId||!Number.isInteger(sender.frameId)||sender.frameId<0)throw Error('字幕対象タブ以外からの操作です');
  if(chrome.webNavigation?.getFrame){
    const frame=await chrome.webNavigation.getFrame({tabId:sender.tab.id,frameId:sender.frameId});
    if(!frame||sender.documentId&&frame.documentId!==sender.documentId)throw Error('字幕フレームが切り替わっています');
  }else if(sender.frameId!==0)throw Error('字幕フレームを確認できません');
  return state;
}
chrome.webNavigation?.onCompleted.addListener(info=>{
  (async()=>{
    const state=await getState();if(info.tabId!==state.targetTabId||info.frameId===0)return;
    overlayFrameCache.delete(info.tabId);
    if(state.htmlTabId)await queueHtmlOperation(async()=>deliverHtml(await getState()));
    else await ensureOverlayFrames(info.tabId,true);
  })().catch(()=>{});
});
chrome.tabs.onRemoved.addListener(tabId=>{overlayFrameCache.delete(tabId);overlayFrameQueues.delete(tabId);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='loading')overlayFrameCache.delete(tabId);});
chrome.permissions.onRemoved?.addListener(()=>overlayFrameCache.clear());
