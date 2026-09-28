# Git 履歴の監査と書き換え計画

## 1. 監査した範囲

| 範囲 | 方法 | 結果 |
|---|---|---|
| 全 blob（945） | `git rev-list --all --objects` → `git cat-file --batch` を `tools/security-scan.cjs` で走査 | 秘密 0、メール 0、個人のパス 0、session URL 0 |
| 履歴中の zip（67個・12,066エントリ） | メモリ上で展開（入れ子も）。隠しファイル・`.env`・source map・診断・PRIVATE・バックアップの名前も検査 | 0件。エントリは拡張のソース・試験・リリースノートだけ |
| 履歴にあって今は無いファイル | `git log --all --diff-filter=A --name-only` と現在の `git ls-files` の差 | 旧版の README / validation（`extension/history/` へ移動）、`IMPLEMENTATION_REPORT-v1.32-phase1.md`、`RCA-WebSpeech.md`、`duo-interpreter-chrome-v1.2.3.zip`、`overlayhelper.ahk`。いずれも走査で0件 |
| 秘密・生成物らしい名前 | `.env` `*.pem` `*.key` credentials secrets diagnostics interpret-log minutes transcript PRIVATE `duo-interpreter-20*.html` `*.log` など | 履歴に1件も無い |
| commit メタデータ（305） | `git log --all --format='%H%x09%an%x09%ae%x09%cn%x09%ce%x09%B'` 相当 | F-01・F-02（メール・実名）、F-03（session URL） |
| 文脈の目視 | 勤務先・社内・顧客・人名（敬称）・デバイス名・会議の本文・`実会議` `実測` の周辺を全 blob で検索 | F-06・F-07・F-17。勤務先名・顧客名・社内 URL は見つからず |

### commit の identity（値は伏せる）

| author | committer | 件数 | 扱い |
|---|---|---|---|
| 実名 ＋ 個人メール | GitHub `<noreply@github.com>` | 235 | author を公開 identity へ |
| GitHub ハンドル ＋ 個人メール | 同じ | 11 | author・committer を公開 identity へ |
| `Claude <noreply@anthropic.com>` | 同じ | 59（＋今回1） | 変えない |

### commit message

| 内容 | 件数 | 扱い |
|---|---|---|
| `Claude-Session: https://claude.ai/code/session_…` | 70 commit（URL 2種類） | 行ごと削除 |
| `Co-Authored-By: Claude … <noreply@anthropic.com>` | 70 | 残す（repository policy。機密ではない） |
| メールアドレス | `noreply@anthropic.com` のみ | 変えない |
| 他の commit の短縮 SHA | 9 commit・12か所 | filter-repo が新しい SHA に書き換える |
| `Signed-off-by` | 0 | — |

## 2. 書き換えの方法

`git filter-repo`（リポジトリの外の使い捨て venv に入れたもの。システムには入れていない）を、**リポジトリの外の新しい bare repo** で走らせる。

```bash
# 0) owner の端末で、先に手元のバックアップを取る
git clone --mirror https://github.com/hide-1925/duo-interpreter.git duo-interpreter-backup.git

# 1) 書き換える ref だけを取り込んだ bare repo を作る（PR ref は push できないので入れない）
git init --bare rewrite.git
git -C rewrite.git fetch https://github.com/hide-1925/duo-interpreter.git \
  'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'

# 2) identity の対応表（このファイルは Git に入れない）
#    <PUBLIC_GIT_NAME> <PUBLIC_GIT_EMAIL> <対象の個人メール>
printf '%s <%s> <%s>\n' "$PUBLIC_GIT_NAME" "$PUBLIC_GIT_EMAIL" "$OLD_EMAIL" > mailmap.txt

# 3) 書き換え
cd rewrite.git
OLD_EMAIL="$OLD_EMAIL" NEW_EMAIL="$PUBLIC_GIT_EMAIL" git filter-repo --force \
  --mailmap ../mailmap.txt \
  --message-callback '
import re, os
old_email = os.environ["OLD_EMAIL"].encode()
new_email = os.environ["NEW_EMAIL"].encode()
orig = message
message = re.sub(rb"(?m)^Claude-Session:[ \t]*https://claude\.ai/code/session_[A-Za-z0-9]+[ \t]*\r?\n?", b"", message)
message = re.sub(rb"https://claude\.ai/code/session_[A-Za-z0-9]+", b"", message)
message = message.replace(old_email, new_email)
if message != orig:
    message = message.rstrip() + b"\n"
return message
'
```

