'use strict';
/* Google Cloud Text-to-Speech 経路の受入試験。
 *
 * 起点は2つ。
 * ・声の名前の組み立てが系統で違う。Chirp 3: HD は「言語-Chirp3-HD-名前」で、
 *   Gemini-TTS は素の「Kore」。同じ欄の値を両方に流すと片方が必ず 400 になる。
 * ・Chirp 3: HD と Gemini-TTS は speakingRate / pitch に対応しない。既定値でも
 *   送ると 400 が返る。送らないことをここで固定する。
 * 実機の鍵が要る経路（合成そのもの）はここでは扱わない。組み立てと方針だけを見る。 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
/* 複数行にまたがる var 宣言を、セミコロンで終わる行まで取り出す。 */
function decl(name){
  const i=lines.findIndex(l=>l.startsWith('var '+name+' ')||l.startsWith('var '+name+'='));
  assert.ok(i>=0,'declaration not found: '+name);
  for(let j=i;j<lines.length;j++) if(/;\s*$/.test(lines[j])) return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated declaration: '+name);
}
const logs=[];
const ctx={console,Date,String,Number,Object,Error,JSON,Math,parseInt,parseFloat,isNaN,isFinite,
  RegExp,Uint8Array,Blob,atob:(b64)=>Buffer.from(b64,'base64').toString('binary'),
  dlog:(...a)=>logs.push(a), KEYS:{}, CFG:{}};
const c=vm.createContext(ctx);
for(const b of [decl('LANGS'),block('function L(code){')&&'',
                'function L(code){ for (var i=0;i<LANGS.length;i++) if (LANGS[i].c === code) return LANGS[i]; return LANGS[0]; }',
                block('function seatPick(seat, subVal, mainVal, inherit){'),
                block('function oaiLevel(v){'),
                block('function prosodyRound('),
                block('function prosodyClamp('),
                'function prosodyMapForTts(){ return ctxMap; } var ctxMap=null;',
                decl('GTTS_URL'),decl('GTTS_VOICES_URL'),
                decl('GTTS_CHIRP_VOICES'),decl('GTTS_GEMINI_VOICES'),
                decl('GTTS_RATE_FACTORS'),decl('GTTS_GAIN_FACTORS'),
                decl('GTTS_NO_AUDIO_PARAMS'),
                block('function gttsKey(){')&&'function gttsKey(){ return (KEYS["tts:google"]||"").trim(); }',
                block('function gttsFamily(){'),
                block('function gttsRateLevel(v){'),
                block('function gttsLangCode(lang){'),
                block('function gttsSeatLang(seat){'),
                block('function gttsVoiceName(seat,lang){'),
                block('function gttsAudioParamsOk(voiceName){'),
                block('function gttsManualTweaks(){'),
                block('function gttsBuildPlan(lang,prosody,voiceName){'),
                block('function gttsBody(text,lang,seat,plan,voiceName){'),
                block('function gttsBlobFrom(b64){'),
                block('function gttsHttpHint(status,message){')].filter(Boolean))
  vm.runInContext(b,c);

const tests=[],test=(n,f)=>{f();tests.push(n);};
function reset(over){
  ctx.CFG=Object.assign({ttsMode:'google',ttsSrc:false,ttsWho:'both',langA:'ja',langB:'en',
    gttsFamily:'chirp3',gttsVoice:'Aoede',gttsVoiceB:'',gttsVoiceId:'',gttsVoiceIdB:'',
    gttsModel:'gemini-2.5-flash-tts',gttsPrompt:'',gttsRate:'0',gttsVolume:'0'},over||{});
  ctx.KEYS={};ctx.ctxMap=null;
  for(const k of Object.keys(c.GTTS_NO_AUDIO_PARAMS))delete c.GTTS_NO_AUDIO_PARAMS[k];
  logs.length=0;
}
const body=(seat,lang,over)=>{
  reset(over);
  const v=c.gttsVoiceName(seat,lang),p=c.gttsBuildPlan(lang,null,v);
  return {voice:v,plan:p,body:c.gttsBody('こんにちは',lang,seat,p,v)};
};

