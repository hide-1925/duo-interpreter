'use strict';
importScripts('html-caption-command.js','html-tab-audio.js','html-host.js','turn-proxy.js','overlay-frames.js','fullscreen-host.js','audio-bridge/controller.js');

const SESSION_KEY = 'duoChromeSession';
const SPEECH_BUILD = '20260906-chrome103-rca-echo';

async function getState() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  return data[SESSION_KEY] || {
    targetTabId: null,
    targetTitle: '',
    targetUrl: '',
    overlayEnabled: false,
    appTabId: null,
    profile: null
  };
}

let stateWrites=Promise.resolve();
function setState(patch) {
  const task=stateWrites.then(async()=>{const next=Object.assign(await getState(),patch,{updatedAt:Date.now()});await chrome.storage.session.set({[SESSION_KEY]:next});return next;});
  stateWrites=task.catch(()=>{});return task;
}

function isRestrictedUrl(url) {
  return !/^https?:|^file:/i.test(String(url || ''));
}

async function injectOverlay(tabId,frameId=0,documentId) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    throw new Error('このページには字幕を重ねられません（ブラウザ内部ページまたは拡張機能ページ）');
  }
  let overlayReady = false;
  let pong;
  try {
    pong = await chrome.tabs.sendMessage(tabId, { type: 'DUO_PING' },documentId?{frameId,documentId}:{frameId});
    overlayReady = !!(pong && pong.ok);
  } catch (_) {}
  if(overlayReady && pong.htmlBridgeVersion !== '1.4.8')throw new Error('字幕対象タブに旧版が残っています。対象タブを再読み込みしてください');
  if (!overlayReady) {
    // Keep dynamic inline !important geometry above our stylesheet defaults.
    const target=documentId?{tabId,documentIds:[documentId]}:{tabId,frameIds:[frameId]};
    await chrome.scripting.insertCSS({ target, files: ['content-overlay.css'], origin: 'AUTHOR' });
    await chrome.scripting.executeScript({ target, files: ['overlay-style.js','overlay-fullscreen.js','text-composer.js','content-overlay.js'] });
    const ready=await chrome.tabs.sendMessage(tabId,{type:'DUO_PING'},documentId?{frameId,documentId}:{frameId});
    if(!ready?.ok||ready.htmlBridgeVersion!=='1.4.8')throw Error('字幕レイヤーの初期化が完了していません。拡張を最新版一式に更新し、対象タブを再読み込みしてください');
  }
  return tab;
}

async function sendToTarget(message) {
  const state = await getState();
  if (!state.targetTabId) throw new Error('対象タブが設定されていません');
  return sendOverlayMessage(state.targetTabId, message);
}

async function getOverlayStatus(){
  const state=await getState();
  if(!state.targetTabId)return {ready:false,error:'字幕対象が未設定です'};
  try{
    const frames=await readOverlayFrameStatus(state.targetTabId);
    const current=frames.find(f=>f.fullscreen?.active&&f.fullscreen?.visible)||frames.find(f=>f.frameId===0)||{};
    return {...current,frames,missingOrigins:[...new Set(frames.filter(f=>!f.allowed&&f.origin).map(f=>f.origin+'/*'))],history:state.duoFullscreenHistory||[]};
  }catch(e){return {ready:false,error:'対象タブの字幕レイヤーが未接続です。対象タブを再読み込みして設定し直してください。'};}
}

