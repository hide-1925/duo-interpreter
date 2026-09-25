'use strict';
const HTML_URL_KEY='duoHtmlSourceUrl';
const DEFAULT_HTML_URL='https://hide-1925.github.io/duo-interpreter/';
async function getHtmlSourceUrl(){
  const saved=(await chrome.storage.local.get(HTML_URL_KEY))[HTML_URL_KEY];
  return saved || DEFAULT_HTML_URL;
}
function validateHtmlUrl(value){
  let u;try{u=new URL(String(value||'').trim());}catch(_){throw new Error('有効なHTTPSのURLを入力してください');}
  if(u.protocol!=='https:'||u.username||u.password)throw new Error('認証情報を含まないHTTPSのURLを入力してください');
  u.hash='';return u.href;
}
async function saveHtmlSourceUrl(value){
  const url=validateHtmlUrl(value);
  if(!await chrome.permissions.contains({origins:[new URL(url).origin+'/*']}))throw new Error('HTML本体のサイトへのアクセスを許可してください');
  if(url!==await getHtmlSourceUrl()){
    const state=await getState();
    // Invalidate the old sender before disposing its relay. The relay also releases any add-on audio capture.
    await setState({htmlTabId:null,htmlDocumentId:null,htmlEntries:[],htmlRevision:0,htmlLastReceived:null,htmlError:'',htmlOpenSettings:false,htmlRunning:false,htmlBuild:'',htmlSourceTitle:''});
    if(state.htmlTabId){try{await chrome.tabs.sendMessage(state.htmlTabId,{type:'DUO_HTML_COMMAND',command:{action:'dispose'}});}catch(_){} }
    if(state.targetTabId){try{await chrome.tabs.sendMessage(state.targetTabId,{type:'DUO_CLEAR_ENTRIES'});}catch(_){} }
  }
  await chrome.storage.local.set({[HTML_URL_KEY]:url});
  return {ok:true,htmlUrl:url,state:await getState()};
}
let htmlQueue=Promise.resolve();
const canonicalHtmlUrl=(value)=>{const u=new URL(value);u.hash='';return u.href;};
function requirePopup(sender){if(sender.url!==chrome.runtime.getURL('popup.html'))throw new Error('この操作はDuoのポップアップから行ってください');}
const htmlAttaching=new Map();
function attachHtmlSource(tabId){
  if(htmlAttaching.has(tabId))return htmlAttaching.get(tabId);
  const task=attachHtmlSourceOnce(tabId).finally(()=>htmlAttaching.delete(tabId));
  htmlAttaching.set(tabId,task);return task;
}
async function attachHtmlSourceOnce(tabId){
  const tab=await chrome.tabs.get(tabId),state=await getState();
  const url=await getHtmlSourceUrl();
  if(!url||canonicalHtmlUrl(tab.url)!==url)throw new Error('登録したHTML本体と異なるページです');
  const [probe]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>({
    ok:!!(window.CFG&&Array.isArray(window.S?.entries)&&document.getElementById('feedA')),
    build:String(window.APP_BUILD||'')
  })});
  if(!probe?.result?.ok)throw new Error('Duo HTML本体ではありません。正常動作しているDuoのページを登録してください');
  // Opening HTML settings must not tear down an active audio capture.
  if(state.htmlTabAudio&&state.htmlTabId===tabId&&state.htmlDocumentId===probe.documentId){
    try{if((await chrome.tabs.sendMessage(tabId,{type:'DUO_HTML_PING'}))?.ok)return tab;}catch(_){}
  }
  await setState({htmlTabId:tabId,htmlDocumentId:probe.documentId||null,htmlSourceTitle:tab.title||'',htmlBuild:probe.result.build,
    htmlRevision:0,htmlEntries:[],htmlError:'',htmlLastReceived:null,htmlReceived:0,htmlDelivered:0});
  await chrome.scripting.executeScript({target:{tabId},files:['html-source-content.js']});
  await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['html-source-main.js']});
  if(state.htmlTabAudio)await setHtmlTabAudio(true);
  if((await getState()).htmlCaptionGuide){await runHtmlCaptionCommand('guide');await setState({htmlCaptionGuide:false});}
  return tab;
}
async function registerHtmlSource(tabId){
  const tab=await chrome.tabs.get(tabId);
  if(!/^https:\/\//.test(tab.url||''))throw new Error('HTTPSで開いたDuo HTMLページを登録してください');
  const [probe]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>!!(window.CFG&&Array.isArray(window.S?.entries)&&document.getElementById('feedA'))});
  if(!probe?.result)throw new Error('このタブはDuo HTML本体ではありません');
  const state=await getState();
  if(state.targetTabId===tabId){
    try{await chrome.tabs.sendMessage(tabId,{type:'DUO_OVERLAY_VISIBILITY',visible:false});}catch(_){}
    await setState({targetTabId:null,targetTitle:'',targetUrl:'',overlayEnabled:false});
  }
  if(state.htmlTabId&&state.htmlTabId!==tabId){try{await chrome.tabs.sendMessage(state.htmlTabId,{type:'DUO_HTML_COMMAND',command:{action:'dispose'}});}catch(_){} }
  if(state.targetTabId){try{await chrome.tabs.sendMessage(state.targetTabId,{type:'DUO_STOP_TARGET_WEB_SPEECH'});}catch(_){} }
  await chrome.storage.local.set({[HTML_URL_KEY]:canonicalHtmlUrl(tab.url)});
  await attachHtmlSource(tabId);
  return {ok:true,state:await getState()};
}
/* activate=false はワンタッチ用。ポップアップは焦点を失うと閉じるので、
   タブを前面に出すと残りの手順が中断される。 */
