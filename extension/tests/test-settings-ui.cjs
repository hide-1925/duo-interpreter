/* 判断層の設定UIが実ブラウザで生え、既存の永続化経路へ正しく相乗りするかを確認する。
   UIはJSから注入するため、index.html の静的markupを見ても検証できない。
   playwright が必要なので gate ではなく E2E 側で回す。 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let chromium;
try{ ({chromium}=require('playwright')); }
catch(err){
  console.error('playwright を解決できません。NODE_PATH=$(npm root -g) を付けて実行してください。');
  process.exit(2);
}

const HTML=fs.readFileSync(path.join(__dirname,'../../index.html'));
const CONTROLS=['turnDecisionMode','turnDecisionLangEn','turnDecisionLangJa','turnDecisionProsody',
  'turnDecisionContextTurns','turnFloorMaxWaitMs','turnFloorExpiry','turnTraceMode','turnDecisionRawLog'];

(async()=>{
  const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end(HTML);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream','--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e).slice(0,300)));
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'load'});
    await page.waitForTimeout(1500);

    const r=await page.evaluate(controls=>{
      const present={};
      for(const id of controls.concat(['turnDecisionSettings','turnTraceExport','turnTraceClear','turnDecisionStatus']))
        present[id]=!!document.getElementById(id);
      /* 初期値がUIへ反映されていること。bindSettings() より後に注入するので、
         install側で値を入れなければ空のまま残る。 */
      const initial={mode:document.getElementById('turnDecisionMode').value,
        trace:document.getElementById('turnTraceMode').value,
        prosody:document.getElementById('turnDecisionProsody').checked,
        rawLog:document.getElementById('turnDecisionRawLog').checked,
        floorMax:document.getElementById('turnFloorMaxWaitMs').value};
      /* 変更が CFG と localStorage の両方へ届くこと。 */
      const set=(id,v)=>{const el=document.getElementById(id);
        if(el.type==='checkbox')el.checked=v;else el.value=v;el.onchange.call(el);};
      set('turnDecisionMode','shadow');
      set('turnTraceMode','record');
      set('turnDecisionRawLog',true);
      const after={mode:[CFG.turnDecisionMode,localStorage.getItem('di.tdMode')],
        trace:[CFG.turnTraceMode,localStorage.getItem('di.tdTrace')],
        rawLog:[CFG.turnDecisionRawLog,localStorage.getItem('di.tdRawLog')],
        traceEnabled:TurnTrace.enabled()};
      /* 記録がonになれば行が積まれ、offなら積まれないこと。 */
      TurnTrace.reset();TurnTrace.voice('A',0.5);
      const recorded=TurnTrace.rows.length;
      set('turnTraceMode','off');
      TurnTrace.reset();TurnTrace.voice('A',0.5);
      const notRecorded=TurnTrace.rows.length;
      /* 空の trace を書き出そうとしても落ちないこと。 */
      document.getElementById('turnTraceExport').click();
      turnDecisionStatus();
      return {present,initial,after,recorded,notRecorded,
        status:document.getElementById('turnDecisionStatus').textContent};
    },CONTROLS);

    const tests=[];const test=(n,f)=>{f();tests.push(n);};

    test('the decision-layer settings box and every control is injected',()=>{
      for(const [id,ok] of Object.entries(r.present)) assert.ok(ok,'missing: '+id);
    });
    test('the UI ships showing off for both the mode and the trace',()=>{
      assert.equal(r.initial.mode,'off');
      assert.equal(r.initial.trace,'off');
    });
    test('defaults reach the controls even though they are injected after bindSettings',()=>{
      assert.equal(r.initial.prosody,true,'turnDecisionProsody def is 1');
      assert.equal(r.initial.rawLog,false,'turnDecisionRawLog def is 0');
      assert.equal(r.initial.floorMax,'3000');
    });
    test('a change lands in CFG and in localStorage through the existing path',()=>{
      assert.deepEqual(r.after.mode,['shadow','shadow']);
      assert.deepEqual(r.after.trace,['record','record']);
      assert.deepEqual(r.after.rawLog,[true,'1']);
    });
    test('switching the trace on and off actually starts and stops recording',()=>{
      assert.equal(r.after.traceEnabled,true);
      assert.equal(r.recorded,1,'record must append a row');
      assert.equal(r.notRecorded,0,'off must append nothing');
    });
    test('exporting an empty trace does not throw',()=>{
      assert.equal(pageErrors.length,0,pageErrors.join(' | '));
    });
    test('the status line reports the mode, the trace and the per-source counters',()=>{
      assert.match(r.status,/判断 /);
      assert.match(r.status,/trace /);
      assert.match(r.status,/確定 rules /);
      assert.match(r.status,/確定後訂正 rules /);
    });
    test('loading the page raises no script error',()=>{
      assert.equal(pageErrors.length,0,pageErrors.join(' | '));
    });

    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    await browser?.close();await new Promise(r=>server.close(r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
