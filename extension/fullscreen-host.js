'use strict';
// Observe site fullscreen only. Window fullscreen is owned by the browser/player.
// Subtitle visibility must not select a different browser window transition.
let fullscreenQueue=Promise.resolve();
function queueFullscreen(task){const next=fullscreenQueue.then(task);fullscreenQueue=next.catch(()=>{});return next;}
function syncDuoFullscreen(message,sender){return queueFullscreen(async()=>{
  const state=await validateOverlayFrameSender(sender);
  const pong=await chrome.tabs.sendMessage(state.targetTabId,{type:'DUO_PING'},sender.documentId?{frameId:sender.frameId,documentId:sender.documentId}:{frameId:sender.frameId});
  // Ignore stale enter/exit messages after rapid toggles or navigation.
  if(!pong?.fullscreen||pong.fullscreen.active!==!!message.active)return {ok:true,ignored:true};
  const history=[...(state.duoFullscreenHistory||[]),{at:Date.now(),frameId:sender.frameId,active:!!message.active,element:pong.fullscreen.element||null,layer:pong.fullscreen.layer||null,visible:!!pong.fullscreen.visible,error:pong.fullscreen.error||''}].slice(-40);
  await setState({duoFullscreenHistory:history});
  // A recording can be paused when fullscreen starts: replay current captions
  // immediately rather than waiting for the next STT update.
  if(message.active&&state.htmlTabId)await deliverHtml(await getState());
  return {ok:true};
});}
