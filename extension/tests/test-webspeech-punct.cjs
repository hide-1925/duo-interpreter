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
  block('function segSemanticTail(text,lang){'),block('function segSemanticDecision(input){'),
  block('function segPartEndsSentence(q,useSource){')])
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
  assert.match(seg,/var shown=segWebMarks\(e,webSpeechPunct\(raw,lang\)\);/);
  assert.match(seg,/segWebClose\(owner,e,punctuateTranscript\(shown,lang\)/,'the final is terminated after the spaces are handled');
  assert.match(seg,/segUpdate\(e,shown,false\)/,'interim text is punctuated too, or the segmenter never sees a sentence end');
  assert.match(src,/t=punctuateTranscript\(webSpeechPunct\(t,langOf\(seat\)\),langOf\(seat\)\);/);
  assert.match(src,/text=punctuateTranscript\(webSpeechPunct\(text,langOf\(self\.seat\)\),langOf\(self\.seat\)\);/);
  assert.match(src,/var itmShown = webSpeechPunct\(itm\.trim\(\), langOf\(seat\)\);/);
  assert.match(src,/var itmShown=webSpeechPunct\(itm\.trim\(\),langOf\(self\.seat\)\);/);
});
test('the API transcription paths are left alone',()=>{
  /* 外部STTは句読点付きで返す。そこへ空白規則をかけると、英語混じりの本文を崩しうる。 */
  const n=(src.match(/webSpeechPunct\(/g)||[]).length;
  assert.equal(n,7,'one definition, two in the segmented path, four in the mic and track paths');
});

/* ── 途中結果を1枚につなぐ ───────────────────────────────────────────────
   Chrome は途中結果を「安定した前半」と「揺れる末尾」の2つの result で返す。
   v1.49.25 の実測では、末尾が別カード（e2）になり、前半の文末「…ことだよね」が
   見えてから確定まで約4.7秒かかった。約60秒で打ち切られた前半は語の途中で
   確定し、「…協力を得られ。」と別カード「れば、作り上げられるという発想だな」に
   割れていた。 */
const W={timers:[]};
const wctx={console,String,Object,JSON,Math,Date,Number,CFG:{prosodyOn:false},
  setTimeout:(fn)=>{W.timers.push(fn);return W.timers.length;},
  clearTimeout:(id)=>{if(id)W.timers[id-1]=null;},
  segEnabled:()=>true,langOf:()=>W.lang||'ja-JP',
  addEntry:(seat,text,interim)=>{const e={id:'e'+(W.cards.length+1),seat,segments:[],segment:{final:false},texts:[],startedAt:Date.now()};W.cards.push(e);return e;},
  segUpdate:(e,text,final)=>{e.texts.push(text);e.srcText=text;e.segment.final=!!final;},
  attachProsody(){},micProsodySnapshot:()=>null,dlog:(...a)=>W.logs.push(a)};
const wc=vm.createContext(wctx);
for(const name of ['JA_SPOKEN_QUESTION','JA_SPOKEN_END','SEG_WEB_JOIN_MS']) vm.runInContext(constLine(name),wc);
for(const b of [block('function hasSpeechContent(s){'),block('function punctuateTranscript(text, lang){'),
  block('function jaSpacePunct(text){'),block('function webSpeechPunct(text, lang){'),
  block('function segSemanticTail(text,lang){'),block('function segWebHoldable(e,shown,lang){'),block('function segWebRelease(owner){'),
  block('function segApplyMark(e,pos,mark){'),block('function segWebMarks(e,text){'),block('function segWebJoin(parts){'),block('function segWebClose(owner,e,text,seat,raw){'),
  block('function segWebResult(owner,ev,seat){'),block('function segWebEnd(owner){')])
  vm.runInContext(b,wc);
function wreset(lang){W.cards=[];W.logs=[];W.timers=[];W.lang=lang||'ja-JP';return {};}
const fire=()=>{const t=W.timers.slice();W.timers=[];t.forEach(f=>f&&f());};
const logged=(m)=>W.logs.filter(a=>a[1]===m).length;
/* SpeechRecognitionResultList の形。isFinal を持つ配列の配列。 */
const R=(...rows)=>({resultIndex:0,results:rows.map(([t,fin])=>Object.assign([{transcript:t}],{isFinal:!!fin}))});
const last=(e)=>e.texts[e.texts.length-1];

test('head and tail interim results are one card, not two',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['弱点ってやっぱり第5世代を作った経験がないことだよね',false],[' その通り',false]),'B');
  assert.equal(W.cards.length,1,'the unstable tail is the same utterance');
  assert.equal(last(W.cards[0]),'弱点ってやっぱり第5世代を作った経験がないことだよね。その通り',
    'the sentence end is visible as soon as the next word exists anywhere');
});
test('a head cut off mid-word stays joined to its tail and gets no invented full stop',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['世界の協力を得られ',true],['れば作り上げられるという発想だな',false]),'B');
  assert.equal(W.cards.length,1);
  assert.equal(last(W.cards[0]),'世界の協力を得られれば作り上げられるという発想だな');
  assert.equal(W.cards[0].segment.final,false,'the utterance is still going');
});
test('when every result is final the card closes, and the next speech starts a new card',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['そうですね',false]),'B');
  wc.segWebResult(o,R(['そうですね',true]),'B');
  assert.equal(W.cards[0].segment.final,true);
  assert.equal(last(W.cards[0]),'そうですね。');
  wc.segWebResult(o,R(['そうですね',true],['次の話です',false]),'B');
  assert.equal(W.cards.length,2);
  assert.equal(last(W.cards[1]),'次の話です','the closed result is not read again');
  assert.equal(W.cards[0].texts.length,2,'the closed card is not touched');
});
test('a card is closed at an inner final only where everything up to it is committed at a sentence end',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['経験がないことだよね',false],[' その通り',false]),'B');
  const e=W.cards[0],text=last(e);
  /* rules が「…だよね。」まで commit した状態。 */
  e.segments=[{committedAt:1,start:0,end:text.indexOf('。')+1}];
  wc.segWebResult(o,R(['経験がないことだよね',true],[' その通りだから',false]),'B');
  assert.equal(e.segment.final,true);
  assert.equal(last(e),'経験がないことだよね。','closed at exactly the committed text, nothing clipped');
  assert.equal(W.cards.length,2);
  assert.equal(last(W.cards[1]),'その通りだから');
});
test('no early close while committed text stops short of the boundary',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['経験がないことだよね',false],[' その通り',false]),'B');
  const e=W.cards[0];
  e.segments=[{committedAt:1,start:0,end:4}];
  wc.segWebResult(o,R(['経験がないことだよね',true],[' その通りだから',false]),'B');
  assert.equal(e.segment.final,false,'closing here would force-commit the rest of the head');
  assert.equal(W.cards.length,1);
  assert.equal(last(e),'経験がないことだよね。その通りだから');
});
test('a list that shrinks never rebuilds an utterance that was already closed',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['一つ目です',true],['二つ目',false]),'B');
  wc.segWebResult(o,R(['一つ目です',true],['二つ目です',true]),'B');
  const n=W.cards.length;
  wc.segWebResult(o,R(['一つ目です',true]),'B');
  assert.equal(W.cards.length,n);
});
test('the end of recognition closes the open card and forgets the position',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['途中まで',false]),'B');
  wc.segWebEnd(o);
  assert.equal(W.cards[0].segment.final,true);
  assert.equal(o._webStart,0,'a restarted recognizer numbers its results from 0 again');
  wc.segWebResult(o,R(['新しい発話',false]),'B');
  assert.equal(W.cards.length,2);
});
test('English parts are joined with a space when Chrome leaves none',()=>{
  const o=wreset('en-US');
  wc.segWebResult(o,R(['hello there',true],['how are you',false]),'A');
  assert.equal(last(W.cards[0]),'hello there how are you');
  const p=wreset('en-US');
  wc.segWebResult(p,R(['hello there',true],[' how are you',false]),'A');
  assert.equal(last(W.cards[0]),'hello there how are you','an existing space is not doubled');
});
/* 判断層が息継ぎを「？」と選んだ後も、次の途中結果で「、」に戻らないこと。
   戻ると確定した本文が訂正扱いになり、翻訳と読み上げが作り直される。 */
