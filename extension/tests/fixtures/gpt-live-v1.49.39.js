/* v1.49.39 の gpt-live-transcribe 経路（extension/app.js から写したもの。編集しない）。
   test-stt-live-parity.cjs が、同じ受信列を旧実装と新しい SttLiveHost に流して結果を突き合わせる。 */
function isLiveTranscribe(){
  return CFG.sttProvider==='openai'&&/^gpt-live-transcribe(?:$|-)/.test(String(CFG.sttModel||'').trim());
}

/* OpenAI gpt-live-transcribe専用のRealtime WebRTC経路。
   録音Blobを/audio/transcriptionsへ送るモデルではないため、入力Trackをそのまま接続する。 */
function RealtimeTranscriptionEngine(seat,stream,opts){
  this.seat=seat||null;this.stream=stream;this.opts=opts||{};this.pc=null;this.dc=null;
  this.dead=false;this.closing=false;this.items={};this.startedAt=0;this.session=sessionGen;
  this.aborters=[];this.openTimer=null;this.connectStage='idle';
  /* gpt-live-transcribe は1つの item_id を長時間更新し続けることがある。
     サーバーの completed だけに依存せず、端末側で発話境界を判断する。 */
  this.boundaryTimer=null;this.boundaryAc=null;this.boundaryAn=null;this.boundaryBuf=null;
  this.lastVoiceAt=0;this.lastRms=0;this.fallbackItemId='live-active';
  this.statsTimer=null;this.statsBusy=false;this.lastBytes=null;
}
RealtimeTranscriptionEngine.prototype.config=function(){
  var langs=[];
  if((S.autoMode&&micSeats().length>1)||duoShouldAutoDetectInput(this.seat))langs=[CFG.langA,CFG.langB];
  else langs=[langOf(this.seat||S.listenSeat||'A')];
  langs=langs.map(function(x){return String(x||'').toLowerCase().split('-')[0];});
  langs=langs.filter(function(x,i,a){return x&&a.indexOf(x)===i;});
  /* gpt-live-transcribeは連続ストリーミング型。専用仕様に合わせて
     languageではなくlanguagesを使い、delayで部分結果の遅延を指定する。
     Turn Detectionは非対応なので下のsession設定でnull固定とする。 */
  var tr={model:'gpt-live-transcribe',delay:'low'};
  if(langs.length)tr.languages=langs;
  var hints=[];
  hints.push('Transcribe verbatim with natural punctuation. Do not add, omit, paraphrase, or translate words.');
  if(CFG.ctx)hints.push(String(CFG.ctx).slice(0,600));
  if(hints.length)tr.prompt=hints.join('\n');
  var kw=CFG.glossary.slice(0,60).map(function(r){return String(r.s||'').trim();})
    .filter(function(x){return x&&x.length<=50&&!/[<>\r\n]/.test(x);});
  if(kw.length)tr.keywords=kw;
  return {type:'transcription',audio:{input:{transcription:tr,turn_detection:null}}};
};
RealtimeTranscriptionEngine.prototype.cancelError=function(){
  var e=new Error('Realtime音声認識の接続を停止しました');e.cancelled=true;e.liveStage=this.connectStage;return e;
};
RealtimeTranscriptionEngine.prototype.clearAborter=function(ctl){
  var i=this.aborters.indexOf(ctl);if(i>=0)this.aborters.splice(i,1);
};
RealtimeTranscriptionEngine.prototype.request=function(stage,url,opts,timeoutMs,asJson){
  var self=this,ctl=(typeof AbortController!=='undefined')?new AbortController():null,timer=null;
  this.connectStage=stage;if(ctl){opts.signal=ctl.signal;this.aborters.push(ctl);}
  if(ctl)timer=setTimeout(function(){try{ctl.abort();}catch(e){}},timeoutMs);
  dlog('stt','live-'+stage+'-request',{timeoutMs:timeoutMs});
  return fetch(url,opts).then(function(r){
    if(timer)clearTimeout(timer);if(ctl)self.clearAborter(ctl);
    var requestId='';try{requestId=r.headers.get('x-request-id')||'';}catch(e){}
    dlog('stt','live-'+stage+'-response',{status:r.status,ok:r.ok,ms:Date.now()-self.startedAt,requestId:requestId});
    if(!r.ok)return r.text().then(function(t){
      var e=new Error('Realtime '+stage+'失敗 '+r.status+': '+String(t||'').slice(0,300));e.liveStage=stage;throw e;
    });
    return asJson?r.json():r.text();
  }).catch(function(err){
    if(timer)clearTimeout(timer);if(ctl)self.clearAborter(ctl);
    if(self.dead)throw self.cancelError();
    if(err&&err.name==='AbortError'){
      var te=new Error('Realtime '+stage+'が'+Math.round(timeoutMs/1000)+'秒でタイムアウトしました');te.liveStage=stage;throw te;
    }
    if(err&&!err.liveStage)err.liveStage=stage;throw err;
  });
};
/* 送信側のRTPを定期的に残す。v1.49.21 の Teams 実測では gpt-live の部分結果が
   7〜65秒遅れて届いたのに、音声がこちらから出ていたのかどうかを示す記録が
   どこにも無かった（この経路だけ統計を取っていなかった）。bytesSinceLast が
   伸びていれば音は出ている＝遅れは相手側、0のままなら出ていない。 */
