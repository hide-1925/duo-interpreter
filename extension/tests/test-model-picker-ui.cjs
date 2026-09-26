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
    const seen=[];
    await page.route('https://openrouter.ai/api/v1/**',route=>{
      const u=new URL(route.request().url()),h=route.request().headers();seen.push({path:u.pathname,q:u.search,auth:!!h.authorization});
      const json=(o)=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(o)});
      if(/\/endpoints$/.test(u.pathname))return json({data:{endpoints:[{latency_last_30m:{p50:420}}]}});
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
    test('no script error',()=>{ assert.equal(pageErrors.length,0,pageErrors.join(' | ')); });
    console.log(JSON.stringify({passed:tests.length,tests},null,2));
  }finally{
    await browser?.close();await new Promise(r=>server.close(r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
