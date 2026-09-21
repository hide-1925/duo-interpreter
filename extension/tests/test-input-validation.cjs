/* 入力源と音声認識の組合せ検査。Webプリセットで Web Speech を選ぶとタブ音声が
   取り込めなくなっていた退行の再発防止。
   かつての判定は「system-audio の endpoint が有効かどうか」だけを見ていたため、
   会議音声を TTS の送出先にしか使わない構成まで巻き込んで止めていた。さらに
   capability テーブルが webspeech の arbitraryTrack を false と宣言しており、
   その経路の実装（WebSpeechTrackEngine）と矛盾していた。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}

const toasts=[];
const ctx={console,Object,Array,String,Number,Math,JSON,RegExp,
  CFG:{}, duoSession:null, toast:m=>toasts.push(m), $:()=>null, dlog:()=>{},
  duoId:(p)=>p+'-test'};
const c=vm.createContext(ctx);
for(const b of [block('var STT_ADAPTER_CAPABILITIES={'),
                block('function duoSessionConfig(presetId){'),
                block('var AudioEndpointManager={'),
                block('function effectiveDisplaySttRoute(){'),
                block('function duoValidateInputs(){')]) vm.runInContext(b,c);

const tests=[];const test=(n,f)=>{f();tests.push(n);};
function setup(preset,over){
  toasts.length=0;
  ctx.CFG=Object.assign({sttProvider:'webspeech',sttModel:'',displaySttRoute:'auto'},over||{});
  ctx.duoSession=c.duoSessionConfig(preset);
  return c;
}
const lastToast=()=>toasts[toasts.length-1]||'';

/* ── 退行の本体 ──────────────────────────────────────────────────────── */
test('Web preset with Web Speech is no longer blocked when the mic is the source',()=>{
  setup('web');
  /* 既定の束ねは p1→local-mic, p2→conference-audio。B側が共有音声になる。 */
  assert.equal(c.AudioEndpointManager.legacySource('A'),'mic');
  assert.equal(c.AudioEndpointManager.legacySource('B'),'display');
  assert.equal(c.duoValidateInputs(),true,lastToast());
});
test('Many to Many with Web Speech passes as well',()=>{
  setup('many_to_many');
  assert.equal(c.duoValidateInputs(),true,lastToast());
});
test('1 on 1 with Web Speech keeps working',()=>{
  setup('one_to_one');
  assert.equal(c.AudioEndpointManager.legacySource('B'),'mic');
  assert.equal(c.duoValidateInputs(),true,lastToast());
});

/* ── capability テーブルが実装と一致していること ───────────────────────── */
test('webspeech declares the arbitrary-track capability its engine implements',()=>{
  const caps=c.STT_ADAPTER_CAPABILITIES.webspeech;
  assert.equal(caps.arbitraryTrack,true);
  assert.equal(caps.systemAudio,true);
  assert.match(src,/function WebSpeechTrackEngine\(seat,track,opts\)/,
    'WebSpeechTrackEngine が無ければ arbitraryTrack:true は誤りになる');
});
test('every adapter in the table is complete',()=>{
  for(const [id,caps] of Object.entries(c.STT_ADAPTER_CAPABILITIES))
    for(const k of ['microphone','systemAudio','arbitraryTrack'])
      assert.equal(typeof caps[k],'boolean',id+'.'+k);
});

/* ── 経路ごとの必要能力 ────────────────────────────────────────────────── */
test('the direct route is refused only for an adapter that cannot take a track',()=>{
  setup('web',{sttProvider:'webspeech',displaySttRoute:'direct'});
  assert.equal(c.effectiveDisplaySttRoute(),'direct');
  assert.equal(c.duoValidateInputs(),true,lastToast());
  /* 能力の無い adapter を仮に置くと、経路を変えるよう案内して止まる。 */
  c.STT_ADAPTER_CAPABILITIES.faketrackless={microphone:true,systemAudio:true,arbitraryTrack:false};
  setup('web',{sttProvider:'faketrackless',displaySttRoute:'direct'});
  assert.equal(c.duoValidateInputs(),false);
  assert.match(lastToast(),/VB-CABLE/);
  delete c.STT_ADAPTER_CAPABILITIES.faketrackless;
});
test('the api route is refused for an adapter that cannot take system audio',()=>{
  c.STT_ADAPTER_CAPABILITIES.fakenosys={microphone:true,systemAudio:false,arbitraryTrack:false};
  setup('web',{sttProvider:'fakenosys',displaySttRoute:'auto'});
  assert.equal(c.effectiveDisplaySttRoute(),'api');
  assert.equal(c.duoValidateInputs(),false);
  assert.match(lastToast(),/外部API/);
  delete c.STT_ADAPTER_CAPABILITIES.fakenosys;
});
test('the VB-CABLE route is a normal input device, so no adapter is refused',()=>{
  c.STT_ADAPTER_CAPABILITIES.fakenone={microphone:true,systemAudio:false,arbitraryTrack:false};
  setup('web',{sttProvider:'fakenone',displaySttRoute:'vb'});
  assert.equal(c.effectiveDisplaySttRoute(),'vb');
  assert.equal(c.duoValidateInputs(),true,lastToast());
  delete c.STT_ADAPTER_CAPABILITIES.fakenone;
});
test('an API adapter on shared audio still passes',()=>{
  for(const p of ['openai','groq','gemini','xai']){
    setup('web',{sttProvider:p});
    assert.equal(c.duoValidateInputs(),true,p+': '+lastToast());
  }
});

/* ── 判定が認識源に限られていること ────────────────────────────────────── */
test('a conference endpoint used only for TTS output does not block recognition',()=>{
  const ctxc=setup('web',{sttProvider:'webspeech'});
  /* 両者をマイクへ束ね直す。会議音声のendpointは有効なまま残る。 */
  ctxc.duoSession.bindings.p2='local-mic';
  assert.equal(c.AudioEndpointManager.legacySource('B'),'mic');
  assert.ok(Object.values(ctxc.duoSession.endpoints).some(e=>e.enabled&&e.type==='system-audio'),
    'この構成でも system-audio の endpoint は有効なままであること');
  assert.equal(c.duoValidateInputs(),true,lastToast());
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
