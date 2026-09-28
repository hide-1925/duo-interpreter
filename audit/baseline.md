# Baseline（監査開始時点）

- 監査日: 2026-09-28
- 対象: `hide-1925/duo-interpreter`
- 監査ブランチ: `claude/duo-github-cleanup-xkdy6h`（`main` から作成）
- 個人メールアドレス・実名・秘密値はこの文書に書かない（fingerprint のみ）

## Git

| 項目 | 値 |
|---|---|
| `main` HEAD | `283fda8809d8ad051c2e73d7c1d50cf11005f4f5`（Merge PR #26、2026-09-27） |
| 作業ツリー | clean |
| clone の状態 | 最初は shallow（203 commit）。`git fetch --unshallow` で全履歴を取得 |
| 到達可能な commit | 305（`--all`、PR ref 含む） |
| blob / tree | 945 / 524 |
| pack サイズ | 約 24.8 MiB |
| Git LFS | 不使用（`.gitattributes` に `filter=lfs` なし） |

### 公開 ref

| ref | SHA | 備考 |
|---|---|---|
| `refs/heads/main` | `283fda8` | 既定ブランチ |
| `refs/heads/claude/kind-dijkstra-y879gv` | `a5ff07a` | main に統合済み（PR #1〜#26 の head） |
| `refs/heads/claude/teams-tts-fix` | `300c507` | main に統合済み |
| `refs/heads/feature/prosody-preservation` | `3ada518` | **main に未統合の commit が1件**（2026-08-29、`index.html` の編集） |
| `refs/tags/v1.48.0` | `454a232` | 軽量タグ（commit を直接指す） |
| `refs/pull/1..26/head` | 26件 | GitHub が管理する読み取り専用 ref。全て上記ブランチから到達可能 |

## GitHub

| 項目 | 値 |
|---|---|
| 可視性 | **private**（監査時点） |
| fork | 0 |
| Pull Request | 26（すべて merged、head は `claude/kind-dijkstra-y879gv`） |
| Issue | 0 |
| PR コメント / review / review コメント / commit コメント | 0 / 0 / 0 / 0 |
| Release | 1（`v1.48.0`、asset `duo-interpreter-chrome.zip`） |
| Pages | 有効（`main` から build。`pages build and deployment` の最新は `283fda8`） |
| Wiki | 機能は有効。内容は取得できず（下記「制約」） |
| Actions artifact | 0 |
| License（GitHub の認識） | なし |

## 道具

| 道具 | 状態 |
|---|---|
| `gitleaks` | 未導入（入れていない） |
| `trufflehog` | 未導入（入れていない） |
| `git filter-repo` | 未導入。**システムには入れず**、作業用の使い捨て venv（リポジトリ外）にだけ入れて dry-run に使用（`a40bce548d2c`） |
| `gh` CLI | この環境では使えない。GitHub API は MCP と API プロキシ経由で参照 |
| 代替スキャン | `tools/security-scan.cjs`（今回追加。`git rev-list --all --objects` + `git cat-file --batch` + 入れ子 zip の展開 + commit メタデータ） |

## テスト（変更前）

`node extension/tests/run-all.cjs` … 35 スイート・686 checks すべて通過。

## 書き換え前バックアップ

- `git bundle create ../duo-interpreter-pre-sanitize.bundle --all` → `git bundle verify` 通過（complete history）
- 置き場所はリポジトリの外（作業コンテナ内）。Git 管理対象にも GitHub にも置いていない
- SHA-256 `43d7ca5bd1e95bc6c7fc6ba1d8f9916f4cd1f86d4d92c781ce024625888f12aa`、約 24.9 MB
- **注意:** 作業コンテナは一時的なので、この bundle は消える。force push を承認する前に、owner 自身の端末で
  `git clone --mirror https://github.com/hide-1925/duo-interpreter.git` などで**手元にバックアップを取ること**

## 制約（確認できなかったもの）

- **Wiki の中身:** `git ls-remote …wiki.git` が認証を求めて失敗（この環境の GitHub 認証は本体リポジトリだけ）。Wiki が空かどうかは未確認
- **GitHub Pages の公開物:** `hide-1925.github.io` への接続が環境のネットワーク方針で拒否された。Pages は `main` から build されており、`main` の作業ツリーは走査済みだが、**配信中のファイルそのものは未確認**
- `GET /repos/{owner}/{repo}/pages` は API プロキシで許可されていない
