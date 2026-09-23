'use strict';
/* 相づちを読み上げない設定の受入試験。
 *
 * 落とした音声は聞き手には存在しない。だから誤って落とすことは、誤って読むことより
 * ずっと悪い。実測ログの短い発話は「Hm.」「そう。」「あかんな。」「อึ้ย」で、文字数だけで
 * 切ると後ろ2つ（中身のある短文と、タイ語の間投詞）まで落ちる。ここで検査するのは
 * 主に「落としてはいけないものを落とさないこと」である。 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
function line(startsWith){
  const l=lines.find(l=>l.startsWith(startsWith));
  assert.ok(l!==undefined,'line not found: '+startsWith);
  return l;
}
const ctx={console,String,Number,Object,Math,parseInt,isFinite,CFG:{}};
const c=vm.createContext(ctx);
for(const b of [block('var BACKCHANNEL_WORDS={'),
                line('function ttsShortMode(){'),
                line('function ttsShortChars(){'),
                block('function ttsUtteranceKey(text){'),
                block('function ttsBackchannelList(lang){'),
                block('function ttsBackchannelSet(lang){'),
                block('function ttsBackchannelDefaultsText(){'),
                block('function ttsShortSkipReason(text,lang){'),
                block('function ttsShortSkipFor(e,useSource){'),
                line('function ttsShortSkipLabel(why){')]) vm.runInContext(b,c);

const tests=[],test=(n,f)=>{f();tests.push(n);};
const mode=(m)=>{ctx.CFG.ttsShortMode=m;};
const skip=(text,lang)=>c.ttsShortSkipReason(text,lang===undefined?'ja':lang);

test('the default reads everything, so enabling this can only be deliberate',()=>{
  ctx.CFG={};
  assert.equal(c.ttsShortMode(),'read');
  for(const t of ['えー','Hm.','あのー','um','そう。'])
    assert.equal(skip(t),'','read mode must not drop '+t);
});
test('an unknown or empty stored mode is read, so a bad value cannot silence speech',()=>{
  for(const m of ['','nonsense','READ',null,undefined]){mode(m);assert.equal(c.ttsShortMode(),'read');}
});
test('filler mode drops the listed fillers',()=>{
  mode('filler');
  for(const t of ['えー','あのー','あの','うーん','ふーん','へー','ほう'])
    assert.equal(skip(t,'ja'),'filler',t+' is on the Japanese list');
  for(const t of ['uh','um','hmm','ah','oh','er'])
    assert.equal(skip(t,'en'),'filler',t+' is on the English list');
});
test('an answer-shaped word is never dropped by default, because dropping it inverts meaning',()=>{
  mode('filler');
  for(const t of ['はい','いいえ','うん','ううん','そう','なるほど','けっこうです'])
    assert.equal(skip(t,'ja'),'','「'+t+'」 can be the answer to a question');
  for(const t of ['yes','no','yeah','yep','okay','ok','right','sure','nope','i see'])
    assert.equal(skip(t,'en'),'','"'+t+'" can be the answer to a question');
});
test('a bare question particle is not a filler',()=>{
  mode('filler');
  assert.equal(skip('え？','ja'),'','「え？」 asks for a repeat; 「えー」 hesitates');
  assert.equal(skip('huh?','en'),'','"Huh?" asks for a repeat');
});
test('the four short utterances from the field log are judged individually',()=>{
  mode('filler');
  assert.equal(skip('Hm.','en'),'filler','a pure filler');
  assert.equal(skip('そう。','ja'),'','could be an answer');
  assert.equal(skip('あかんな。','ja'),'','this one has content');
  assert.equal(skip('อึ้ย','th'),'','Thai has no list, so nothing is dropped');
});
test('a language with no list never loses anything',()=>{
  mode('filler');
  for(const l of ['th','ko','zh','','xx']) assert.equal(skip('uh',l),'','language '+l);
});
test('spelling variants are matched: case, width, kana, punctuation, repeats',()=>{
  mode('filler');
  for(const t of ['Hmmm...','HMM','ｈｍｍ','hmm!','hmm，'])
    assert.equal(skip(t,'en'),'filler',t);
  for(const t of ['ウーン','うーーーん','うーん、','うーん。','うーん…'])
    assert.equal(skip(t,'ja'),'filler',t);
  assert.equal(skip('えーーー','ja'),'filler','a long drawl is still 「えー」');
  assert.equal(skip('uh-huh','en'),'filler','the hyphen is not part of the word');
  assert.equal(skip('  あのー  ','ja'),'filler','surrounding space is ignored');
});
test('the prolongation mark is part of the word and is never stripped',()=>{
  const u=c.ttsUtteranceKey('えー');
  assert.equal(u.key,'えー','え and ー must both survive');
  assert.equal(c.ttsUtteranceKey('え-').key,'え','an ASCII hyphen is punctuation, ー is not');
});
test('runs are collapsed for matching but the plain length is kept for counting',()=>{
  const u=c.ttsUtteranceKey('ええええ。');
  assert.equal(u.key,'え','collapsed for the word list');
  assert.equal(u.plain,'ええええ','4 characters, with the punctuation gone');
});
test('short mode counts characters without punctuation',()=>{
  mode('short');ctx.CFG.ttsShortChars='3';
  assert.equal(skip('そう。','ja'),'short','2 characters');
  assert.equal(skip('あかんな。','ja'),'','4 characters, above the threshold');
  assert.equal(skip('อึ้ย','th'),'','4 characters, above the threshold');
  assert.equal(skip('Hm.','en'),'filler','the list is checked first, so the reason is precise');
});
test('the threshold is clamped, so a stored 0 or 999 cannot mute the meeting',()=>{
  ctx.CFG.ttsShortChars='0';   assert.equal(c.ttsShortChars(),3,'0 falls back to the default');
  ctx.CFG.ttsShortChars='';    assert.equal(c.ttsShortChars(),3);
  ctx.CFG.ttsShortChars='abc'; assert.equal(c.ttsShortChars(),3);
  ctx.CFG.ttsShortChars='999'; assert.equal(c.ttsShortChars(),20,'clamped to 20');
  ctx.CFG.ttsShortChars='7';   assert.equal(c.ttsShortChars(),7);
});
test('a hand written list replaces the built-in one for every language',()=>{
  mode('filler');ctx.CFG.ttsBackchannelWords='はい, うん\nyeah';
  assert.equal(skip('はい','ja'),'filler','the operator asked for this one');
  assert.equal(skip('えー','ja'),'','the built-in list is no longer in use');
  assert.equal(skip('yeah','en'),'filler','one list serves every language');
  assert.equal(skip('อึ้ย','th'),'','still nothing matches Thai');
  ctx.CFG.ttsBackchannelWords='   ';
  assert.equal(skip('えー','ja'),'filler','blanking the box restores the default');
  ctx.CFG.ttsBackchannelWords='';
});
test('an ideographic comma also separates a hand written list',()=>{
  mode('filler');ctx.CFG.ttsBackchannelWords='はい、いいえ';
  assert.equal(skip('はい','ja'),'filler');
  assert.equal(skip('いいえ','ja'),'filler');
  ctx.CFG.ttsBackchannelWords='';
});
test('a translation that only looks like a filler is still read',()=>{
  mode('filler');
  assert.equal(c.ttsShortSkipFor({srcText:'それは違います。',dstText:'Hmm.',
    srcLang:'ja',dstLang:'en'},false),'',
    'a short translation of a real sentence means the translation failed, not that nothing was said');
  assert.equal(c.ttsShortSkipFor({srcText:'えー',dstText:'Uh.',
    srcLang:'ja',dstLang:'en'},false),'filler','both sides are fillers');
});
test('reading the source looks only at the source',()=>{
  mode('filler');
  assert.equal(c.ttsShortSkipFor({srcText:'えー',dstText:'That is a long sentence.',
    srcLang:'ja',dstLang:'en'},true),'filler');
  assert.equal(c.ttsShortSkipFor({srcText:'長い文です。',dstText:'Hmm.',
    srcLang:'ja',dstLang:'en'},true),'');
});
test('read mode short circuits before any text is inspected',()=>{
  mode('read');
  assert.equal(c.ttsShortSkipFor({srcText:'えー',dstText:'Uh.',srcLang:'ja',dstLang:'en'},false),'');
  assert.equal(c.ttsShortSkipFor(null,false),'','and a missing card cannot throw');
});
test('an empty or punctuation-only text is left to the existing empty-text path',()=>{
  mode('filler');
  for(const t of ['','   ','。。。','...',null,undefined]) assert.equal(skip(t,'ja'),'');
});
test('the reason is reported in words the operator can read in the log',()=>{
  assert.match(c.ttsShortSkipLabel('filler'),/一覧/);
  assert.match(c.ttsShortSkipLabel('short'),/文字数/);
});
test('the picker in the page offers exactly the modes the code accepts',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
  const sel=html.match(/<select id="ttsShortMode">([\s\S]*?)<\/select>/);
  assert.ok(sel,'the picker has to exist');
  const values=[...sel[1].matchAll(/value="([^"]*)"/g)].map(m=>m[1]);
  assert.deepEqual(values,['read','filler','short']);
  for(const v of values){mode(v);assert.equal(c.ttsShortMode(),v,v+' must not fall back');}
  assert.ok(/\{ prop:"ttsShortMode"[^\n]*def:'read'/.test(src),'the default has to be read');
  assert.ok(/<span id="ttsBackchannelDefaults">\s*<\/span>/.test(html),
    'the default list is filled from the table at startup, never typed into the page');
});
test('the list shown to the operator is generated from the table, so it cannot drift',()=>{
  const text=c.ttsBackchannelDefaultsText();
  assert.match(text,/^ja：/);
  assert.ok(text.indexOf('えー')>=0&&text.indexOf('hmm')>=0);
  for(const l of Object.keys(c.BACKCHANNEL_WORDS)) assert.ok(text.indexOf(l+'：')>=0,l+' is missing');
  for(const l of Object.keys(c.BACKCHANNEL_WORDS))
    for(const w of c.BACKCHANNEL_WORDS[l]) assert.ok(text.indexOf(w)>=0,w+' is missing');
});
test('no answer-shaped word has slipped into the built-in lists',()=>{
  /* 一覧を足すときに、答えになりうる語を混ぜないための番。 */
  const forbidden=['はい','いいえ','うん','ううん','そう','そうです','なるほど','だめ','いい',
                   'yes','no','yeah','yep','nope','okay','ok','right','sure','i see','huh','well'];
  for(const l of Object.keys(c.BACKCHANNEL_WORDS))
    for(const w of c.BACKCHANNEL_WORDS[l])
      assert.ok(!forbidden.includes(String(w).toLowerCase()),
        '「'+w+'」 can answer a question and must not be dropped by default');
});
test('both hook sites go through the same predicate, so the two paths cannot disagree',()=>{
  assert.equal((src.match(/ttsShortSkipFor\(/g)||[]).length,3,
    'one definition plus exactly two call sites: speak() and segPump()');
  assert.ok(/function speak\(e\)\{[\s\S]*?ttsShortSkipFor\(e,useSrc\)/.test(src),'speak() calls it');
  assert.ok(/backchannel-skip/.test(src),'segPump logs its own skip so the card can be traced');
  assert.ok(/if\(!j\.manual\)\{\s*\n\s*var shortWhy=ttsShortSkipFor/.test(src),
    'manual replay must never be dropped');
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
