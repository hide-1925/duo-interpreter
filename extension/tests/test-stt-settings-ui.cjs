/* ストリーミング認識の設定欄（STTマルチプロバイダ開発仕様書 §10）が実ブラウザで生え、
   選んだ Provider の欄だけを出し、既存の保存経路へ相乗りするかを確かめる。
   欄は JS から注入するので index.html の静的 markup では検証できない。
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
    browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream','--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e).slice(0,300)));
    const url='http://127.0.0.1:'+server.address().port;
    await page.goto(url,{waitUntil:'load'});await page.waitForTimeout(1200);

    const r=await page.evaluate(()=>{
      const panel=document.getElementById('sttLivePanel'),out={};
      out.exists=!!panel;out.hiddenForWebSpeech=panel.style.display==='none';
      /* OpenAI を選び、モデルを gpt-live-transcribe にする（画面の onchange と同じ経路）。 */
      const prov=document.getElementById('sttProvider');prov.value='openai';prov.onchange.call(prov);
      fourOSetModel('gpt-live-transcribe');
      out.shownForLive=panel.style.display==='';
      out.openaiRow=document.getElementById('sttLive_openai').style.display==='';
      const sel=document.getElementById('sttLiveDelay');
      out.tag=sel.tagName;out.value=sel.value;
      out.options=[...sel.options].map(o=>[o.value,o.textContent]);
      out.summary=document.getElementById('sttLiveSummary').textContent;
      out.className=panel.className;
      sel.value='high';sel.dispatchEvent(new Event('change'));
      out.after=[CFG.sttLiveDelay,localStorage.getItem('di.sttLiveDelay')];
      out.summaryAfter=document.getElementById('sttLiveSummary').textContent;
      out.sent=STT_LIVE_PROVIDERS.openai.session(new SttLiveHost('openai','A',null,{})).audio.input.transcription.delay;
      /* ほかのモデルに替えると欄は消える。 */
      fourOSetModel('gpt-4o-mini-transcribe');
      out.hiddenForRest=panel.style.display==='none';
      fourOSetModel('gpt-live-transcribe');
      return out;
    });
    assert.ok(r.exists,'the panel must be injected');tests.push('the streaming settings panel is injected');
    assert.ok(r.hiddenForWebSpeech,'hidden while Web Speech is selected');
    assert.ok(r.shownForLive&&r.openaiRow,'shown for gpt-live-transcribe');
    assert.ok(r.hiddenForRest,'hidden again for a file-based model');
    tests.push('the panel appears only while a streaming model is selected');
    assert.equal(r.tag,'SELECT');assert.equal(r.value,'low');
    assert.deepEqual(r.options.map(o=>o[0]),['minimal','low','medium','high','xhigh']);
    assert.deepEqual(r.options.filter(o=>o[1].includes('（既定）')).map(o=>o[0]),['low'],'only the default carries （既定）');
    tests.push('delay is a pull-down with five values and low marked as the default');
    assert.match(r.className,/\badv\b/);assert.match(r.className,/\bpanel-form\b/);
    tests.push('the injected panel uses adv panel-form (設定UI設計指針.md §4)');
    assert.match(r.summary,/delay low/);assert.match(r.summaryAfter,/delay high/);
    assert.deepEqual(r.after,['high','high']);assert.equal(r.sent,'high');
    tests.push('a change reaches CFG, localStorage, the summary and the session that is sent');

    await page.reload({waitUntil:'load'});await page.waitForTimeout(1200);
    const again=await page.evaluate(()=>({value:document.getElementById('sttLiveDelay').value,
      shown:document.getElementById('sttLivePanel').style.display===''}));
    assert.deepEqual(again,{value:'high',shown:true});
    tests.push('the choice survives a reload');

    /* ElevenLabs・AssemblyAI・Soniox（Phase 2〜4）。 */
    const p=await page.evaluate(()=>{
      const out={},prov=document.getElementById('sttProvider');
      const vis=(id)=>{let el=document.getElementById(id);while(el){if(el.style&&el.style.display==='none')return false;el=el.parentElement;}return true;};
      const choice=(prop)=>STT_LIVE_CHOICES[prop];
      for(const id of ['elevenlabs','assemblyai','soniox']){
        prov.value=id;prov.onchange.call(prov);
        const rows=STT_LIVE_PANELS.filter(x=>x.provider===id||x.provider==='common').flatMap(x=>x.rows).filter(r=>r.prop);
        out[id]={panel:vis('sttLivePanel'),own:vis('sttLive_'+id),others:['openai','elevenlabs','assemblyai','soniox'].filter(x=>x!==id).map(x=>vis('sttLive_'+x)),
          chunk:vis('sttLiveRow_sttChunkMs'),model:document.getElementById('sttModel').value,
          fetchHidden:document.getElementById('fetchSttModels').style.display==='none',placeholder:document.getElementById('sttKey').placeholder,
          selects:rows.map(r=>{const el=document.getElementById(r.prop);return {prop:r.prop,tag:el.tagName,
            values:[...el.options].map(o=>o.value),marked:[...el.options].filter(o=>o.textContent.includes('（既定）')).map(o=>o.value),
            expected:choice(r.prop).values.map(v=>v[0]),def:choice(r.prop).def,value:el.value};}),
          summary:document.getElementById('sttLiveSummary').textContent};
      }
      /* Soniox の「組み合わせ」は3つの欄をまとめて変え、個別に変えると「個別に選ぶ」に戻る。 */
      const combo=document.getElementById('sttSonioxPreset');out.comboStart=combo.value;
      combo.value='fast';combo.dispatchEvent(new Event('change'));
      out.fast=[CFG.sttSonioxEndpointLevel,CFG.sttSonioxEndpointSensitivity,CFG.sttSonioxMaxEndpointDelayMs,
        localStorage.getItem('di.sttSonioxEndpointLevel'),document.getElementById('sttSonioxEndpointLevel').value,combo.value];
      out.helloAfterFast=STT_LIVE_PROVIDERS.soniox.performance();
      const lv=document.getElementById('sttSonioxEndpointLevel');lv.value='1';lv.dispatchEvent(new Event('change'));
      out.custom=combo.value;
      combo.value='default';combo.dispatchEvent(new Event('change'));out.backToDefault=[CFG.sttSonioxEndpointLevel,combo.value];
      prov.value='openai';prov.onchange.call(prov);fourOSetModel('gpt-live-transcribe');
      out.openaiChunk=vis('sttLiveRow_sttChunkMs');out.openaiCommon=vis('sttLive_common');
      return out;
    });
    for(const id of ['elevenlabs','assemblyai','soniox']){
      const x=p[id];
      assert.ok(x.panel&&x.own,id+': its own rows are shown');assert.deepEqual(x.others,[false,false,false],id+': no other provider rows');
      assert.ok(x.chunk,id+': the chunk length row is shown for WebSocket providers');
      assert.ok(x.fetchHidden,id+': no model-list fetch button');
      for(const s of x.selects){
        assert.equal(s.tag,'SELECT',s.prop+' must be a pull-down (D-5)');
        assert.deepEqual(s.values,s.expected,s.prop+' options');
        assert.deepEqual(s.marked,[s.def],s.prop+': only the default carries （既定）');
      }
    }
    tests.push('every ElevenLabs, AssemblyAI and Soniox setting is a pull-down with only its default marked');
    assert.equal(p.elevenlabs.model,'scribe_v2_realtime');assert.equal(p.assemblyai.model,'universal-3-5-pro');assert.equal(p.soniox.model,'stt-rt-v5');
    assert.match(p.assemblyai.placeholder,/翻訳欄のキーは使いません/);assert.match(p.elevenlabs.placeholder,/ElevenLabs/);
    assert.match(p.soniox.summary,/Soniox：endpoint_latency_adjustment_level 0/);
    tests.push('choosing a provider selects its default model and explains which key it uses');
    assert.equal(p.comboStart,'default');
    assert.deepEqual(p.fast,['2','0.3','1500','2','2','fast']);
    assert.deepEqual(p.helloAfterFast,{endpoint_latency_adjustment_level:2,endpoint_sensitivity:0.3,max_endpoint_delay_ms:1500});
    assert.equal(p.custom,'custom');assert.deepEqual(p.backToDefault,['0','default']);
    tests.push('the Soniox combination sets its three fields, and an individual change shows 個別に選ぶ');
    assert.equal(p.openaiChunk,false,'gpt-live sends a WebRTC track, not chunks');assert.equal(p.openaiCommon,true);
    tests.push('gpt-live shows the common card-close row but not the chunk length');
    assert.deepEqual(pageErrors,[],'no page errors');tests.push('no page errors');
    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    if(browser)await browser.close();
    server.close();
  }
})().catch(err=>{console.error(err);process.exit(1);});
