# 配布物（zip）の監査

## 1. 走査

| 対象 | 数 | 方法 | 結果 |
|---|---|---|---|
| `dist/*.zip`（v1.4.1〜v1.4.49） | 49 | メモリ上で展開（入れ子も）。ディスクへは書かないので zip-slip は起きない | 0件 |
| `duo-interpreter-chrome.zip`（ルート） | 1 | 同上 | 0件 |
| 履歴にある zip（`duo-interpreter-chrome-v1.2.3.zip` を含む全版） | 67 blob・12,066エントリ | 同上 | 0件 |
| Release `v1.48.0` の asset | 1 | 同上 | 0件 |

エントリ名の検査（隠しファイル、`.env`、`*.map`、`*.bak`、`~`、credentials、secrets、diagnostics、interpret-log、minutes、PRIVATE）も0件。
入っていたのは、拡張のソース、試験、fixture（F-06）、リリースノート、検証記録、アイコンだけだった。
バイナリ（アイコンの PNG）は印字可能な文字列（`strings` 相当）で走査した。

## 2. zip とソースの整合

| 確認 | 結果 |
|---|---|
| ルートの zip と `dist/…-v1.4.49.zip` | バイト単位で同一 |
| v1.4.49 の zip と、その時点の `extension/` の登録済みファイル | 177ファイルすべて一致（`実装状況-v1.4.0.md` は名前が UTF-8 フラグなしで格納されていただけで中身は同一） |
| 登録済みなのに zip に無いファイル / zip にあって登録されていないファイル | 0 / 0 |

これまでの zip は手作業で作られていて、どの commit から作ったかを記録していなかった。

### 今回から

- `tools/build-extension-zip.cjs` … `git ls-files extension` のファイルだけを、名前順・時刻固定（`APP_BUILD` の日付）・UTF-8 の名前で zip にする。**同じ中身からは同じバイト列**になる（2回作って SHA-256 一致を確認）
- `--check` … ルートの zip の中身と、登録済みの `extension/` を1ファイルずつ突き合わせる
- `versions.json` の各版に `extensionZipSha256` を記録する（v1.49.39 から）

| 版 | ファイル数 | SHA-256 |
|---|---|---|
| 拡張 1.4.50（HTML v1.49.39） | 181 | `versions.json` の `v1.49.39.extensionZipSha256` を参照 |

## 3. `dist/` の運用（F-15・提案。変更はしていない）

いまは版ごとの zip を `dist/` に積んでいる（50個・約39MB。履歴中の zip は67個で、pack の大半を占める）。

| | A. 現行のまま | B. GitHub Releases へ移す |
|---|---|---|
| リポジトリに置くもの | 全版の zip | ソースと最新の zip だけ |
| 過去版の入手 | clone すれば全部ある | Release の asset |
| 監査の面積 | 版が増えるたびに zip の中身も走査が要る。履歴から消せない | 走査対象は最新の zip だけ |
| リポジトリの大きさ | 版ごとに約1.3MB ずつ増え続ける | 増えない |
| 来歴 | zip とコミットの対応は `versions.json` だけ | Release のタグ・本文に commit と SHA-256 を書ける |
| 秘密が紛れた場合 | 全版の zip を含めて履歴の書き換えが要る | asset を消して作り直せば済む |

**推奨: B。** 移す場合も、既に履歴にある zip は残る（消すなら履歴の書き換えが要る）。移行の決定は owner。
