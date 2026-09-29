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
    assert.deepEqual(pageErrors,[],'no page errors');tests.push('no page errors');
    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    if(browser)await browser.close();
    server.close();
  }
})().catch(err=>{console.error(err);process.exit(1);});