async function openHtmlSource(settings=false,activate=true){
  const state=await getState();const url=await getHtmlSourceUrl();
  if(!await chrome.permissions.contains({origins:[new URL(url).origin+'/*']}))throw new Error('HTML本体のサイトへのアクセスを許可してください');
  let tab;
  if(state.htmlTabId){try{const existing=await chrome.tabs.get(state.htmlTabId);if(canonicalHtmlUrl(existing.url)===url)tab=existing;}catch(_){} }
  if(!tab){
    const candidates=await chrome.tabs.query({url:new URL(url).origin+'/*'});
    tab=candidates.find(t=>{try{return canonicalHtmlUrl(t.url)===url;}catch(_){return false;}});
  }
  if(tab){
    if(state.targetTabId===tab.id){
      try{await chrome.tabs.sendMessage(tab.id,{type:'DUO_OVERLAY_VISIBILITY',visible:false});}catch(_){}
      await setState({targetTabId:null,targetTitle:'',targetUrl:'',overlayEnabled:false});
    }
    await setState({htmlTabId:tab.id});
    if(activate){await chrome.tabs.update(tab.id,{active:true});if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});}
    if(tab.status==='loading')await setState({htmlOpenSettings:settings});
    if(tab.status!=='loading'){
      await attachHtmlSource(tab.id);
      if(settings)await chrome.tabs.sendMessage(tab.id,{type:'DUO_HTML_COMMAND',command:{action:'settings'}});
    }
  }else{
    tab=await chrome.tabs.create({url,active:activate});await setState({htmlTabId:tab.id,htmlDocumentId:null,htmlError:'読み込み中',htmlOpenSettings:settings});
    // The completion event normally attaches. Check status to cover a cached page
    // that completed between tabs.create and saving its id.
    const loaded=await chrome.tabs.get(tab.id);
    if(loaded.status==='complete'){await attachHtmlSource(tab.id);if(settings)await chrome.tabs.sendMessage(tab.id,{type:'DUO_HTML_COMMAND',command:{action:'settings'}});}
  }
  return {ok:true,tab};
}
function cleanHtmlEntry(e){
  if(!e||typeof e.id!=='string'||!e.id||e.id.length>80)return null;
  const str=(v,n)=>String(v??'').slice(0,n);
  return {id:e.id,seat:e.seat==='B'?'B':'A',srcText:str(e.srcText,4000),dstText:str(e.dstText,4000),
    srcLang:str(e.srcLang,20),dstLang:str(e.dstLang,20),time:str(e.time,30),interim:!!e.interim,translationSkipped:!!e.translationSkipped};
}
function cleanHtmlProfile(p){
  if(!p||typeof p!=='object')return null;
  const out={layout:['left','right','bottom','free'].includes(p.layout)?p.layout:'right'};
  const nums={width:[28,12,96],freeWidth:[28,12,96],freeHeight:[55,12,88],sideHeight:[80,12,88],bottomWidth:[80,20,96],bottomHeight:[42,12,88],x:[68,0,100],y:[18,0,100],items:[4,1,200],hold:[18,0,180],font:[26,12,64],line:[1.35,1,2],itemWidth:[100,35,100],textOpacity:[92,0,100],bgOpacity:[35,0,100]};
  for(const [k,[d,lo,hi]] of Object.entries(nums)){const n=Number(p[k]);out[k]=Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):d;}
  for(const k of ['textA','textB','srcA','srcB','bg'])out[k]=/^#[0-9a-f]{6}$/i.test(p[k]||'')?p[k]:(k==='bg'?'#000000':'#FFFFFF');
  for(const k of ['shadow','outline','round','showSrc'])out[k]=!!p[k];
  return out;
}
async function deliverHtml(state){
  if(!state.targetTabId)return;
  if(state.targetTabId===state.htmlTabId)throw new Error('HTML本体と字幕対象は別のタブにしてください');
  const reply=await sendOverlayMessage(state.targetTabId,{type:'DUO_HTML_BATCH',sourceKey:String(state.htmlTabId)+':'+state.htmlDocumentId,
    entries:state.htmlEntries||[],profile:state.profile||{},visible:state.overlayEnabled});
  if(!reply?.ok)throw new Error('字幕対象タブを再読み込みし、字幕対象に設定し直してください');
  await setState({htmlDelivered:Date.now(),htmlError:''});
}
async function receiveHtml(message,sender){
  const state=await getState(),data=message.data;
  const url=await getHtmlSourceUrl();
  if(sender.tab?.id!==state.htmlTabId||sender.frameId!==0||!url||canonicalHtmlUrl(sender.url)!==url||
    (state.htmlDocumentId&&sender.documentId!==state.htmlDocumentId))throw new Error('登録HTML本体以外からの字幕です');
  if(!data||!Number.isSafeInteger(data.revision)||data.revision<1||!Array.isArray(data.entries)||data.entries.length>200||!Array.isArray(data.removed)||data.removed.length>400)throw new Error('字幕形式が不正です');
  if(data.revision<=Number(state.htmlRevision||0))return {ok:true,ignored:true};
  const rows=new Map((data.reset?[]:state.htmlEntries||[]).map(e=>[e.id,e]));
  for(const id of data.removed)rows.delete(String(id));
  for(const value of data.entries){const e=cleanHtmlEntry(value);if(e)rows.set(e.id,e);}
  const profile=cleanHtmlProfile(data.profile)||state.profile;
  const next=await setState({htmlEntries:[...rows.values()].slice(-200),htmlRevision:data.revision,profile,
    htmlRunning:!!data.running,htmlLastReceived:Date.now(),htmlReceived:(state.htmlReceived||0)+data.entries.length,htmlError:''});
  try{await deliverHtml(next);}catch(error){await setState({htmlError:String(error.message||error)});}
  // Target failure must not stop the source; cached captions can be replayed when
  // the user selects or reloads the target. No text is stored in local storage.
  return {ok:true};
}
function queueHtmlOperation(operation){const task=htmlQueue.then(operation);htmlQueue=task.catch(()=>{});return task;}
function queueHtml(message,sender){return queueHtmlOperation(()=>receiveHtml(message,sender));}
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.status!=='complete')return;
  (async()=>{
    const s=await getState();
    if(tabId===s.htmlTabId){
      try{await attachHtmlSource(tabId);if(s.htmlOpenSettings)await chrome.tabs.sendMessage(tabId,{type:'DUO_HTML_COMMAND',command:{action:'settings'}});await setState({htmlOpenSettings:false});}
      catch(e){await setState({htmlError:String(e.message||e)});}
    }else if(tabId===s.targetTabId&&s.htmlTabId){try{await deliverHtml(s);}catch(e){await setState({htmlError:String(e.message||e)});}}
  })().catch(()=>{});
});

