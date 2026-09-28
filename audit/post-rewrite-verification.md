# 書き換え後の検証

**状態: 未実施。** 履歴の書き換え（force push またはリポジトリの作り直し）は owner の承認待ち。
dry-run の結果は `history-audit.md` §3 にある。以下は承認後に行う手順と、記入する欄。

## 手順

既存の作業ツリーは信用しない。公開 URL から別のディレクトリへ clone し直してから行う。

```bash
git clone https://github.com/hide-1925/duo-interpreter.git verify && cd verify
git fetch origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'

# 実名などの検索語（Git に入れない）
printf '%s\n' '<実名の姓>' '<実名の名>' > .audit-private-terms.txt

node tools/security-scan.cjs                 # 作業ツリー + 全履歴 + commit メタデータ + zip
git log --all --format='%an <%ae>%n%cn <%ce>' | sort | uniq -c
git log --all --format=%B | grep -c 'claude.ai/code/session_'   # 0 であること
git for-each-ref                            # 残すブランチ・タグだけであること
node tools/build-extension-zip.cjs --check
node extension/tests/run-all.cjs
NODE_PATH=$(npm root -g) node extension/tests/run-all.cjs --with-e2e
rm .audit-private-terms.txt
```

GitHub 側:

- PR 本文（26件）を取り直し、`claude.ai/code/session_` が 0件であること（作り直した場合は PR 自体が無い）
- `refs/pull/*/head` が旧 SHA を指していないこと（同じリポジトリへ force push した場合は、GitHub Support の対応後に確認）
- 旧 `main` の SHA `283fda8809d8ad051c2e73d7c1d50cf11005f4f5` を `GET /repos/hide-1925/duo-interpreter/commits/283fda8…` で引けないこと
- Release（作り直した場合は再作成）の本文と asset を走査
- Pages の配信物（`index.html`）を取得して走査
- Wiki が空であること（または無効にしたこと）

## 記入欄

| 確認 | 結果 | 日時 |
|---|---|---|
| clone した URL・HEAD | | |
| `security-scan.cjs`（Critical / High / Medium / Low） | | |
| identity の一覧 | | |
| session URL の件数 | | |
| ブランチ・タグ | | |
| zip の `--check` | | |
| 決定論の試験 | | |
| E2E | | |
| PR 本文 | | |
| PR ref | | |
| 旧 SHA の到達可否 | | |
| Release | | |
| Pages | | |
| Wiki | | |