test('a mark chosen by the decision layer survives the next recogniser update',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['大丈夫なの ここが大事なところでな',false]),'B');
  const e=W.cards[0],text=last(e),pos=text.indexOf('、');
  e.segment.text=text;
  assert.equal(wc.segApplyMark(e,pos,'？'),true);
  assert.equal(e.segment.text.slice(0,pos+1),'大丈夫なの？');
  wc.segWebResult(o,R(['大丈夫なの ここが大事なところでな 断ったのは',false]),'B');
  assert.equal(last(e).slice(0,pos+1),'大丈夫なの？','the recogniser does not undo it');
  wc.segWebResult(o,R(['大丈夫なの ここが大事なところでな 断ったのは',true]),'B');
  assert.equal(last(e).slice(0,pos+1),'大丈夫なの？','nor does the final');
});
test('a mark is only placed on a breath comma',()=>{
  const e={segment:{text:'はい。そうです'}};
  assert.equal(wc.segApplyMark(e,2,'？'),false,'a full stop the rules found is left alone');
  assert.equal(e.segment.text,'はい。そうです');
});
test('the card is rotated at a boundary the decision layer marked',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['強気すぎない',false],[' 大丈夫なの',false]),'B');
  const e=W.cards[0],text=last(e),pos=text.indexOf('、');
  e.segment.text=text;wc.segApplyMark(e,pos,'？');
  e.segments=[{committedAt:1,start:0,end:pos+1}];
  wc.segWebResult(o,R(['強気すぎない',true],[' 大丈夫なの',false]),'B');
  assert.equal(last(e),'強気すぎない？');
  assert.equal(e.segment.final,true);
  assert.equal(last(W.cards[1]),'大丈夫なの');
});
/* ── Chrome の60秒確定で文の途中からカードが割れない（v1.49.26実測）──────── */
const CUT='公式ドキュメントではどちらも マニュアル つまり 全ての操作を';
test('a final that stops mid-sentence is held, and the next result joins the same card',()=>{
  const o=wreset();
  wc.segWebResult(o,R([CUT,true]),'B');
  assert.equal(W.cards.length,1);
  assert.equal(W.cards[0].segment.final,false,'the forced final is not the end of the sentence');
  assert.equal(logged('webspeech-final-held'),1);
  assert.ok(!/。$/.test(last(W.cards[0])),'no full stop is invented at the cut');
  wc.segWebResult(o,R([CUT,true],['確認するモードで始まると書かれています',false]),'B');
  assert.equal(W.cards.length,1,'the continuation stays on the same card');
  assert.match(last(W.cards[0]),/全ての操作を確認するモードで始まると/);
  assert.equal(logged('webspeech-final-joined'),1);
  wc.segWebResult(o,R([CUT,true],['確認するモードで始まると書かれています',true]),'B');
  assert.equal(W.cards[0].segment.final,true,'a sentence end closes it at once');
  assert.match(last(W.cards[0]),/書かれています。$/);
  fire();
  assert.equal(W.cards.length,1);
});
test('a held final closes by itself when nothing follows',()=>{
  const o=wreset();
  wc.segWebResult(o,R([CUT,true]),'B');
  fire();
  assert.equal(W.cards[0].segment.final,true);
  assert.match(last(W.cards[0]),/操作を。$/,'the old terminal mark is applied only when the card really ends');
  wc.segWebResult(o,R([CUT,true],['次の話です',false]),'B');
  assert.equal(W.cards.length,2,'after the close, new speech is a new card');
});
test('a final that ends a sentence closes at once, without waiting',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['ありがとうございます',true]),'B');
  assert.equal(W.cards[0].segment.final,true);
  assert.equal(W.timers.filter(Boolean).length,0);
});
test('a card near the 60 second limit is held even at a sentence-like ending',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['同じバージョンで改善もありです',false]),'B');
  W.cards[0].startedAt=Date.now()-55000;
  wc.segWebResult(o,R(['同じバージョンで改善もありです',true]),'B');
  assert.equal(W.cards[0].segment.final,false,'the forced cut can land on です in the middle of a sentence');
});
test('the end of recognition closes a held card at once',()=>{
  const o=wreset();
  wc.segWebResult(o,R([CUT,true]),'B');
  wc.segWebEnd(o);
  assert.equal(W.cards[0].segment.final,true);
  assert.equal(o._webHold,null);
  assert.equal(o._webStart,0);
});

