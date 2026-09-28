# Public Release Gate

2026-09-28 時点。`[x]` は確認済み、`[ ]` は未了（理由を併記）。

## Critical gate

- [x] 有効な secret 0件（作業ツリー・全 blob・全 zip・commit メタデータ・PR 本文・Release）
- [x] private key / credential file 0件
- [x] secret が見つかった場合の revoke / rotate … 見つからなかったので不要

## Privacy gate

- [ ] 対象の個人メール 0件 … **F-01。書き換えの承認待ち**（dry-run では 0件）
- [ ] 対象の実名メタデータ 0件 … **F-02。同上**
- [ ] Claude Code session URL 0件 … **F-03（commit message）・F-04（PR 本文）。承認待ち**
- [ ] private term 0件 … commit メタデータにだけ残っている（F-02）。ファイルの中身は 0件
- [x] 誤って入った文字起こし・診断 0件（F-06・F-07 は owner 確認事項として記録）

## Git gate

- [x] working tree clean
- [x] 全 public branch を監査（4本）
- [x] 全 tag を監査（1個）
- [x] commit メタデータを監査
- [x] commit message を監査
- [ ] 旧い sensitive な object に到達できない … **F-05。PR ref の扱いの決定待ち**
- [x] force push の対象一覧を明示（`history-audit.md` §3）

## GitHub metadata gate

- [ ] PR 本文の走査 0件 … 45か所。編集か作り直しの承認待ち
- [x] PR コメントの走査 0件（コメント・review 自体が 0件）
- [x] Issue / コメントの走査 0件（0件）
- [x] Release の本文・asset の走査
- [ ] Wiki の走査 … **未確認**（取得できず）。使っていなければ無効化を推奨
- [ ] Pages の配信物の確認 … **未確認**（接続できず）。build 元の `main` は走査済み

## Artifact gate

- [x] 全 tracked zip の走査
- [x] 最新 zip とソースの整合（`tools/build-extension-zip.cjs --check`）
- [x] 生成される個人用ファイルが tracked されていない（`.gitignore` と試験で固定）

## Runtime security gate

- [x] 通常の書き出しに APIキーが入らない（F-10）
- [x] 診断ログの伏せ字の試験が通る（F-11）
- [x] 拡張の権限の理由を文書化（`SECURITY.md`、`extension-permission-audit.md`）
- [x] 共有用の診断を評価・実装（F-12。既定を共有用に）

## Quality gate

- [x] 決定論の試験 … 36スイート・727 checks 通過
- [x] E2E … 5スイート・40 checks 通過（headless Chromium）
- [x] 構文検査 … JS/CJS 67ファイル、JSON 全件
- [x] security の回帰試験 … `test-secret-guard`（41）・`test-secret-guard-ui`（9）

---

## owner の決定が要ること

| # | 決めること | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | 公開する Git の名前・メール | 例: `hide-1925 <209939878+hide-1925@users.noreply.github.com>`（GitHub の noreply） | noreply（GitHub の設定「Keep my email addresses private」とも一致する） |
| 2 | 旧 commit の消し方（F-05） | A. 同じリポジトリへ force push ＋ GitHub Support / B. リポジトリを作り直して push | **B**（private・fork 0 なので確実） |
| 3 | PR 本文の session URL（F-04） | 編集する / 作り直しで消える | 2 で A なら編集する |
| 4 | ブランチの削除（F-19） | `claude/kind-dijkstra-y879gv`・`claude/teams-tts-fix`（統合済み）／ `feature/prosody-preservation`（未統合1件） | 統合済み2本は削除。未統合の1本は owner が中身を見て判断 |
| 5 | LICENSE（F-14） | `license-decision.md` | owner が選ぶ |
| 6 | `dist/` を Releases へ移すか（F-15） | A. 現行 / B. Releases | B |
| 7 | 「APIキーも埋め込む」を残すか | 確認つきで残す（今回の実装）／機能ごと削除 | 使っているなら残す。使っていないなら削除が最も安全 |
| 8 | fixture の実会議の日時（F-06）・文書中の発話断片（F-07） | 残す / 消す（消すなら履歴の書き換えに含める） | F-07 は出典の確認次第 |

## この後の順序

1. owner が上の 1〜4 を決め、**自分の端末でバックアップ**（`git clone --mirror`）を取る
2. 書き換え（`history-audit.md` §2）→ SHA 参照の修正 commit → push（A なら force push、B なら新しいリポジトリへ push）
3. `post-rewrite-verification.md` の手順で、clone し直して検証
4. A の場合は GitHub Support へ依頼し、完了を確認してから public にする
