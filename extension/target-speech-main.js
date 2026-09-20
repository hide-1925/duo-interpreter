(() => {
  'use strict';
  if (window.__duoTargetSpeechMainInstalled) return;
  window.__duoTargetSpeechMainInstalled = true;
  const BUILD = '20260906-chrome103-rca-echo';
  const journal = { build: BUILD, sessions: [] };
  // Metadata only. Read separately through scripting when exporting diagnostics:
  // a failed event bridge must not erase the source-side evidence.
  window.__duoSpeechRcaSnapshot = () => JSON.parse(JSON.stringify(journal));
  let active = null;

  function note(current, kind, data = {}) {
    if (!current.audit) return;
    current.audit.events.push({ at: Date.now(), kind, ...data });
    if (current.audit.events.length > 160) { current.audit.events.shift(); current.audit.evicted++; }
  }

  function emit(current, kind, data = {}) {
    window.dispatchEvent(new CustomEvent('duo-target-speech-main-event', {
      detail: JSON.stringify({
        sessionId: current.sessionId, seat: current.seat, lang: current.lang,
        world: 'main', build: BUILD, captureMethod: current.captureMethod,
        audioProfile: current.audioProfile, kind, ...data
      })
    }));
  }
  const isCurrent = (current) => active === current && !current.dead;

  function trackInfo(current) {
    const track = current.track;
    const settings = track && track.getSettings ? track.getSettings() : {};
    return {
      trackMode: current.captureMethod === 'display' ? 'display-direct' : 'tab-direct',
      trackState: track ? track.readyState : null,
      muted: track ? track.muted : null, enabled: track ? track.enabled : null,
      sampleRate: settings.sampleRate || null, channelCount: settings.channelCount || null,
      echoCancellation: settings.echoCancellation ?? null,
      noiseSuppression: settings.noiseSuppression ?? null,
      autoGainControl: settings.autoGainControl ?? null,
      suppressLocalAudioPlayback: settings.suppressLocalAudioPlayback ?? null,
      rmsPeak: current.rmsPeak, meterState: current.audioContext ? current.audioContext.state : 'unavailable'
    };
  }

  function stop(reason = 'stop') {
    const current = active;
    if (!current) return;
    current.dead = true;
    note(current, 'stopped', { reason });
    active = null;
    clearTimeout(current.restartTimer);
    clearInterval(current.meterTimer);
    clearInterval(current.ownerTimer);
    if (current.prompt) current.prompt.remove();
    try {
      if (current.recognition) {
        current.recognition.onend = null;
        current.recognition.abort();
      }
    } catch (_) {}
    try { if (current.stream) current.stream.getTracks().forEach((track) => track.stop()); } catch (_) {}
    try { if (current.source) current.source.disconnect(); } catch (_) {}
    try { if (current.audioContext) current.audioContext.close().catch(() => {}); } catch (_) {}
    emit(current, 'stopped', { reason });
  }

  function fail(current, error, message = '') {
    if (!isCurrent(current)) return;
    note(current, 'fatal', { error, message: String(message).slice(0,500) });
    emit(current, 'fatal', { error, message: String(message).slice(0,500), ...trackInfo(current) });
    stop(error);
  }

  // No resampling or recapture: both acquisition methods pass the original audio track.
  // Web Audio only measures the signal and restores tabCapture's local playback.
  function installMeter(current) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      current.audioContext = new AudioContextClass();
      current.source = current.audioContext.createMediaStreamSource(new MediaStream([current.track]));
      const analyser = current.audioContext.createAnalyser();
      analyser.fftSize = 2048;
      current.source.connect(analyser);
      if (current.captureMethod === 'tab') current.source.connect(current.audioContext.destination);
      const context = current.audioContext;
      context.resume().then(() => {
        if (isCurrent(current)) emit(current, 'monitor', { state: context.state, rate: context.sampleRate });
      }).catch((error) => {
        if (isCurrent(current)) emit(current, 'monitor', { state: context.state, error: error.name });
      });
      const buffer = new Float32Array(analyser.fftSize);
      let lastLog = performance.now();
      current.meterTimer = setInterval(() => {
        if (!isCurrent(current)) return;
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) sum += value * value;
        const rms = Math.sqrt(sum / buffer.length);
        current.rmsPeak = Math.max(current.rmsPeak || 0, rms);
        current.lastRms = rms;
        if (rms > 0.035) current.lastAboveAt = Date.now();
        current.audit.level = { rms: Number(rms.toFixed(6)), at: Date.now(),
          belowThresholdMs: Date.now() - current.lastAboveAt, threshold: 0.035,
          contextState: current.audioContext.state };
        current.audit.maxBelowThresholdMs = Math.max(current.audit.maxBelowThresholdMs || 0, current.audit.level.belowThresholdMs);
        if (performance.now() - lastLog >= 1000) {
          emit(current, 'level', { rms: Number(rms.toFixed(6)), ...trackInfo(current) });
          lastLog = performance.now();
        }
      }, 50);
    } catch (error) {
      emit(current, 'monitor', { state: 'unavailable', error: error.name, message: String(error.message).slice(0,300) });
    }
  }

  function beginRecognition(current) {
    if (!isCurrent(current)) return;
    if (current.track.readyState !== 'live') { fail(current, 'audio-ended'); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = current.recognition = new Recognition();
    const live = () => isCurrent(current) && current.recognition === recognition;
    recognition.lang = current.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    note(current, 'recognizer', { generation: current.restarts, lang: recognition.lang,
      continuous: recognition.continuous, interimResults: recognition.interimResults,
      maxAlternatives: recognition.maxAlternatives, ...trackInfo(current) });
    const startedAt = performance.now();
    recognition.onstart = () => {
      if (live()) emit(current, 'recognition-start', { elapsedMs: Math.round(performance.now()-startedAt), ...trackInfo(current) });
    };
    recognition.onaudiostart = () => { if (live()) emit(current, 'audio-start', trackInfo(current)); };
    recognition.onsoundstart = () => { if (live()) emit(current, 'sound-start', trackInfo(current)); };
    for (const name of ['speechstart', 'speechend', 'soundend', 'audioend']) {
      recognition['on' + name] = () => {
        if (!live()) return;
        const data = { sourceAt: Date.now(), generation: current.restarts };
        note(current, name, data); emit(current, name, data);
      };
    }
    recognition.onresult = (event) => {
      if (!live()) return;
      let interim = ''; const finals = [];
      const resultSeq = ++current.audit.resultEvents;
      const sourceAt = Date.now(), resultsMeta = [];
      for (let i=event.resultIndex; i<event.results.length; i++) {
        const result=event.results[i];
        const text=String(result[0] && result[0].transcript || '');
        resultsMeta.push({ index: i, isFinal: !!result.isFinal, chars: text.length });
        if(result.isFinal) finals.push(text); else interim+=text;
      }
      current.errors=0;
      const trace = { resultSeq, sourceAt, generation: current.restarts,
        resultIndex: event.resultIndex, resultCount: event.results.length, resultsMeta,
        finalCount: finals.length, interimChars: interim.length };
      current.audit.finalResults += finals.length;
      current.audit.lastResult = trace;
      if (finals.length) note(current, 'raw-final', trace);
      if(interim && performance.now()-current.lastInterimLog>=1000) {
        emit(current, 'interim', { chars: interim.length });
        current.lastInterimLog=performance.now();
      }
      emit(current, 'result', { interim, finals, trace });
    };
    recognition.onerror = (event) => {
      if (!live()) return;
      const error=String(event.error || 'unknown');
      note(current, 'recognition-error', { error, generation: current.restarts });
      if(error!=='aborted' && error!=='no-speech') current.errors++;
      emit(current, 'error', {
        error, message: String(event.message || '').slice(0,500),
        count: current.errors, elapsedMs: Math.round(performance.now()-startedAt), ...trackInfo(current)
      });
      if(['not-allowed','service-not-allowed','audio-capture'].includes(error) || current.errors>=3) {
        fail(current, error, event.message);
      }
    };
    recognition.onend = () => {
      if(!live()) return;
      note(current, 'recognition-end', { generation: current.restarts });
      emit(current, 'ended', { restart: current.restarts, elapsedMs: Math.round(performance.now()-startedAt) });
      current.restarts++;
      current.restartTimer=setTimeout(() => beginRecognition(current), Math.min(3000,150+current.errors*500));
    };
    try {
      recognition.start(current.track);
      // This is a call acknowledgement, NOT the recognition.onstart event.
      emit(current, 'started', { restart: current.restarts, ...trackInfo(current) });
    } catch(error) { fail(current, error.name, error.message); }
  }

  async function acquire(current, streamId) {
    if(!isCurrent(current)) return;
    emit(current, 'capture-request', {
      origin: location.origin, secureContext: window.isSecureContext,
      userActivation: !!navigator.userActivation?.isActive
    });
    try {
      // Must be invoked synchronously from the target-page button for getDisplayMedia.
      const displayOptions = {
            video: { displaySurface: 'browser' },
            audio: current.audioProfile === 'no-echo' ? { echoCancellation: false }
              : current.audioProfile === 'html-audio' ? true : { suppressLocalAudioPlayback: false },
            selfBrowserSurface: 'include', preferCurrentTab: true,
            systemAudio: 'exclude', windowAudio: 'window', surfaceSwitching: 'exclude'
          };
      note(current, 'capture-request', { origin: location.origin,
        options: current.captureMethod === 'display' ? displayOptions : { method: 'tabCapture' } });
      const request = current.captureMethod === 'display'
        ? navigator.mediaDevices.getDisplayMedia(displayOptions)
        : navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
            video: false
          });
      const stream = await request;
      if(!isCurrent(current)) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream=stream;
      current.track=stream.getAudioTracks()[0];
      if(!current.track) { fail(current,'no-audio-track','共有元をタブにし、「タブの音声も共有」をONにしてください。'); return; }
      const video=stream.getVideoTracks()[0];
      note(current, 'capture-ready', trackInfo(current));
      if (current.audioProfile === 'no-echo' && current.captureMethod === 'display') {
        const settings = current.track.getSettings();
        const applied = settings.echoCancellation === false;
        const experiment = { requested: { echoCancellation: false },
          applied: settings.echoCancellation ?? null, verified: applied,
          verdict: applied ? 'C条件の適用を確認' : 'C条件の適用を確認できません。原因の判定は保留',
          ...trackInfo(current) };
        current.audit.experiment = experiment;
        note(current, 'audio-experiment', experiment); emit(current, 'audio-experiment', experiment);
      }
      emit(current,'capture-ready',{
        ...trackInfo(current), surface: video ? video.getSettings().displaySurface || 'unknown' : 'tab',
        videoTrackRetained: !!video
      });
      // Keep video track alive for stable display capture, but never render or send video.
      for(const track of stream.getTracks()) {
        track.addEventListener('ended', () => { if(isCurrent(current)) fail(current,'capture-ended','共有が終了しました'); },{once:true});
      }
      installMeter(current);
      beginRecognition(current);
    } catch(error) { fail(current,error.name || 'capture-failed',error.message); }
  }

  function requestDisplayStart(current) {
    const host=document.createElement('div');
    host.id='duo-speech-capture-prompt';
    host.style.cssText='all:initial!important;position:fixed!important;top:16px!important;left:16px!important;z-index:2147483647!important;display:block!important;';
    const shadow=host.attachShadow({mode:'closed'});
    const box=document.createElement('div');
    box.style.cssText='background:#142337;color:white;border:1px solid #68b7ff;border-radius:10px;padding:14px;max-width:380px;font:14px/1.6 sans-serif;box-shadow:0 4px 20px #0008';
    const label=document.createElement('div');
    label.textContent='Duo 音声共有：この字幕対象タブと「タブの音声も共有」を選んでください。選択した音声をWeb Speechで認識します。';
    const startButton=document.createElement('button');
    startButton.textContent='音声共有を選んで開始';
    startButton.style.cssText='margin:10px 8px 0 0;padding:8px;cursor:pointer';
    const cancelButton=document.createElement('button');
    cancelButton.textContent='キャンセル';
    cancelButton.style.cssText='padding:8px;cursor:pointer';
    startButton.onclick=() => {
      if(!isCurrent(current) || startButton.disabled) return;
      startButton.disabled=true;
      // Do not await a message or tab switch before calling acquire().
      acquire(current);
      host.remove();
    };
    cancelButton.onclick=() => { if(isCurrent(current)) stop('cancelled'); };
    box.append(label,startButton,cancelButton);
    shadow.append(box);
    document.documentElement.appendChild(host);
    current.prompt=host;
    emit(current,'waiting-user',{origin:location.origin});
  }

  window.addEventListener('duo-target-speech-main-command', (event) => {
    let command;
    try { command=JSON.parse(String(event.detail || '{}')); } catch(_) { return; }
    if(command.action==='stop') {
      if(active && (!command.sessionId || command.sessionId===active.sessionId)) stop('app-stop');
      return;
    }
    if (command.action === 'result-ack') {
      if (active && command.sessionId === active.sessionId) {
        active.audit.ackedResultEvents++;
        active.audit.ackedFinalResults += Number(command.finalCount) || 0;
        if (command.finalCount) note(active, 'bridge-ack', {
          resultSeq: command.resultSeq, finalCount: command.finalCount, ackAt: Date.now() });
      }
      return;
    }
    if(command.action!=='start' || !command.sessionId) return;
    stop('replace');
    const current=active={
      sessionId:String(command.sessionId),seat:command.seat==='B'?'B':'A',lang:String(command.lang || 'ja-JP'),
      captureMethod:command.captureMethod==='tab'?'tab':'display',
      audioProfile:['html-audio','no-echo'].includes(command.audioProfile)?command.audioProfile:'current',
      stream:null,track:null,recognition:null,audioContext:null,source:null,prompt:null,
      dead:false,errors:0,restarts:0,restartTimer:0,meterTimer:0,ownerTimer:0,rmsPeak:null,lastInterimLog:-Infinity,
      lastRms:null,lastAboveAt:Date.now()
    };
    current.audit = { sessionId: current.sessionId, startedAt: Date.now(), build: BUILD,
      audioProfile: current.audioProfile, captureMethod: current.captureMethod,
      resultEvents: 0, finalResults: 0, ackedResultEvents: 0, ackedFinalResults: 0, events: [], evicted: 0 };
    journal.sessions.push(current.audit);
    if (journal.sessions.length > 6) journal.sessions.shift();
    if(!(window.SpeechRecognition || window.webkitSpeechRecognition)) { fail(current,'unsupported','Web Speech APIを利用できません'); return; }
    current.ownerTimer=setInterval(() => emit(current,'heartbeat'),2000);
    if(current.captureMethod==='display') requestDisplayStart(current);
    else acquire(current,String(command.streamId || ''));
  });
  window.addEventListener('pagehide',()=>stop('pagehide'));
})();