/* ── 読み上げが「文の終わり」を待ち続けない（v1.49.26実測 8.2秒・3.3秒・8.4秒）── */
const tq=(text,over,cardText)=>({segment:Object.assign({sourceText:text,end:text.length,commitReason:['semantic-sentence','stable']},over||{}),
  card:{segment:{final:false,text:cardText==null?text:cardText}}});
test('a part is a sentence end when it ends with a mark',()=>{
  assert.equal(c.segPartEndsSentence(tq('全94項目です。'),true),true);
  assert.equal(c.segPartEndsSentence(tq('確認できたのは2件だけです'),true),false);
});
test('a part committed at a sentence ending by the rules is a sentence end',()=>{
  assert.equal(c.segPartEndsSentence(tq('確認できたのは2件だけです',{commitReason:['semantic-ending','stable']}),true),true);
});
test('a part whose full stop landed at the start of the next part is a sentence end',()=>{
  const t='確認できたのは2件だけです';
  assert.equal(c.segPartEndsSentence(tq(t,{},t+'。他は'),true),true,'the space after です became 。 on the next update');
  assert.equal(c.segPartEndsSentence(tq(t,{},t+'、他は'),true),false,'a comma is not a sentence end');
});
test('the Aivis grouping uses the sentence-end check',()=>{
  assert.match(src,/group\.forEach\(function\(q,i\)\{if\(segPartEndsSentence\(q,useSource\)\)cut=i\+1;\}\);/);
});

test('empty results make no card',()=>{
  const o=wreset();
  wc.segWebResult(o,R(['  ',false]),'B');
  assert.equal(W.cards.length,0);
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
