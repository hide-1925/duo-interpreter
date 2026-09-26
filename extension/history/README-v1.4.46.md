# Duo Interpreter 拡張 v1.4.46

HTML 本体 **v1.49.35**（ビルド `20260927-v14935-openrouter-tts`）と対です。

開発仕様書「OpenRouter を STT・翻訳・TTS で使えるようにする」の ③ です。

## 読み上げに OpenRouter と Groq を足す

⚙→音声 の「読み上げ」に、次の2つが増えました。

| 読み上げ | モデル | 声 | 言語 |
|---|---|---|---|
| OpenRouter | 既定 `google/gemini-3.8-flash-tts`。「🔎 選ぶ」で、読み上げに使えるモデルだけから選べる | モデルごとに OpenRouter の一覧（`supported_voices`）から、席ごとに選ぶ | モデル次第 |
| Groq | 既定 `canopylabs/orpheus-v1-english`（ほかに `canopylabs/orpheus-arabic-saudi`） | 英語：autumn・diana・hannah・austin・Daniel・troy／アラビア語：fahad・sultan・lulwa・noura（手入力もできる） | 英語かアラビア語だけ |

- OpenRouter のキーは、読み上げ欄が空なら翻訳欄のキーを使います。Groq のキーは、翻訳欄か音声認識欄のキーを使います。
- 「試しに使う」で、選んだモデルの最初の声で見本の1文を鳴らします。
- Groq で読めない言語（日本語など）は、ブラウザ内蔵の声で読みます。そのことを「いまの設定」に出します。

### 返ってきた音声の扱い

OpenRouter へは `response_format: "pcm"` で頼みます。Gemini の TTS は PCM しか返さないと、外部の実装に記録があるためです。

返ってきた中身の頭と `content-type` で形を見分けます。

- WAV・MP3・Ogg・FLAC は、そのまま鳴らします。
- それ以外は、16bit モノラルの PCM とみなして WAV に包みます。
  - `content-type` に `rate=` があればそのサンプルレートを使い、無ければ 24kHz とみなします。

診断ログの `openrouter-ok` に、形・サンプルレート・バイト数を残します。**声が高すぎる／低すぎるときは、サンプルレートが違います。** その記録を教えてください。

届いた先頭から鳴らす方式（逐次再生）は、まだ入れていません。いまは受け取り終わってから鳴らします。実機で形とサンプルレートを確かめてから足します。

### 話速と音量

- 話速：OpenAI 系のモデルは API の `speed` を使います。それ以外は、ピッチを保ったまま再生速度を変えます。
- 音量：Web Audio で変えます。

### 失敗したとき

ブラウザ内蔵の声で読みます。30秒に1回だけ理由を出します（例：「ブラウザから呼べませんでした」）。429 を受けたら、30秒はその読み上げを休みます。

## 確認したこと

- `test-hub-tts`（新規・6件）：
  - 返った中身の見分け（WAV・MP3・生の PCM、`rate=`、WAV の頭の値）
  - 席ごとの声
  - 話速を API に送るか再生側で変えるか
  - 失敗・429・キー無しのときにブラウザの声へ移ること
  - Groq の言語の制限と既定の声
  - 「試しに使う」
- `test-model-picker-ui`（E2E）8→11件：headless Chromium で、代役の OpenRouter に対して次を確かめた
  - 読み上げの選択肢に OpenRouter と Groq が出ること
  - 声の一覧がモデルの一覧から作られること
  - 0.3秒ぶんの生の PCM が 24kHz の WAV として 0.3秒鳴ること
  - Groq の欄と「英語だけです」の案内

**実際の OpenRouter・Groq の読み上げは、まだ確かめていません。** v1.49.34 の接続テストで、読み上げが通るかを先に見てください。

## 更新のしかた

HTML本体の `index.html` を差し替えて再読み込みしてください。拡張は版の対応を合わせるための更新です。

## 検査

`node extension/tests/run-all.cjs --with-e2e` → 678件・全通過。
