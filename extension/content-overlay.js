(() => {
  'use strict';
  if (window.__duoChromeOverlayInstalled) return;
  if(typeof DuoOverlayFullscreen!=='function')throw Error('字幕の全画面処理が読み込まれていません。拡張ファイル一式を更新してください');

  const STORAGE_KEY = 'duoOverlayGeometry';
  const DEFAULT_GEOMETRY = { left: null, top: Math.round(innerHeight * .18), right: 18, width: Math.min(520, Math.max(280, innerWidth * .28)), height: Math.max(180, innerHeight * .55), locked: true };
  const entries = new Map();
  const timers = new Map();
  const htmlSeen = new Map();
  let htmlSourceKey = '';
  const strokes = [];
  let geometry = Object.assign({}, DEFAULT_GEOMETRY);
  let profile = { layout: 'right', width: 28, freeWidth: 28, freeHeight: 55, sideHeight: 80, bottomWidth: 80, bottomHeight: 42, x: 68, y: 18, items: 4, hold: 18, font: 26, line: 1.35, itemWidth: 100, textA: '#FFFFFF', textB: '#A7E8FF', srcA: '#D4E8DE', srcB: '#E7D3DA', bg: '#000000', textOpacity: 92, bgOpacity: 35, shadow: true, outline: false, round: true };
  let drawing = false;
  let draft = null;
  let speechSessionId = '';

  const root = document.createElement('div');
  // Separate the surface from v1.2.5's USER !important stylesheet, if still
  // present in the document. That stylesheet can defeat inline geometry.
  root.id = 'duo-caption-surface';
  root.className = 'duo-locked'+(window===window.top?'':' duo-frame-inactive');
  root.innerHTML = `
    <div class="duo-frame">
      <div class="duo-toolbar">
        <span class="duo-title">DUO 字幕</span>
        <button class="duo-tool" data-action="font-down" aria-label="字幕を小さくする" title="字幕を小さくする">A−</button>
        <button class="duo-tool" data-action="font-up" aria-label="字幕を大きくする" title="字幕を大きくする">A＋</button>
        <button class="duo-tool" data-action="caption-window" aria-label="字幕小窓を開く" title="ウィンドウ外に字幕小窓を表示">↗</button>
        <button class="duo-tool" data-action="text" title="テキスト入力" aria-label="テキスト入力">⌨</button>
        <button class="duo-tool duo-conference" data-action="conference" aria-pressed="false" title="ローカル発話のTTSを会議のマイクへ送る">web会議マイク音声</button>
        <button class="duo-tool" data-action="draw" title="画面へペンで注釈">✎</button>
        <button class="duo-tool" data-action="undo" title="注釈を一つ戻す">↶</button>
        <button class="duo-tool" data-action="clear" title="注釈を確認なしで消去">⌫</button>
        <button class="duo-tool duo-on" data-action="lock" title="字幕欄の移動・サイズ変更を切替">🔒</button>
      </div>
      <div class="duo-feed" tabindex="0" aria-label="字幕履歴（スクロールできます）"></div>
      <div class="duo-resize" data-corner="nw" title="左上をドラッグしてサイズ変更"></div>
      <div class="duo-resize" data-corner="ne" title="右上をドラッグしてサイズ変更"></div>
      <div class="duo-resize" data-corner="sw" title="左下をドラッグしてサイズ変更"></div>
      <div class="duo-resize" data-corner="se" title="右下をドラッグしてサイズ変更"></div>
    </div>`;
  document.documentElement.appendChild(root);

  const canvas = document.createElement('canvas');
  canvas.id = 'duo-chrome-annotation-canvas';
  document.documentElement.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  // Once mounted inside the fullscreen player, overlay clicks must not also
  // toggle playback/fullscreen. Leave keyboard shortcuts and default focus alone.
  for (const surface of [root, canvas]) {
    for (const type of ['click', 'dblclick', 'contextmenu']) {
      surface.addEventListener(type, event => event.stopPropagation());
    }
  }
  const feed = root.querySelector('.duo-feed');
  const toolbar = root.querySelector('.duo-toolbar');
  DuoTextComposer(root.querySelector('.duo-frame'),root.querySelector('[data-action="text"]'));
  const conferenceButton=root.querySelector('[data-action="conference"]');
  const conferenceStatus=document.createElement('span');conferenceStatus.className='duo-conference-status';conferenceStatus.setAttribute('role','status');toolbar.after(conferenceStatus);
  function conferenceState(s){conferenceButton.classList.toggle('duo-on',!!s?.active);conferenceButton.setAttribute('aria-pressed',String(!!s?.active));conferenceStatus.textContent=s?.pending?'接続待機中':s?.error||'';}
  conferenceButton.addEventListener('click',async()=>{conferenceButton.disabled=true;try{const r=await chrome.runtime.sendMessage({type:'DUO_CONFERENCE_TOGGLE'});if(!r?.ok)throw Error(r?.error||'接続失敗');conferenceState(r);}catch(error){conferenceStatus.textContent=error.message;}finally{conferenceButton.disabled=false;}});
  chrome.runtime.onMessage.addListener(m=>{if(m.type==='DUO_CONFERENCE_STATE')conferenceState(m.state);});
  chrome.runtime.sendMessage({type:'DUO_GET_STATE'}).then(r=>conferenceState(r?.conference)).catch(()=>{});

  const resizeHandles = root.querySelectorAll('.duo-resize');
  const lockButton = root.querySelector('[data-action="lock"]');
  const drawButton = root.querySelector('[data-action="draw"]');
  const fullscreen = DuoOverlayFullscreen(root,canvas,resizeCanvas);
  const fontSteps = [12,14,16,18,20,22,26,30,36,44,52,64];
  let windowNotice=null;
  function dismissWindowNotice(){windowNotice?.remove();windowNotice=null;}
  async function openCaptionWindow(){
    try{
      const response=await chrome.runtime.sendMessage({type:'DUO_OPEN_HTML_CAPTION_WINDOW'});
      if(!response?.ok)throw Error(response?.error||'HTML本体の小窓を開けませんでした');
      dismissWindowNotice();
    }catch(error){
      dismissWindowNotice();const panel=document.createElement('div');panel.className='duo-window-launcher';
      const message=document.createElement('p');message.textContent=String(error.message||error);
      const close=document.createElement('button');close.textContent='閉じる';close.addEventListener('click',dismissWindowNotice);
      panel.appendChild(message);panel.appendChild(close);document.documentElement.appendChild(panel);windowNotice=panel;
    }
  }
  root.querySelector('[data-action="caption-window"]').addEventListener('click',openCaptionWindow);
  addEventListener('pagehide',dismissWindowNotice,{once:true});
  function changeFont(direction) {
    const current = Number(profile.font) || 26;
    const font = direction > 0 ? (fontSteps.find(n => n > current) || 64) : ([...fontSteps].reverse().find(n => n < current) || 12);
    applyProfile({ font });
    chrome.runtime.sendMessage({ type: 'DUO_SET_FONT', font }).catch(() => {});
  }
  root.querySelector('[data-action="font-down"]').addEventListener('click', () => changeFont(-1));
  root.querySelector('[data-action="font-up"]').addEventListener('click', () => changeFont(1));
  feed.addEventListener('wheel', (event) => {
    if (event.ctrlKey || feed.scrollHeight <= feed.clientHeight) return;
    event.preventDefault(); event.stopPropagation();
    feed.scrollTop += event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? feed.clientHeight : 1);
  }, { passive: false });

  function rgba(hex, alpha) {
    const clean = String(hex || '#000000').replace('#', '');
    const value = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
    return `rgba(${parseInt(value.slice(0,2),16)},${parseInt(value.slice(2,4),16)},${parseInt(value.slice(4,6),16)},${alpha})`;
  }

  function saveGeometry() {
    chrome.storage.local.set({ [STORAGE_KEY]: geometry }).catch(() => {});
  }

  function applyGeometry() {
    root.style.setProperty('width', `${Math.round(geometry.width)}px`, 'important');
    root.style.setProperty('height', `${Math.round(geometry.height)}px`, 'important');
    root.style.setProperty('top', `${Math.round(geometry.top)}px`, 'important');
    if (geometry.left == null) {
      root.style.removeProperty('left');
      root.style.setProperty('right', `${Math.round(geometry.right || 18)}px`, 'important');
    } else {
      root.style.setProperty('left', `${Math.round(geometry.left)}px`, 'important');
      root.style.removeProperty('right');
    }
    root.classList.toggle('duo-locked', !!geometry.locked);
    lockButton.textContent = geometry.locked ? '🔒' : '🔓';
    lockButton.title = geometry.locked ? '位置固定中：クリックで移動・サイズ変更を有効にする' : '移動・サイズ変更が可能：クリックで位置を固定する';
    lockButton.setAttribute('aria-label', lockButton.title);
    lockButton.setAttribute('aria-pressed', String(!!geometry.locked));
    lockButton.classList.toggle('duo-on', !!geometry.locked);
  }

  function applyLayout(layout) {
    const margin = 18;
    if (layout === 'left' || layout === 'right') {
      geometry.width = innerWidth * Math.max(12, Math.min(60, Number(profile.width) || 28)) / 100;
      geometry.height = innerHeight * Math.max(12, Math.min(88, Number(profile.sideHeight) || 80)) / 100;
      geometry.top = Math.max(margin, (innerHeight - geometry.height) / 2);
      geometry.left = layout === 'left' ? margin : null;
      geometry.right = layout === 'right' ? margin : null;
    } else if (layout === 'bottom') {
      geometry.width = innerWidth * Math.max(20, Math.min(96, Number(profile.bottomWidth) || 80)) / 100;
      geometry.height = innerHeight * Math.max(12, Math.min(70, Number(profile.bottomHeight) || 42)) / 100;
      geometry.left = (innerWidth - geometry.width) / 2;
      geometry.right = null;
      geometry.top = innerHeight - geometry.height - margin;
    } else if (layout === 'free') {
      geometry.width = innerWidth * Math.max(12, Math.min(96, Number(profile.freeWidth) || 28)) / 100;
      geometry.height = innerHeight * Math.max(12, Math.min(88, Number(profile.freeHeight) || 55)) / 100;
      geometry.left = innerWidth * Math.max(0, Math.min(100, Number(profile.x) || 68)) / 100;
      geometry.right = null;
      geometry.top = innerHeight * Math.max(0, Math.min(100, Number(profile.y) || 18)) / 100;
    }
    clampGeometry(); applyGeometry(); saveGeometry();
  }

  function applyProfile(next) {
    const previousLayout = profile.layout;
    const geometryKeys = ['layout', 'width', 'freeWidth', 'freeHeight', 'sideHeight', 'bottomWidth', 'bottomHeight', 'x', 'y'];
    const geometryChanged = !!next && geometryKeys.some((key) => next[key] !== undefined && String(next[key]) !== String(profile[key]));
    const holdChanged = !!next && next.hold !== undefined && String(next.hold) !== String(profile.hold);
    profile = Object.assign(profile, next || {});
    root.style.setProperty('--duo-font', `${Number(profile.font) || 26}px`);
    root.style.setProperty('--duo-line', String(Number(profile.line) || 1.35));
    root.style.setProperty('--duo-item-width', `${Math.max(35, Math.min(100, Number(profile.itemWidth) || 100))}%`);
    root.style.setProperty('--duo-text-opacity', String(Math.max(0, Math.min(100, Number.isFinite(Number(profile.textOpacity)) ? Number(profile.textOpacity) : 92)) / 100));
    root.style.setProperty('--duo-shadow', profile.shadow ? '0 5px 22px rgba(0,0,0,.4)' : 'none');
    root.style.setProperty('--duo-radius', profile.round ? '10px' : '0px');
    root.style.setProperty('--duo-outline', profile.outline ? '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000' : '0 2px 5px rgba(0,0,0,.95)');
    feed.querySelectorAll('.duo-entry').forEach(styleEntry);
    trimEntries();
    if (geometryChanged || (next && next.layout && next.layout !== previousLayout)) applyLayout(profile.layout);
    if (holdChanged) {
      timers.forEach(clearTimeout); timers.clear();
      const holdSeconds = Number(profile.hold);
      if (holdSeconds > 0) feed.querySelectorAll('.duo-entry:not(.duo-interim)').forEach((entry) => {
        const key = entry.dataset.entryId;
        timers.set(key, setTimeout(() => removeEntry(key), holdSeconds * 1000));
      });
    }
  }

  function styleEntry(el) {
    const seat = el.dataset.seat || 'A';
    const bgOpacity = Number.isFinite(Number(profile.bgOpacity)) ? Number(profile.bgOpacity) : 35;
    el.style.setProperty('background', rgba(profile.bg, Math.max(0, Math.min(100, bgOpacity)) / 100), 'important');
    el.style.setProperty('--duo-main', seat === 'A' ? profile.textA : profile.textB);
    el.style.setProperty('--duo-sub', seat === 'A' ? profile.srcA : profile.srcB);
    const sub = el.querySelector('.duo-sub');
    sub.style.setProperty('display', sub.textContent && profile.showSrc !== false ? 'block' : 'none', 'important');
  }

  function trimEntries() {
    const max = Number(profile.hold) === 0 ? 200 : Math.max(1, Number(profile.items) || 4);
    while (feed.children.length > max) {
      const first = feed.firstElementChild;
      if (!first) break;
      removeEntry(first.dataset.entryId);
    }
  }

  function removeEntry(id) {
    const key = String(id || '');
    const el = entries.get(key);
    if (el) el.remove();
    entries.delete(key);
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.delete(key);
  }

  function renderEntry(entry) {
    if (!entry || !entry.id) return;
    const follow = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 24;
    const key = String(entry.id);
    let el = entries.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'duo-entry';
      el.dataset.entryId = key;
      el.innerHTML = '<span class="duo-main"></span><span class="duo-sub"></span>';
      entries.set(key, el);
      feed.appendChild(el);
    }
    const translated = entry.dstText && entry.dstText !== '(翻訳エラー)';
    const noTranslation = !!entry.translationSkipped;
    const main = translated ? entry.dstText : entry.srcText;
    const sub = translated && !noTranslation ? entry.srcText : '';
    el.dataset.seat = entry.seat || 'A';
    el.classList.toggle('duo-interim', !!entry.interim);
    el.querySelector('.duo-main').textContent = main || '';
    el.querySelector('.duo-sub').textContent = sub || '';
    el.querySelector('.duo-sub').style.setProperty('display', sub ? 'block' : 'none', 'important');
    styleEntry(el);
    trimEntries();
    if (follow) feed.scrollTop = feed.scrollHeight;
    if (timers.has(key)) clearTimeout(timers.get(key));
    if (!entry.interim && Number(profile.hold) > 0) {
      timers.set(key, setTimeout(() => removeEntry(key), Number(profile.hold) * 1000));
    }
  }

  function clearEntries() {
    timers.forEach(clearTimeout); timers.clear(); entries.clear(); feed.replaceChildren();
  }

  function receiveHtmlBatch(message) {
    if(htmlSourceKey !== message.sourceKey){clearEntries();htmlSeen.clear();htmlSourceKey=message.sourceKey;}
    applyProfile(message.profile);
    root.classList.toggle('duo-hidden', !message.visible);
    const rows=Array.isArray(message.entries)?message.entries.slice(-200):[];
    const ids=new Set(rows.map(e=>String(e.id)));
    for(const id of htmlSeen.keys())if(!ids.has(id)){removeEntry(id);htmlSeen.delete(id);}
    const follow=feed.scrollHeight-feed.clientHeight-feed.scrollTop<24;
    const scrollTop=feed.scrollTop;
    for(const row of rows){
      const key=String(row.id),sig=JSON.stringify(row);
      // Keep signatures after expiry/clear: replay must not revive old captions.
      if(htmlSeen.get(key)===sig)continue;
      htmlSeen.set(key,sig);renderEntry(row);
    }
    feed.scrollTop=follow?feed.scrollHeight:scrollTop;
  }

  function emitSpeech(event) {
    if(!speechSessionId || event.sessionId !== speechSessionId) return;
    const stopDisconnected = () => {
      if(speechSessionId!==event.sessionId)return;
      const sessionId=speechSessionId;speechSessionId='';
      sendMainSpeechCommand({action:'stop',sessionId});
    };
    try {
      const forwarded = { ...event, contentAt: Date.now() };
      chrome.runtime.sendMessage({ type: 'DUO_TARGET_SPEECH_EVENT', event: forwarded })
        .then(response => {
          if(!response || !response.ok) { stopDisconnected(); return; }
          if (event.kind === 'result' && event.trace) sendMainSpeechCommand({
            action: 'result-ack', sessionId: event.sessionId,
            resultSeq: event.trace.resultSeq, finalCount: event.trace.finalCount
          });
        })
        .catch(stopDisconnected);
    } catch(_) { stopDisconnected(); }
  }

  function sendMainSpeechCommand(command) {
    window.dispatchEvent(new CustomEvent('duo-target-speech-main-command', {
      detail: JSON.stringify(command || {})
    }));
  }

  window.addEventListener('duo-target-speech-main-event', (event) => {
    let payload;
    try { payload = JSON.parse(String(event && event.detail || '{}')); } catch (_) { return; }
    emitSpeech(payload);
  });

  function clampGeometry() {
    // A small embedded player must not shrink saved fullscreen geometry while hidden.
    if(window!==window.top&&!document.fullscreenElement&&!document.webkitFullscreenElement)return;
    geometry.width = Math.max(240, Math.min(innerWidth * .96, geometry.width));
    geometry.height = Math.max(120, Math.min(innerHeight * .88, geometry.height));
    geometry.top = Math.max(0, Math.min(innerHeight - geometry.height, geometry.top));
    const visibleWidth = geometry.width * Math.max(35, Math.min(100, Number(profile.itemWidth) || 100)) / 100;
    if (geometry.left != null) geometry.left = Math.max(0, Math.min(innerWidth - visibleWidth, geometry.left));
  }

  let activeDragEnd = null;
  const dragState = { starts:0, moves:0, phase:'idle', lastPointerTarget:'', lastError:'' };
  root.addEventListener('pointerdown', event => {
    dragState.lastPointerTarget = event.target.closest('.duo-resize')?.dataset.corner ||
      (event.target.closest('button') ? 'button' : event.target.closest('.duo-toolbar') ? 'toolbar' : 'caption');
  }, true);
  function interactionSnapshot(){
    const rect=root.getBoundingClientRect(), css=getComputedStyle(root);
    const wanted={left:geometry.left,top:geometry.top,width:geometry.width,height:geometry.height};
    const actual={left:rect.left,top:rect.top,width:rect.width,height:rect.height};
    const mismatch=rect.width>0&&rect.height>0?['top','width','height',...(geometry.left==null?[]:['left'])]
      .some(key=>Math.abs(wanted[key]-actual[key])>2):null;
    return {locked:!!geometry.locked,drag:{...dragState},wanted,actual,mismatch,
      css:{position:css.position,width:css.width,height:css.height,pointerEvents:css.pointerEvents},
      viewport:{width:innerWidth,height:innerHeight},surfaceId:root.id};
  }
  function pointerDrag(startEvent, onMove, onEnd) {
    startEvent.preventDefault(); startEvent.stopPropagation();
    if (activeDragEnd) activeDragEnd();
    dragState.starts++;dragState.moves=0;dragState.phase='started';dragState.lastError='';
    const pointerId = startEvent.pointerId;
    const target = startEvent.currentTarget || root;
    let ended = false;
    const move = (event) => {
      if (event.pointerId !== pointerId) return;
      if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) { up(event); return; }
      event.preventDefault(); event.stopPropagation();
      dragState.moves++;dragState.phase='moving';
      try { onMove(event); } catch(error) { dragState.lastError=String(error.message||error);up(event); }
    };
    const up = (event) => {
      if (ended || (event && event.pointerId != null && event.pointerId !== pointerId)) return;
      ended = true;
      dragState.phase='ended';
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
      removeEventListener('blur', up, true);
      target.removeEventListener('lostpointercapture', up);
      activeDragEnd = null;
      root.classList.remove('duo-dragging');
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch (_) {}
      if (onEnd) onEnd(event);
    };
    activeDragEnd = up;
    root.classList.add('duo-dragging');
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
    addEventListener('blur', up, true);
    target.addEventListener('lostpointercapture', up);
    // Keep receiving events when the pointer leaves the handle or crosses an iframe.
    try { target.setPointerCapture(pointerId); } catch (_) {}
  }

  toolbar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button') || geometry.locked) return;
    const rect = root.getBoundingClientRect();
    const sx = event.clientX, sy = event.clientY, left = rect.left, top = rect.top;
    geometry.left = left; geometry.right = null;
    pointerDrag(event, (move) => {
      geometry.left = left + move.clientX - sx; geometry.top = top + move.clientY - sy;
      clampGeometry(); applyGeometry();
    }, () => saveGeometry());
  });

  for (const resizeHandle of resizeHandles) resizeHandle.addEventListener('pointerdown', (event) => {
    if (geometry.locked || event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    const ratio = Math.max(35, Math.min(100, Number(profile.itemWidth) || 100)) / 100;
    const sx = event.clientX, sy = event.clientY;
    const left = rect.left, top = rect.top, width = geometry.width * ratio, height = geometry.height;
    const right = left + width, bottom = top + height;
    const west = resizeHandle.dataset.corner.includes('w'), north = resizeHandle.dataset.corner.includes('n');
    geometry.left = left; geometry.right = null;
    pointerDrag(event, (move) => {
      // Clamp visible dimensions first, then derive the moving edges from the
      // fixed opposite corner. The comment-width percentage applies only once.
      const maxWidth = Math.max(1, Math.min(innerWidth * .96 * ratio, west ? right : innerWidth - left));
      const maxHeight = Math.max(1, Math.min(innerHeight * .88, north ? bottom : innerHeight - top));
      const nextWidth = Math.max(Math.min(240 * ratio, maxWidth), Math.min(maxWidth, width + (west ? -1 : 1) * (move.clientX - sx)));
      const nextHeight = Math.max(Math.min(120, maxHeight), Math.min(maxHeight, height + (north ? -1 : 1) * (move.clientY - sy)));
      geometry.width = nextWidth / ratio; geometry.height = nextHeight;
      geometry.left = west ? right - nextWidth : left;
      geometry.top = north ? bottom - nextHeight : top;
      applyGeometry();
    }, () => saveGeometry());
  });

  lockButton.addEventListener('click', (event) => {
    event.preventDefault(); event.stopPropagation(); geometry.locked = !geometry.locked; applyGeometry(); saveGeometry();
  });

  function resizeCanvas() {
    const ratio = Math.max(1, devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * ratio); canvas.height = Math.round(innerHeight * ratio);
    canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); redraw();
    clampGeometry(); applyGeometry();
  }

  function redraw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 4;
    for (const stroke of strokes.concat(draft ? [draft] : [])) {
      if (!stroke.length) continue;
      ctx.beginPath(); ctx.moveTo(stroke[0].x * innerWidth, stroke[0].y * innerHeight);
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x * innerWidth, stroke[i].y * innerHeight);
      ctx.stroke();
    }
  }

  function setDrawing(on) {
    drawing = !!on; canvas.classList.toggle('duo-active', drawing); root.classList.toggle('duo-drawing', drawing); drawButton.classList.toggle('duo-on', drawing);
  }

  drawButton.addEventListener('click', (event) => { event.stopPropagation(); setDrawing(!drawing); });
  root.querySelector('[data-action="undo"]').addEventListener('click', (event) => { event.stopPropagation(); strokes.pop(); redraw(); });
  root.querySelector('[data-action="clear"]').addEventListener('click', (event) => { event.stopPropagation(); strokes.length = 0; draft = null; redraw(); });

  canvas.addEventListener('pointerdown', (event) => {
    if (!drawing || event.button !== 0) return; event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    draft = [{ x: event.clientX / innerWidth, y: event.clientY / innerHeight, id: event.pointerId }]; redraw();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!draft || draft[0].id !== event.pointerId) return; event.preventDefault();
    draft.push({ x: event.clientX / innerWidth, y: event.clientY / innerHeight }); redraw();
  });
  const finishStroke = (event) => {
    if (!draft || draft[0].id !== event.pointerId) return;
    draft.forEach((point) => delete point.id); if (draft.length > 1) strokes.push(draft); draft = null; redraw();
  };
  canvas.addEventListener('pointerup', finishStroke); canvas.addEventListener('pointercancel', finishStroke);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'DUO_START_TARGET_WEB_SPEECH') {
      speechSessionId=String(message.sessionId || '');
      sendMainSpeechCommand({
        action: 'start', streamId: message.streamId, sessionId: String(message.sessionId || ''),
        seat: message.seat, lang: message.lang, captureMethod: message.captureMethod, audioProfile: message.audioProfile
      });
      sendResponse({ ok: true, result: { sessionId: String(message.sessionId || ''), world: 'main' } });
      return;
    }
    if (message && message.type === 'DUO_STOP_TARGET_WEB_SPEECH') {
      sendMainSpeechCommand({ action: 'stop', sessionId: String(message.sessionId || '') });
      sendResponse({ ok: true }); return;
    }
    switch (message && message.type) {
      case 'DUO_PING': sendResponse({ ok: true, installed: true, htmlBridgeVersion:'1.4.0', fullscreen:fullscreen.snapshot(), interaction:interactionSnapshot(), captions:entries.size, speechBuild: '20260906-chrome103-rca-echo' }); return;
      case 'DUO_HTML_BATCH': receiveHtmlBatch(message); break;
      case 'DUO_ENTRY': renderEntry(message.entry); break;
      case 'DUO_REMOVE_ENTRY': removeEntry(message.id); break;
      case 'DUO_PROFILE': applyProfile(message.profile); break;
      case 'DUO_CLEAR_ENTRIES': clearEntries(); break;
      case 'DUO_OVERLAY_VISIBILITY': root.classList.toggle('duo-hidden', !message.visible); break;
      case 'DUO_RESET_OVERLAY': geometry = Object.assign({}, DEFAULT_GEOMETRY); applyGeometry(); saveGeometry(); break;
      default: return;
    }
    fullscreen.sync();
    sendResponse({ ok: true });
  });

  chrome.storage.local.get(STORAGE_KEY).then((data) => {
    geometry = Object.assign({}, DEFAULT_GEOMETRY, data[STORAGE_KEY] || {}); clampGeometry(); applyGeometry();
  }).catch(() => applyGeometry());
  addEventListener('resize', resizeCanvas, { passive: true });
  resizeCanvas();
  fullscreen.sync();
  window.__duoChromeOverlayInstalled = true;
})();

