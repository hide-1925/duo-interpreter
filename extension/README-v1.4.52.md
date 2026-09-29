# Duo Interpreter 拡張 v1.4.52

HTML 本体 **v1.51.0**（ビルド `20260929-v1510-stt-multi-provider`）と対です。

`STTマルチプロバイダ開発仕様書.md` の **Phase 2〜4 と Phase 5 の一部**です。音声認識に、ElevenLabs・AssemblyAI・Soniox の
ストリーミング認識を足しました。**既定の設定のままなら、今までの音声認識（Web Speech・録音分割・gpt-live）の動きは変わりません。**

## 1. 足したもの

| | 内容 |
|---|---|
| サービス | ⚙→音声 に「ElevenLabs Scribe v2 Realtime」「AssemblyAI Universal-3.5 Pro Realtime」「Soniox v5 Realtime」 |
| 音声の送り方 | 受け取ったマイク・共有音声・VB-CABLE の音を、AudioWorklet で PCM16・16kHz・モノラルにし、100ms ごとに WebSocket で送る。キャプチャは増やさない |
| 鍵 | 接続のたびに、その会社の発行元で一時資格情報を作り、WebSocket にはそれだけを使う。3社とも翻訳のキーは借りない（ElevenLabs は読み上げ欄の ElevenLabs のキーを使える） |
| 性能設定（すべてプルダウン） | ElevenLabs：確定のしかた・確定までの無音（既定1.5秒）・詳細3つ。AssemblyAI：性能モード（既定 balanced）・詳細（上書きした項目だけ送る）。Soniox：区切りの速さ Level 0〜3（既定0）・詳細2つ・「組み合わせ」（公式の既定／公式の低遅延の出発点） |
| カードを閉じる合図 | 早いほう（既定）／Provider の区切りだけ／Duo の区切りだけ（Provider の区間をつないで1本にし、確定本文で閉じたカードを直す） |
| 切断 | エラーを会社ごとの表で分類し、キー・設定の問題なら止めて知らせ、一時的な問題なら1分に3回まで、一時資格情報を作り直してつなぎ直す。開いていたカードはそこで閉じる |
| 確認ボタン | 「🔍 確認」は一時資格情報の発行を試す。ブラウザから届かない（CORS の可能性）ときと、キーが断られたときで文言を分ける |
| 拡張の権限 | `streaming.assemblyai.com` と `api.soniox.com`（一時資格情報の発行のため。音声の WebSocket 自体には権限は要らない） |

各社の API の形は、公式の SDK（npm で配布されているもの）のソースで照合しました（仕様書の付録A2）。

## 2. 変えていないこと

- gpt-live-transcribe の送る設定と動き（`test-stt-live-parity` で v1.49.39 と突き合わせたまま通る）。
- Web Speech・録音分割の音声認識、翻訳、読み上げ、発話交代の判断層。判断層は Provider を知らず、どの会社の partial にも同じように働く。

## 3. 検査

- `test-stt-live-adapters`（決定論・14件）… 3社の受信列 → 正規化イベント（partial は全文で置き換え、AssemblyAI は turn_order で区間を見分け、
  Soniox の `<end>`・`<fin>` は本文に入れない）、送る設定、エラーの分類、選択肢が SDK の範囲に収まること。DOM も翻訳も無い vm で動かす（Adapter はそれらに触れない）。
- `test-stt-pcm`（決定論・8件）… 48kHz・44.1kHz から 16kHz へ、振幅・周波数・折り返しの抑え方・ブロックの継ぎ目、PCM16 の丸めと切り捨て、Worklet が 100ms ごとに渡すこと。
- `test-stt-keys`（決定論・5件）… 長期のキーは発行元にだけその会社のヘッダで送り、WebSocket には一時資格情報だけ。伏せ字。CORS とキーの問題の文言。記録に鍵も用語集も出ないこと。
- `test-stt-live-host`（決定論・19件）… カードを閉じる合図の3つ、つなぎと確定本文での直し、空になったカードを消す、エラーの分類、再接続の上限。
- `test-stt-stream-ui`（実ブラウザ・7件）… 本物の AudioWorklet で 440Hz の音を 3,200 バイトずつ送り、偽の WebSocket と発行先で3社の流れを最後まで通す。
- `test-stt-settings-ui`（実ブラウザ・11件）… 3社の欄がプルダウンで、既定だけに「（既定）」が付くこと、Soniox の「組み合わせ」。

## 4. 実機で確かめてほしいこと

`受入確認手順.md` の B-8zf。とくに、**HTML 版（GitHub Pages）から各社の一時キーを発行できるか（CORS）**。
届かなかった会社は、拡張版から使えます。どう扱うか（D-2）は、その結果を見て決めます。