/* ── 声の名前の組み立て ─────────────────────────────────────────────────── */
test('Chirp 3: HD builds the name from the language it is about to read',()=>{
  assert.equal(body('A','ja').voice,'ja-JP-Chirp3-HD-Aoede');
  assert.equal(body('A','en').voice,'en-US-Chirp3-HD-Aoede');
  assert.equal(body('A','de').voice,'de-DE-Chirp3-HD-Aoede');
});
test('Chinese and Arabic carry the tags Google actually uses, not the browser ones',()=>{
  /* 既定のBCP-47（zh-CN / ar-SA 相当）をそのまま送ると 400 になる。 */
  assert.equal(body('A','zh').voice,'cmn-CN-Chirp3-HD-Aoede');
  assert.equal(body('A','zh-TW').voice,'cmn-TW-Chirp3-HD-Aoede');
  assert.equal(body('A','ar').voice,'ar-XA-Chirp3-HD-Aoede');
  reset({gttsFamily:'gemini'});
  assert.equal(c.gttsLangCode('ar'),'ar-001','Gemini-TTS のアラビア語は ar-XA では通らない');
});
test('Gemini-TTS sends the bare name, the model and the prompt',()=>{
  const r=body('A','ja',{gttsFamily:'gemini',gttsVoice:'Kore',
    gttsModel:'gemini-2.5-pro-tts',gttsPrompt:'淡々と読んでください'});
  assert.equal(r.voice,'Kore');
  assert.equal(r.body.voice.modelName,'gemini-2.5-pro-tts');
  assert.equal(r.body.input.prompt,'淡々と読んでください');
  assert.equal(r.body.voice.languageCode,'ja-JP');
});
test('an empty prompt is left out rather than sent as an empty instruction',()=>{
  const r=body('A','ja',{gttsFamily:'gemini',gttsVoice:'Kore',gttsPrompt:'   '});
  assert.equal(r.body.input.prompt,undefined);
});
test('Chirp 3: HD never carries a model name, which would change the voice',()=>{
  assert.equal(body('A','ja').body.voice.modelName,undefined);
});
test('a name typed in by hand beats the dropdown, in every family',()=>{
  for(const fam of ['chirp3','gemini','direct']){
    const r=body('A','ja',{gttsFamily:fam,gttsVoiceId:'ja-JP-Neural2-B'});
    assert.equal(r.voice,'ja-JP-Neural2-B',fam);
  }
});
test('the B seat inherits the A seat voice while its own is blank',()=>{
  assert.equal(body('B','en').voice,'en-US-Chirp3-HD-Aoede');
  assert.equal(body('B','en',{gttsVoiceB:'Puck'}).voice,'en-US-Chirp3-HD-Puck');
});
test('direct with nothing typed in has no voice, so the caller must fall back',()=>{
  assert.equal(body('A','ja',{gttsFamily:'direct'}).voice,'');
});

/* ── 話速・ピッチを送ってよい声かどうか ─────────────────────────────────
   Chirp 3: HD は speakingRate / pitch / SSML のいずれにも対応しない。既定値でも
   送ると 400 が返る報告がある。Gemini-TTS も数値では受けない。 */
test('speakingRate is never sent for Chirp 3: HD or Gemini-TTS',()=>{
  for(const over of [{gttsRate:'4'},{gttsFamily:'gemini',gttsVoice:'Kore',gttsRate:'4'}]){
    const r=body('A','ja',over);
    assert.equal(r.body.audioConfig.speakingRate,undefined,JSON.stringify(over));
    assert.equal(r.body.audioConfig.pitch,undefined,'pitch must never be sent at all');
    assert.equal(r.plan.apiRate,1);
  }
});
test('a classic voice does get the rate through the API',()=>{
  const r=body('A','ja',{gttsFamily:'direct',gttsVoiceId:'ja-JP-Neural2-B',gttsRate:'1'});
  assert.equal(r.body.audioConfig.speakingRate,1.15);
  assert.equal(r.plan.playbackRate,1);
});
test('a Chirp 3 name typed into the direct field is still recognised',()=>{
  const r=body('A','ja',{gttsFamily:'direct',gttsVoiceId:'ja-JP-Chirp3-HD-Kore',gttsRate:'1'});
  assert.equal(r.body.audioConfig.speakingRate,undefined,'the name decides, not the dropdown');
  assert.equal(r.plan.playbackRate,1.15,'the speed has to come from playback instead');
});
test('a voice Google rejected once is not asked again with the same fields',()=>{
  reset({gttsFamily:'direct',gttsVoiceId:'ja-JP-Studio-B',gttsRate:'1'});
  assert.equal(c.gttsAudioParamsOk('ja-JP-Studio-B'),true);
  c.GTTS_NO_AUDIO_PARAMS['ja-JP-Studio-B']=true;
  assert.equal(c.gttsAudioParamsOk('ja-JP-Studio-B'),false);
  const p=c.gttsBuildPlan('ja',null,'ja-JP-Studio-B');
  assert.equal(p.apiRate,1);
  assert.equal(p.playbackRate,1.15,'the speed moves to playback, it is not lost');
});
test('the whole speed is kept: API rate times playback rate is what was asked for',()=>{
  for(const lv of ['-2','-1','0','1','2','3','4']){
    const r=body('A','ja',{gttsFamily:'direct',gttsVoiceId:'ja-JP-Neural2-B',gttsRate:lv});
    assert.equal(Math.round(r.plan.apiRate*r.plan.playbackRate*1000)/1000,r.plan.desiredRate,'level '+lv);
  }
});
test('playback rate stays inside what the player accepts',()=>{
  const r=body('A','ja',{gttsRate:'4'});           /* 1.8 倍を全部再生側で出す */
  assert.ok(r.plan.playbackRate<=2&&r.plan.playbackRate>=0.5);
  assert.equal(r.plan.playbackRate,1.8);
});
test('the analyzed prosody moves the speed and the volume, and nothing else',()=>{
  reset();
  ctx.ctxMap={rate:1.1,volume:0.9,dynamics:1};
  const p=c.gttsBuildPlan('ja',{available:true},'ja-JP-Chirp3-HD-Aoede');
  assert.ok(p.map,'the map must be recorded so the log can show it');
  assert.equal(p.desiredRate,1.1);
  assert.equal(p.gain,0.9);
});

