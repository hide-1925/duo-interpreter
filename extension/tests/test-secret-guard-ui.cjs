/* 書き出しからAPIキーと会話の本文が漏れないことを実ブラウザで見る（test-secret-guard の E2E 側）。
   本物のボタンを押し、本物のダウンロードとダイアログを受けて中身を確かめる。
   - 設定埋め込みHTML: 既定ではキーが入らない／埋め込みは確認して承認したときだけ、名前で分かれる
   - 埋め込みOFFでも、コンテキストにキーを貼っていたら書き出さない
   - 診断ログ: 既定は共有用（本文・デバイス名なし）、完全版は確認してから。どちらもキーは伏せる
   playwright が要るので E2E 側で回す。 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let chromium;
try{ ({chromium}=require('playwright')); }
catch(err){ console.error('playwright を解決できません。NODE_PATH=$(npm root -g) を付けて実行してください。'); process.exit(2); }
const HTML=fs.readFileSync(path.join(__dirname,'../../index.html'));

/* どの正規表現にも当たらない形のキー。完全一致で伏せられるかを見る。 */
const KEY_TRANS='Zq7-custom-TransKey-4f1c9b2e8d7a';
const KEY_AIVIS='aivis0f3e9c1d2b7a6e5f4d3c2b1a';
const KEY_TURN='TurnVendorKey-8c6b1e2d9f0a';
const SECRET_TALK='社外秘の会議の本文です';
const DEVICE='Jabra Evolve2 65 (0b0e:0310)';

