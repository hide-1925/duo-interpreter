# Duo Interpreter Chrome/Edge 拡張 v1.4.7

対象：「接続待機中」のままタイムアウトして接続できない問題
前提：HTML v1.47.0（変更なし）

## 1. v1.4.6実環境ログで確定したこと

`duo-subtitle-interaction (18).json`。2回試して2回とも同じ失敗。

```
  0.0s  frame-discovery  eligible=1  method=mic-in-processed-mix
 15.3s  {"error":"", "reason":"connection-timeout"}
 31.5s  frame-discovery  eligible=1  method=mic-in-processed-mix
 46.6s  {"error":"", "reason":"connection-timeout"}
```

**まず切り分け。**

- 候補選定は正常（`eligibleCount:1`）。v1.4.3〜v1.4.6で直した部分は効いている。
- `microphone-discovery` が**一度も無い**。つまり `adapter.start()` が走っていない。
  失敗は音声アダプターより手前、**ローカルWebRTCブリッジの接続段階**。
- v1.4.6で追加した `conference-apply-skipped` / `conference-mode-skipped` も無い。
  **今回の失敗はv1.4.6の変更とは無関係。**
- 15.3秒・15.0秒という値は、HTML側 `duoConferenceTimer` の15000msと一致する
  （Service Worker側の20秒ではない）。

## 2. 原因：ICE収集2段分が15秒の期限を食いつぶす

HTML側（index.html v1.47.0）。

```js
duoConferenceTimer=setTimeout(…,15000);                    // ← 期限はここから
await pc.setLocalDescription(await pc.createOffer());
await duoIceComplete(pc);                                  // ← 最大8秒
duoConferenceSend({kind:'offer',…});                       // offerはこの後
```

Teams側（`audio-bridge/target.js`）。

```js
await peer.setLocalDescription(await peer.createAnswer());
await /* iceGatheringState === 'complete' を待つ。最大8秒 */;
emit({kind:'answer',…});
```

**15秒の期限が、両側のICE収集（各最大8秒）を合計で抱えている。**
最悪16秒で、answerが返る前に期限切れになる。

観測とも一致する。

- どちら側も8秒の個別上限には達していない（ICEタイムアウトのエラーが無い）
- `transport-failed` も無い。HTMLはanswerを受け取れず、`connectionState` は
  `new` のまま15秒経過した
- 15.3秒 ≒ HTML収集7.5秒 + Teams収集7.8秒

`iceServers:[]` なのでホスト候補のみだが、収集の完了はネットワークインター
フェースごとのmDNS登録を待つ。VPNや仮想アダプターが多い端末では数秒かかり、
**日によって成否が変わる**。以前つながっていたのはこのためで、環境が揺れている。

## 3. 修正

### audio-bridge/target.js

**answerはICE候補が1つ取れた時点で返す。** 収集の完了は待たない。
両者は同一ブラウザー内なので、ホスト候補1つあれば接続できる。候補が出てから
250msだけ待って確定させ、候補が1つも出ないまま8秒経過した場合のみ従来どおり
失敗させる。これで answer 側の所要は数百msになり、期限は事実上HTML側の収集と
接続だけを見ればよくなる。

**ハンドシェイクの診断を追加。** どこで止まったかがログで分かるようにした。

- `conference-offer-received`（awaitより前に発行。offerが届いたか届かなかったかを区別できる）
- `conference-answer-sent`（収集所要ms、候補数、`iceGatheringState`）
- `conference-bridge-state`（ブリッジの `connectionState` 遷移）

### audio-bridge/controller.js

**フレーム選定でブリッジ本体の有無も確認する。** 従来は
`window.DuoTeamsAdapter`（`conference-adapters/teams.js`）だけを見ていたが、
offerに応答するのは `audio-bridge/target.js`（`window.__duoConferenceTarget`）
で、別のスクリプトである。前者だけある状態のフレームを選ぶと、offerは正常に
中継されたまま誰も応答せず、症状は「エラーなしの15秒タイムアウト」になる。
選んだフレームに応答側が無ければ、その場で理由を出して止める。

**offer / answer の中継を記録する。** `conference-offer-relayed` /
`conference-answer-relayed` にセッション開始からの経過msを載せる。

## 4. 検証

Node VMテスト128件成功（v1.4.6は121件）。構文チェック32ファイル成功。

`audio-bridge/target.js` はこれまでテストが1つも無かったため、
`tests/test-bridge-target.cjs` を新設した（5件）。

- offerはawaitより前に受領を通知する
- ICE候補1つでanswerを返し、収集完了を待たない
  （**v1.4.6のソースに対して実際に失敗することを確認済み**）
- 収集が先に完了した場合もそのまま返す
- 候補が1つも無ければanswerを出さない
- ブリッジの状態遷移を報告し、失敗でセッションを止める

フレーム選定側に2件追加。

- アダプターはあるがブリッジ本体が無いフレームは、黙って使わず拒否する
- ブリッジ本体があるフレームを優先して選ぶ

**未検証：** 実ブラウザーでの接続。今回の修正は成立までの時間を縮めるもので、
環境側でICE収集が極端に遅い場合やUDPが遮断されている場合は別の失敗になる。
その場合は新しい診断で区別できる。

## 5. HTML側について（未実施）

根本的には **HTMLの15秒タイマーが自分のICE収集より前に始まっている** のが
筋の悪いところで、offer送信後に開始すれば期限は接続だけを見ることになる。
`index.html` は公開中のアプリ本体なので今回は変更していない。必要なら
タイマー開始位置を `duoConferenceSend({kind:'offer'…})` の後へ移す1行で済む。