/* ── 読む言語は席ではなく向きで決まる ───────────────────────────────── */
test('the A seat is read in the other language, because it is the translation',()=>{
  reset();
  assert.equal(c.gttsSeatLang('A'),'en','A の発言は既定で訳文（Bの言語）で読まれる');
  assert.equal(c.gttsSeatLang('B'),'ja');
});
test('reading the source instead flips both seats',()=>{
  reset({ttsSrc:true});
  assert.equal(c.gttsSeatLang('A'),'ja');
  assert.equal(c.gttsSeatLang('B'),'en');
});

/* ── 応答の扱い ─────────────────────────────────────────────────────────── */
test('audioContent comes back as base64 and is turned into an mp3 blob',()=>{
  const b=c.gttsBlobFrom(Buffer.from([0xff,0xfb,0x90,0x00]).toString('base64'));
  assert.equal(b.size,4);
  assert.equal(b.type,'audio/mpeg');
});
test('the request asks for MP3 and never for SSML',()=>{
  const r=body('A','ja');
  assert.equal(r.body.audioConfig.audioEncoding,'MP3');
  assert.equal(r.body.input.ssml,undefined);
  assert.equal(r.body.input.text,'こんにちは');
});
test('the error text says what to do, and names the rate case separately',()=>{
  assert.match(c.gttsHttpHint(400,'speaking_rate is not supported'),/話速・ピッチ/);
  assert.match(c.gttsHttpHint(403,'API has not been used'),/有効/);
  assert.match(c.gttsHttpHint(429,''),/上限/);
});
test('an invalid key comes back as 400, not 401, and must not read as a bad voice',()=>{
  /* 実測の応答：{"error":{"code":400,...,"reason":"API_KEY_INVALID"}}。 */
  const hint=c.gttsHttpHint(400,'API key not valid. Please pass a valid API key.');
  assert.match(hint,/APIキーが無効/);
  assert.ok(!/声の名前/.test(hint),'a bad key must not send the user off to check voice names');
});
test('the endpoint is the v1 REST synthesize path, called with an api key header',()=>{
  assert.equal(c.GTTS_URL,'https://texttospeech.googleapis.com/v1/text:synthesize');
  assert.equal(c.GTTS_VOICES_URL,'https://texttospeech.googleapis.com/v1/voices');
});
test('the Chirp 3 list is the one Google documents, and Gemini adds to it',()=>{
  /* VM の外と中で Array の prototype が別なので、中身を並べて比べる。 */
  assert.equal(Array.from(c.GTTS_CHIRP_VOICES).join(','),'Aoede,Puck,Charon,Kore,Fenrir,Leda,Orus,Zephyr');
  assert.equal(c.GTTS_GEMINI_VOICES.length,30);
  for(const n of c.GTTS_CHIRP_VOICES)
    assert.ok(c.GTTS_GEMINI_VOICES.indexOf(n)>=0,n+' must be offered for Gemini too');
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