RealtimeTranscriptionEngine.prototype.startStats=function(){
  var self=this;if(this.statsTimer)return;
  this.lastBytes=null;this.statsBusy=false;
  this.statsTimer=setInterval(function(){self.logStats();},5000);
};
RealtimeTranscriptionEngine.prototype.logStats=function(){
  var self=this,pc=this.pc;
  if(this.dead||this.closing||!pc||!pc.getStats||this.statsBusy)return;
  this.statsBusy=true;
  Promise.resolve().then(function(){return pc.getStats();}).then(function(stats){
    if(self.dead||self.closing)return;
    var bytes=0,packets=0;
    stats.forEach(function(r){if(r.type==='outbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio')){bytes+=r.bytesSent||0;packets+=r.packetsSent||0;}});
    var track=self.stream&&self.stream.getAudioTracks?self.stream.getAudioTracks()[0]:null;
    dlog('stt','live-audio-transport',{seat:self.seat,connection:pc.connectionState,
      trackState:track?track.readyState:null,trackEnabled:track?!!track.enabled:null,trackMuted:track?!!track.muted:null,
      rms:self.lastRms==null?null:+Number(self.lastRms).toFixed(5),
      bytesSent:bytes,packetsSent:packets,
      bytesSinceLast:self.lastBytes==null?null:bytes-self.lastBytes});
    self.lastBytes=bytes;
  }).catch(function(){}).then(function(){self.statsBusy=false;});
};
RealtimeTranscriptionEngine.prototype.closeConnection=function(){
  this.closing=true;if(this.openTimer){clearTimeout(this.openTimer);this.openTimer=null;}
  if(this.statsTimer){clearInterval(this.statsTimer);this.statsTimer=null;}
  this.stopBoundaryMonitor();
  this.aborters.splice(0).forEach(function(ctl){try{ctl.abort();}catch(e){}});
  try{if(this.dc)this.dc.close();}catch(e){}try{if(this.pc)this.pc.close();}catch(e){}
  this.dc=null;this.pc=null;
};
RealtimeTranscriptionEngine.prototype.start=function(){
  var self=this,key=sttKey();if(!key)return Promise.reject(new Error('OpenAIの音声認識用APIキーが未設定です'));
  var track=this.stream&&this.stream.getAudioTracks&&this.stream.getAudioTracks()[0];
  if(!track||track.readyState!=='live')return Promise.reject(new Error('有効な音声Trackがありません'));
  this.startedAt=Date.now();this.dead=false;this.closing=false;var sessionCfg=this.config(),tr=sessionCfg.audio.input.transcription;
  dlog('stt','live-connect',{model:'gpt-live-transcribe',seat:this.seat||'auto',transport:'webrtc',languages:tr.languages||(tr.language?[tr.language]:[]),trackState:track.readyState,trackMuted:!!track.muted});
  return this.request('secret','https://api.openai.com/v1/realtime/client_secrets',{
    method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({session:sessionCfg})
  },12000,true).then(function(j){
    var secret=j.value||(j.client_secret&&j.client_secret.value);if(!secret)throw new Error('Realtimeクライアントシークレットを取得できませんでした');
    dlog('stt','live-secret-ok',{ms:Date.now()-self.startedAt,sessionType:(j.session&&j.session.type)||'transcription'});
    return self.connect(secret,track);
  }).catch(function(err){
    if(err&&err.cancelled)throw err;
    dlog('stt','live-FAIL',{model:'gpt-live-transcribe',stage:(err&&err.liveStage)||self.connectStage,ms:Date.now()-self.startedAt,err:String((err&&err.message)||err).slice(0,300)});
    self.closeConnection();throw err;
  });
};
RealtimeTranscriptionEngine.prototype.connect=function(secret,track){
  var self=this,pc=new RTCPeerConnection(),opened=false,openResolve,openReject;
  this.connectStage='peer';this.pc=pc;this.closing=false;
  var audioOnly=(typeof MediaStream!=='undefined')?new MediaStream([track]):this.stream;
  pc.addTrack(track,audioOnly);
  var dc=pc.createDataChannel('oai-events');this.dc=dc;
  var openPromise=new Promise(function(resolve,reject){openResolve=resolve;openReject=reject;});
  /* SDP交換より前にDataChannelエラーが起きても未処理Promiseにしない。
     start()へ返した時点では元Promiseのrejectをそのまま伝播する。 */
  openPromise.catch(function(){});
  dc.onmessage=function(ev){self.onEvent(ev);};
  dc.onopen=function(){
    if(self.dead||self.closing)return;opened=true;if(self.openTimer){clearTimeout(self.openTimer);self.openTimer=null;}
    self.connectStage='open';self.startBoundaryMonitor();self.startStats();
    dlog('stt','live-open',{model:'gpt-live-transcribe',ms:Date.now()-self.startedAt,transport:'webrtc'});openResolve();
  };
  dc.onerror=function(){
    if(self.dead||self.closing||opened)return;var e=new Error('Realtime DataChannelを開けませんでした');e.liveStage='datachannel';openReject(e);
  };
  dc.onclose=function(){if(!self.dead&&!self.closing)dlog('stt','live-channel-close',{state:dc.readyState});};
  pc.onconnectionstatechange=function(){
    if(self.dead||self.closing)return;dlog('stt','live-state',{state:pc.connectionState});
    if(pc.connectionState==='failed'){
      var e=new Error('Realtime WebRTC接続がfailedになりました');e.liveStage='peer';if(!opened)openReject(e);
      else{dlog('stt','live-FAIL',{model:'gpt-live-transcribe',stage:'peer',err:e.message});toast('Realtime音声認識の接続が切れました。停止して開始し直してください。');}
    }else if(pc.connectionState==='disconnected')toast('Realtime音声認識の接続が一時的に切れています。再接続を待っています。');
  };
  pc.oniceconnectionstatechange=function(){if(!self.dead&&!self.closing)dlog('stt','live-ice',{state:pc.iceConnectionState});};
  pc.onicegatheringstatechange=function(){if(!self.dead&&!self.closing)dlog('stt','live-gather',{state:pc.iceGatheringState});};
  pc.onsignalingstatechange=function(){if(!self.dead&&!self.closing)dlog('stt','live-signal',{state:pc.signalingState});};
  pc.onicecandidateerror=function(ev){if(!self.dead&&!self.closing)dlog('stt','live-ice-error',{code:ev.errorCode||0,err:String(ev.errorText||'').slice(0,160)});};
  dlog('stt','live-offer-start',{trackId:String(track.id||'').slice(0,8)});
  return pc.createOffer().then(function(o){
    self.connectStage='local-sdp';dlog('stt','live-offer-ok',{ms:Date.now()-self.startedAt,sdpBytes:(o.sdp||'').length});
    return pc.setLocalDescription(o).then(function(){dlog('stt','live-local-sdp',{ms:Date.now()-self.startedAt});return o;});
  }).then(function(o){
    return self.request('sdp','https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/sdp'},body:o.sdp},12000,false);
  }).then(function(sdp){
    self.connectStage='remote-sdp';dlog('stt','live-sdp-ok',{ms:Date.now()-self.startedAt,sdpBytes:String(sdp||'').length});
    return pc.setRemoteDescription({type:'answer',sdp:sdp});
  }).then(function(){
    dlog('stt','live-remote-sdp',{ms:Date.now()-self.startedAt});
    if(opened)return;
    self.connectStage='datachannel';self.openTimer=setTimeout(function(){
      self.openTimer=null;var e=new Error('Realtime DataChannelが10秒以内に開きませんでした');e.liveStage='datachannel';openReject(e);
    },10000);
    return openPromise;
  });
};
RealtimeTranscriptionEngine.prototype.item=function(id){
  id=id||this.fallbackItemId;var x=this.items[id];if(x)return x;
  x=this.items[id]={id:id,entry:null,text:'',allText:'',committedText:'',created:Date.now(),
    segmentStarted:0,lastDeltaAt:0,deltaCount:0,segmentNo:0};
  return x;
};
RealtimeTranscriptionEngine.prototype.ensureEntry=function(x){
  if(x.entry)return x.entry;
  var seat=this.seat||S.listenSeat||'A';x.entry=addEntry(seat,'',true);x.entry.startedAt=x.nextCardStartedAt||x.audioStartedAt||x.created||Date.now();if(x.audioEndedAt)x.entry.audioEndedAt=x.audioEndedAt;x.segmentStarted=Date.now();x.deltaCount=0;
  return x.entry;
};
/* 文章末尾だけを見る軽量な文脈境界判定。
   strong: 文末記号、likely: 終止表現、continuing: 接続表現、neutral: 判定不能。
   STT本文は変更せず、確定を早めるか待つかだけに使う。 */
