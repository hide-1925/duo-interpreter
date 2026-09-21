'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),read=n=>fs.readFileSync(path.join(root,n),'utf8');
const passed=[];async function test(name,fn){await fn();passed.push(name);}
function html({deny=false,missing=false,opened=false}={}){
 let calls=0,guided=0;const logs=[];
 const win={closed:false,innerWidth:440,innerHeight:480};
 const window={CFG:{ovCapTextOpacity:92},S:{running:true,entries:[{id:'secret'}]},captionPip:{win:opened?win:null,nodes:new Map([['a',{}]])},documentPictureInPicture:{requestWindow:()=>{throw Error('must not create a separate renderer');}},dlog:(...args)=>logs.push(args),openDrawer:()=>guided++,toast(){}};
 const native=async()=>{calls++;if(!deny)window.captionPip.win=win;};if(!missing)window.openCaptionPip=native;
 const button={scrollIntoView:()=>guided++,focus:()=>guided++};
 const context=vm.createContext({URL,location:{href:'https://example.test/duo/#settings'},window,navigator:{userActivation:{isActive:true}},document:{getElementById:()=>button,querySelector:()=>({click:()=>guided++})}});
 vm.runInContext(read('html-caption-command.js'),context);
 return {window,logs,native,get calls(){return calls;},get guided(){return guided;},run:(action,url='https://example.test/duo/')=>context.commandHtmlCaptionWindow(url,action)};
}
function popup({open=true,noHtml=false,dirty=false}={}){
 const elements=new Map(),calls=[];const get=id=>{if(!elements.has(id))elements.set(id,{addEventListener:(type,fn)=>elements.get(id)[type]=fn,textContent:'',className:''});return elements.get(id);};
 const chrome={scripting:{executeScript:async args=>{calls.push({kind:'inject',args});return [{result:{ok:open,open}}];}},runtime:{onMessage:{addListener(){}},sendMessage:async m=>{calls.push({kind:'message',m});return {ok:true};}}};
 const context=vm.createContext({DuoTextComposer(){},document:{getElementById:get},chrome,window:{close:()=>calls.push({kind:'close'})}});
 vm.runInContext(read('html-caption-command.js'),context);
 vm.runInContext(read('popup.js').replace("refresh().catch((error) => show(error.message, 'err'));",''),context);
 vm.runInContext(`state=${JSON.stringify(noHtml?{}:{htmlTabId:7,htmlDocumentId:'registered-document'})};registeredHtmlUrl='https://example.test/duo/';htmlUrlDirty=${dirty};`,context);
 return {calls,click:()=>get('openCaptionWindow').click(),get};
}
(async()=>{
 await test('Calls exact native HTML settings function and leaves recognition unchanged',async()=>{
  const h=html(),speech=h.window.S;const result=await h.run('open');assert(result.ok&&result.open);assert.equal(h.calls,1);assert.equal(h.window.openCaptionPip,h.native);assert.equal(h.window.S,speech);assert(h.window.S.running);assert.equal(result.route,'html-main');assert.equal(result.captions,1);assert(!JSON.stringify(result).includes('secret'));
 });
 await test('Status sees a small window opened manually from HTML without invoking open',async()=>{
  const h=html({opened:true});const r=await h.run('status');assert(r.open);assert.equal(r.width,440);assert.equal(h.calls,0);
 });
 await test('A swallowed native rejection is detected by actual window state',async()=>{
  const h=html({deny:true});const r=await h.run('open');assert(!r.ok&&!r.open);assert.equal(r.phase,'error');assert(h.logs.some(x=>x[1]==='html-pip-result'));
 });
 await test('Wrong page and missing native function do not open another renderer',async()=>{
  const h=html();assert(!(await h.run('open','https://wrong.test/')).ok);assert.equal(h.calls,0);
  assert(!(await html({missing:true}).run('open')).ok);
 });
 await test('Guide focuses actual HTML settings button without pretending PiP opened',async()=>{
  const h=html();const r=await h.run('guide');assert(r.ok);assert.equal(r.phase,'awaiting-click');assert(!r.open);assert.equal(h.calls,0);assert(h.guided>=3);
 });
 await test('Popup click injects first, into registered HTML document and MAIN world',async()=>{
  const h=popup();await h.click();assert.equal(h.calls[0].kind,'inject');const args=h.calls[0].args;assert.equal(args.target.tabId,7);assert.equal(args.target.documentIds[0],'registered-document');assert.equal(args.world,'MAIN');assert.equal(args.args[1],'open');assert.equal(args.func.name,'commandHtmlCaptionWindow');assert.equal(h.calls[1].kind,'close');
 });
 await test('Popup failure or unopened HTML routes to working native settings button',async()=>{
  for(const opts of [{open:false},{noHtml:true}]){const h=popup(opts);await h.click();assert(h.calls.some(x=>x.m?.type==='DUO_GUIDE_HTML_CAPTION_WINDOW'));assert.equal(h.calls.at(-1).kind,'close');}
 });
 await test('Unsaved URL prevents opening stale HTML',async()=>{const h=popup({dirty:true});await h.click();assert.equal(h.calls.length,0);assert(h.get('status').textContent.includes('登録'));});
 console.log(JSON.stringify({ok:true,passed:passed.length,tests:passed,scope:'Native function and popup routing in Node VM; real Chrome activation propagation untested'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});


