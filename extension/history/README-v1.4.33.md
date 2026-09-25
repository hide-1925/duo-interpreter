# Duo Interpreter 拡張 v1.4.33

HTML 本体 **v1.49.22**（ビルド `20260925-v14922-gemini38-model-field`）と対です。

## Gemini 3.8 を使えるようにしました（というより、モデル名を表から外しました）

v1.4.32 で入れた Google Cloud TTS のモデル選択は**プルダウン**で、中身は Google の
公式サンプル（`gemini-2.5-flash-tts` / `gemini-3.1-flash-tts-preview` / `gemini-2.5-pro-tts` /
`gemini-2.5-flash-lite-preview-tts`）でした。その2日後に **Gemini 3.8 Flash TTS と
Gemini 3.8 Flash-Lite TTS** が出ています。

**プルダウンのままだと、Google が新しいモデルを出すたびにこのアプリの版を上げないと
使えません。** それは間違った作りなので、直しました。

### 直したこと

⚙ → 音声 → 読み上げ → Google Cloud TTS →（系統を Gemini-TTS にすると出る）**モデル**

- **入力欄になりました。** 候補は出ますが、選ばずに打ち込めます。
  **Google が新しいモデルを出したら、このアプリを更新しなくてもその名前を書けば使えます。**
- 既定を **`gemini-3.8-flash-lite-tts`** にしました。読み上げ用途向けの高速・低コスト版で、
  `gemini-3.1-flash-tts-preview` の置き換えにあたります。同時通訳はまさにこの用途です。
- 候補として出るのは次の6つです。

|モデル名|位置づけ|
|---|---|
|`gemini-3.8-flash-lite-tts`（既定）|高速・低コスト。読み上げ用途の標準|
|`gemini-3.8-flash-tts`|表現重視。声の設計・複製に対応|
|`gemini-2.5-flash-tts`|ひとつ前の正式版|
|`gemini-2.5-pro-tts`|ひとつ前の表現重視|
|`gemini-3.1-flash-tts-preview`|3.8 に置き換えられたプレビュー|
|`gemini-2.5-flash-lite-preview-tts`|旧・軽量プレビュー|

**声の設計（文章から声を作る）や声の複製**で作った声を使う場合は、その識別子を
「**声の名前を直接入力**」へ貼ってください。こちらは v1.4.32 から入力欄なので、
そのまま使えます。

### 変えていないこと

- リクエストの形は同じです（`voice.modelName` に書いた名前をそのまま載せます）。
- 音声形式は **MP3** のままです。Gemini-TTS は Cloud Text-to-Speech API 経由で
  MP3 を受け付けます（3.8 は既定が WAV に変わりましたが、こちらは明示指定しています）。
- 話速の扱いも同じです。**Gemini-TTS には `speakingRate` を送りません**（話し方は
  プロンプトで指示する設計です）。速さはピッチ保持再生で出します。

## 確かめていないこと

- **v1.4.32 から変わらず、合成そのものは未確認です。** この作業環境に Google のキーが
  ありません。モデル名の扱い（書いたとおりに送ること）はブラウザで確認しましたが、
  `gemini-3.8-flash-lite-tts` が**実際に応答を返すかは試していません。**
  最初の1回は「🔍 確認」でキーの疎通を見てから読み上げてください。
- Gemini 3.8 が `<laugh>` のようなインラインタグを Cloud Text-to-Speech 経由でも
  受け付けるかは確かめていません。受け付けるなら「話し方の指示」ではなく本文に書けます。

## 更新のしかた

`chrome://extensions` → Duo Interpreter → 再読み込み。HTML 本体を直接開いている
場合は `index.html` を上書きしてから再読み込みしてください。

## 検査

`node extension/tests/run-all.cjs --with-e2e` → 497件・全通過。

`test-google-tts` は 26 件になりました。足した3件は、**表に無いモデル名でもそのまま
送ること**（`gemini-9-whatever-tts` のような未知の名前を検査に使っています）、
入力欄なので前後の空白を落とすこと、空欄のときは出荷時の既定へ落ちることです。
