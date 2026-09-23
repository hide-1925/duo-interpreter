'use strict';
/* extension/app.html は index.html の変換結果である、という規則を検査する。
 *
 * この検査が無いあいだに実際に版ずれが出た。v1.49.11 の「Aivis 60秒10回を超えた
 * とき」と v1.49.12 の「相づちの読み上げ」を index.html にだけ足したため、拡張の
 * 中のページにはその設定欄が存在しなかった。bindSettings は $(el) が無ければ黙って
 * 飛ばすので、エラーも警告も出ずに「設定できない設定」になっていた。
 *
 * 規則はひとつ。app.html は index.html の中の素の <script>…</script>（本体コード）を
 * app.js と extension-bridge.js の読み込みに置き換えただけのもので、それ以外は
 * 1バイトも違わない。markup を片方にだけ足せばここで落ちる。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..','..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const tests=[],test=(n,f)=>{f();tests.push(n);};

const indexHtml=read('index.html').replace(/\r\n/g,'\n');
const appHtml=read('extension/app.html');
const SCRIPTS='\n<script src="app.js"></script>\n<script src="extension-bridge.js"></script>\n';

test('index.html holds the app code in one bare script block',()=>{
  const m=indexHtml.match(/\n<script>\n[\s\S]*?\n<\/script>\n/);
  assert.ok(m,'the transform depends on there being exactly one bare <script> block');
  const rest=indexHtml.replace(m[0],'');
  assert.ok(!/\n<script>\n/.test(rest),'a second bare script block would break the transform');
});

test('app.html is index.html with the app code swapped for the two script tags',()=>{
  const m=indexHtml.match(/\n<script>\n[\s\S]*?\n<\/script>\n/);
  const want=indexHtml.slice(0,indexHtml.indexOf(m[0]))+SCRIPTS
    +indexHtml.slice(indexHtml.indexOf(m[0])+m[0].length);
  if(want!==appHtml){
    /* どこが違うのかを出す。行番号だけだと、どちらに足りないのか読み取れない。 */
    const a=want.split('\n'),b=appHtml.split('\n');
    const lines=[];
    for(let i=0,j=0;(i<a.length||j<b.length)&&lines.length<6;i++,j++){
      if(a[i]!==b[j]) lines.push('index.html:'+(i+1)+' '+JSON.stringify((a[i]||'').slice(0,90))
                                +'\n  app.html:'+(j+1)+' '+JSON.stringify((b[j]||'').slice(0,90)));
    }
    assert.fail('extension/app.html is not the transform of index.html. '
      +'Regenerate it instead of editing one side.\n'+lines.join('\n'));
  }
});

test('app.html keeps LF and index.html keeps CRLF, as .gitattributes requires',()=>{
  assert.ok(!/\r\n/.test(appHtml),'extension/app.html must stay LF');
  assert.ok(/\r\n/.test(read('index.html')),'index.html must stay CRLF');
});

test('every element the config schema binds to actually exists somewhere',()=>{
  /* 版ずれの実害はここ。el に書いた id がどこにも無ければ、その設定は画面から
     触れない。markup（両ページ共通）か、JSが注入する markup（判断層のパネル）の
     どちらかには必ずある、を検査する。綴り違いもここで落ちる。 */
  const appJs=read('extension/app.js');
  const els=[...appJs.matchAll(/\bel:\s*"([A-Za-z0-9_]+)"/g)].map(m=>m[1]);
  assert.ok(els.length>30,'expected the config schema to bind many elements, got '+els.length);
  const missing=els.filter(id=>{
    const has=new RegExp('id=\\\\?"'+id+'\\\\?"');
    return !has.test(appHtml)&&!has.test(appJs);
  });
  assert.deepEqual(missing,[],'these settings have no element to bind to: '+missing.join(', '));
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