(async()=>{
  const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end(HTML);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;const tests=[];const test=(n,f)=>{f();tests.push(n);};
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1100,height:900}});
    const page=await context.newPage();
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e).slice(0,300)));
    let dialogAnswer=null;const dialogs=[];
    page.on('dialog',d=>{dialogs.push(d.message());dialogAnswer?d.accept():d.dismiss();});
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'load'});
    await page.waitForTimeout(1000);

    /* キーは本物の入力欄から入れる（保存経路も通す）。判断層のキーは設定値として入れる。 */
    await page.evaluate(({t,a,turn})=>{
      const k=document.getElementById('apiKey');k.value=t;k.dispatchEvent(new Event('input'));
      KEYS['aivis']=a;saveKeys();
      CFG.turnDecisionKeys=JSON.stringify({typesafe:turn});
    },{t:KEY_TRANS,a:KEY_AIVIS,turn:KEY_TURN});

    async function click(id,{expectDownload=true,answer=null}={}){
      dialogAnswer=answer;
      const wait=page.waitForEvent('download',{timeout:expectDownload?5000:1500}).catch(()=>null);
      await page.evaluate(id=>document.getElementById(id).click(),id);
      const dl=await wait;
      if(!dl)return null;
      return {name:dl.suggestedFilename(),body:fs.readFileSync(await dl.path(),'utf8')};
    }
    const checked=(id,on)=>page.evaluate(({id,on})=>{const el=document.getElementById(id);if(on!==undefined)el.checked=on;return el.checked;},{id,on});
    const keysIn=(s)=>[KEY_TRANS,KEY_AIVIS,KEY_TURN].filter(k=>s.indexOf(k)>=0);

    /* ── 設定埋め込みHTML ─────────────────── */
    const initial={embed:await checked('embedKey'),full:await checked('diagFull')};
    test('both opt-ins are off when the page opens',()=>{ assert.deepEqual(initial,{embed:false,full:false}); });
    const normal=await click('saveHtml');
    test('a normal export carries no key at all',()=>{
      assert.ok(normal,'no download');
      assert.match(normal.name,/^duo-interpreter-\d{8}-\d{4}\.html$/);
      assert.deepEqual(keysIn(normal.body),[]);
      const cfg=JSON.parse(normal.body.match(/<script id="embedded-config" type="application\/json">([\s\S]*?)<\/script>/)[1]);
      assert.equal(cfg.keys,undefined);
      assert.ok(!('turnDecisionKeys' in cfg)&&!('turnDecisionApiKey' in cfg));
    });

    await checked('embedKey',true);
    const declined=await click('saveHtml',{expectDownload:false,answer:false});
    test('opting in asks first; declining writes nothing',()=>{
      assert.equal(declined,null);
      assert.match(dialogs[dialogs.length-1],/平文/);
      assert.match(dialogs[dialogs.length-1],/PRIVATE-WITH-KEYS/);
    });
    const withKeys=await click('saveHtml',{answer:true});
    const afterOptIn=await checked('embedKey');
    test('accepting writes a file named apart that carries the translation and TTS keys',()=>{
      assert.ok(withKeys,'no download');
      assert.match(withKeys.name,/^duo-interpreter-PRIVATE-WITH-KEYS-\d{8}-\d{4}\.html$/);
      assert.deepEqual(keysIn(withKeys.body).sort(),[KEY_AIVIS,KEY_TRANS].sort());
      assert.ok(withKeys.body.indexOf(KEY_TURN)<0,'turn-decision keys are portable:false even with the opt-in');
    });
    test('the opt-in goes back off after one export',()=>{ assert.equal(afterOptIn,false); });

    await page.evaluate(k=>{const c=document.getElementById('ctx');c.value='社内の用語 '+k;c.dispatchEvent(new Event('input'));c.dispatchEvent(new Event('change'));CFG.ctx=c.value;},KEY_TRANS);
    const blocked=await click('saveHtml',{expectDownload:false});
    const toastText=await page.evaluate(()=>document.getElementById('toast').textContent);
    test('a key pasted into the context stops a normal export',()=>{
      assert.equal(blocked,null);
      assert.match(toastText,/書き出しを止めました/);
    });
    await page.evaluate(()=>{const c=document.getElementById('ctx');c.value='';c.dispatchEvent(new Event('input'));c.dispatchEvent(new Event('change'));CFG.ctx='';});

    /* ── 診断ログ ─────────────────────────── */
    await page.evaluate(({talk,key,dev})=>{
      CFG.micDevLbl=dev;CFG.micDev='abcdef0123456789';
      dlog('stt','result',{seat:'A',lang:'ja',chars:talk.length,text:talk});
      dlog('mic','acquired',{label:dev,deviceId:'abcdef01'});
      dlog('translate','FAIL',{err:'401 Incorrect API key provided: '+key,status:401});
      S.entries.push({id:'e-secret',seat:'A',srcLang:'ja',dstLang:'en',time:'12:00:00',srcText:talk,dstText:'confidential minutes'});
    },{talk:SECRET_TALK,key:KEY_TRANS,dev:DEVICE});

    assert.equal(await checked('diagFull'),false);
    const safe=await click('dlDiag');
    test('the default diagnostics are for sharing: no conversation, no device name, no key',()=>{
      assert.ok(safe,'no download');
      assert.match(safe.name,/^duo-diagnostics-\d{8}-\d{4}\.md$/);
      assert.match(safe.body,/診断ログ（共有用）/);
      for(const leak of [SECRET_TALK,'confidential minutes',DEVICE,'Jabra'])
        assert.ok(safe.body.indexOf(leak)<0,'safe diagnostics leaked '+leak);
      assert.deepEqual(keysIn(safe.body),[]);
      assert.match(safe.body,/共有用のため本文は省きました/);
      assert.match(safe.body,/"text":"\[11文字\]"/,'the action log keeps the length');
      assert.match(safe.body,/Incorrect API key provided: \*\*\*REDACTED\*\*\*/);
    });

    await checked('diagFull',true);
    const fullDeclined=await click('dlDiag',{expectDownload:false,answer:false});
    const full=await click('dlDiag',{answer:true});
    test('the full diagnostics ask first, then include the conversation but still no key',()=>{
      assert.equal(fullDeclined,null);
      assert.match(dialogs[dialogs.length-1],/会話の本文/);
      assert.ok(full,'no download');
      assert.match(full.name,/^duo-diagnostics-full-\d{8}-\d{4}\.md$/);
      assert.match(full.body,/診断ログ（完全版）/);
      assert.ok(full.body.indexOf(SECRET_TALK)>=0,'the full log should carry the conversation');
      assert.deepEqual(keysIn(full.body),[]);
    });
    test('the page has no errors',()=>{ assert.deepEqual(pageErrors,[]); });
  }finally{ if(browser)await browser.close(); server.close(); }
  console.log(JSON.stringify({test:'secret-guard-ui',passed:tests.length,tests}));
})().catch(e=>{console.error(e);process.exit(1);});