async function openApp() {
  const state = await getState();
  if (state.appTabId) {
    try {
      const tab = await chrome.tabs.get(state.appTabId);
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return tab;
    } catch (_) {
      await setState({ appTabId: null });
    }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  await setState({ appTabId: tab.id });
  return tab;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  const patch = {};
  if (state.targetTabId === tabId) Object.assign(patch, {
    targetTabId: null,
    targetTitle: '',
    targetUrl: '',
    overlayEnabled: false
  });
  if (state.appTabId === tabId) {
    patch.appTabId = null;
    if (state.targetTabId) {
      try { await chrome.tabs.sendMessage(state.targetTabId, { type: 'DUO_STOP_TARGET_WEB_SPEECH' }); } catch (_) {}
    }
  }
  if(state.htmlTabId===tabId)Object.assign(patch,{htmlTabId:null,htmlDocumentId:null,htmlRunning:false,htmlLastReceived:null,htmlError:'HTML本体を閉じました'});
  if (Object.keys(patch).length) await setState(patch);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message && message.type) {
      case 'DUO_TEXT_SUBMIT':return duoTextCommand(message,sender);
      case 'DUO_CONFERENCE_TOGGLE':return conferenceQueue(()=>conferenceToggle(sender));
      case 'DUO_TEAMS_SPEAKERS':return teamsSpeakerSignal(message.data,sender);
      case 'DUO_CONFERENCE_SIGNAL':return conferenceQueue(()=>conferenceSignal(message.data,sender));
      case 'DUO_CONFERENCE_LEASE':return conferenceLease(message,sender);
      case 'DUO_GET_STATE':
        return { ok: true, workerVersion:'1.4.26', conference:conferencePublic(), state: await getState(), htmlUrl:await getHtmlSourceUrl(), overlay:await getOverlayStatus(), turn:await turnPermission() };

      case 'DUO_FULLSCREEN_CHANGED':return syncDuoFullscreen(message,sender);
      case 'DUO_REFRESH_FRAMES': {
        requirePopup(sender);const state=await getState();if(!state.targetTabId)throw Error('字幕対象が未設定です');
        await ensureOverlayFrames(state.targetTabId,true);
        if(state.htmlTabId)await deliverHtml(state);
        return {ok:true};
      }

      case 'DUO_SAVE_HTML_URL':requirePopup(sender);return queueHtmlOperation(()=>saveHtmlSourceUrl(message.url));
      case 'DUO_REGISTER_HTML':requirePopup(sender);return registerHtmlSource(message.tabId);
      case 'DUO_HTML_DATA':return queueHtml(message,sender);
      /* 判断層の往復だけを中継する。縛りは turn-proxy.js 側に書いてある。 */
      case 'DUO_TURN_FETCH':return turnFetch(message,sender);
      case 'DUO_SET_TURN_ORIGIN':requirePopup(sender);return setTurnOrigin(message.origin);
      case 'DUO_CLEAR_TURN_ORIGIN':requirePopup(sender);return clearTurnOrigin();
      case 'DUO_HTML_AUDIO_CAPTURE':return getHtmlTabAudioId(sender);
      case 'DUO_PREPARE_TARGET': {
        requirePopup(sender);
        const rows=await inspectOverlayFrames(message.tabId);
        return {ok:true,origins:[...new Set(rows.filter(r=>!r.allowed&&r.origin).map(r=>r.origin+'/*'))]};
      }
      case 'DUO_SET_TARGET': {
        const tab = await chrome.tabs.get(message.tabId);
        const previous = await getState();
        requirePopup(sender);
        await conferenceQueue(()=>conferenceStop('target-change'));
        if(previous.htmlTabId===tab.id)throw new Error('ここはHTML本体です。字幕を表示する動画・資料のタブで設定してください');
        if (previous.targetTabId && previous.targetTabId !== tab.id) {
          try { await chrome.tabs.sendMessage(previous.targetTabId, { type: 'DUO_STOP_TARGET_WEB_SPEECH' }); } catch (_) {}
          try { await chrome.tabs.sendMessage(previous.targetTabId, { type: 'DUO_OVERLAY_VISIBILITY', visible: false }); } catch (_) {}
        }
        await injectOverlay(tab.id);
        const state = await setState({
          targetTabId: tab.id,
          targetTitle: tab.title || '',
          targetUrl: tab.url || '',
          htmlTabAudio: true,
          overlayEnabled: true
        });
        if(previous.targetTabId!==tab.id&&previous.htmlTabId)await chrome.tabs.sendMessage(previous.htmlTabId,{type:'DUO_HTML_AUDIO_STOP'}).catch(()=>{});
        await ensureOverlayFrames(tab.id,true);
        await sendOverlayMessage(tab.id, { type: 'DUO_OVERLAY_VISIBILITY', visible: true });
        if (state.profile) await sendOverlayMessage(tab.id, { type: 'DUO_PROFILE', profile: state.profile });
        // Edge and Chrome keep independent extension sessions. Reconnect an existing local HTML tab.
        if(!state.htmlTabId)await queueHtmlOperation(connectExistingHtmlSource);
        const connected=await getState();
        if(connected.htmlTabId){await queueHtmlOperation(()=>setHtmlTabAudio(true));await deliverHtml(connected);}
        return { ok: true, state:connected };
      }

      case 'DUO_OPEN_APP':
        return openHtmlSource();

      case 'DUO_OPEN_HTML_CAPTION_WINDOW': {
        const state=await getState();
        if(sender.url!==chrome.runtime.getURL('popup.html'))await validateOverlayFrameSender(sender);
        return openHtmlCaptionWindow();
      }
      case 'DUO_GUIDE_HTML_CAPTION_WINDOW':requirePopup(sender);return guideHtmlCaptionWindow();

      case 'DUO_OPEN_SETTINGS': {
        return openHtmlSource(true);
      }
      case 'DUO_OPEN_LEGACY_SETTINGS': {
        const tab = await openApp();
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'DUO_SHOW_OVERLAY_SETTINGS' });
        } catch (_) {
          await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('app.html#overlay-settings') });
        }
        return { ok: true, tab };
      }

      case 'DUO_GET_STREAM_ID': {
        const state = await getState();
        if (!state.targetTabId) throw new Error('対象タブを先に設定してください');
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.targetTabId });
        return { ok: true, streamId, targetTabId: state.targetTabId, title: state.targetTitle };
      }

      case 'DUO_START_TARGET_WEB_SPEECH': {
        const state = await getState();
        if(state.htmlTabId)throw new Error('音声認識はHTML本体で開始してください');
        if (!state.targetTabId) throw new Error('字幕対象タブを先に設定してください');
        if (state.appTabId && sender.tab?.id !== state.appTabId) throw new Error('Duo本体以外からの開始要求です');
        const target = await injectOverlay(state.targetTabId);
        const pong = await chrome.tabs.sendMessage(state.targetTabId, { type: 'DUO_PING' },{frameId:0});
        if (pong?.speechBuild !== SPEECH_BUILD) throw new Error('対象タブに旧版が残っています。動画タブを再読み込みし、字幕対象に設定し直してください');
        if (!/^https:/i.test(String(target.url || ''))) throw new Error('直接Web SpeechはHTTPSの字幕対象タブで利用してください');
        await chrome.scripting.executeScript({ target: { tabId: state.targetTabId }, world: 'MAIN', files: ['target-speech-main.js'] });
        const check = await chrome.scripting.executeScript({ target: { tabId: state.targetTabId }, world: 'MAIN',
          func: () => window.__duoSpeechRcaSnapshot?.().build || null });
        if (check?.[0]?.result !== SPEECH_BUILD) throw new Error('音声認識スクリプトが旧版です。動画タブを再読み込みしてください');
        const captureMethod = message.captureMethod === 'tab' ? 'tab' : 'display';
        const streamId = captureMethod === 'tab' ? await chrome.tabCapture.getMediaStreamId({
          targetTabId: state.targetTabId,
          consumerTabId: state.targetTabId
        }) : null;
        const response = await chrome.tabs.sendMessage(state.targetTabId, {
          type: 'DUO_START_TARGET_WEB_SPEECH', streamId, captureMethod,
          audioProfile: ['html-audio','no-echo'].includes(message.audioProfile) ? message.audioProfile : 'current',
          sessionId: String(message.sessionId || ''), seat: message.seat, lang: message.lang
        });
        if (!response || !response.ok) throw new Error(response && response.error || '対象タブ側のWeb Speechを開始できませんでした');
        if(captureMethod === 'display') {
          await chrome.tabs.update(target.id, { active: true });
          if(target.windowId) await chrome.windows.update(target.windowId, { focused: true });
        }
        return { ok: true, targetTabId: state.targetTabId, result: response.result };
      }

      case 'DUO_STOP_TARGET_WEB_SPEECH': {
        const state = await getState();
        if(state.appTabId && sender.tab?.id !== state.appTabId) throw new Error('Duo本体以外からの停止要求です');
        if (state.targetTabId) {
          try { await chrome.tabs.sendMessage(state.targetTabId, { type: 'DUO_STOP_TARGET_WEB_SPEECH', sessionId: message.sessionId }); } catch (_) {}
        }
        return { ok: true };
      }

      case 'DUO_TARGET_SPEECH_EVENT': {
        const workerAt = Date.now();
        const state = await getState();
        if (!state.targetTabId || sender.tab?.id !== state.targetTabId) throw new Error('字幕対象タブ以外からの認識結果です');
        if (!state.appTabId) throw new Error('Duo本体が開いていません');
        const response = await chrome.tabs.sendMessage(state.appTabId, { type: 'DUO_TARGET_SPEECH_EVENT_APP', event: { ...message.event, workerAt } });
        return { ok: !!(response && response.ok) };
      }

      case 'DUO_GET_SPEECH_RCA': {
        const state = await getState();
        if (!state.appTabId || sender.tab?.id !== state.appTabId) throw new Error('Duo本体以外からの診断要求です');
        if (!state.targetTabId) return { ok: false, error: '字幕対象タブが未設定です' };
        const result = await chrome.scripting.executeScript({ target: { tabId: state.targetTabId }, world: 'MAIN',
          func: () => window.__duoSpeechRcaSnapshot?.() || null });
        return { ok: true, targetTabId: state.targetTabId, snapshot: result?.[0]?.result || null };
      }

      case 'DUO_ENTRY':
      case 'DUO_REMOVE_ENTRY':
      case 'DUO_CLEAR_ENTRIES':
        if(message.type!=='DUO_CLEAR_ENTRIES'&&(await getState()).htmlTabId)throw new Error('字幕は登録HTML本体から受け取ります');
        await sendToTarget(message);
        return { ok: true };

      case 'DUO_PROFILE':
        if((await getState()).htmlTabId)throw new Error('表示設定は登録HTML本体から受け取ります');
        await setState({ profile: message.profile || null });
        await sendToTarget(message);
        return { ok: true };

      case 'DUO_SET_FONT': {
        const state = await validateOverlayFrameSender(sender);
        const font = Math.max(12, Math.min(64, Number(message.font) || 26));
        await chrome.storage.local.set({ duoOverlayFont: font });
        const profile = Object.assign({}, state.profile || {}, { font });
        await setState({ profile });
        if(state.htmlTabId){try{await chrome.tabs.sendMessage(state.htmlTabId,{type:'DUO_HTML_COMMAND',command:{action:'font',font}});}catch(e){await setState({htmlError:'HTML本体への文字サイズ同期に失敗しました'});}}
        await sendToTarget({ type: 'DUO_PROFILE', profile });
        return { ok: true };
      }

      case 'DUO_TOGGLE_OVERLAY': {
        const state = await getState();
        const visible = typeof message.visible === 'boolean' ? message.visible : !state.overlayEnabled;
        await sendToTarget({ type: 'DUO_OVERLAY_VISIBILITY', visible });
        return { ok: true, state: await setState({ overlayEnabled: visible }) };
      }

      case 'DUO_RESET_OVERLAY':
        await sendToTarget({ type: 'DUO_RESET_OVERLAY' });
        return { ok: true };

      default:
        return { ok: false, error: 'unknown_message' };
    }
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: String(error && error.message || error) });
  });
  return true;
});