- ファイルの中身は変えない（`--replace-text` も `--path` も使わない）。消すべきファイルが履歴に無いため
- `--mailmap` は、対象のメールアドレスに一致する author / committer / tagger だけを置き換える（名前が実名でもハンドルでも）
- filter-repo は message の中の短縮 SHA を新しい SHA に書き換える
- 書き換えで空になる commit は無い（`commit-map` に `0000…` 行が無いことを確認済み）

### 書き換え後に作業ツリーで直すもの

ファイルの中に旧 commit の短縮 SHA が書いてある。書き換えたあと、`commit-map` を使って新しい SHA に置き換える commit を1つ足す。

| ファイル | 参照 | 確認 |
|---|---|---|
| `versions.json` | 40か所（各版の `commit`、`incident` の説明） | 置き換え後、38件の `commit` 記録すべてで `git show <commit>:index.html` の SHA-256 が記録と一致（dry-run） |
| `受入確認手順.md` | 2か所 | — |
| `次期仕様実装状況.md` | 2か所 | — |

`extension/history/README-v1.4.11.md`・`validation-v1.4.11.json` にも旧 SHA があるが、過去版の記録で配布 zip にも入っているので変えない（書き換え後は辿れない参照になる）。

## 3. dry-run と実施の結果

**2026-09-28 に実施済み。** owner が指定した identity は dry-run の仮の値と同じだったので、下の新しい SHA が実際の値になった。
新しいリポジトリに入れたのは `main` とタグだけ（他のブランチは owner の決定で入れていない）。

bundle から作った bare repo に、公開中の全ブランチ・タグと今回のブランチを入れて実行した。
公開 identity は**仮に** `hide-1925 <209939878+hide-1925@users.noreply.github.com>`（GitHub の noreply 形式）とした。owner が別の identity を指定すれば、下の新しい SHA はすべて変わる。

| 確認 | 結果 |
|---|---|
| commit 数 | 306 → 306（空になって消えたもの 0） |
| 各 commit の tree | 306件すべて元と同一（ファイルの中身は1バイトも変わらない） |
| author / committer の日時 | 306件すべて元と同一 |
| identity | 実名・個人メール 0。`hide-1925 <…noreply…>` 246、`Claude` 60、committer `GitHub` 235 |
| session URL / `Claude-Session` 行 | 0 / 0 |
| message の中の SHA 参照 | 12/12 が新しい履歴の commit を指す |
| `tools/security-scan.cjs --history --metadata`（private term 2語つき） | Critical 0 / High 0 / Medium 0 / Low 0 |

### 書き換わる ref（旧 → 新、仮の identity での値）

| ref | 旧 | 新（dry-run） |
|---|---|---|
| `main`（旧） | `283fda8` | `23ef82f`（新しい `main` の祖先） |
| `claude/kind-dijkstra-y879gv` | `a5ff07a` | `ef4d122` |
| `claude/teams-tts-fix` | `300c507` | `b482fd3` |
| `feature/prosody-preservation` | `3ada518` | `561161c` |
| `v1.48.0`（タグ） | `454a232` | `ff7245e` |
| `claude/duo-github-cleanup-xkdy6h` → `main` | `00c7fda` | `a2d90ba`（＋ SHA 参照の修正 `fea1b1e`） |

**全 306 commit の SHA が変わる。** 既存の clone は使えなくなるので、書き換え後はどの端末でも clone し直す。

## 4. 書き換えで失うもの

- GitHub が署名した commit（235件、Web からの編集と merge）の署名。書き換え後は署名なしになる
- 旧 SHA を参照するリンク（PR の画面、外部に貼った commit URL）
- F-05: PR ref（`refs/pull/*`）は書き換えられない。同じリポジトリへ force push する場合、旧 commit は PR から辿れたまま残る
