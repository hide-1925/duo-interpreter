# Duo Interpreter 拡張 v1.4.15

HTML 本体 **v1.49.4**（ビルド `20260923-v1494-state-projection`）と対です。

公式ドキュメントの **Models** と **Jev 1.13 jaggedness** を読んだ結果の修正です。
**私の実装に2つの誤りと1つの設計問題がありました。**

## 誤り1: 文脈上限を取り違えていた

公式の Models ページ：

> Context length: 64k tokens per request; 32k tokens for `state` plus the longest question

**32k は OpenRouter 固有の制限ではなく、直叩きにも掛かる枠**でした。前版まで私は
「OpenRouter は直接の半分」と書き、**OpenRouter だけに上限を置いて直叩きには何も
置いていませんでした。**

実害があります。`recentTurns` を増やすと state は伸びます。上限が無いと長い state は
`422` を受け、`422` は NEVER_RETRY なので**判断層が会議の途中で自分を off にします。**

TypeSafe 系の全経路に上限（body 24,000 文字）を入れました。トークン数はブラウザ側で
数えられないので文字数で保守的に代理しています。全文が CJK でも 1文字≒1トークンを
超えないため、24,000 文字なら 32k の内側です。超えたら送らず Rules へ落ちます。
**途中で切って送ることはしません**（候補の `before`/`after` と本文がずれ、存在しない
位置を選ばせてしまうため）。

OpenRouter 側の実際の枠は確認できていないので、UIには「未確認」と出します。

## 誤り2: `active` が `jev-preview` を通していた

公式の Models ページによると alias は2つあり、**現在はどちらも `jev-1.13.0` を指します。**

|alias|指す先|
|---|---|
|`jev-latest`|`jev-1.13.0`|
|`jev-preview`|`jev-1.13.0`|

> An alias moves when a new release ships, so the answers behind it can change without a
> change on your side.

`active` では校正済みの固定 version を pin する設計にしていましたが、**弾いていたのは
`latest` だけで `preview` は通っていました。**両方を弾くようにし、エラー文にも
`jev-1.13.0` という具体名を出します。設定欄の注記にも書きました。

## 設計問題: 質問が名指ししない `state` を送っていた

公式の jaggedness ページ：

> Accuracy falls as the state grows with content unrelated to the decision. Unrelated
> detail acts as a distractor.
> Giving it more context in `state` than the question needs. Jev suffers from context rot.

送っている state の項目と、質問の `instructions`／`criteria` がバッククォートで名指し
している識別子を突き合わせました。**17項目のうち9項目はどの質問からも参照されて
いませんでした。**

|落としたもの|理由|
|---|---|
|`schemaVersion` `sessionId` `utteranceId` `revision` `speakerKey`|こちらの記録用。モデルには無関係|
|`sourceLanguage` `speechEvent`|どの質問も参照していない|
|`evidence`|同上（4つの真偽値）|
|`candidateBoundaries`|**`criteria` 側に `before`/`after` として同じ本文が入る。丸ごと重複だった**|
|`tts.pendingFirstAudio` `tts.overlapMode`|`tts.active` と `tts.queueDebtMs` だけが名指しされている|

許可リストは**質問の本文から自動で作ります。**手で二重管理すると必ず片方が古くなる
ので、「文面で `` `x` `` と書けば送られ、書かなければ送られない」という一方向の規則に
しました。新しい項目を送りたければ、まず instructions に書く必要があります。

**内部の state は全項目そのままです。** trace・local モデル・Phase 3 の床はこれらを
使うので、削ったのは送信する形だけです。

### この作業中に自分のバグを1件見つけました

OpenRouter の本文で projection を先に当てていたため、`answerSchema` が見る
`candidateBoundaries` が消え、**選べる選択肢が `HOLD` だけになっていました。**
「モデルは省いた値を選べない」のだから、これは全部 HOLD を強制するのと同じです。
既存のテスト（`the OpenRouter schema offers exactly the candidates the state proposed`）
が捕まえました。組み立てには完全な state、送信には projection を使う形に直しました。

## 日本語について（公式の明記）

> English is the primary training language and where accuracy is currently best. Other
> languages, including CJK scripts, are handled but not equally well; test on your own
> content before relying on Jev for a non-English workload, and pay close attention to
> Confidence when routing.

**日英の通訳が主用途なので、これは黙っていられません。** 設定欄の注記に「日本語は
公式が英語と同等ではないと明記しているので、日本語側は必ず shadow で確かめてください」
と出します。言語別に閾値を持つ設計（§9.3）はこの記述と整合しています。

## まだ直していないこと（測る前に触らない）

jaggedness の失敗モード #2「Math and Numbers」に、**いまの設計は正面から当たって
います。**

> `jev-1.13` does not count reliably. This covers characters in a word, occurrences of a
> term in a passage, and items in a long list.
> Jev will perform better on semantic representations than numeric.

- `stablePrefixChars` は**文字数そのもの**です
- 候補IDに `C_FULL_28` のように**文字オフセットが入っています**
- `silenceMs` `lastDeltaMs` `queueDebtMs` と prosody の各値は**すべて生の数値**です

公式の指示は「コードで変換して、計算済みの数値か名前付きのバケットを渡せ」です。
**ただし、これは直しません。いまは。**

**Jev の応答をまだ1件も受け取っていないので、直しても良くなったか分からないから**
です。前後比較の基準が無い状態で表現形を作り替えるのは、外部レビューが指摘した
「接続成功を確認する前に周辺実装が先行する」の繰り返しになります。

shadow で trace が取れたら、次の順で当たります。

1. 候補IDを数字を含まない不透明な名前にする（`CUT_A` 等。対応はコード側が持つ）
2. `silenceMs` `lastDeltaMs` を名前付きバケットにする
3. prosody の生値を「下降/平坦/上昇」のような意味に寄せる

各段階を shadow で前版と比べます。**測ってから直します。**

## 検査

```
NODE_PATH=$(npm root -g) node extension/tests/run-all.cjs --with-e2e
```

`test-turn-providers` に追加：送る state が質問の名指しと一致すること、名指しされた
下位項目だけが送られること、projection が内部 state を壊さないこと、TypeSafe 系の
全経路が文脈上限を守ること、`active` が両方の alias を弾くこと。

古い期待値（`state.schemaVersion` が送られる、候補が `state` 側に出る）は
**意図的に変更**しました。

## 変わっていないもの

- `turnDecisionMode` の既定は `off`
- 判断層のキーは書き出しに載りません
- 判断層が届かないときは Rules で動き続けます（INV-08）
- 中継の縛り（許可オリジン1つ・HTTPSのみ・ヘッダ allowlist・頼める相手の限定）
