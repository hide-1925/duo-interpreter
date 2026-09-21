(() => {
  'use strict';
  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.id) return;

  const sent = new Map();
  let monitorContext = null;
  let monitorSource = null;
  let speechSessionId = '';

  function send(message) {
    return chrome.runtime.sendMessage(message).then((response) => {
      if (!response || !response.ok) throw new Error(response && response.error || 'Chrome拡張との通信に失敗しました');
      return response;
    });
  }

  function profileFromApp() {
    if (!globalThis.CFG) return {};
    return {
      layout: CFG.ovCapLayout,
      width: Number(CFG.ovCapWidth) || 28,
      freeWidth: Number(CFG.ovCapFreeWidth) || 28,
      freeHeight: Number(CFG.ovCapFreeHeight) || 55,
      sideHeight: Number(CFG.ovCapSideHeight) || 80,
      bottomWidth: Number(CFG.ovCapBottomWidth) || 80,
      bottomHeight: Number(CFG.ovCapBottomHeight) || 42,
      x: Number(CFG.ovCapX) || 68,
      y: Number(CFG.ovCapY) || 18,
      items: Number(CFG.ovCapItems) || 4,
      hold: Number(CFG.ovCapHold),
      font: Number(CFG.ovCapFont) || 26,
      line: Number(CFG.ovCapLine) || 1.35,
      itemWidth: Number(CFG.ovCapItemWidth) || 100,
      textA: CFG.ovCapTextA,
      textB: CFG.ovCapTextB,
      srcA: CFG.ovCapSrcA,
      srcB: CFG.ovCapSrcB,
      bg: CFG.ovCapBg,
      textOpacity: Number(CFG.ovCapTextOpacity) || 92,
      bgOpacity: Number(CFG.ovCapBgOpacity) || 35,
      shadow: !!CFG.ovCapShadow,
      outline: !!CFG.ovCapOutline,
      round: !!CFG.ovCapRound
    };
  }

  async function captureTargetAudio() {
    const response = await send({ type: 'DUO_GET_STREAM_ID' });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: response.streamId
        }
      },
      video: false
    });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('対象タブから音声Trackを取得できませんでした');
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        monitorContext = monitorContext && monitorContext.state !== 'closed' ? monitorContext : new AudioContextClass();
        if (monitorSource) try { monitorSource.disconnect(); } catch (_) {}
        monitorSource = monitorContext.createMediaStreamSource(stream);
        monitorSource.connect(monitorContext.destination);
        if (monitorContext.state === 'suspended') await monitorContext.resume();
      } catch (_) {}
    }
    track.addEventListener('ended', () => {
      if (monitorSource) try { monitorSource.disconnect(); } catch (_) {}
      monitorSource = null;
    }, { once: true });
    return { track, stream, ownsStream: true, fromOverlay: false, fromExtensionTab: true };
  }

  function publishEntry(entry) {
    if (!entry || !entry.id) return;
    const payload = {
      id: entry.id,
      seat: entry.seat,
      srcText: entry.srcText || '',
      dstText: entry.dstText || '',
      srcLang: entry.srcLang,
      dstLang: entry.dstLang,
      interim: !!entry.interim,
      translationSkipped: !!entry.translationSkipped,
      time: entry.time
    };
    const signature = JSON.stringify(payload);
    if (sent.get(entry.id) === signature) return;
    sent.set(entry.id, signature);
    send({ type: 'DUO_ENTRY', entry: payload }).catch(() => {});
  }

  function removeEntry(id) {
    sent.delete(id);
    send({ type: 'DUO_REMOVE_ENTRY', id }).catch(() => {});
  }

  function publishProfile() {
    if (globalThis.CFG) chrome.storage.local.set({ duoOverlayFont: Number(CFG.ovCapFont) || 26 }).catch(() => {});
    send({ type: 'DUO_PROFILE', profile: profileFromApp() }).catch(() => {});
  }

  function startTargetWebSpeech(seat, lang, sessionId, captureMethod, audioProfile) {
    speechSessionId=sessionId;
    return send({ type: 'DUO_START_TARGET_WEB_SPEECH', seat, lang, sessionId, captureMethod, audioProfile });
  }

  function stopTargetWebSpeech(sessionId) {
    if(speechSessionId===sessionId)speechSessionId='';
    return send({ type: 'DUO_STOP_TARGET_WEB_SPEECH', sessionId }).catch(() => ({ ok: false }));
  }
  addEventListener('pagehide', () => { if(speechSessionId) stopTargetWebSpeech(speechSessionId); });

  function receiveFont(font) {
    if (!globalThis.CFG || !Number.isFinite(Number(font))) return;
    CFG.ovCapFont = String(Math.max(12, Math.min(44, Number(font))));
    store.set('di.overlay.font', CFG.ovCapFont);
    applyCaptureControls(); applyCaptureProfile();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.duoOverlayFont && String(changes.duoOverlayFont.newValue) !== String(globalThis.CFG?.ovCapFont)) receiveFont(changes.duoOverlayFont.newValue);
  });

  function setTabAudioSeat(seat) {
    if(typeof window.duoApplyPreset==='function'){window.duoApplyPreset('web');return;}
    if (!globalThis.CFG || !globalThis.store) return;
    const id = seat === 'A' ? 'srcA' : 'srcB';
    const key = seat === 'A' ? 'di.sa' : 'di.sb';
    CFG[id] = 'display'; store.set(key, 'display');
    const select = document.getElementById(id);
    if (select) { select.value = 'display'; select.dispatchEvent(new Event('change', { bubbles: true })); }
  }

  function installDock() {
    const dock = document.createElement('aside');
    dock.id = 'duoExtensionDock';
    dock.innerHTML = `
      <strong>Chrome拡張</strong>
      <span id="duoExtensionTarget">対象タブを確認中…</span>
      <button id="duoUseTabB">Webプリセットを選択</button>
      <button id="duoShowTarget">対象タブを表示</button>
      <button id="duoClearTargetCaptions">タブ字幕を消去</button>`;
    document.body.appendChild(dock);
    document.getElementById('duoUseTabB').addEventListener('click', () => setTabAudioSeat('B'));
    document.getElementById('duoClearTargetCaptions').addEventListener('click', () => send({ type: 'DUO_CLEAR_ENTRIES' }).catch(() => {}));
    document.getElementById('duoShowTarget').addEventListener('click', async () => {
      const response = await send({ type: 'DUO_GET_STATE' });
      if (response.state.targetTabId) chrome.tabs.update(response.state.targetTabId, { active: true });
    });
    send({ type: 'DUO_GET_STATE' }).then((response) => {
      const state = response.state;
      document.getElementById('duoExtensionTarget').textContent = state.targetTabId ? `字幕対象：${state.targetTitle || '名称不明'}` : '字幕対象が未設定です。ツールバーのDuoアイコンから設定してください。';
      document.getElementById('duoUseTabB').disabled = !state.targetTabId;
      document.getElementById('duoShowTarget').disabled = !state.targetTabId;
    }).catch((error) => { document.getElementById('duoExtensionTarget').textContent = error.message; });
  }

  function showOverlaySettings() {
    const tab = document.querySelector('.tabs button[data-tab="p4"]');
    if (tab) tab.click();
    const drawer = document.getElementById('drawer');
    const scrim = document.getElementById('scrim');
    if (drawer) drawer.classList.add('open');
    if (scrim) scrim.classList.add('on');
    requestAnimationFrame(() => {
      const section = document.getElementById('overlaySettingsMain');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;
    if (message.type === 'DUO_SHOW_OVERLAY_SETTINGS') {
      showOverlaySettings(); sendResponse({ ok: true }); return;
    }
    if (message.type === 'DUO_TARGET_SPEECH_EVENT_APP') {
      if(!speechSessionId || message.event?.sessionId!==speechSessionId){sendResponse({ok:false});return;}
      if(message.event.kind==='heartbeat'){sendResponse({ok:true});return;}
      dispatchEvent(new CustomEvent('duo-target-speech-event', { detail: { ...message.event, bridgeAt: Date.now() } }));
      sendResponse({ ok: true });
    }
  });

  globalThis.DuoExtension = { send, captureTargetAudio, startTargetWebSpeech, stopTargetWebSpeech, publishEntry, removeEntry, publishProfile, profileFromApp };
  addEventListener('DOMContentLoaded', () => {
    installDock();
    setTimeout(publishProfile, 200);
    if (location.hash === '#overlay-settings') setTimeout(showOverlaySettings, 0);
  }, { once: true });
})();
