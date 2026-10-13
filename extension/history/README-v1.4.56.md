# Duo Interpreter 拡張 v1.4.56

HTML 本体 **v1.54.0**（ビルド `20261010-v1540-openai-decisions`）と対です。

発話交代の判断層に、OpenAI の Decisions API の経路を足しました。拡張の側のコードは変えていません（`api.openai.com` は前から `host_permissions` にあります）。

## 1. 足したこと：判断層の経路「OpenAI — Decisions API」

OpenAI が 2026-10-06 に公開ベータで出した Decisions API（`POST /v1/decisions`、既定のモデル `gpt-6-luna`）は、Jev と同じく「型の付いた質問に、選択肢ごとの確率で答える」API です。
⚙→音声→「発話交代の判断層（実験）」の「経路」に「OpenAI — Decisions API（未検証）」として出ます。

| | 内容 |
|---|---|
| 送るもの | Jev と同じ（認識中の原文の末尾と、ONなら音響特徴）。質問の文面も Jev と1文字も変えない |
| 形の違い | 質問は map ではなく順のある配列、選択肢の説明は `choices[].description`、0〜1 の問いは `predicate`。答えは `name` で引く |
| 答えない場合 | 質問ごとに `refusal` が返ることがある。1つでもあれば Rules へ落とし、`refusal: 質問名` を記録する。判断層は off にしない |
| 確率の扱い | Duo の閾値は Jev の校正済みの確率で決めたので、OpenAI の確率では「ここで切る」側の基準を自動で厳しくする |
| キー | 判断層の欄に OpenAI のキーを別に入れる。翻訳欄のキーは借りない。書き出しにも埋込みHTMLにも乗らない |
| 未検証 | 形は公式 SDK（openai-node・openai-python）のソースで照合した。実機での疎通はまだ |

## 2. あわせて直したこと（既存の経路にも効く）

- **Base URL の欄に別の会社の送り先が残っていると、そこへ別の会社のキーを送っていた。** 欄は全経路で1つなので、Jev 用に `https://api.typesafe.ai` を入れたまま OpenRouter や OpenAI へ切り替えると、そのキーが TypeSafe へ送られていた。別の会社の経路の既定と同じオリジンなら、その経路では使わず自分の既定へ戻す。自前の中継の URL はそのまま使う。
- 旧版の単一のキー欄（TypeSafe／OpenRouter だけの頃のもの）を、OpenAI の経路では読まない。
- 疎通の確認で refusal を「契約の形に解析できません」と言わない。到達できないときに「Jev — アドオン経由」を勧めるのは TypeSafe の経路だけにした。

## 3. 検査

- `test-turn-providers` に10件（送る形、文面と候補、`name` と順での引き当て、refusal、壊れた答え9種、キー、Base URL、文脈上限、疎通の確認）。
  旧キーの流用・Base URL の取り違え・`name` を見ない・refusal を握りつぶす・predicate の意味を落とす、をそれぞれ入れると落ちることを確かめた。
- `test-settings-ui`（実ブラウザ）：選択肢に「（未検証）」付きで出る、キーが会社ごとに保存され書き出しに乗らない、キーの説明にモデル名と「shadow で」が出る。

## 4. 実機で確かめてほしいこと

`受入確認手順.md` の B-8zj。まず「この経路へ疎通を試す」を拡張の画面と HTML 版の両方で。
