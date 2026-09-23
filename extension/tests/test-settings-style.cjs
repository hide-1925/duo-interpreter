'use strict';
/* 設定UIの見た目の規則を、文書とコードの両方で縛る。
 *
 * 起点は実際に出た不揃い。JSから注入する2つのパネル（Web会議への音声送出・発話交代の
 * 判断層）は素の <p> と <label> を使っており、クラスが無いためブラウザ既定の 16px で
 * 出ていた。隣の区画は 11.5px なので、同じ画面に 1.4 倍の差がついていた。
 * 数値を #id へ書き足して合わせると、次のパネルでまた別の値が書かれる。段を決めて、
 * 設定UI設計指針.md と CSS が食い違ったらここで落ちるようにする。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..','..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const tests=[],test=(n,f)=>{f();tests.push(n);};

const html=read('index.html').replace(/\r\n/g,'\n');
const css=/<style>([\s\S]*?)<\/style>/.exec(html)[1];
const doc=read('設定UI設計指針.md');
const appJs=read('extension/app.js');
/* 宣言の値を引く。同じセレクタが複数あれば後に書かれたほうが勝つので、最後に
   見つかった font-size を返す。セレクタの手前は行頭・カンマ・閉じ括弧に限る
   （そうしないと .btn が .field-head>.btn にも当たってしまう）。 */
const sizeOf=(selector)=>{
  const esc=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp('(?:^|[\n,}])\\s*'+esc+'\\{([^}]*)\\}','g');
  let m,found=null;
  while((m=re.exec(css))){
    const s=/font-size:([0-9.]+)px/.exec(m[1]);
    if(s) found=s[1];
  }
  return found;
};

test('the document states the three sizes and the CSS uses those same numbers',()=>{
  /* 文書の表から読む。文書を書き換えたらCSSも直すことになる。 */
  const body=/\|\*\*本文\*\*\|\*\*([0-9.]+)\*\*\|/.exec(doc);
  const control=/\|\*\*操作\*\*\|\*\*([0-9.]+)\*\*\|/.exec(doc);
  const input=/\|\*\*入力\*\*\|\*\*([0-9.]+)\*\*\|/.exec(doc);
  assert.ok(body&&control&&input,'the size table must stay machine readable');
  assert.equal(body[1],'11.5');assert.equal(control[1],'12.5');assert.equal(input[1],'16');
  assert.equal(sizeOf('.field > label'),body[1],'section headings are body size');
  assert.equal(sizeOf('.field small'),body[1],'notes are body size');
  assert.equal(sizeOf('.note'),body[1]);
  assert.equal(sizeOf('.settings-help'),body[1]);
  assert.equal(sizeOf('details.adv.panel-form p'),body[1]);
  assert.equal(sizeOf('details.adv > summary'),control[1],'a fold heading is a control');
  assert.equal(sizeOf('.btn'),control[1]);
  assert.equal(sizeOf('input[type=text],input[type=password],select,textarea'),input[1]);
});

test('the input size is declared in exactly one place, since the later rule wins',()=>{
  /* 以前は基本の規則に 13.5px と書いてあり、後ろの 16px に上書きされて効いていな
     かった。死んだ数値が残ると、読んだ人はそれが効いていると思う。 */
  const decls=css.match(/input\[type=text\],input\[type=password\],select,textarea\{[^}]*\}/g)||[];
  const withSize=decls.filter(d=>/font-size/.test(d));
  assert.equal(withSize.length,1,'expected one font-size for the form controls, got '+withSize.length);
  assert.match(withSize[0],/font-size:16px/);
});

test('every panel the script injects carries panel-form',()=>{
  const created=[...appJs.matchAll(/createElement\('details'\);\s*box\.className='([^']*)'/g)].map(m=>m[1]);
  assert.ok(created.length>=2,'expected the conference and decision panels, got '+created.length);
  for(const cls of created)
    assert.ok(/\bpanel-form\b/.test(cls),
      'an injected details without panel-form renders its <p> and <label> at the browser default: '+cls);
});

test('no settings panel carries a font size on its own id',()=>{
  /* #id に書くと、この段そのものが無意味になる。 */
  const offenders=[...css.matchAll(/#(turnDecisionSettings|conferenceSettings|segmentSettings)[^{]*\{([^}]*)\}/g)]
    .filter(m=>/font-size/.test(m[2])).map(m=>m[1]);
  assert.deepEqual(offenders,[],'move these into .panel-form instead: '+offenders.join(', '));
});

test('the folded explanation reads as the same control as the automatic one',()=>{
  /* 自動でたたむ側は .notetog のピル。明示的にたたむ側だけ三角の summary だと、
     同じ「説明」に2つの見た目ができる。 */
  const pill=/\.notetog\{([^}]*)\}/.exec(css)[1];
  const help=/\.settings-help>summary\{([^}]*)\}/.exec(css);
  assert.ok(help,'the explicit fold needs its own summary style');
  for(const prop of ['border-radius:999px','font-size:10.5px','font-weight:700']){
    assert.ok(pill.includes(prop),'.notetog lost '+prop);
    assert.ok(help[1].includes(prop),'.settings-help>summary must match .notetog on '+prop);
  }
  assert.match(help[1],/list-style:none/,'the default triangle would break the pill');
});

test('the long explanations in the decision panel are folded, not always on screen',()=>{
  const panel=/function turnDecisionInstall\(\)\{[\s\S]*?host\.appendChild\(box\);/.exec(appJs)[0];
  const folds=(panel.match(/class="settings-help"/g)||[]).length;
  assert.ok(folds>=5,'expected the five long notes to be folded, found '+folds);
  /* たたんだ外に残ってよいのは、設定を選ぶために読む必要がある短い文だけ。 */
  const loose=[...panel.matchAll(/\+'<p>([^']{120,})/g)].map(m=>m[1].slice(0,40));
  assert.deepEqual(loose,[],'these paragraphs are long enough to fold: '+loose.join(' / '));
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
