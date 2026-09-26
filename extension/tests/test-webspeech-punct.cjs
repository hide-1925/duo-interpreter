'use strict';
/* Web Speech（日本語）の空白を句読点に直せているかの受入試験。
 *
 * 起点は実測（v1.49.23・Web Speech＋共有音声Track）。Chrome は日本語に句読点を
 * 付けず、息継ぎの位置に空白を入れて返す。「〜違うんですよね 安全保障論というのは
 * 歴史をモデルとしてみる つまりそれ…」のまま流れ、文末が無いので 120字の
 * 長さ打切り（semantic-length-fallback）まで切れず、最後の一文にだけ「。」が付いた。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
function constLine(name){
  const m=new RegExp('^var '+name+'=[^\\n]*$','m').exec(src);
  assert.ok(m,'constant not found: '+name);
  return m[0];
}
const ctx={console,String,Object,JSON,Math};
const c=vm.createContext(ctx);
for(const name of ['JA_SPOKEN_QUESTION','JA_SPOKEN_END']) vm.runInContext(constLine(name),c);
for(const b of [block('function hasSpeechContent(s){'),block('function punctuateTranscript(text, lang){'),
  block('function jaSpacePunct(text){'),block('function webSpeechPunct(text, lang){'),
  block('function segSemanticTail(text,lang){'),block('function segSemanticDecision(input){')])
  vm.runInContext(b,c);

const tests=[];const test=(n,f)=>{f();tests.push(n);};
const REPORTED='歴史学という分野とちょっとアプローチが違うんですよね 安全保障論というのは歴史をモデルとしてみる つまりそれぞれ違う あの';

test('the reported sentence gets its sentence end and its pauses back',()=>{
  assert.equal(c.webSpeechPunct(REPORTED,'ja-JP'),
    '歴史学という分野とちょっとアプローチが違うんですよね。安全保障論というのは歴史をモデルとしてみる、つまりそれぞれ違う、あの');
  assert.equal(c.punctuateTranscript(c.webSpeechPunct(REPORTED,'ja-JP'),'ja-JP').slice(-4),'、あの。',
    'the final still gets its terminal mark');
});
test('a question ending becomes a question mark',()=>{
  assert.equal(c.jaSpacePunct('それは本当ですか 次に進みます'),'それは本当ですか？次に進みます');
  assert.equal(c.jaSpacePunct('一緒に行きませんか じゃあ'),'一緒に行きませんか？じゃあ');
});
test('polite and plain sentence ends that are unambiguous close the sentence',()=>{
  assert.equal(c.jaSpacePunct('ありがとうございます 次の議題です'),'ありがとうございます。次の議題です');
  assert.equal(c.jaSpacePunct('昨日は雨でした 今日は晴れ'),'昨日は雨でした。今日は晴れ');
  assert.equal(c.jaSpacePunct('そういうことだよね それで'),'そういうことだよね。それで');
});
test('endings that also occur mid-sentence only get a comma',()=>{
  assert.equal(c.jaSpacePunct('まだ 解決していない'),'まだ、解決していない','まだ is an adverb, not a copula');
  assert.equal(c.jaSpacePunct('何か 問題があれば'),'何か、問題があれば','何か is not a question');
  assert.equal(c.jaSpacePunct('静かな 部屋'),'静かな、部屋','かな inside an adjective is not a question');
  assert.equal(c.jaSpacePunct('モデルとしてみる つまり'),'モデルとしてみる、つまり',
    'a plain verb may end a clause or a sentence; the safe mark is the comma');
});
test('spaces next to Latin words are word spaces and stay',()=>{
  assert.equal(c.jaSpacePunct('今日は Google の話です 次は'),'今日は Google の話です。次は');
  assert.equal(c.jaSpacePunct('バージョン 3 から'),'バージョン 3 から');
  assert.equal(c.jaSpacePunct('Google Chrome を使います'),'Google Chrome を使います');
});
test('a sentence end before a Latin word still closes the sentence',()=>{
  assert.equal(c.jaSpacePunct('よろしくお願いします OK'),'よろしくお願いします。OK');
});
test('existing punctuation is kept and the stray space dropped',()=>{
  assert.equal(c.jaSpacePunct('はい。 そうです'),'はい。そうです');
  assert.equal(c.jaSpacePunct('「こんにちは」 と言った'),'「こんにちは」と言った');
  assert.equal(c.jaSpacePunct('えっと 、次'),'えっと、次');
});
test('full-width and repeated spaces are treated as one pause',()=>{
  assert.equal(c.jaSpacePunct('そうですね　　では'),'そうですね。では');
  assert.equal(c.jaSpacePunct('ええと   次'),'ええと、次');
});
test('leading and trailing spaces are left for trim to remove',()=>{
  assert.equal(c.jaSpacePunct(' そうです '),' そうです ');
});
test('other languages are untouched',()=>{
  assert.equal(c.webSpeechPunct('this is fine thank you','en-US'),'this is fine thank you');
  assert.equal(c.webSpeechPunct('我们 今天','zh-CN'),'我们 今天');
  assert.equal(c.webSpeechPunct('違うんです 次','en-US'),'違うんです 次','the seat language decides, not the script');
});
test('a text without spaces comes back as the same string',()=>{
  const t='違うんですよね';
  assert.equal(c.jaSpacePunct(t),t);
});
/* 途中結果は伸びながら何度も来る。前半の記号が後から変わると、確定済みの部分が
   訂正扱いになって翻訳が作り直される。後ろを見ずに決めるので、前半は変わらない。 */
