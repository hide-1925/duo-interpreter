# Duo Interpreter 拡張 v1.4.51

HTML 本体 **v1.50.0**（ビルド `20260929-v1500-stt-live-host`）と対です。

`STTマルチプロバイダ開発仕様書.md` の **Phase 1** です。gpt-live-transcribe の経路を、あとから
ElevenLabs・AssemblyAI・Soniox を足せる形に分けました。**`delay` を「低（low）」のまま使うかぎり、
認識・カード・翻訳・読み上げの動きは v1.49.39 と同じです。**

## 1. 変わったこと

| | 前 | 今 |
|---|---|---|
| gpt-live の実装 | `RealtimeTranscriptionEngine` 1つに、接続とカード管理が同居 | カード・区切り・計測・停止は `SttLiveHost`、接続と受信の読み替えは `STT_LIVE_PROVIDERS.openai`（Adapter） |
| `delay` | `low` 固定 | ⚙→音声 の「ストリーミング認識の設定」で **minimal／low（既定）／medium／high／xhigh** から選べる（gpt-live-transcribe を選んでいるときだけ出る）。次の「開始」から反映 |
| 計測 | 最初の partial と final の時刻だけ | カードを閉じるたびに `live-metrics`（TTFP・TTTR・閉じた理由・partial 数・書き換え回数・PRR・字数）。**本文は入れない**。診断ログに「ストリーミング認識の設定」「ストリーミング認識の計測」（件数・中央値・p90） |

TTFP と TTTR の起点は、端末側の音量判定で0.4秒以上の無音のあとに初めて声を検出した時刻です。
話し続けているあいだに次のカードが開いたときは、前のカードを閉じた時刻を起点にします。
TTTR は、そのカードで最初の区間が翻訳へ出た時刻（逐次読み上げが OFF ならカードを閉じて翻訳した時刻）です。

## 2. 変えていないこと

- 送る session 設定。`delay=low` のとき v1.49.39 とバイト単位で同じです（検査で固定）。
- カードを閉じる規則（文末らしさ・無音・文字の停止・判断層 INV-13）、`completed` の扱い、診断の記録名と中身。
- キーの扱い。gpt-live は今までどおり音声認識欄のキー、空なら翻訳欄のキーを使います。

## 3. 検査

- `test-stt-live-parity`（決定論・12件）… 同じ DataChannel の受信列と時刻を、v1.49.39 の実装
  （`tests/fixtures/gpt-live-v1.49.39.js`）と今の `SttLiveHost` に流し、カード・翻訳と読み上げの呼び出し・
  診断の記録が一致することを、逐次読み上げの ON／OFF の両方で確かめる。区切りの待ち時間を1つ変えると落ちることも確かめた。
- `test-stt-live-host`（決定論・8件）… 全文置換の partial（書き換えで閉じたカードを壊さない）、計測の値と本文を持たないこと、
  新しい Provider が翻訳のキーや別の会社のキーを借りないこと、選択肢に無い保存値を既定へ戻すこと、停止後の受信を捨てること。
- `test-stt-settings-ui`（実ブラウザ・7件）… 設定欄が gpt-live のときだけ出ること、delay が5段のプルダウンで「（既定）」が low だけに付くこと、
  変更が CFG・localStorage・送る session に届き、再読込しても残ること。

## 4. 実機で確かめてほしいこと

`受入確認手順.md` の B-8ze。とくに **delay の5段それぞれで接続できるか** は実機でしか分かりません
（OpenAI の SDK の型注記は「delay は gpt-realtime-whisper でだけ使える」と書いており、ガイドと食い違っています）。
