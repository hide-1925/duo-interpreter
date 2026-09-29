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
      window.fetch=(url,opts)=>{window.__fetch.push({url:String(url),method:opts&&opts.method,headers:opts&&opts.headers});
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
    assert.deepEqual(pageErrors,[],'no page errors');tests.push('no page errors');
    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    if(browser)await browser.close();
    server.close();
  }
})().catch(err=>{console.error(err);process.exit(1);});
