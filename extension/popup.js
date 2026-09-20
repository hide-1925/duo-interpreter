'use strict';

const $ = (id) => document.getElementById(id);
DuoTextComposer($('textComposer'),$('openText'));
function conferenceState(s){$('conferenceMic').classList.toggle('active',!!s?.active);$('conferenceMic').setAttribute('aria-pressed',String(!!s?.active));$('conferenceStatus').textContent=s?.pending?'接続待機中':s?.error||'';}
$('conferenceMic').addEventListener('click',async()=>{$('conferenceMic').disabled=true;try{conferenceState(await send({type:'DUO_CONFERENCE_TOGGLE'}));}catch(error){$('conferenceStatus').textContent=error.message;}finally{$('conferenceMic').disabled=false;}});
chrome.runtime.onMessage.addListener(m=>{if(m.type==='DUO_CONFERENCE_STATE')conferenceState(m.state);});
let activeTab = null;
let state = null;
let htmlUrlDirty = false;
let registeredHtmlUrl = '';
let missingPlayerOrigins=[];
let targetPermissionOrigins=[];

function show(message, kind) {
  $('status').textContent = message || '';
  $('status').className = kind || '';
}

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response || !response.ok) throw new Error(response && response.error || '処理に失敗しました');
    return response;
  });
}

$('downloadInteraction').addEventListener('click', async () => {
  try {
    const response=await send({type:'DUO_GET_STATE'});
    const report={extensionVersion:chrome.runtime.getManifest().version,workerVersion:response.workerVersion||'unknown',generatedAt:new Date().toISOString(),responseFields:Object.keys(response),overlay:response.overlay||{ready:false,error:'バックグラウンドから字幕情報が返されていません。拡張ファイルの混在を確認してください'}};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='duo-subtitle-interaction.json';
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    show('字幕操作ログを保存しました（会話本文・APIキーは含みません）','ok');
  } catch(error) { show(error.message,'err'); }
});
function validTarget(tab) {
  return tab && /^(https?|file):/i.test(tab.url || '');
}

async function refresh() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await send({ type: 'DUO_GET_STATE' });
  conferenceState(response.conference);
  if(response.workerVersion!==chrome.runtime.getManifest().version||!response.overlay){
    throw Error('拡張ファイルの版が一致しません。最新版ZIPを空のフォルダーへ展開し、拡張を読み込み直してください');
  }
  state = response.state;
  const overlay=response.overlay||{},full=overlay.fullscreen||{};
  missingPlayerOrigins=overlay.missingOrigins||[];
  $('overlayState').textContent=overlay.ready?'字幕レイヤー：'+(state.overlayEnabled?'表示中':'非表示')+' · 字幕'+(overlay.captions||0)+'件'+(full.active?' · 動画全画面':'')+(full.error?' · '+full.error:''):'字幕レイヤー：'+(overlay.error||'未接続');
  $('overlayState').className=full.error||!overlay.ready?'err':'ok';
  if(missingPlayerOrigins.length)$('overlayState').textContent+=' · 埋め込みプレイヤーの表示許可が必要です';
  const failedFrames=(overlay.frames||[]).filter(f=>f.allowed&&!f.ready&&f.frameId!==0);
  if(failedFrames.length){$('overlayState').textContent+=' · 埋め込みプレイヤーへ接続できません。タブを再読み込みしてください';$('overlayState').className='err';}

  registeredHtmlUrl = response.htmlUrl;
  if (!htmlUrlDirty) $('htmlSource').value = response.htmlUrl;
  $('htmlSource').title = response.htmlUrl || '';
  const browserName=/Edg\//.test(navigator.userAgent)?'Edge':'Chrome';
  $('htmlConnection').textContent = htmlUrlDirty ? 'URL変更は未保存です' : state.htmlLastReceived && !state.htmlError ? browserName+'内のHTML本体と接続済み'+(state.htmlRunning?' · 認識中':' · 認識停止中') : browserName+'内のHTML本体が未接続です。「HTML本体を開く」で接続してください';
  if (state.htmlError) show(state.htmlError, 'err');
  $('currentTab').textContent = activeTab ? (activeTab.title || activeTab.url || '名称不明') : '取得できません';
  $('targetTab').textContent = state.targetTabId ? (state.targetTitle || `タブ ${state.targetTabId}`) : '未設定';
  $('targetTab').classList.toggle('muted', !state.targetTabId);
  $('setTarget').disabled=true;
  targetPermissionOrigins=[];
  if(validTarget(activeTab)&&activeTab.id!==state.htmlTabId){
    const prepared=await send({type:'DUO_PREPARE_TARGET',tabId:activeTab.id});
    targetPermissionOrigins=prepared.origins;
    $('setTarget').disabled=false;
  }
  $('toggleOverlay').disabled = !state.targetTabId;
  $('clearEntries').disabled = !state.targetTabId;
  $('resetOverlay').disabled = !state.targetTabId;
  $('toggleOverlay').textContent = state.overlayEnabled ? 'タブ内字幕を隠す' : 'タブ内字幕を表示';
}