RealtimeTranscriptionEngine.prototype.boundaryContext=function(text,lang){
  var s=String(text||'').trim(),tail=s.replace(/[\"'」』）】〕〉》\]]+$/,'').trim();
  if(!tail)return 'neutral';
  // "U.S." or "1." at the end may continue ("U.S. stock", "1.5"); give it the ordinary wait.
  if(/\.$/.test(tail)&&segPeriodHold(tail,tail.length))return 'neutral';
  if(/[。！？!?…]|\.(?:\s*)$/.test(tail.slice(-2)))return 'strong';
  if(/^ja(?:-|$)/i.test(lang||'')){
    if(/(?:けど|けれど|けれども|ので|のに|から|ながら|つつ|たり|て|で|が|と|なら|また|そして|しかし|つまり|例えば|たとえば|えっと|その|この|あの)$/.test(tail))return 'continuing';
    if(/(?:です|ます|でした|ました|ません|でしょう|だ|だった|である|と思う|と思います|ください|ありがとう|ございます|ですね|ですよ|だね|だよ|かな|なのか|ですか|ますか)$/.test(tail))return 'likely';
  }else{
    if(/\b(?:and|but|because|so|if|when|while|although|though|that|which|to|of|for|with|or|then)$/i.test(tail))return 'continuing';
  }
  return 'neutral';
};
RealtimeTranscriptionEngine.prototype.boundaryPolicy=function(kind){
  if(kind==='strong'||kind==='likely')return {idle:650,silence:650,hard:1250};
  if(kind==='continuing')return {idle:1500,silence:1500,hard:3000};
  return {idle:950,silence:1000,hard:1900};
};
RealtimeTranscriptionEngine.prototype.startBoundaryMonitor=function(){
  var self=this;if(this.boundaryTimer)return;
  this.lastVoiceAt=Date.now();
  try{
    this.boundaryAc=new (window.AudioContext||window.webkitAudioContext)();
    this.boundaryAn=this.boundaryAc.createAnalyser();this.boundaryAn.fftSize=512;
    this.boundaryAc.createMediaStreamSource(this.stream).connect(this.boundaryAn);
    this.boundaryBuf=new Uint8Array(this.boundaryAn.frequencyBinCount);
    /* 境界判定用の512点とは別に、解析用の2048点を同じ入力から取る。512点では
       YINの探索下限が48kHzで約189Hzになり、男性の話声（85〜180Hz）が丸ごと
       範囲外に落ちる。境界判定のRMS窓は触らない。 */
    if(CFG.prosodyOn){
      var pan=this.boundaryAc.createAnalyser();pan.fftSize=2048;
      this.boundaryAc.createMediaStreamSource(this.stream).connect(pan);
      this.prosody=new ProsodyAnalyzer(pan,this.boundaryAc.sampleRate,
        'live:'+(this.opts.isMic?'mic':(this.opts.route||'audio')));
    }
    if(this.boundaryAc.state==='suspended'){
      var rp=this.boundaryAc.resume();if(rp&&rp.catch)rp.catch(function(){});
    }
  }catch(err){
    this.boundaryAc=null;this.boundaryAn=null;this.boundaryBuf=null;
    if(this.prosody){try{this.prosody.stop();}catch(e2){}this.prosody=null;}
    dlog('stt','live-boundary-audio-FAIL',{err:String((err&&err.message)||err).slice(0,120)});
  }
  dlog('stt','live-boundary-start',{mode:this.boundaryAn?'context+audio+delta':'context+delta',
    threshold:+(CFG.vad/1000).toFixed(4),prosody:this.prosody?this.prosody.source:'off'});
  this.boundaryTimer=setInterval(function(){self.checkBoundaries();},80);
};
RealtimeTranscriptionEngine.prototype.stopBoundaryMonitor=function(){
  if(this.boundaryTimer){clearInterval(this.boundaryTimer);this.boundaryTimer=null;}
  if(this.prosody){try{this.prosody.stop();}catch(e){}this.prosody=null;}
  if(this.boundaryAc){try{this.boundaryAc.close();}catch(e){}}
  this.boundaryAc=null;this.boundaryAn=null;this.boundaryBuf=null;
};
RealtimeTranscriptionEngine.prototype.checkBoundaries=function(){
  if(this.dead||this.closing||!S.running)return;var now=Date.now(),rms=0;
  if(this.boundaryAn&&this.boundaryBuf){
    this.boundaryAn.getByteTimeDomainData(this.boundaryBuf);var sum=0;
    for(var i=0;i<this.boundaryBuf.length;i++){var v=(this.boundaryBuf[i]-128)/128;sum+=v*v;}
    rms=Math.sqrt(sum/this.boundaryBuf.length);this.lastRms=rms;
    if(rms>CFG.vad/1000)this.lastVoiceAt=now;
  }
  /* rmsHint は渡さない。解析器は自分の2048点窓から改めて実効値を出す。 */
  if(this.prosody)this.prosody.sample(now);
  if(segEnabled()){
    if(this.boundaryAn)segVoice(this.seat||S.listenSeat||'A',rms);
    segLiveBoundaries(this);return;
  }
  var self=this;
  Object.keys(this.items).forEach(function(id){
    var x=self.items[id];if(!x||!x.entry||!String(x.text||'').trim()||!x.lastDeltaAt)return;
    var idle=now-x.lastDeltaAt,silence=now-self.lastVoiceAt,kind=self.boundaryContext(x.text,langOf(x.entry.seat));
    var p=self.boundaryPolicy(kind),audioQuiet=!self.boundaryAn||silence>=p.silence;
    var reason='';
    if(idle>=p.hard)reason='delta-timeout';
    else if(idle>=p.idle&&audioQuiet)reason=(kind==='strong'||kind==='likely')?'context-complete':'audio-pause';
    else if((now-x.segmentStarted)>=30000&&idle>=650)reason='max-duration';
    if(reason)self.finalizeSegment(id,x,reason,{context:kind,idleMs:idle,silenceMs:self.boundaryAn?silence:null,rms:rms});
  });
};
RealtimeTranscriptionEngine.prototype.finalizeSegment=function(id,x,reason,meta){
  if(!x||!x.entry)return false;var text=String(x.text||'').trim(),holder=x.entry;
  x.entry=null;x.text='';x.segmentStarted=0;x.segmentNo++;x.committedText+=text;
  if(this.dead||!S.running||this.session!==sessionGen){removeEntry(holder);dlog('stt','stale-result-drop',{provider:'openai-live',item:id});return false;}
  var lang=langOf(holder.seat),raw=text;text=punctuateTranscript(text,lang);
  if(!text||!hasSpeechContent(text)||isEcho(text)){removeEntry(holder);dlog('stt','live-drop',{item:id,chars:text.length,reason:reason});return false;}
  if((S.autoMode&&micSeats().length>1)||!this.seat){
    var g=guessSeatFromText(text);holder.seat=g;holder.srcLang=langOf(g);holder.dstLang=langOf(g==='A'?'B':'A');S.listenSeat=g;updateStatus();lang=holder.srcLang;
  }
  holder.srcText=text;holder.interim=false;render(holder);
  if(CFG.prosodyOn)attachProsody(holder,micProsodySnapshot(text,true,holder.seat));
  meta=meta||{};
  dlog('stt','live-boundary',{item:id,segment:x.segmentNo,reason:reason,context:meta.context||this.boundaryContext(raw,lang),chars:text.length,
    idleMs:meta.idleMs==null?null:Math.round(meta.idleMs),silenceMs:meta.silenceMs==null?null:Math.round(meta.silenceMs)});
  dlog('stt','live-result',{provider:'openai',model:'gpt-live-transcribe',transport:'webrtc',seat:holder.seat,lang:lang,item:id,segment:x.segmentNo,chars:text.length,punctuated:text!==raw,boundary:reason});
  speakSrcNow(holder);translate(holder);return true;
};
RealtimeTranscriptionEngine.prototype.onEvent=function(ev){
  if(this.dead||this.closing||!S.running||this.session!==sessionGen)return;
  var e;try{e=JSON.parse(ev.data);}catch(_){return;}var t=e.type||'',id=e.item_id||e.id||this.fallbackItemId;
  if(t==='input_audio_buffer.speech_started'){var timed=this.item(id);timed.audioStartedAt=Date.now();if(timed.entry)timed.entry.startedAt=timed.audioStartedAt;dlog('speaker','stt-started',{item:id,at:timed.audioStartedAt,serverAudioStartMs:e.audio_start_ms});return;}
  if(t==='input_audio_buffer.speech_stopped'){var timedEnd=this.item(id);timedEnd.audioEndedAt=Date.now();if(timedEnd.entry)timedEnd.entry.audioEndedAt=timedEnd.audioEndedAt;return;}
  if(segLiveEvent(this,e,id))return;
  if(t==='conversation.item.input_audio_transcription.delta'||t==='input_audio_transcription.delta'){
    var delta=String(e.delta||'');if(!delta)return;
    var x=this.item(id),entry=this.ensureEntry(x);x.text+=delta;x.allText+=delta;x.lastDeltaAt=Date.now();x.deltaCount++;
    entry.srcText=x.text;render(entry);
    if(x.deltaCount===1)dlog('stt','live-delta',{item:id,segment:x.segmentNo+1,chars:delta.length,context:this.boundaryContext(x.text,langOf(entry.seat))});
    return;
  }
  if(t==='conversation.item.input_audio_transcription.completed'||t==='input_audio_transcription.completed'){
    var y=this.item(id),serverText=String(e.transcript||'');
    /* completed が全履歴を返す場合、すでにローカル確定した部分を再翻訳しない。
       delta未受信でcompletedだけ来た場合と、末尾だけ増えた場合のみ補完する。 */
    if(serverText&&serverText.indexOf(y.allText)===0&&serverText.length>y.allText.length){
      var tail=serverText.slice(y.allText.length);y.text+=tail;y.allText=serverText;y.lastDeltaAt=Date.now();
      var completedEntry=this.ensureEntry(y);completedEntry.srcText=y.text;render(completedEntry);
    }else if(serverText&&!y.allText&&!y.text){
      y.text=serverText;y.allText=serverText;y.lastDeltaAt=Date.now();
      var onlyEntry=this.ensureEntry(y);onlyEntry.srcText=y.text;render(onlyEntry);
    }else if(serverText&&serverText!==y.allText){
      dlog('stt','live-reconcile',{item:id,serverChars:serverText.length,deltaChars:y.allText.length,action:'keep-local-segments'});
    }
    if(y.entry)this.finalizeSegment(id,y,'server-completed',{context:this.boundaryContext(y.text,langOf(y.entry.seat)),idleMs:0,silenceMs:null});
    else dlog('stt','live-completed',{item:id,chars:serverText.length,pending:0});
    delete this.items[id];return;
  }
  if(t==='error'||e.error){
    var msg=(e.error&&e.error.message)||e.message||'Realtime音声認識エラー';
    dlog('stt','live-FAIL',{model:'gpt-live-transcribe',err:String(msg).slice(0,200)});toast('Realtime音声認識失敗: '+msg);
  }
};
RealtimeTranscriptionEngine.prototype.stop=function(){
  this.dead=true;this.stopBoundaryMonitor();this.closeConnection();
  Object.keys(this.items).forEach(function(k){var e=this.items[k].entry;if(e&&!e.segment)removeEntry(e);},this);this.items={};
  if(this.opts.ownsStream&&this.stream)try{this.stream.getTracks().forEach(function(t){t.stop();});}catch(e){}
  dlog('stt','live-stop',{model:'gpt-live-transcribe',stage:this.connectStage});
};
function segLiveClose(engine,id,x,reason,meta){
  var e=x.entry;if(!e||!e.srcText.trim()||e.segment.cancelled)return;
  segUpdate(e,e.srcText,true);e.segment.finalReason=reason;
  x.segmentRanges=x.segmentRanges||[];
  e.audioEndedAt=e.audioEndedAt||Date.now();x.nextCardStartedAt=e.audioEndedAt;duoSpeakerUpdate(e);duoSpeakerPaint(e);x.segmentRanges.push({entry:e,end:x.text.length});x.cardOffset=x.text.length;x.entry=null;
  dlog('stt','live-card-final',{item:id,cardId:e.id,reason:reason,chars:e.srcText.length,meta:meta||{}});
}
function segLiveBoundaries(engine){
  var now=Date.now();
  Object.keys(engine.items).forEach(function(id){
    var x=engine.items[id],e=x.entry;if(!e||!e.segment||e.segment.cancelled||!e.srcText.trim())return;
    var idle=now-x.lastDeltaAt,kind=engine.boundaryContext(e.srcText,e.srcLang),p=engine.boundaryPolicy(kind);
    var silence=segSilence(e,now),reason='';
    if(idle>=p.hard)reason='delta-timeout';
    else if(idle>=p.idle&&silence!==null&&silence>=p.silence)reason='audio-pause';
    else if(now-e.startedAt>=30000&&idle>=650)reason='max-duration';
    if(!reason&&TurnDecision.liveClose(e,idle,silence,now))reason='turn-complete';
    if(reason){TurnDecision.liveClosed(e,x,reason,p,idle,now);
      segLiveClose(engine,id,x,reason,{context:kind,idleMs:idle,silenceMs:silence});}
  });
}
function segLiveReconcile(engine,x,text){
  // Map all closed-card boundaries through the final transcript correction.
  var old=x.text||'',ranges=x.segmentRanges||[],ends=segMapCardEnds(old,text,ranges.map(function(r){return r.end;})),at=0;
  ranges.forEach(function(r,i){
    var end=Math.max(at,Math.min(text.length,ends[i]));
    if(!r.entry.segment.cancelled){duoLiveAssignSeat(engine,r.entry,text.slice(at,end));segUpdate(r.entry,text.slice(at,end),true);}
    r.end=end;at=end;
  });
  x.cardOffset=at;x.text=text;
  if(x.entry||at<text.length){var e=engine.ensureEntry(x);duoLiveAssignSeat(engine,e,text.slice(at));segUpdate(e,text.slice(at),true);}
}
function segMapCardEnds(old,text,ends){
  var prefix=0,suffix=0;
  while(prefix<old.length&&prefix<text.length&&old[prefix]===text[prefix])prefix++;
  while(suffix<old.length-prefix&&suffix<text.length-prefix&&old[old.length-1-suffix]===text[text.length-1-suffix])suffix++;
  var a=old.slice(prefix),b=text.slice(prefix),map={};
  // Multiple edits (including a new tail) require alignment, not one replacement span.
  if(a.length*b.length<=2000000){
    var width=b.length+1,dp=new Uint32Array((a.length+1)*width),i,j;
    for(i=a.length-1;i>=0;i--)for(j=b.length-1;j>=0;j--)
      dp[i*width+j]=a[i]===b[j]?1+dp[(i+1)*width+j+1]:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
    i=0;j=0;map[prefix]=prefix;
    while(i<a.length){
      if(j<b.length&&a[i]===b[j]){i++;j++;map[prefix+i]=prefix+j;}
      else if(j<b.length&&dp[i*width+j+1]>dp[(i+1)*width+j])j++;
      else {i++;map[prefix+i]=prefix+j;}
    }
  }
  var previous=0;
  return ends.map(function(end){var mapped;
    if(end<=prefix)mapped=end;
    else if(map[end]!==undefined)mapped=map[end];
    else {
      // Large final corrections: use a nearby text anchor, keeping alignment work bounded.
      var anchor=old.slice(Math.max(0,end-32),end),found=text.indexOf(anchor,previous);
      mapped=anchor&&found>=0?found+anchor.length:Math.min(text.length,end+text.length-old.length);
    }
    previous=Math.max(previous,mapped);return previous;
  });
}
function segLiveEvent(engine,event,id){
  if(!segEnabled())return false;
  var t=event.type||'',isDelta=/transcription\.delta$/.test(t),isFinal=/transcription\.completed$/.test(t);
  if(!isDelta&&!isFinal)return false;
  engine.segmentCompleted=engine.segmentCompleted||{};
  if(engine.segmentCompleted[id])return true;
  if(isDelta&&!event.delta)return true;
  var x=engine.item(id),now=Date.now(),previousDeltaAt=x.lastDeltaAt;
  if(isFinal){
    segLiveReconcile(engine,x,String(event.transcript||x.text));
    dlog('stt','live-segment-final',{item:id,chars:x.text.length,cards:(x.segmentRanges||[]).length+(x.entry?1:0)});
    engine.segmentCompleted[id]=now;
    Object.keys(engine.segmentCompleted).forEach(function(k){if(now-engine.segmentCompleted[k]>300000)delete engine.segmentCompleted[k];});
    delete engine.items[id];return true;
  }
  x.text+=String(event.delta||'');x.lastDeltaAt=now;
  var entry=engine.ensureEntry(x),local=x.text.slice(x.cardOffset||0);
  TurnDecision.liveResumed(entry,x,now,String(event.delta||''));
  if(!x.segmentLogAt||now-x.segmentLogAt>=1000){
    dlog('stt','live-segment-delta',{item:id,cardId:entry.id,chars:local.length,deltaChars:String(event.delta||'').length,arrivalGapMs:previousDeltaAt?now-previousDeltaAt:null});x.segmentLogAt=now;
  }
  duoLiveAssignSeat(engine,entry,local);
  segUpdate(entry,local,false);return true;
}