async function runHtmlCaptionCommand(action){
  const state=await getState();
  if(!state.htmlTabId)return {ok:false,phase:'no-html',route:'html-main',error:'HTML本体を開いてください'};
  try{
    const url=await getHtmlSourceUrl();
    const target={tabId:state.htmlTabId};
    if(state.htmlDocumentId)target.documentIds=[state.htmlDocumentId];
    const results=await chrome.scripting.executeScript({target,world:'MAIN',func:commandHtmlCaptionWindow,args:[url,action]});
    return results[0]?.result||{ok:false,phase:'unknown',error:'HTML本体から小窓の状態を取得できません'};
  }catch(error){return {ok:false,phase:'unknown',route:'html-main',error:String(error.message||error)};}
}
async function guideHtmlCaptionWindow(){
  await openHtmlSource();
  const state=await getState();
  const tab=await chrome.tabs.get(state.htmlTabId);
  if(tab.status==='loading'){
    await setState({htmlCaptionGuide:true});
    return {ok:true,phase:'awaiting-click',route:'html-main'};
  }
  return runHtmlCaptionCommand('guide');
}
async function openHtmlCaptionWindow(){
  const result=await runHtmlCaptionCommand('open');
  if(result.ok&&result.open)return result;
  return guideHtmlCaptionWindow();
}

// Read only the configured source URL in this browser; never start recording implicitly.
async function connectExistingHtmlSource(){
  const url=await getHtmlSourceUrl();
  if(!await chrome.permissions.contains({origins:[new URL(url).origin+'/*']}))return;
  const candidates=await chrome.tabs.query({url:new URL(url).origin+'/*'});
  const tab=candidates.find(t=>{try{return t.status==='complete'&&canonicalHtmlUrl(t.url)===url;}catch(_){return false;}});
  if(!tab)return;
  try{await attachHtmlSource(tab.id);}catch(e){await setState({htmlError:String(e.message||e)});}
}
