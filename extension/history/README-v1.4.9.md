# Duo Interpreter Chrome/Edge 拡張 v1.4.9

HTML v1.48.0 と対で動きます。

## 1. この版で直したこと

**Web Speech API を選ぶと共有音声を認識できなくなっていた不具合**を直しました。
v1.47.1 から存在していた不具合で、Web / Many to Many プリセットで音声認識に
Web Speech を選ぶと「Webプリセットの共有音声には OpenAI / Groq / Gemini の
音声認識を選んでください」で開始できませんでした。

原因は2つで、どちらも判断層とは無関係です。

| 箇所 | 何が起きていたか |
| --- | --- |
| `STT_ADAPTER_CAPABILITIES.webspeech` | `arbitraryTrack:false` と宣言していた。しかし `WebSpeechTrackEngine` は Chrome 135+ の `SpeechRecognition.start(audioTrack)` で共有音声 Track を直接認識するために存在する。能力はあるのにテーブルが塞いでいた |
| `duoValidateInputs()` | system-audio endpoint の *有効/無効* だけを見ており、それを *認識源に使うか* を見ていなかった。`conference-audio` は Web と Many to Many で常に enabled なので、マイクを認識源にして会議音声は読み上げの送出先にしか使わない構成まで巻き込んで止めていた |

Chrome 135 未満では `WebSpeechTrackEngine` が失敗し「共有音声の直接認識を開始
できません」が出ます。これは正しい動作です。開始前に塞ぐのをやめ、実機が理由を
出すようにしました。

## 2. 追加したもの（既定では動きません）

発話の切り出しを秒数ではなく判断で決めるための**計測基盤と判断層の契約**を
入れました。**`turnDecisionMode` の既定は `off` で、そのとき境界判定と読み上げ
開始は v1.47.1 と同一の値を返します。** 外部通信も判断層向けの音響計算も
発生しません。off から動かさない限り、この版は上の不具合修正だけです。

| 追加 | 役割 |
| --- | --- |
| `TurnDecision` / `TurnProviders` | 判断層の契約と Provider adapter（`rules` / `local` / `jev-direct`） |
| `TurnTrace` | 実会議の記録。⚙→音声 から採れます |
| `tools/turn-trace-replay.js` | 記録の再生と、言語ごとの重み学習・閾値逆算 |
| `ProsodyAnalyzer.prototype.peek` | 発話途中の非破壊スナップショット |

閾値は**校正前の出荷値**です。実会議の記録を `--fit` に通して置き換えるまで、
`assist` 以上へは上げないでください。

## 3. 実機で確認できたこと

v1.4.8 で確認した Web版Teams の on / mix / off の3モードは、この版で製品コードの
該当箇所を触っていないため据え置きです。`extension/validation-v1.4.9.json` の
`notVerified` に、この版で未確認のものを列挙しています。

**自動の実ブラウザ E2E がこの版で初めて通りました。** `tests/test-browser.cjs` は
これまで成功実績がありませんでした。原因はテスト側の2点で、ICE gathering の
*完了* を待っていたこと（STUN に到達できない環境では完了しません。製品側は
v1.4.7 以降は最初の候補で応答する仕様です）と、mDNS で隠された `.local` 候補が
同一ページ内ループバックで解決できなかったことです。製品コードは触っていません。

## 4. 検査

```
NODE_PATH=$(npm root -g) node tests/run-all.cjs --with-e2e
```

| 区分 | 件数 |
| --- | --- |
| 決定論的（`tests/run-all.cjs`） | 214 |
| `tools/` の3スイート | 45 |
| 実ブラウザ E2E | `test-browser` 成功 / `test-settings-ui` 8 |
| 構文検査 | `extension/` の `.js` `.cjs` 40ファイル + `index.html` インラインと `app.js` |

内訳は `validation-v1.4.9.json` にあります。
