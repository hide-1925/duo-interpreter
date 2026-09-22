/* 出荷した版と実体の対応を検査する。
 *
 * v1.48.0 を名乗る別物を main へ載せた事故が起点。判断層の経路UIを足したのに
 * APP_VERSION も APP_BUILD も据え置いたため、診断ログの版とビルドIDだけでは
 * 2つのビルドを見分けられなかった。人間の注意力ではなく検査で止める。
 *
 * 規則はひとつ。「いま名乗っている版が versions.json に記録されているなら、
 * 記録された SHA-256 と実ファイルが一致しなければならない」。
 * 中身を変えたら版を上げるしかなくなる。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),
      assert=require('node:assert/strict');
const root=path.join(__dirname,'..','..');
const read=(p)=>fs.readFileSync(path.join(root,p));
const sha=(b)=>crypto.createHash('sha256').update(b).digest('hex');
const field=(buf,name)=>{
  const m=new RegExp(name+" = '([^']*)'").exec(buf.toString('utf8').slice(0,200000));
  return m?m[1]:null;
};
const tests=[],test=(n,f)=>{f();tests.push(n);};

const html=read('index.html'),appjs=read('extension/app.js');
const manifest=JSON.parse(read('extension/manifest.json'));
const doc=JSON.parse(read('versions.json'));
const version=field(html,'APP_VERSION'),build=field(html,'APP_BUILD');

test('the running version is recorded in versions.json',()=>{
  assert.ok(version,'index.html must declare APP_VERSION');
  assert.ok(doc.releases&&doc.releases[version],
    version+' is not in versions.json. Add it when you ship, or bump the version.');
});

test('the recorded hash matches the file, so content cannot change under a shipped version',()=>{
  const rec=doc.releases[version];
  assert.equal(sha(html),rec.indexHtmlSha256,
    'index.html no longer matches what '+version+' recorded. '+
    'Bump APP_VERSION and add a versions.json entry instead of reshipping a different '+version+'.');
  assert.equal(sha(appjs),rec.extensionAppJsSha256,
    'extension/app.js no longer matches what '+version+' recorded. Bump the version.');
});

test('the build id names the version it belongs to',()=>{
  const rec=doc.releases[version];
  assert.equal(build,rec.build,'APP_BUILD disagrees with versions.json');
  /* v1.49.0 -> v1490。版を上げてビルドIDを据え置く取り違えもここで止まる。 */
  const tag='v'+version.replace(/^v/,'').replace(/\./g,'');
  assert.ok(build.indexOf(tag)>=0,'APP_BUILD ('+build+') must contain '+tag);
});

test('the extension version paired with this HTML version is the one on disk',()=>{
  assert.equal(manifest.version,doc.releases[version].extension,
    'extension/manifest.json ('+manifest.version+') is not the version '+version+' is paired with');
});

test('the extension release notes name the HTML version they pair with',()=>{
  const notes='extension/README-v'+manifest.version+'.md';
  assert.ok(fs.existsSync(path.join(root,notes)),'missing release notes: '+notes);
  const body=read(notes).toString('utf8');
  assert.ok(body.indexOf(version)>=0,notes+' must say it pairs with HTML '+version);
});

test('every recorded release is complete and internally consistent',()=>{
  const seen=new Set();
  for(const [v,rec] of Object.entries(doc.releases)){
    for(const f of ['build','extension','indexHtmlSha256','extensionAppJsSha256','summary'])
      assert.ok(rec[f],v+' is missing '+f);
    assert.match(rec.indexHtmlSha256,/^[0-9a-f]{64}$/,v+' has a malformed hash');
    assert.match(rec.extensionAppJsSha256,/^[0-9a-f]{64}$/,v+' has a malformed app.js hash');
    assert.ok(!seen.has(rec.indexHtmlSha256),
      'two versions record the same index.html: '+v+'. One of them is mislabelled.');
    seen.add(rec.indexHtmlSha256);
  }
});

test('the versions.json records agree with what git actually shipped',()=>{
  /* 記録が後から書き換えられていないこと。commit を書いた版は git と突き合わせる。 */
  const {execFileSync}=require('node:child_process');
  for(const [v,rec] of Object.entries(doc.releases)){
    if(!rec.commit)continue;
    let blob;
    try{ blob=execFileSync('git',['show',rec.commit+':index.html'],
      {cwd:root,maxBuffer:64*1024*1024,stdio:['ignore','pipe','ignore']}); }
    catch(err){ continue; }            /* 浅いcloneでは辿れない。その場合は検査しない */
    assert.equal(sha(blob),rec.indexHtmlSha256,
      v+' records a hash that is not what '+rec.commit+' contains');
  }
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
