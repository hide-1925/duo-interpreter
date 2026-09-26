#!/usr/bin/env node
/* 全スイートの実行。§12.3 の分離に従い、決定論的なスイートだけを gate とし、
 * 実ブラウザを起動する E2E は別扱いにする（playwright の解決と環境に依存する）。
 *
 *   node extension/tests/run-all.cjs            決定論的スイートのみ
 *   NODE_PATH=$(npm root -g) node extension/tests/run-all.cjs --with-e2e
 *
 * モデルの挙動テストはここには入れない。モデル更新で落ちるものを gate にすると
 * 判断層とは無関係な赤が出続ける。 */
'use strict';
const {execFileSync}=require('node:child_process'),path=require('node:path');

const GATE=['test-turn-decision.cjs','test-file-sync.cjs','test-release-manifest.cjs','test-turn-trace-replay.cjs',
  'test-input-validation.cjs','test-app-html-sync.cjs','test-settings-style.cjs',
  'test-segment-policy.cjs','test-turn-providers.cjs','test-turn-proxy.cjs','test-tts-limits.cjs',
  'test-google-tts.cjs','test-one-touch.cjs','test-tts-skip.cjs','test-webspeech-punct.cjs','test-webspeech-track.cjs','test-aivis-prefetch.cjs','test-4o-tuning.cjs','test-model-tiers.cjs','test-model-hub.cjs','test-hub-tts.cjs',
  'test-backchannel.cjs',
  'test-teams.cjs','test-next.cjs','test-controller.cjs','test-frame-routing.cjs',
  'test-bridge-target.cjs','test-mic-discovery.cjs'];
/* tools/ の3スイートは実物の service-worker.js などを読み込む。gate の外に置いた
   ままにしていたため、v1.4.9 の版ずれを出荷前に捕まえられなかった。 */
const TOOLS=['test-html-bridge.js','test-html-caption-command.js','test-html-tab-audio.js'];
const E2E=['test-browser.cjs','test-settings-ui.cjs','test-model-picker-ui.cjs'];

const withE2e=process.argv.includes('--with-e2e');
let failed=0,total=0;

for(const f of GATE.concat(TOOLS.map(t=>'../tools/'+t)).concat(withE2e?E2E:[])){
  const label=path.basename(f).replace(/\.(cjs|js)$/,'');
  try{
    const out=execFileSync(process.execPath,[path.join(__dirname,f)],
      {encoding:'utf8',timeout:300000,stdio:['ignore','pipe','pipe']});
    const m=out.match(/"passed":\s*(\d+)/);
    const n=m?Number(m[1]):null;
    if(n)total+=n;
    console.log('PASS  '+label.padEnd(26)+(n?n+' checks':'ok'));
  }catch(err){
    failed++;
    console.log('FAIL  '+label);
    const text=String(err.stdout||'')+String(err.stderr||'');
    for(const line of text.trim().split('\n').slice(-6)) console.log('        '+line);
  }
}
console.log('—');
console.log(failed?failed+' suite(s) failed':'all suites pass ('+total+' checks)');
if(!withE2e) console.log('E2E は別実行: NODE_PATH=$(npm root -g) node extension/tests/run-all.cjs --with-e2e');
process.exitCode=failed?1:0;
