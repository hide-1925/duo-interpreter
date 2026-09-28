# 書き換え後の検証

**状態: 実施済み（2026-09-28）。** owner の決定は「B. リポジトリを作り直す」。

## 行ったこと

1. owner が手元に `git clone --mirror` のバックアップを取った（ref 32本、`main` = `283fda8…`）
2. `git filter-repo`（`history-audit.md` §2）で `main`（今回の修正を含む）とタグ `v1.48.0` を書き換えた。公開 identity は `hide-1925 <209939878+hide-1925@users.noreply.github.com>`
3. ファイルの中の旧 SHA の参照を直す commit を足した（`fea1b1e`）
4. owner が旧リポジトリを削除し、同じ名前で空の private リポジトリを作った
5. 書き換えた履歴を push し、`main` を作った

ブランチ `claude/kind-dijkstra-y879gv`・`claude/teams-tts-fix`・`feature/prosody-preservation` は owner の決定で新しいリポジトリに入れていない。
`feature/prosody-preservation` の未統合の commit（2026-08-29、`index.html` の編集）は owner のバックアップにだけ残っている。

## 検証

既存の作業ツリーは使わず、公開 URL から別のディレクトリへ clone し直して行った。

| 確認 | 結果 |
|---|---|
| clone した URL・HEAD | `https://github.com/hide-1925/duo-interpreter.git`、`main` = `fea1b1e25d2bfd36f329da515783690686f1436e`、shallow でない、307 commit |
| `security-scan.cjs`（作業ツリー 256ファイル・全 978 blob・307 commit・zip 118個／12,432エントリ、private term 3語） | Critical 0 / High 0 / Medium 0 / Low 0 |
| identity の一覧 | `hide-1925 <209939878+hide-1925@users.noreply.github.com>`・`Claude <noreply@anthropic.com>`・`GitHub <noreply@github.com>` だけ |
| session URL の件数 | 0 |
| ブランチ・タグ | `main`、作業ブランチ `claude/duo-github-cleanup-xkdy6h`（下記）。タグは未作成（下記） |
| zip の `--check` | 181ファイル、不一致 0 |
| 決定論の試験 | 36スイート・727 checks 通過 |
| E2E | 5スイート・40 checks 通過 |
| PR 本文 | PR 0件（作り直しで消えた） |
| PR ref | `refs/pull/*` 0本 |
| 旧 SHA の到達可否 | 旧 `main`（`283fda8`）・旧 PR head（`a5ff07a`）・未統合 commit（`3ada518`）とも `GET /commits/{sha}` が 422（存在しない） |
| Release | 0件（作り直しは owner の作業。下記） |
| Pages | 無効（再設定は owner の作業。下記） |
| Wiki | 機能は有効のまま、中身は空のはず（新しいリポジトリ）。使わないなら無効化を推奨 |

## owner の作業として残っていること

この環境のセッションでは、`main` とタグへの git push、リポジトリ設定の変更、Release の作成が許可されていない
（作業ブランチへの push と、API によるブランチの作成だけが通った）。

1. **既定ブランチを `main` にする**（Settings → General → Default branch）。今は最初に push した作業ブランチが既定になっている
2. **Pages を有効にする**（Settings → Pages → Deploy from a branch → `main` / `(root)`）
3. **タグ `v1.48.0` を `ff7245e79c04c484d6acfa486e429c15adfc5667` に作り、Release を作り直す**（任意。本文は旧 Release と同じ、asset はタグの `duo-interpreter-chrome.zip`）
4. 作業ブランチ `claude/duo-github-cleanup-xkdy6h` を `main` に取り込んだあと削除する
5. 他の端末にある古い clone は使わず、clone し直す

## 残るリスク

- 旧リポジトリの clone を持つ端末（owner の端末のバックアップを含む）には、旧い履歴がそのまま残る。バックアップは公開しないこと
- GitHub 内部の、削除済みリポジトリのデータの保持期間は利用者からは確認できない（旧リポジトリは private・fork 0 だった）
- 実キーは見つからなかった。GitHub の外（利用者の端末・共有した診断ログ・渡したHTML）にあったものは検査の範囲外