$('registerHtml').addEventListener('click', async () => {
  try {
    const url = new URL($('htmlSource').value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('認証情報を含まないHTTPSのURLを入力してください');
    // Request from the user gesture, before any asynchronous work.
    const granted = await chrome.permissions.request({origins:[url.origin + '/*']});
    if (!granted) throw new Error('HTML本体との接続には、このサイトへのアクセス許可が必要です');
    await send({type:'DUO_SAVE_HTML_URL',url:url.href});
    htmlUrlDirty = false;
    await refresh();
    show('URLを保存しました。「HTML本体を開く」で接続します', 'ok');
  } catch(error) { show(error.message, 'err'); }
});

$('htmlSource').addEventListener('input', () => {
  htmlUrlDirty = $('htmlSource').value !== registeredHtmlUrl;
  $('htmlConnection').textContent = htmlUrlDirty ? 'URL変更は未保存です' : '起動先設定済み';
});
$('htmlSource').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); $('registerHtml').click(); }
});

async function openHtml(type) {
  if (htmlUrlDirty) throw new Error('変更したURLを「HTML本体に登録」で保存してください');
  const granted = await chrome.permissions.request({origins:[new URL(registeredHtmlUrl).origin + '/*']});
  if (!granted) throw new Error('HTML本体との接続には、このサイトへのアクセス許可が必要です');
  await send({type});
  window.close();
}

$('setTarget').addEventListener('click', async () => {
  try {
    if(htmlUrlDirty)throw Error('変更したHTMLのURLを先に登録してください');
    const tabId=activeTab.id;
    $('setTarget').disabled=true;
    // Prepared while opening the menu; request directly from this click.
    const origins=[...new Set([...targetPermissionOrigins,new URL(registeredHtmlUrl).origin+'/*'])];
    const granted=await chrome.permissions.request({origins});
    if(!granted)throw Error('字幕を重ねるには、対象サイトへのアクセス許可が必要です');
    show('字幕と音声を接続しています…');
    const response=await send({type:'DUO_SET_TARGET',tabId});
    state=response.state;
    await refresh();
    show(!state.htmlTabId?'字幕対象を設定しました。HTML本体を開くと音声も接続します':state.htmlRunning?'字幕を接続しました。音声の切替が必要な場合はHTMLで停止・開始してください':'字幕と音声を接続しました。HTML本体で「開始」を押してください','ok');
  } catch(error) { show(error.message,'err'); }
  finally { $('setTarget').disabled=!validTarget(activeTab)||activeTab.id===state?.htmlTabId; }
});

$('openApp').addEventListener('click', async () => {
  try { await openHtml('DUO_OPEN_APP'); }
  catch (error) { show(error.message, 'err'); }
});

$('openOverlaySettings').addEventListener('click', async () => {
  try { await openHtml('DUO_OPEN_SETTINGS'); }
  catch (error) { show(error.message, 'err'); }
});

$('toggleOverlay').addEventListener('click', async () => {
  try {
    const response = await send({ type: 'DUO_TOGGLE_OVERLAY' });
    state = response.state;
    show(state.overlayEnabled ? '字幕を表示しました' : '字幕を隠しました', 'ok');
    await refresh();
  } catch (error) { show(error.message, 'err'); }
});

$('clearEntries').addEventListener('click', async () => {
  try { await send({ type: 'DUO_CLEAR_ENTRIES' }); show('字幕を消去しました', 'ok'); }
  catch (error) { show(error.message, 'err'); }
});

$('resetOverlay').addEventListener('click', async () => {
  try { await send({ type: 'DUO_RESET_OVERLAY' }); show('位置とサイズをリセットしました', 'ok'); }
  catch (error) { show(error.message, 'err'); }
});

$('openCaptionWindow').addEventListener('click', async () => {
  try {
    if(htmlUrlDirty)throw Error('変更したURLを先に登録してください');
    if(!state?.htmlTabId){await send({type:'DUO_GUIDE_HTML_CAPTION_WINDOW'});window.close();return;}
    const target={tabId:state.htmlTabId};
    if(state.htmlDocumentId)target.documentIds=[state.htmlDocumentId];
    // This is the first asynchronous call: preserve the popup click activation.
    const results=await chrome.scripting.executeScript({target,world:'MAIN',func:commandHtmlCaptionWindow,args:[registeredHtmlUrl,'open']});
    const result=results[0]?.result;
    if(result?.ok&&result.open){window.close();return;}
    await send({type:'DUO_GUIDE_HTML_CAPTION_WINDOW'});window.close();
  } catch(error) { show(error.message,'err'); }
});

refresh().catch((error) => show(error.message, 'err'));


