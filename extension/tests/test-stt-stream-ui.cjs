/* ストリーミング認識（ElevenLabs・AssemblyAI・Soniox）を実ブラウザで通す（STTマルチプロバイダ開発仕様書 §5〜§7）。
   本物の AudioWorklet と変換で 440Hz の音を PCM16・16kHz にし、偽の WebSocket と fetch（一時キーの発行）へ送る。
   各社へは接続しない。確かめるのは、一時キーの発行先・接続先・最初のメッセージ・音声の形（100ms＝3,200バイト）・
   受信からカードができること・止めたときの終わり方。
   playwright が必要なので gate ではなく E2E 側で回す。 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let chromium;
try{ ({chromium}=require('playwright')); }
catch(err){
  console.error('playwright を解決できません。NODE_PATH=$(npm root -g) を付けて実行してください。');
  process.exit(2);
}
const HTML=fs.readFileSync(path.join(__dirname,'../../index.html'));
const tests=[];

(async()=>{
  const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end(HTML);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e).slice(0,300)));
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'load'});await page.waitForTimeout(1000);
    await page.evaluate(()=>{
      window.__ws=[];window.__fetch=[];
      window.WebSocket=class{
        constructor(url){this.url=url;this.readyState=0;this.sent=[];this.bufferedAmount=0;this.binaryType='blob';window.__ws.push(this);
          setTimeout(()=>{this.readyState=1;if(this.onopen)this.onopen();},20);}
        send(d){this.sent.push(d);}
        close(code){this.closedWith=code;this.readyState=3;}
        emit(o){if(this.onmessage)this.onmessage({data:typeof o==='string'?o:JSON.stringify(o)});}
      };
      window.__down=[];
      window.fetch=(url,opts)=>{window.__fetch.push({url:String(url),method:opts&&opts.method,headers:opts&&opts.headers});
        if(window.__down.some(h=>String(url).includes(h)))return Promise.resolve({ok:false,status:503,headers:{get:()=>''},text:()=>Promise.resolve('unavailable')});
        return Promise.resolve({ok:true,status:200,headers:{get:()=>''},json:()=>Promise.resolve({token:'tmp-tok-123456',api_key:'tmp-key-123456'}),text:()=>Promise.resolve('')});};
      const ac=new AudioContext(),osc=ac.createOscillator(),dest=ac.createMediaStreamDestination();
      osc.frequency.value=440;osc.connect(dest);osc.start();window.__stream=dest.stream;
      KEYS['stt:soniox']=KEYS['stt:assemblyai']=KEYS['stt:elevenlabs']='account-key-abcdef';
      CFG.segmentMode='balanced';S.running=true;
    });
    const run=async(provider,ready)=>page.evaluate(async({provider,ready})=>{
      window.__ws=[];window.__fetch=[];S.entries.slice().forEach(e=>{try{removeEntry(e);}catch(_){}} );
      const h=new SttLiveHost(provider,'A',window.__stream,{isMic:true});
      const started=h.start();
      await new Promise(r=>setTimeout(r,60));
      const ws=window.__ws[0];
      if(ready)ws.emit(ready);
      await started;
      await new Promise(r=>setTimeout(r,900));
      const frames=ws.sent.filter(x=>x instanceof ArrayBuffer),text=ws.sent.filter(x=>typeof x==='string');
      let pcm=null;
      if(frames.length)pcm=new Int16Array(frames[frames.length-1]);
      else if(text.length>1){const b=atob(JSON.parse(text[text.length-1]).audio_base_64);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);pcm=new Int16Array(u.buffer);}
      const rms=pcm?Math.sqrt(pcm.reduce((s,v)=>s+v*v,0)/pcm.length):0;
      return {h:null,url:ws.url,fetch:window.__fetch.map(f=>({url:f.url,method:f.method,headers:f.headers})),
        firstText:text[0]||null,textCount:text.length,frameBytes:frames.map(f=>f.byteLength),pcmLen:pcm?pcm.length:0,rms,
        id:(window.__hosts=(window.__hosts||[])).push(h)-1};
    },{provider,ready});
    const finish=async(id,msgs,wait)=>page.evaluate(async({id,msgs,wait})=>{
      const h=window.__hosts[id],ws=window.__ws[0];
      for(const m of msgs){ws.emit(m);await new Promise(r=>setTimeout(r,40));}
      await new Promise(r=>setTimeout(r,wait||200));
      const cards=S.entries.map(e=>({text:e.segment?e.segment.text:e.srcText,final:e.segment?e.segment.final:!e.interim}));
      h.stop();
      return {cards,last:ws.sent[ws.sent.length-1],closedWith:ws.closedWith,metrics:typeof STT_LIVE_STATS==='object'};
    },{id,msgs,wait});

    /* Soniox：最初の JSON に一時キーと v5 の区切りの設定。音声はバイナリ。 */
    let r=await run('soniox',null);
    assert.equal(r.fetch.length,1);assert.equal(r.fetch[0].url,'https://api.soniox.com/v1/auth/temporary-api-key');
    assert.equal(r.fetch[0].headers.Authorization,'Bearer account-key-abcdef');
    assert.equal(r.url,'wss://stt-rt.soniox.com/transcribe-websocket');
    const hello=JSON.parse(r.firstText);
    assert.equal(hello.api_key,'tmp-key-123456');assert.equal(hello.model,'stt-rt-v5');assert.equal(hello.audio_format,'pcm_s16le');
    assert.equal(hello.sample_rate,16000);assert.equal(hello.endpoint_latency_adjustment_level,0);
    tests.push('soniox: temporary key from the issuer, then the config message with it');
    assert.ok(r.frameBytes.length>=4,'about ten 100 ms frames a second, got '+r.frameBytes.length);
    assert.ok(r.frameBytes.every(b=>b===3200),'every frame is 100 ms of PCM16 at 16 kHz: '+r.frameBytes.join(','));
    assert.ok(r.rms>2000,'the 440 Hz tone arrives as audio, rms '+r.rms);
    tests.push('the real AudioWorklet sends 100 ms PCM16 frames of the actual audio');
    const t=(x,f)=>({text:x,is_final:!!f,confidence:1});
    let f=await finish(r.id,[{tokens:[t('今日は'),t('晴れ')]},{tokens:[t('今日は',1),t('晴れです。',1),t('<end>',1)]}],300);
    assert.deepEqual(f.cards,[{text:'今日は晴れです。',final:true}]);
    assert.equal(f.last,'','stop sends the empty message that ends a Soniox stream');assert.equal(f.closedWith,1000);
    tests.push('soniox: tokens become a closed card at <end>, and stop ends the stream');

    /* AssemblyAI：Begin を待ってから音声。URL に一時トークン。 */
    r=await run('assemblyai',{type:'Begin',id:'s1',expires_at:0});
    assert.equal(r.fetch[0].url,'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60');
    assert.equal(r.fetch[0].headers.Authorization,'account-key-abcdef');
    const u=new URL(r.url);
    assert.equal(u.origin+u.pathname,'wss://streaming.assemblyai.com/v3/ws');
    assert.equal(u.searchParams.get('token'),'tmp-tok-123456');assert.equal(u.searchParams.get('speech_model'),'universal-3-5-pro');
    assert.equal(u.searchParams.get('mode'),'balanced');assert.equal(u.searchParams.get('continuous_partials'),'true');
    assert.equal(r.firstText,null,'no JSON before audio');
    assert.ok(r.frameBytes.length>=4&&r.frameBytes.every(b=>b===3200));
    f=await finish(r.id,[{type:'Turn',turn_order:0,end_of_turn:false,turn_is_formatted:false,transcript:'Hello there',words:[]},
      {type:'Turn',turn_order:0,end_of_turn:true,turn_is_formatted:true,transcript:'Hello there.',words:[]}],300);
    assert.deepEqual(f.cards,[{text:'Hello there.',final:true}]);
    assert.equal(f.last,'{"type":"Terminate"}');
    tests.push('assemblyai: token in the URL, audio after Begin, a turn becomes a card, Terminate on stop');

    /* ElevenLabs：session_started を待ってから、JSON（base64）で音声。 */
    r=await run('elevenlabs',{message_type:'session_started',session_id:'x',config:{}});
    assert.equal(r.fetch[0].url,'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
    assert.equal(r.fetch[0].headers['xi-api-key'],'account-key-abcdef');
    const e=new URL(r.url);
    assert.equal(e.searchParams.get('token'),'tmp-tok-123456');assert.equal(e.searchParams.get('audio_format'),'pcm_16000');
    assert.equal(e.searchParams.get('vad_silence_threshold_secs'),'1.5');assert.equal(e.searchParams.get('min_silence_duration_ms'),'100');
    assert.ok(r.textCount>=4,'audio chunks as JSON messages');assert.equal(r.pcmLen,1600);assert.ok(r.rms>2000);
    f=await finish(r.id,[{message_type:'partial_transcript',text:'私は'},{message_type:'partial_transcript',text:'私は今日'},
      {message_type:'committed_transcript',text:'私は今日。'}],300);
    assert.deepEqual(f.cards,[{text:'私は今日。',final:true}],'partials replace, never append');
    tests.push('elevenlabs: single-use token, VAD values in the URL, base64 PCM16, partials replace');
    assert.ok(!r.url.includes('account-key-abcdef'),'the account key never goes into the WebSocket URL');
    tests.push('the account key never reaches the WebSocket');

    /* 自動フォールバック（§14.3）。Soniox の一時キー発行が 503 のとき、OFF なら止まり、ON なら予備1の AssemblyAI で続ける。 */
    const fb=await page.evaluate(async()=>{
      const out={};window.__down=['api.soniox.com'];
      CFG.sttProvider='soniox';CFG.sttModel='stt-rt-v5';CFG.sttAutoFallback='off';
      window.__ws=[];window.__fetch=[];
      let h=new SttLiveHost('soniox','A',window.__stream,{isMic:true});
      try{await h.start();out.off='started';}catch(e){out.off=e.message;}
      out.offSockets=window.__ws.length;
      CFG.sttAutoFallback='on';CFG.sttFallback1='assemblyai';CFG.sttFallback2='';CFG.sttFallback3='';
      window.__ws=[];window.__fetch=[];sttLiveStatsReset();S.entries.slice().forEach(e=>{try{removeEntry(e);}catch(_){}} );
      h=new SttLiveHost('soniox','A',window.__stream,{isMic:true});
      const started=h.start();
      await new Promise(r=>setTimeout(r,80));
      const ws=window.__ws[0];out.url=ws&&ws.url;ws.emit({type:'Begin',id:'s2',expires_at:0});
      await started;
      out.fetch=window.__fetch.map(f=>f.url);out.provider=h.provider;out.msg=sttLiveMsg('mic',h);
      await new Promise(r=>setTimeout(r,400));
      out.frames=ws.sent.filter(x=>x instanceof ArrayBuffer).length;
      ws.emit({type:'Turn',turn_order:0,end_of_turn:true,turn_is_formatted:true,transcript:'Backup works.',words:[]});
      await new Promise(r=>setTimeout(r,300));
      out.cards=S.entries.map(e=>e.segment?e.segment.text:e.srcText);
      out.diag=sttLiveFallbackSummary();
      h.stop();out.last=ws.sent[ws.sent.length-1];
      window.__down=[];CFG.sttAutoFallback='off';
      return out;
    });
    assert.match(fb.off,/Soniox token失敗 503/);assert.equal(fb.offSockets,0);
    tests.push('fallback OFF: an issuer outage stops with the chosen provider\'s error');
    assert.deepEqual(fb.fetch,['https://api.soniox.com/v1/auth/temporary-api-key','https://streaming.assemblyai.com/v3/token?expires_in_seconds=60']);
    assert.equal(fb.provider,'assemblyai');assert.match(fb.url,/^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/);
    assert.ok(fb.frames>=2,'audio flows to the backup');assert.deepEqual(fb.cards,['Backup works.']);
    assert.match(fb.msg,/Soniox につながらないため、自動フォールバックで AssemblyAI に切り替えました/);
    assert.match(fb.diag,/切替 soniox→assemblyai$/);assert.equal(fb.last,'{"type":"Terminate"}');
    tests.push('fallback ON: the same audio moves to the first backup, cards come from it, and stop ends it');

    /* 発行経路（§8.3）。relay は内容スクリプトの代わりをページ内に置き、broker は偽の Broker。
       どちらも、発行元へのページからの fetch が無いこと、WebSocket に返ってきた一時キーが載ることを見る。 */
    const route=await page.evaluate(async()=>{
      const out={};CFG.sttAutoFallback='off';
      window.__relaySeen=[];
      window.addEventListener('duo-stt-token-request',(e)=>{const d=JSON.parse(e.detail);window.__relaySeen.push(d.request);
        window.dispatchEvent(new CustomEvent('duo-turn-reply',{detail:JSON.stringify({id:d.id,ok:true,status:200,text:'{"token":"relay-tok-000555"}'})}));});
      window.dispatchEvent(new CustomEvent('duo-turn-bridge',{detail:JSON.stringify({ready:true,stt:true})}));
      CFG.sttProvider='assemblyai';CFG.sttModel='universal-3-5-pro';CFG.sttCredentialRoute='relay';
      window.__ws=[];window.__fetch=[];
      let h=new SttLiveHost('assemblyai','A',window.__stream,{isMic:true});
      let started=h.start();await new Promise(r=>setTimeout(r,80));
      let ws=window.__ws[0];ws.emit({type:'Begin',id:'s3',expires_at:0});await started;
      out.relay={fetch:window.__fetch.map(f=>f.url),seen:window.__relaySeen,token:new URL(ws.url).searchParams.get('token'),diag:sttCredentialSummary()};
      h.stop();
      CFG.sttProvider='soniox';CFG.sttModel='stt-rt-v5';CFG.sttCredentialRoute='broker';CFG.sttBrokerUrl='https://broker.example.com/duo';
      const saved=KEYS['stt:soniox'];delete KEYS['stt:soniox'];
      window.__ws=[];window.__fetch=[];
      h=new SttLiveHost('soniox','A',window.__stream,{isMic:true});
      await h.start();await new Promise(r=>setTimeout(r,300));ws=window.__ws[0];
      out.broker={fetch:window.__fetch.map(f=>({url:f.url,method:f.method,headers:f.headers})),hello:JSON.parse(ws.sent[0]),
        frames:ws.sent.filter(x=>x instanceof ArrayBuffer).length};
      h.stop();KEYS['stt:soniox']=saved;CFG.sttCredentialRoute='direct';CFG.sttBrokerUrl='';
      return out;
    });
    assert.deepEqual(route.relay.fetch,[],'relay: the page itself does not call the issuer');
    assert.deepEqual(route.relay.seen,[{provider:'assemblyai',key:'account-key-abcdef'}]);
    assert.equal(route.relay.token,'relay-tok-000555');assert.equal(route.relay.diag,'relay（拡張：接続済み）');
    tests.push('relay: the key goes to the extension bridge, and the WebSocket uses the temporary key it returns');
    assert.deepEqual(route.broker.fetch,[{url:'https://broker.example.com/duo/token/stt/soniox',method:'POST',headers:{'Content-Type':'application/json'}}]);
    assert.equal(route.broker.hello.api_key,'tmp-tok-123456','the broker contract field (token), not Soniox\'s own api_key');assert.ok(route.broker.frames>=1);
    tests.push('broker: with no Soniox key on the page, the broker token opens the stream and audio flows');

    /* 画面取込を閉じたとき（v1.53.1）。共有音声の認識が黙って止まらず、知らせが出て、開いていたカードは閉じ、
       ほかの入力（マイク）の認識は残る。同じ回のうちに取り込み直すと、共有音声の認識だけが再開する。 */
    const ov=await page.evaluate(async()=>{
      const out={};const toasts=[];const realToast=window.toast;window.toast=(m,ok)=>{toasts.push(m);};
      CFG.sttProvider='soniox';CFG.sttModel='stt-rt-v5';CFG.sttCredentialRoute='direct';CFG.sttAutoFallback='off';
      CFG.srcA='mic';CFG.srcB='display';CFG.displaySttRoute='auto';S.running=true;
      S.entries.slice().forEach(e=>{try{removeEntry(e);}catch(_){}} );
      const mic={stop(){mic.stopped=true;},stream:null};engines=[mic];
      const ac=new AudioContext(),mk=()=>{const o=ac.createOscillator(),d=ac.createMediaStreamDestination();o.connect(d);o.start();return d.stream.getAudioTracks()[0];};
      overlaySession.audioTrack=mk();overlaySession.opened=true;
      window.__ws=[];window.__fetch=[];
      out.route=effectiveDisplaySttRoute();
      const info=await getDisplayAudioForStt();const h=await startDisplayEngine('B',out.route,info);
      await new Promise(r=>setTimeout(r,250));
      const ws1=window.__ws[0];
      ws1.emit({tokens:[{text:'Half a sentence',is_final:false}]});await new Promise(r=>setTimeout(r,150));
      out.openBefore=S.entries.filter(e=>e.seat==='B').map(e=>e.segment?e.segment.final:!e.interim);
      const gen=sessionGen;
      overlaySession.close();
      out.afterClose={engines:engines.length,micAlive:engines[0]===mic&&!mic.stopped,hostDead:h.dead,
        toast:toasts[toasts.length-1]||'',gen:overlaySession.sttStoppedGen===gen,
        cards:S.entries.filter(e=>e.seat==='B').map(e=>({final:e.segment?e.segment.final:!e.interim,reason:e.segment&&e.segment.finalReason}))};
      overlaySession.audioTrack=mk();
      out.resumed=overlaySttResume();
      await new Promise(r=>setTimeout(r,300));
      out.afterResume={engines:engines.length,micAlive:engines[0]===mic&&!mic.stopped,sockets:window.__ws.length,
        newHost:engines[1]&&engines[1].constructor.name,seat:engines[1]&&engines[1].seat,flagCleared:overlaySession.sttStoppedGen===null};
      out.twice=overlaySttResume();
      engines.slice(1).forEach(e=>e.stop());engines=[];overlaySession.audioTrack=null;overlaySession.opened=false;
      window.toast=realToast;S.running=true;
      return out;
    });
    assert.equal(ov.route,'api');
    assert.deepEqual(ov.openBefore,[false],'a card is open when the capture closes');
    assert.equal(ov.afterClose.engines,1);assert.equal(ov.afterClose.micAlive,true);assert.equal(ov.afterClose.hostDead,true);
    assert.match(ov.afterClose.toast,/画面取込を閉じたため、共有音声の認識を止めました。マイクの認識は続いています。/);
    assert.match(ov.afterClose.toast,/もう一度取り込むと、共有音声の認識を再開します/);
    assert.deepEqual(ov.afterClose.cards,[{final:true,reason:'source-stopped'}],'the open card is closed with its text, not left waiting');
    assert.equal(ov.afterClose.gen,true);
    tests.push('closing the capture overlay stops shared-audio recognition with a message, closes its card, and keeps the mic');
    assert.equal(ov.resumed,true);
    assert.deepEqual(ov.afterResume,{engines:2,micAlive:true,sockets:2,newHost:'SttLiveHost',seat:'B',flagCleared:true});
    assert.equal(ov.twice,false,'resumes once');
    tests.push('capturing again in the same session restarts only the shared-audio recognition');
    assert.deepEqual(pageErrors,[],'no page errors');tests.push('no page errors');
    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    if(browser)await browser.close();
    server.close();
  }
})().catch(err=>{console.error(err);process.exit(1);});
