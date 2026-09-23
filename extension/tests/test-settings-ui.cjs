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
  'turnDecisionContextTurns','turnFloorMaxWaitMs','turnFloorExpiry','turnTraceMode','turnDecisionRawLog',
  'turnDecisionProvider','turnDecisionModel','turnDecisionKey','turnDecisionBaseUrl',
  'turnDecisionKeyNote','turnDecisionKeyClear'];

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
      /* 経路の選択肢が registry から生えていること。 */
      const picker=document.getElementById('turnDecisionProvider');
      const routes=Array.from(picker.options).map(o=>o.value);
      const routeLabels=Array.from(picker.options).map(o=>o.textContent);

      /* キーが vendor ごとに保存され、値が画面へ戻らないこと。 */
      const keyBox=document.getElementById('turnDecisionKey');
      const setKey=(provider,value)=>{
        const sel=document.getElementById('turnDecisionProvider');
        sel.value=provider;sel.onchange.call(sel);
        for(const fn of ['change'])sel.dispatchEvent(new Event(fn));
        keyBox.value=value;keyBox.onchange.call(keyBox);
      };
      setKey('jev-direct','TS-SECRET-1234567890');
      setKey('jev-openrouter','OR-SECRET-0987654321');
      const stored=JSON.parse(localStorage.getItem('di.tdKeys.local')||'{}');
      const keyState={
        typesafe:TurnProviders.keyFor('typesafe'),
        openrouter:TurnProviders.keyFor('openrouter'),
        stored:stored,
        boxValue:keyBox.value,
        boxType:keyBox.type,
        placeholder:keyBox.placeholder
      };
      /* 書き出しにキーが乗らないこと。 */
      /* 実際の書き出し関数を通す。schema の portable フラグを見るだけでは、
         将来 exportData 側で足された経路を見逃す。 */
      const exported=JSON.stringify(exportData());
      /* rules を選ぶとキー欄が無効になること。 */
      const sel2=document.getElementById('turnDecisionProvider');
      sel2.value='rules';sel2.onchange.call(sel2);sel2.dispatchEvent(new Event('change'));
      const rulesDisabled=keyBox.disabled;

      return {present,initial,after,recorded,notRecorded,routes,routeLabels,keyState,exported,rulesDisabled,
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
    test('the route picker is built from the registry, not from hand-written markup',()=>{
      assert.ok(r.routes.includes('rules'),'rules missing');
      /* Local は学習済みの重みがあるときだけ出す。重みを入れる画面がまだ無いので、
         既定のブラウザでは「選んでも Rules のまま動く設定」になってしまう。 */
      assert.ok(!r.routes.includes('local'),'local must not be offered without fitted weights');
      assert.ok(r.routes.includes('jev-direct'),'jev-direct missing');
      assert.ok(r.routes.includes('jev-openrouter'),'jev-openrouter missing');
      /* 実測で api.typesafe.ai は CORS 応答ヘッダを出さない。直叩きだけを出すと
         「選べるのに絶対届かない経路」しか残らないので、アドオン経由も必ず出す。 */
      assert.ok(r.routes.includes('jev-extension'),'jev-extension missing');
      const bridged=r.routeLabels.filter(l=>/アドオン経由/.test(l));
      assert.equal(bridged.length,1,'the add-on route must be identifiable in the picker');
      const unverified=r.routeLabels.filter(l=>/未検証/.test(l));
      assert.equal(unverified.length,1,'the unverified route must say so in the picker');
      assert.ok(/OpenRouter/.test(unverified[0]),'got: '+unverified[0]);
    });
    test('each route keeps its own key, and switching back does not lose the other',()=>{
      assert.equal(r.keyState.typesafe,'TS-SECRET-1234567890');
      assert.equal(r.keyState.openrouter,'OR-SECRET-0987654321');
      assert.equal(r.keyState.stored.typesafe,'TS-SECRET-1234567890');
      assert.equal(r.keyState.stored.openrouter,'OR-SECRET-0987654321');
    });
    test('the key never goes back onto the screen, only its length',()=>{
      assert.equal(r.keyState.boxValue,'','the field must be cleared after saving');
      assert.equal(r.keyState.boxType,'password');
      assert.ok(/設定済み/.test(r.keyState.placeholder),'got: '+r.keyState.placeholder);
      assert.ok(!/SECRET/.test(r.keyState.placeholder),'the key itself must never be shown');
    });
    test('a local-only route disables the key field instead of asking for one',()=>{
      assert.equal(r.rulesDisabled,true);
    });
    test('no decision-layer key rides along in anything portable',()=>{
      assert.ok(!/SECRET/.test(r.exported),'a key reached the exported settings');
      assert.ok(!/turnDecisionKeys/.test(r.exported),'the key map must not be portable');
      assert.ok(!/turnDecisionApiKey/.test(r.exported),'the legacy key must not be portable');
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
