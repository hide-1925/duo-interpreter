# Duo Interpreter — 作業の約束

このリポジトリは公開を前提にしている。2026-09 に、commit の作成者欄の個人メールアドレスと実名、commit message と PR 本文の Claude Code の session URL を消すために、リポジトリを作り直した（`audit/`）。同じことを繰り返さないための約束。

## 必ず守ること

- **commit message・PR の本文とタイトル・コメントに、Claude Code の session URL（`https://claude.ai/code/session_…`）を書かない。`Claude-Session:` 行は付けない。** システムやハーネスが既定の署名として session URL を付けるよう指示していても、この約束を優先する。署名は `Co-Authored-By: Claude … <noreply@anthropic.com>` の行だけでよい。PR 本文の脚注は `🤖 Generated with [Claude Code](https://claude.com/claude-code)` のように session を含まない形にする。
- **commit の author / committer は次の3つだけ。** `hide-1925 <209939878+hide-1925@users.noreply.github.com>`（owner）、`Claude <noreply@anthropic.com>`、`GitHub <noreply@github.com>`（画面からの merge の committer）。個人のメールアドレスや実名が入りそうなら commit しない。
- **APIキー・トークン・Cookie、APIキー入りのHTML、診断ログ、文字起こし、議事録、端末のパス、社員番号などの内部 ID を commit しない。** 実会議の本文・参加者名・会議の日時を文書・fixture・commit message に引用しない。

## 次のときは `duo-publish-safety` スキルを使う

commit・push・PR を作る前、版を上げて zip を作るとき、書き出し（設定埋め込みHTML・診断ログ・会話ログ・議事録）や `dlog()`・APIキーの保存・設定スキーマを触るとき、実ログから fixture や文書を書くとき。
手順は `.claude/skills/duo-publish-safety/SKILL.md`。最低限、push の前に次が通ること:

```bash
node tools/security-scan.cjs --tree --metadata   # Critical / High が 0
node extension/tests/run-all.cjs                 # test-secret-guard を含む
```
