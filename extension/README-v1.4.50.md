# Duo Interpreter 拡張 v1.4.50

HTML 本体 **v1.49.39**（ビルド `20260928-v14939-secret-guard`）と対です。

公開リポジトリの監査（`audit/findings.md`）で見つかった、**書き出しから APIキーと会話の本文が漏れうる経路**を塞ぎました。
翻訳・読み上げ・認識の動きは変えていません。

## 1. 設定・用語集を埋め込んだHTML

| | 前 | 今 |
|---|---|---|
| 既定（「APIキーも埋め込む」OFF） | キーは入らない | 同じ。加えて、**手元のキーと同じ文字列が1つでも入っていれば書き出さない**（コンテキストや用語集にキーを貼ってしまった場合） |
| 「APIキーも埋め込む」ON | 確認なしで書き出す。ファイル名は通常と同じ | **書き出す前に確認**。ファイル名は `duo-interpreter-PRIVATE-WITH-KEYS-YYYYMMDD-HHMM.html`。書き出したあとは**OFFに戻る** |

判断層のキー（`portable:false`）は、ONでも入りません（前と同じ）。
`.gitignore` は `duo-interpreter-20*.html` と `duo-interpreter-*PRIVATE*.html` を除外します。

## 2. 診断ログ

**既定を「共有用」にしました。** 完全版はチェックを入れ、確認してから書き出します。

| | 共有用（既定） | 完全版 |
|---|---|---|
| 会話ログ | 件数だけ | 本文・訳文 |
| 動作ログの本文（`text`・`context`・`to` など） | 字数だけ（`[11文字]`） | そのまま |
| 参加者名 | 人数だけ | そのまま |
| デバイス名 | 台数だけ／設定行は `(デバイス名は省略)` | そのまま |
| 理由・エラー・状態 | そのまま | そのまま |
| APIキー | 伏せ字 | 伏せ字 |
| ファイル名 | `duo-diagnostics-YYYYMMDD-HHMM.md` | `duo-diagnostics-full-YYYYMMDD-HHMM.md` |

**動作の原因を調べるときは完全版を使ってください。** 今までと同じ中身です（キーの伏せ字が強くなっただけ）。

### 伏せ字を強くした

前は、動作ログの行と Base URL にだけ、キーの**形式**で伏せていました。次のものは素通りしていました。

- 形式の決まっていないキー（Aivis・VOICEVOX・独自の互換API）
- ElevenLabs の `sk_…`、Hugging Face の `hf_…`、GitHub の `ghp_…`、JWT
- `Cookie` / `Set-Cookie`、`x-goog-api-key`、`client_secret`、WebRTC の `credential`
- URL の `?key=` `token=`、URL の `user:pass@`
- API のエラー文に入って返ってきたキー

今は、**いま手元にあるキーの実値**（翻訳・認識・読み上げ・判断層・埋め込みHTMLから読んだもの）を先に完全一致で伏せ、そのあと形式で伏せます。
伏せ字は動作ログだけでなく**診断ログ全体**に掛けます。

## 3. 監査の道具

- `tools/security-scan.cjs` … 作業ツリー・全履歴・commit のメタデータ・ZIP の中（入れ子も）から、キー・メールアドレス・Claude Code の session URL・私的なパスなどを探す。値は出さず、規則名・場所・長さ・SHA-256 の先頭8桁だけを出す。
- `SECURITY.md` … 保存するもの・送り先・書き出しの中身・拡張の権限・脆弱性の報告方法。

## 4. 検査

- `test-secret-guard`（決定論・41件）… `exportData`・`exportHtml` の分岐・`.gitignore`・伏せ字（完全一致と23の形式）・共有用診断・ポップアップの字幕操作ログ・作業ツリーと配布 ZIP の走査
- `test-secret-guard-ui`（実ブラウザ・9件）… 本物のボタン・ダウンロード・ダイアログで、書き出したHTMLと診断ログの中身を確かめる

前の `redact()` は、上の漏れ方10種類をすべて素通りしていました（回帰の証拠）。
