/* OpenRouter のモデル選択画面を実ブラウザで動かす。OpenRouter は代役（page.route）。
   おすすめ（速さ・精度・安さ・人気）→ 作った会社 → モデル → 試す → 決める、の流れと、
   スマートフォンの幅で画面からはみ出さないこと、Esc で閉じてボタンへ戻ることを見る。
   playwright が要るので E2E 側で回す。 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let chromium;
try{ ({chromium}=require('playwright')); }
catch(err){ console.error('playwright を解決できません。NODE_PATH=$(npm root -g) を付けて実行してください。'); process.exit(2); }
const HTML=fs.readFileSync(path.join(__dirname,'../../index.html'));
const M=(id,name,created,extra)=>Object.assign({id,name,created,architecture:{input_modalities:['text'],output_modalities:['text']},
  pricing:{prompt:'0.0000001',completion:'0.0000004'},supported_parameters:['temperature']},extra||{});
const ALL=[M('deepseek/deepseek-v4.1-flash','DeepSeek V4.1 Flash',30,{reasoning:{mandatory:false}}),M('deepseek/deepseek-v4-flash','DeepSeek V4 Flash',20),
  M('google/gemini-3.8-flash','Gemini 3.8 Flash',29),M('google/gemma-3-27b-it:free','Gemma 3 27B (free)',10,{pricing:{prompt:'0',completion:'0'}}),
  M('openai/gpt-4o-mini','GPT-4o mini',5)];

(async()=>{
  const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end(HTML);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;const tests=[];const test=(n,f)=>{f();tests.push(n);};
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e).slice(0,300)));
    const seen=[],sttSeen=[];
    await page.route('https://openrouter.ai/api/v1/**',route=>{
      const u=new URL(route.request().url()),h=route.request().headers();seen.push({path:u.pathname,q:u.search,auth:!!h.authorization});
      const json=(o)=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(o)});
      if(/\/endpoints$/.test(u.pathname))return json({data:{endpoints:[{latency_last_30m:{p50:420}}]}});
      if(u.pathname.endsWith('/audio/speech')){
        /* 0.3秒ぶんの生の PCM（24kHz・16bit・モノラル） */
        const n=7200,b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/8)*8000),i*2);
        return route.fulfill({status:200,contentType:'audio/pcm',headers:{'access-control-allow-origin':'*'},body:b});
      }
      if(u.pathname.endsWith('/audio/transcriptions')){
        const b=JSON.parse(route.request().postData()||'{}');sttSeen.push({model:b.model,format:b.input_audio&&b.input_audio.format,language:b.language});
        if(b.input_audio&&b.input_audio.format==='webm')return route.fulfill({status:400,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({error:{message:'Unsupported audio format: webm'}})});
        return json({text:'こんにちは'});
      }
      if(u.pathname.endsWith('/models')&&u.searchParams.get('output_modalities')==='transcription')
        return json({data:[M('openai/gpt-4o-mini-transcribe','GPT-4o mini Transcribe',50,{architecture:{input_modalities:['audio'],output_modalities:['transcription']}}),
          M('google/chirp-3','Chirp 3',45,{architecture:{input_modalities:['audio'],output_modalities:['transcription']}})]});
      if(u.pathname.endsWith('/models')&&u.searchParams.get('output_modalities')==='speech')
        return json({data:[M('google/gemini-3.8-flash-tts','Gemini 3.8 Flash TTS',40,{architecture:{input_modalities:['text'],output_modalities:['speech']},supported_voices:['Kore','Puck','Zephyr']})]});
      if(u.pathname.endsWith('/models')){
        const sort=u.searchParams.get('sort');
        if(sort==='latency-low-to-high')return json({data:[ALL[0],ALL[2],ALL[4]]});
        if(sort)return json({data:[ALL[2],ALL[0]]});
        return json({data:ALL});
      }
      if(u.pathname.endsWith('/chat/completions'))return json({provider:'DeepSeek',choices:[{message:{content:"Let's start today's meeting."}}]});
      return json({});
    });
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'load'});
    await page.waitForTimeout(1200);
    const setup=await page.evaluate(()=>{
      openDrawer(true);
      const sel=document.getElementById('provider');sel.value='openrouter';sel.dispatchEvent(new Event('change'));
      const k=document.getElementById('apiKey');k.value='sk-or-test';k.dispatchEvent(new Event('input'));
      return {pick:getComputedStyle(document.getElementById('modelPick')).display,opts:getComputedStyle(document.getElementById('orTransOpts')).display,
        route:document.getElementById('orRoute').value,zdr:document.getElementById('orZdr').checked};
    });
    await page.focus('#modelPick');await page.keyboard.press('Enter');
    await page.waitForSelector('#mpickRecoList .mpick-row');
    await page.waitForFunction(()=>document.querySelector('#mpickRecoList .mpick-lat')&&document.querySelector('#mpickRecoList .mpick-lat').textContent);
    const reco=await page.evaluate(()=>({open:!document.getElementById('mpick').hidden,
      chips:[...document.querySelectorAll('#mpickPresets .mpick-chip')].map(b=>b.textContent),
      on:document.querySelector('#mpickPresets .mpick-chip.on').textContent,
      rows:[...document.querySelectorAll('#mpickRecoList .mpick-row .mpick-id')].map(e=>e.textContent),
      lat:document.querySelector('#mpickRecoList .mpick-lat').textContent,
      badge:document.querySelector('#mpickRecoList .mpick-meta').textContent}));
    await page.click('#mpickPresets [data-preset="quality"]');
    await page.waitForFunction(()=>document.querySelectorAll('#mpickRecoList .mpick-row').length===2);
    await page.click('#mpick [data-tab="all"]');
    await page.waitForSelector('#mpickAllList .mpick-author');
    const authors=await page.evaluate(()=>[...document.querySelectorAll('#mpickAllList .mpick-author')].map(b=>b.textContent));
    await page.click('#mpickAllList .mpick-author >> text=google');
    const google=await page.evaluate(()=>[...document.querySelectorAll('#mpickAllList .mpick-row .mpick-id')].map(e=>e.textContent));
    await page.click('#mpickFree');
    const freeOnly=await page.evaluate(()=>[...document.querySelectorAll('#mpickAllList .mpick-row .mpick-id')].map(e=>e.textContent));
    await page.click('#mpickFree');
    await page.fill('#mpickSearch','flash');
    const search=await page.evaluate(()=>[...document.querySelectorAll('#mpickAllList .mpick-row .mpick-id')].map(e=>e.textContent));
    await page.click('#mpickAllList .mpick-row[data-id="google/gemini-3.8-flash"]');
    await page.click('#mpickTry');
    await page.waitForFunction(()=>/✅/.test(document.getElementById('mpickMsg').textContent));
    const tried=await page.evaluate(()=>({msg:document.getElementById('mpickMsg').textContent,sel:document.getElementById('mpickSel').textContent}));
    await page.click('#mpickOk');
    const picked=await page.evaluate(()=>({model:CFG.model,stored:localStorage.getItem('di.model'),select:document.getElementById('model').value,
      hidden:document.getElementById('mpick').hidden}));
    /* スマートフォンの幅：全面表示で、横にはみ出さない。Esc で閉じてボタンへ戻る。 */
    await page.setViewportSize({width:390,height:780});
    await page.focus('#modelPick');await page.keyboard.press('Enter');
    await page.waitForSelector('#mpickRecoList .mpick-row');
    const mobile=await page.evaluate(()=>{const c=document.querySelector('.mpick-card').getBoundingClientRect();
      return {w:Math.round(c.width),h:Math.round(c.height),vw:innerWidth,overflow:document.getElementById('mpick').scrollWidth>innerWidth};});
    await page.keyboard.press('Escape');
    const closed=await page.evaluate(()=>({hidden:document.getElementById('mpick').hidden,focus:document.activeElement&&document.activeElement.id}));

    /* ③ 読み上げ：OpenRouter を選ぶと、声の一覧がモデルから作られ、生の PCM が鳴る */
    await page.setViewportSize({width:1100,height:900});
    await page.evaluate(()=>{const sel=document.getElementById('ttsMode');sel.value='openrouter';sel.dispatchEvent(new Event('change'));});
    await page.waitForFunction(()=>document.getElementById('orVoiceA').options.length===3);
    const ttsPanel=await page.evaluate(()=>({panel:getComputedStyle(document.getElementById('orTtsOnly')).display,
      model:document.getElementById('orTtsModel').value,
      a:document.getElementById('orVoiceA').value,b:document.getElementById('orVoiceB').value,
      opts:[...document.getElementById('orVoiceA').options].map(o=>o.value),
      option:[...document.getElementById('ttsMode').options].map(o=>o.value)}));
    await page.evaluate(()=>{window.__t0=DLOG.length;TTS_PROVIDERS.openrouter.speak('テストです','ja','A',null);});
    await page.waitForFunction(()=>DLOG.slice(window.__t0).some(e=>(e.m==='play-start'||e.m==='wa-play')&&e.d&&e.d.src==='openrouter'),null,{timeout:15000});
    const ttsPlay=await page.evaluate(()=>{const L=DLOG.slice(window.__t0),ok=L.find(e=>e.m==='openrouter-ok'),wa=L.find(e=>e.m==='wa-play');return Object.assign({},ok&&ok.d,{durMs:wa&&wa.d.dur});});
    await page.evaluate(()=>{const sel=document.getElementById('ttsMode');sel.value='groq';sel.dispatchEvent(new Event('change'));});
    const groqPanel=await page.evaluate(()=>({panel:getComputedStyle(document.getElementById('groqTtsOnly')).display,
      model:document.getElementById('groqTtsModel').value,list:[...document.querySelectorAll('#groqVoiceList option')].map(o=>o.value),
      a:document.getElementById('groqVoiceA').value,plan:document.getElementById('ttsPlan').textContent}));

    /* ④ 音声認識：OpenRouter を選ぶと一覧が読まれ、よく使われているモデルが入る。
       webm を断られたら、ブラウザの中で 16kHz の WAV に変えて送り直す。 */
    await page.evaluate(()=>{const sel=document.getElementById('sttProvider');sel.value='openrouter';sel.dispatchEvent(new Event('change'));
      const k=document.getElementById('sttKey');k.value='sk-or-test';k.dispatchEvent(new Event('input'));});
    await page.waitForFunction(()=>CFG.sttModel==='openai/gpt-4o-mini-transcribe');
    const sttPanel=await page.evaluate(()=>({pick:getComputedStyle(document.getElementById('sttModelPick')).display,
      opts:[...document.getElementById('sttModel').options].map(o=>o.value).filter(v=>v.indexOf('/')>0),four:fourOFileModel()}));
    await page.evaluate(()=>document.getElementById('sttModelPick').click());
    const sttKind=await page.evaluate(()=>MPICK.opts.kind);
    await page.click('#mpick [data-tab="all"]');
    await page.waitForSelector('#mpickAllList .mpick-author');
    const sttAuthors=await page.evaluate(()=>[...document.querySelectorAll('#mpickAllList .mpick-author .mpick-name')].map(e=>e.textContent));
    await page.keyboard.press('Escape');
    const sttRun=await page.evaluate(async()=>{
      /* 本物の OfflineAudioContext で 48kHz の WAV を 16kHz に変える */
      const ctx=new OfflineAudioContext(1,24000,48000),osc=ctx.createOscillator();osc.connect(ctx.destination);osc.start();
      const wav=audioBufferToWav(await ctx.startRendering(),0),small=await blobToWav16k(wav),dv=new DataView(await small.arrayBuffer());
      const fake=new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3])],{type:'audio/webm'});
      /* 変換の前に、webm として一度断られる流れ（中身は変換できる WAV にしておく） */
      /* AUTO で2つの言語をマイク1本で聞くときは言語を送らない（v1.49.31 の決まり）。ここでは席の言語を送らせる */
      S.autoMode=false;
      const text=await openrouterSTT(wav.slice(0,wav.size,'audio/webm'),'ja',{});
      return {rate:dv.getUint32(24,true),ch:dv.getUint16(22,true),bytes:small.size,text:text,wavNext:!!OR_STT_WAV[CFG.sttModel]};
    });

    test('choosing OpenRouter shows the picker button and the OpenRouter options, speed routing by default',()=>{
      assert.notEqual(setup.pick,'none');assert.notEqual(setup.opts,'none');
      assert.equal(setup.route,'latency');assert.equal(setup.zdr,false);
    });
    test('the picker opens on the speed recommendations with latency and marks',()=>{
      assert.equal(reco.open,true);assert.deepEqual(reco.chips,['速さ','精度','安さ','人気']);assert.equal(reco.on,'速さ');
      assert.deepEqual(reco.rows,['deepseek/deepseek-v4.1-flash','google/gemini-3.8-flash','openai/gpt-4o-mini']);
      assert.match(reco.lat,/約0\.42秒/);assert.match(reco.badge,/推論あり/);
    });
    test('each recommendation asks the list with its own sort; lists go without the key',()=>{
      const q=seen.filter(s=>s.path.endsWith('/models')).map(s=>s.q);
      assert.ok(q.some(x=>/sort=latency-low-to-high&limit=3&category=translation/.test(x)));
      assert.ok(q.some(x=>/sort=intelligence-high-to-low/.test(x)));
      assert.ok(seen.filter(s=>s.path.endsWith('/models')).every(s=>!s.auth));
    });
    test('"all" lists makers with counts, then that maker\'s models newest first',()=>{
      assert.deepEqual(authors,['deepseek2 件','google2 件','openai1 件']);
      assert.deepEqual(google,['google/gemini-3.8-flash','google/gemma-3-27b-it:free']);
    });
    test('free-only and search narrow the list; search crosses makers',()=>{
      assert.deepEqual(freeOnly,['google/gemma-3-27b-it:free']);
      assert.deepEqual(search,['deepseek/deepseek-v4.1-flash','google/gemini-3.8-flash','deepseek/deepseek-v4-flash']);
    });
    test('trying translates a sample and shows the time; picking sets and stores the model',()=>{
      assert.match(tried.msg,/✅ [\d.]+秒：Let's start/);assert.match(tried.sel,/Gemini 3\.8 Flash/);
      assert.equal(picked.model,'google/gemini-3.8-flash');assert.equal(picked.stored,'google/gemini-3.8-flash');
      assert.equal(picked.select,'google/gemini-3.8-flash');assert.equal(picked.hidden,true);
    });
    test('on a phone the picker fills the screen without sideways scroll, and Esc returns to the button',()=>{
      assert.equal(mobile.w,mobile.vw);assert.equal(mobile.overflow,false);
      assert.equal(closed.hidden,true);assert.equal(closed.focus,'modelPick');
    });
    test('TTS offers OpenRouter and Groq; the OpenRouter voices come from the model list, one per seat',()=>{
      assert.ok(ttsPanel.option.includes('openrouter')&&ttsPanel.option.includes('groq'));
      assert.notEqual(ttsPanel.panel,'none');assert.equal(ttsPanel.model,'google/gemini-3.8-flash-tts');
      assert.deepEqual(ttsPanel.opts,['Kore','Puck','Zephyr']);assert.equal(ttsPanel.a,'Kore');assert.equal(ttsPanel.b,'Puck');
    });
    test('raw PCM from OpenRouter is wrapped as 24 kHz WAV and played through the normal queue',()=>{
      assert.equal(ttsPlay.kind,'pcm');assert.equal(ttsPlay.rate,24000);assert.equal(ttsPlay.voice,'Kore');assert.equal(ttsPlay.bytes,14400);
      assert.equal(ttsPlay.durMs,300,'0.3 s at 24 kHz plays for 0.3 s');
    });
    test('Groq TTS lists its English voices and says Japanese goes to the browser voice',()=>{
      assert.notEqual(groqPanel.panel,'none');assert.equal(groqPanel.model,'canopylabs/orpheus-v1-english');
      assert.deepEqual(groqPanel.list,['autumn','diana','hannah','austin','Daniel','troy']);assert.equal(groqPanel.a,'autumn');
      assert.match(groqPanel.plan,/英語だけです/);
    });
    test('STT offers OpenRouter; its list loads without a key question and the most used model is set',()=>{
      assert.notEqual(sttPanel.pick,'none');
      assert.deepEqual(sttPanel.opts.sort(),['google/chirp-3','openai/gpt-4o-mini-transcribe']);
      assert.equal(sttPanel.four,true,'the OpenAI 4o model uses the ordered file buffer');
      assert.equal(sttKind,'stt');
      assert.deepEqual(sttAuthors,['google','openai'],'the STT picker lists only transcription models');
    });
    test('a webm refusal is converted to 16 kHz mono WAV in the browser and sent again',()=>{
      assert.equal(sttRun.rate,16000);assert.equal(sttRun.ch,1);assert.equal(sttRun.bytes,44+8000*2);
      assert.equal(sttRun.text,'こんにちは');assert.equal(sttRun.wavNext,true);
      assert.deepEqual(sttSeen.map(x=>x.format),['webm','wav']);
      assert.ok(sttSeen.every(x=>x.model==='openai/gpt-4o-mini-transcribe'&&x.language==='ja'));
    });
    test('no script error',()=>{ assert.equal(pageErrors.length,0,pageErrors.join(' | ')); });
    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    await browser?.close();await new Promise(r=>server.close(r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
