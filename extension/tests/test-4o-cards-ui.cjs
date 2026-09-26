/* gpt-4o 系のカードのまとまりを実ブラウザで見る。録音結果は代役（sttCall を差し替え）、翻訳は
   OpenRouter の代役（page.route）。本物の segTick が回る状態で、
   - 話し続けるあいだカードは1枚のまま、文ごとに翻訳が出ること
   - 続きの録音を待つあいだ、下に仮カードが出ないこと、カードの表示が「話の続きを待っています」になること
   - 2秒の間でカードが閉じ、次の発話が新しいカードになること
   - 逐次読み上げがエラーで OFF に戻らないこと
   を確かめる。playwright が要るので E2E 側で回す。 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let chromium;
try{ ({chromium}=require('playwright')); }
catch(err){ console.error('playwright を解決できません。NODE_PATH=$(npm root -g) を付けて実行してください。'); process.exit(2); }
const HTML=fs.readFileSync(path.join(__dirname,'../../index.html'));

(async()=>{
  const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end(HTML);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;const tests=[];const test=(n,f)=>{f();tests.push(n);};
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e).slice(0,300)));
    const asked=[];
    await page.route('https://openrouter.ai/api/v1/**',route=>{
      const u=new URL(route.request().url());
      const json=(o)=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(o)});
      if(u.pathname.endsWith('/chat/completions')){
        const b=JSON.parse(route.request().postData()||'{}'),m=b.messages||[],last=String((m[m.length-1]||{}).content||'');
        const target=(/【訳す発話】\s*([\s\S]*)$/.exec(last)||[,last])[1].trim();asked.push(target);
        return json({provider:'Test',choices:[{message:{content:'訳:'+target.slice(0,20)}}]});
      }
      return json({data:[]});
    });
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'load'});
    await page.waitForTimeout(1000);
    await page.evaluate(()=>{
      const sel=document.getElementById('provider');sel.value='openrouter';sel.dispatchEvent(new Event('change'));
      const k=document.getElementById('apiKey');k.value='sk-or-test';k.dispatchEvent(new Event('input'));
      CFG.model='deepseek/deepseek-v4.1-flash';
      CFG.sttProvider='openai';CFG.sttModel='gpt-4o-mini-transcribe';CFG.segmentMode='adaptive';CFG.segmentBoundary='semantic';
      CFG.ttsMode='off';CFG.langA='ja';CFG.langB='en';S.autoMode=false;S.running=true;
      window.__stt=[];window.sttCall=function(){return new Promise(function(res){window.__stt.push(res);});};
      window.__buf=new FourOFileBuffer({});
      window.__clip=function(text,ms){var end=Date.now(),meta={reason:'silence',seconds:10,carry:true,startedAt:end-(ms||3000),endedAt:end};
        window.__buf.submit(new Blob(['x']),'B',null,meta);var n=document.querySelectorAll('#feedB [data-eid]').length;window.__stt.shift()(text);return n;};
      window.__cards=function(){return Array.from(document.querySelectorAll('#feedB [data-eid]')).map(function(el){
        var e=S.entries.find(function(x){return x.id===el.dataset.eid;});
        return {id:el.dataset.eid,src:e&&e.srcText,dst:e&&e.dstText,open:!!(e&&e.fourOState&&e.fourOState.pending),label:(el.querySelector('.live-rec')||{}).textContent||''};});};
    });
    const during1=await page.evaluate(()=>window.__clip('Our economy is the envy of the world.'));
    await page.waitForTimeout(700);
    const during2=await page.evaluate(()=>window.__clip('Our military is the most powerful on Earth.'));
    await page.waitForTimeout(700);
    const during3=await page.evaluate(()=>window.__clip('America is rising and'));
    await page.waitForTimeout(900);
    const open=await page.evaluate(()=>window.__cards());
    test('one card while the speaker goes on; no placeholder card flashes up for the next recording',()=>{
      assert.equal(during1,1,'the first recording shows its card');
      assert.equal(during2,1,'the second recording goes into the open card');assert.equal(during3,1);
      assert.equal(open.length,1,JSON.stringify(open));
      assert.equal(open[0].src,'Our economy is the envy of the world. Our military is the most powerful on Earth. America is rising and');
      assert.equal(open[0].open,true);
    });
    test('each finished sentence is translated inside the card; the unfinished end waits',()=>{
      assert.deepEqual(asked,['Our economy is the envy of the world.','Our military is the most powerful on Earth.']);
      assert.match(open[0].dst,/訳:Our economy.*訳:Our military/);
      assert.match(open[0].label,/話の続きを待っています · \d+字/);
    });
    await page.evaluate(()=>{window.__buf.poll(Date.now(),true,1000);});
    await page.waitForTimeout(900);
    const flushed=await page.evaluate(()=>window.__cards());
    test('after 0.9 s without voice the unfinished end is translated too, and the card stays open',()=>{
      assert.equal(asked[2],'America is rising and');
      assert.equal(flushed[0].open,true);
    });
    await page.evaluate(()=>{window.__buf.poll(Date.now(),true,2100);});
    await page.waitForTimeout(300);
    await page.evaluate(()=>window.__clip('Our nation is growing.'));
    await page.waitForTimeout(900);
    const after=await page.evaluate(()=>({cards:window.__cards(),mode:CFG.segmentMode,
      errors:(window.DIAG&&DIAG.logs||[]).filter(function(l){return /scheduler-error/.test(JSON.stringify(l));}).length}));
    test('a 2 s pause closes the card and the next words open a new one',()=>{
      assert.equal(after.cards.length,2,JSON.stringify(after.cards));
      assert.equal(after.cards[0].open,false);assert.match(after.cards[0].label,/発話確定/);
      assert.equal(after.cards[1].src,'Our nation is growing.');
    });
    test('sequential reading keeps running and the page has no errors',()=>{
      assert.equal(after.mode,'adaptive');assert.equal(after.errors,0);
      assert.deepEqual(pageErrors,[]);
    });
  }finally{ if(browser)await browser.close(); server.close(); }
  console.log(JSON.stringify({test:'4o-cards-ui',passed:tests.length,tests}));
})().catch(e=>{console.error(e);process.exit(1);});