test('growing interim text never changes what was already punctuated',()=>{
  const full=c.jaSpacePunct(REPORTED);
  for(let n=1;n<=REPORTED.length;n++){
    const part=c.jaSpacePunct(REPORTED.slice(0,n).trim());
    assert.ok(full.startsWith(part),'prefix '+n+' became '+part);
  }
});
/* 句読点が戻れば、区切りは「文末」で切れる。空白のままだと120字の長さ打切りまで
   待つ（実測でカード1枚110〜120字）。 */
test('with the sentence end restored the segmenter cuts at the sentence, not at 120 characters',()=>{
  const policy={min:12,max:48,stability:400,silence:700,mode:'balanced'};
  const raw=REPORTED,fixed=c.webSpeechPunct(REPORTED,'ja-JP');
  const before=c.segSemanticDecision({text:raw,stableLength:raw.length,policy,lang:'ja-JP',idleMs:0,silenceMs:-1,final:false});
  assert.equal(before.length,0,'the raw text has no sentence end to cut at');
  const after=c.segSemanticDecision({text:fixed,stableLength:fixed.length,policy,lang:'ja-JP',idleMs:0,silenceMs:-1,final:false});
  assert.equal(after.length,fixed.indexOf('。')+1);
  assert.deepEqual(Array.from(after.reasons),['semantic-sentence','stable']);
});

/* 三つの Web Speech 経路（逐次・マイク・共有音声Track）すべてが通っているか。 */
test('every Web Speech path runs the space punctuation',()=>{
  const seg=block('function segWebResult(owner,ev,seat){');
  assert.match(seg,/webSpeechPunct\(text,langOf\(seat\)\)/);
  assert.match(seg,/punctuateTranscript\(shown/,'the final is terminated after the spaces are handled');
  assert.match(seg,/segUpdate\(e,r\.isFinal\?punctuateTranscript\(shown,langOf\(seat\)\):shown/,
    'interim text is punctuated too, or the segmenter never sees a sentence end');
  assert.match(src,/t=punctuateTranscript\(webSpeechPunct\(t,langOf\(seat\)\),langOf\(seat\)\);/);
  assert.match(src,/text=punctuateTranscript\(webSpeechPunct\(text,langOf\(self\.seat\)\),langOf\(self\.seat\)\);/);
  assert.match(src,/var itmShown = webSpeechPunct\(itm\.trim\(\), langOf\(seat\)\);/);
  assert.match(src,/var itmShown=webSpeechPunct\(itm\.trim\(\),langOf\(self\.seat\)\);/);
});
test('the API transcription paths are left alone',()=>{
  /* 外部STTは句読点付きで返す。そこへ空白規則をかけると、英語混じりの本文を崩しうる。 */
  const n=(src.match(/webSpeechPunct\(/g)||[]).length;
  assert.equal(n,6,'one definition plus five Web Speech call sites');
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
