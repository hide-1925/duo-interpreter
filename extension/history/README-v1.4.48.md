# Duo Interpreter 拡張 v1.4.48

HTML 本体 **v1.49.37**（ビルド `20260927-v14937-groq-models`）と対です。

## Groq の翻訳モデルを今の顔ぶれにする

Groq は、2026年8月16日で Llama 3.1 8B Instant と Llama 3.3 70B Versatile の提供を終えたようです。
[LiteLLM のモデル一覧](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)でも、翻訳に使える Groq のモデルは次の3つだけでした。

- `openai/gpt-oss-20b`
- `openai/gpt-oss-120b`
- `qwen/qwen3.8-27b`

ところがアプリに入っている一覧は、先頭（既定のモデル）が `llama-3.3-70b-versatile` のままでした。そのため、キーを入れて一覧を取り直す前は、翻訳が失敗していました。

| | 前 | 今 |
|---|---|---|
| 内蔵の一覧 | llama-3.3-70b-versatile、llama-3.1-8b-instant、gpt-oss-120b、qwen3-32b、kimi-k2-instruct | **gpt-oss-20b**（最速・安い）、gpt-oss-120b（高精度）、qwen3.8-27b |
| 「速さ」のおすすめ | llama-3.1-8b-instant、gpt-oss-20b | **gpt-oss-20b**、qwen3.8-27b |
| 「精度」のおすすめ | gpt-oss-120b、kimi-k2-instruct、llama-3.3-70b-versatile | gpt-oss-120b、qwen3.8-27b |

おすすめは、今までどおり、そのアカウントの一覧にあるものだけを出します。

### 保存していた Llama は置き換える

翻訳プロバイダが Groq で、翻訳モデルが提供の終わった Llama のまま保存されていた場合は、開いたときに `openai/gpt-oss-20b` に置き換えて保存し直します。

- 画面に「Groq の llama-3.3-70b-versatile は提供が終わったため、翻訳モデルを openai/gpt-oss-20b に替えました。」と1回出します。
- 診断ログに `groq-model-retired` を残します。
- ほかのプロバイダの Llama（OpenRouter の `meta-llama/…` など）と、今も使える Groq のモデルには触りません。

### 速さの目安（参考）

検索結果の要約によると、gpt-oss-20b は約1,000トークン/秒、gpt-oss-120b は約400〜500トークン/秒でした。元のページはこの環境からは開けていません。
同時通訳では、1回に訳すのが短い文です。そのため、1秒あたりの速さより「返り始めるまでの時間」が効きます。「🔎 選ぶ」→「試しに使う」で実際の秒数を比べてください。

## 確認したこと

- `test-groq-models`（新規・4件）：
  - 内蔵の一覧の中身と既定のモデル
  - おすすめに提供の終わったモデルが無いこと
  - 保存していた Llama の置き換え
  - ほかのプロバイダや今のモデルに触らないこと
- `test-model-hub` の Groq の代役の一覧を、今の顔ぶれに直した。
- headless Chromium：`llama-3.3-70b-versatile` を保存した状態で開くと、`openai/gpt-oss-20b` に替わり、保存と画面の選択と案内がそろうことを確かめた。

## 更新のしかた

HTML本体の `index.html` を差し替えて再読み込みしてください。拡張は版の対応を合わせるための更新です。

## 検査

`node extension/tests/run-all.cjs --with-e2e` → 692件・全通過。
