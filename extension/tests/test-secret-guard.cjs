'use strict';
/* APIキーと会話の本文が、書き出し（設定埋め込みHTML・診断ログ）から漏れないことの試験。
 *
 * 起点は公開リポジトリの監査（audit/findings.md）。書き出しの経路は次の3つで、
 * どれも「利用者が人に渡す／Claude に貼る／Git に置く」可能性がある。
 *   - exportData()        … 設定埋め込みHTMLの中身
 *   - exportHtml()        … APIキー埋め込みは明示のときだけ。ファイル名で見分ける
 *   - diagText()/redact() … 診断ログ。既定は共有用（本文・参加者名・デバイス名なし）
 * 正規表現だけの伏せ字は、形式の決まっていないキー（Aivis・VOICEVOX・独自の互換API）
 * を素通しにしていたので、手元のキーの実値で完全一致させる。 */
const path=require('node:path'),fs=require('node:fs'),vm=require('node:vm'),
      assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..','..');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith,close){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if((close||['}','};']).includes(lines[j])) return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const line=(startsWith)=>{const l=lines.find(x=>x.startsWith(startsWith));assert.ok(l,'line not found: '+startsWith);return l;};

/* 形式の決まっていないキー。どの正規表現にも当たらない形にしてある。 */
const CUSTOM='Zq7-custom-VendorKey-4f1c9b2e8d7a';
const AIVIS='aivis0f3e9c1d2b7a6e5f4d3c2b1a';
const TURN='TurnVendorKey-8c6b1e2d9f0a';
const EMBEDDED='EmbeddedFromPrivateHtml-5e4d3c2b';
const OPENAI='sk-proj-'+'A'.repeat(20)+'b'.repeat(20);

const ctx={console,String,Object,JSON,Array,Math,Date,Number,RegExp,Set,Map,
  KEYS:{openai:OPENAI,'tts:aivis':AIVIS,'stt:custom':CUSTOM,empty:'',short:'abc'},
  EMBED:{keys:{openai:EMBEDDED}},
  CFG:{turnDecisionKeys:JSON.stringify({typesafe:TURN}),turnDecisionApiKey:'',micDevLbl:'Jabra Evolve2 65 (0b0e:0310)',vbDevLbl:'',outDevLocalLbl:'',outDevRemoteLbl:''},
  store:{get:(k,d)=>d,set(){},del(){}},
  stamp:()=>'20260928-1200'};
const c=vm.createContext(ctx);
for(const b of [block('function knownSecrets(){'),block('function redact(s){'),
  block('function exportHtmlFileName(withKeys){'),block('function exportLeaksKey(html){'),
  line('var DIAG_TEXT_KEYS='),line('var DIAG_REASON_KEYS='),
  block('function diagSafeValue(v,key){'),block('function diagSafeRow(v){')])
  vm.runInContext(b,c);

const tests=[];const test=(n,f)=>{f();tests.push(n);};
const has=(s,v)=>String(s).indexOf(v)>=0;

/* ── 設定埋め込みHTMLの中身（exportData） ───────────────── */
test('exportData never carries a key: every setting named like a key is portable:false',()=>{
  const schema=block('var CONFIG_SCHEMA = [',['];']);
  const props=[...schema.matchAll(/prop:"([A-Za-z]+)"[^\n]*?portable:(true|false)/g)].map(m=>({prop:m[1],portable:m[2]==='true'}));
  assert.ok(props.length>50,'schema not parsed');
  const keyish=props.filter(p=>/key|secret|token|passw/i.test(p.prop));
  assert.ok(keyish.length>=2,'expected the turn-decision key settings');
  for(const p of keyish) assert.equal(p.portable,false,p.prop+' looks like a secret but is portable');
});
test('exportData writes only portable settings, so localOnly keys stay out',()=>{
  const x=vm.createContext({CFG:{a:'1',b:TURN,c:'3'},Date,
    CONFIG_SCHEMA:[{prop:'a',embed:'a',portable:true},{prop:'b',localOnly:true,portable:false},{prop:'c',embed:'c',portable:true,type:'bool'}]});
  vm.runInContext(block('function encodeConfigValue(s,value){'),x);
  vm.runInContext(block('function exportData(){'),x);
  const out=JSON.stringify(vm.runInContext('exportData()',x));
  assert.ok(!has(out,TURN),'a portable:false value was exported');
  assert.ok(has(out,'"a":"1"'));
});
test('exportHtml attaches KEYS only behind the explicit opt-in',()=>{
  const fn=block('function exportHtml(){');
  const uses=fn.match(/data\.keys\s*=/g)||[];
  assert.equal(uses.length,1,'KEYS must be attached in exactly one place');
  assert.match(fn,/if \(withKeys\) data\.keys = KEYS;/);
  assert.match(fn,/var withKeys = !!\$\('embedKey'\)\.checked;/);
  assert.match(fn,/withKeys && !confirm\(/,'opting in must ask before writing');
  assert.match(fn,/!withKeys && exportLeaksKey\(html\)/,'a normal export must refuse to carry any key');
  assert.match(fn,/\$\('embedKey'\)\.checked = false;/,'the opt-in resets after each export');
});
test('the opt-in is off in the shipped markup, and nothing is embedded yet',()=>{
  for(const f of ['index.html','extension/app.html']){
    const html=fs.readFileSync(path.join(root,f),'utf8');
    assert.match(html,/<input type="checkbox" id="embedKey">/,f+': embedKey must not be pre-checked');
    assert.match(html,/<input type="checkbox" id="diagFull">/,f+': diagFull must not be pre-checked');
    const cfg=html.match(/<script id="embedded-config" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(cfg,f+': embedded-config missing');
    assert.ok(!/"keys"\s*:/.test(cfg[1]),f+': embedded-config carries keys');
  }
});
test('a normal export that would carry a key is refused',()=>{
  assert.equal(c.exportLeaksKey('<html>'+CUSTOM+'</html>'),true);
  assert.equal(c.exportLeaksKey('<html>'+TURN+'</html>'),true,'turn-decision keys count too');
  assert.equal(c.exportLeaksKey('<html>'+EMBEDDED+'</html>'),true,'keys from a PRIVATE file count too');
  assert.equal(c.exportLeaksKey('<html>no secrets here abc</html>'),false,'short values are not treated as keys');
});

/* ── ファイル名と .gitignore ─────────────────────────── */
function ignored(name){
  try{execFileSync('git',['check-ignore','-q','--no-index',name],{cwd:root,stdio:'ignore'});return true;}
  catch(_){return false;}
}
test('the file with keys is named apart and is git-ignored',()=>{
  const withKeys=c.exportHtmlFileName(true),normal=c.exportHtmlFileName(false);
  assert.equal(withKeys,'duo-interpreter-PRIVATE-WITH-KEYS-20260928-1200.html');
  assert.equal(normal,'duo-interpreter-20260928-1200.html');
  assert.ok(ignored(withKeys),withKeys+' is not ignored');
  assert.ok(ignored(normal),normal+' is not ignored');
});
test('every generated output the app writes is git-ignored',()=>{
  for(const name of ['duo-diagnostics-20260928-1200.md','duo-diagnostics-full-20260928-1200.md',
    'interpret-log-20260928-1200.txt','interpret-log-20260928-1200.csv','minutes-20260928-1200.txt',
    'duo-subtitle-interaction.json','duo-subtitle-interaction (18).json','.audit-private-terms.txt','.env','x.pem'])
    assert.ok(ignored(name),name+' is not ignored');
  assert.ok(!ignored('.env.example'),'.env.example should stay committable');
});
test('the download names in the code are the ones .gitignore expects',()=>{
  for(const re of [/download\('duo-diagnostics-'/, /'interpret-log-'/, /'minutes-'/])
    assert.match(src,re);
  assert.match(fs.readFileSync(path.join(__dirname,'../popup.js'),'utf8'),/link\.download='duo-subtitle-interaction\.json'/);
});

/* ── 伏せ字（redact） ─────────────────────────────── */
test('exact-match: keys of any format are masked',()=>{
  const out=c.redact('custom='+CUSTOM+' aivis '+AIVIS+' turn:'+TURN+' embedded '+EMBEDDED);
  for(const v of [CUSTOM,AIVIS,TURN,EMBEDDED]) assert.ok(!has(out,v),'leaked '+v.slice(0,6));
  assert.equal((out.match(/\*\*\*REDACTED\*\*\*/g)||[]).length,4);
});
test('exact-match does not touch empty or short values',()=>{
  assert.equal(c.redact('abc  ok'),'abc  ok');
});
/* 偽の値。ソースにそのまま書くと秘密の走査（tools/security-scan.cjs や GitHub の
   push protection）に当たるので、実行時に組み立てる。 */
const J=(...a)=>a.join('');
const LEAKS={
  bearer:J('Authorization: Bear','er abcdefghijklmnopqrstuvwx.yz'),
  headerJson:'{"Authorization":"Bearer abcdefghijklmnop","Content-Type":"application/json"}',
  xiApiKey:J('{"xi-api-','key":"0123456789abcdef0123456789abcdef"}'),
  xGoog:'x-goog-api-key: plainvalue-1234567890',
  cookie:'Cookie: session=abcdef1234567890; theme=dark',
  setCookie:'Set-Cookie: sid=abcdef1234567890; Path=/; HttpOnly',
  clientSecret:'{"client_secret":{"value":"ek_abcdef1234567890"}}',
  clientSecretFlat:'{"client_secret":"cs-abcdef1234567890"}',
  queryKey:'GET https://example.invalid/v1/tts?key=AbC123xyz789&format=mp3',
  queryToken:'wss://example.invalid/realtime?model=x&access_token=tok_abcdef123456',
  userinfo:'https://alice:hunter2pass@proxy.example.invalid/v1',
  elevenlabs:'xi key sk_'+'a1'.repeat(24),
  openrouter:'sk-or-v1-'+'0f'.repeat(32),
  anthropic:'sk-ant-api03-'+'x'.repeat(40),
  google:'AIza'+'B'.repeat(35),
  groq:'gsk_'+'C'.repeat(52),
  xai:'xai-'+'D'.repeat(80),
  hf:'hf_'+'E'.repeat(34),
  github:'ghp_'+'F'.repeat(36),
  jwt:J('ey','JhbGciOiJIUzI1NiJ9.','ey','JzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  webrtc:'{"urls":"turn:turn.example.invalid","username":"u","credential":"s3cr3t-cred-value"}',
  echoed:'{"error":{"message":"Incorrect API key provided: '+CUSTOM+'."}}',
  apiKeyField:'{"api_key":"abcdef1234567890","model":"x"}'
};
const SECRET_PARTS={bearer:'abcdefghijklmnopqrstuvwx',headerJson:'abcdefghijklmnop',xiApiKey:'0123456789abcdef',
  xGoog:'plainvalue-1234567890',cookie:'abcdef1234567890',setCookie:'abcdef1234567890',clientSecret:'abcdef1234567890',
  clientSecretFlat:'cs-abcdef1234567890',queryKey:'AbC123xyz789',queryToken:'tok_abcdef123456',userinfo:'hunter2pass',
  elevenlabs:'a1a1a1a1a1a1',openrouter:'0f0f0f0f0f0f',anthropic:'xxxxxxxxxxxx',google:'BBBBBBBBBBBB',groq:'CCCCCCCCCCCC',
  xai:'DDDDDDDDDDDD',hf:'EEEEEEEEEEEE',github:'FFFFFFFFFFFF',jwt:'dozjgNryP4J3jVmNHl0w5N',webrtc:'s3cr3t-cred-value',
  echoed:CUSTOM,apiKeyField:'abcdef1234567890'};
for(const [name,text] of Object.entries(LEAKS))
  test('pattern: '+name+' is masked',()=>{
    const out=c.redact(text);
    assert.ok(!has(out,SECRET_PARTS[name]),name+' leaked: '+out);
    assert.ok(has(out,'REDACTED'),name+' left no marker: '+out);
  });
test('ordinary diagnostic lines are left alone',()=>{
  for(const s of ['{"max_tokens":256,"input_tokens":1200,"output_tokens":34}',
    'turn-decision-request {"provider":"jev-direct","language":"ja","candidates":0,"textChars":6}',
    '{"reason":["stt-final","semantic-final-tail"],"token":12}',
    'live-secret-ok {"ms":312,"sessionType":"transcription"}',
    'https://api.openai.com/v1/audio/transcriptions',
    '| 翻訳プロバイダ | openrouter |'])
    assert.equal(c.redact(s),s,'over-redacted: '+s);
});

/* ── 診断ログの共有用（既定） ──────────────────────────── */
test('safe diagnostics: text fields become a length, identifiers stay',()=>{
  const d=c.diagSafeValue({seat:'A',lang:'ja',chars:6,text:'社外秘の会議の本文です',to:'next words',from:'before',
    reason:['stt-final','semantic-final-tail'],why:'停止後に届いた',label:'Jabra Evolve2 65',context:'前の発話',
    ms:312,ok:true,speakers:[{name:'山田 太郎'}],nested:{results:[{name:'AbortError',ok:false,text:'hello there'}]}});
  const j=JSON.stringify(d);
  for(const leak of ['社外秘の会議の本文です','next words','before','Jabra','前の発話','山田','hello there'])
    assert.ok(!has(j,leak),'leaked '+leak+': '+j);
  assert.equal(d.text,'[11文字]');
  assert.equal(d.speakers,'[省略]');
  assert.deepEqual(d.reason,['stt-final','semantic-final-tail']);
  assert.equal(d.why,'停止後に届いた','app-authored reasons are needed for debugging');
  assert.equal(d.seat,'A');assert.equal(d.chars,6);assert.equal(d.ok,true);
  assert.equal(d.nested.results[0].name,'AbortError');
});
test('safe diagnostics: unknown keys keep only short ASCII identifiers',()=>{
  assert.equal(c.diagSafeValue('pages-build',undefined),'pages-build');
  assert.equal(c.diagSafeValue('日本語の本文',undefined),'[6文字]');
  assert.equal(c.diagSafeValue({item:'x'.repeat(81)}).item,'[81文字]');
});
test('safe diagnostics: device names in the settings rows are hidden',()=>{
  assert.equal(c.diagSafeRow('Jabra Evolve2 65 (0b0e:0310)'),'(デバイス名は省略)');
  assert.equal(c.diagSafeRow('既定'),'既定');
});

/* ── diagText の組み立て ───────────────────────────── */
test('diagText is safe by default and redacts the whole output, not only the action log',()=>{
  const fn=block('function diagText(devices, full){');
  assert.match(fn,/safe = !full/);
  assert.match(fn,/return redact\(out\.join\('\\n'\)\);/);
  assert.match(fn,/else if \(safe\) out\.push\('（共有用のため本文は省きました/);
  assert.match(fn,/JSON\.stringify\(safe \? diagSafeValue\(e\.d\) : e\.d\)/);
  assert.match(fn,/if \(safe\) out\.push\('- ' \+ devices\.length/);
  assert.match(fn,/participants:participants\.length/);
});
test('the full diagnostics need the checkbox and a confirmation',()=>{
  const fn=block('function diagMode(){');
  assert.match(fn,/if\(!box\|\|!box\.checked\)return 'safe';/);
  assert.match(fn,/confirm\(/);
  for(const id of ['dlDiag','copyDiag']){
    const h=block("$('"+id+"').onclick = function(){");
    assert.match(h,/var mode=diagMode\(\);if\(!mode\)return;/,id+' must go through diagMode');
    assert.match(h,/mode==='full'\);\n\};$/,id+' must pass the mode to withDiagText');
  }
});

/* ── 拡張のポップアップの字幕操作ログ ─────────────────────── */
test('the popup interaction report carries no conversation or key fields',()=>{
  const pop=fs.readFileSync(path.join(__dirname,'../popup.js'),'utf8');
  const m=pop.match(/const report=\{([^;]*)\};/);
  assert.ok(m,'report literal not found');
  const fields=[...m[1].matchAll(/(\w+):/g)].map(x=>x[1]).filter(k=>!['ready','error'].includes(k));
  assert.deepEqual(fields,['extensionVersion','workerVersion','generatedAt','responseFields','conference','overlay']);
  /* responseFields は Object.keys(response) ―― 値ではなく欄の名前だけ */
  assert.ok(!/\bKEYS\b|apiKey|\.text\b|\bentries\b|srcText|dstText/.test(m[1]));
});

/* ── 配布物と作業ツリー ───────────────────────────── */
test('the tracked tree and the shipped zip contain no secret, email or session URL',()=>{
  const out=execFileSync(process.execPath,[path.join(root,'tools/security-scan.cjs'),'--tree','--quiet'],
    {cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});
  const s=JSON.parse(out.trim().split('\n').pop());
  assert.equal(s.bySeverity.Critical,0,'Critical findings: '+JSON.stringify(s.byRule));
  assert.equal(s.bySeverity.High,0,'High findings: '+JSON.stringify(s.byRule));
  assert.ok(s.stats.zips>=1&&s.stats.zipEntries>100,'the zips were not opened');
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
