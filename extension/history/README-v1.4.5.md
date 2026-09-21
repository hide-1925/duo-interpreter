# Duo Interpreter Chrome/Edge 拡張 v1.4.5

対象：Web版TeamsへTTS音声を送出できない問題
前提：HTML v1.47.0（変更なし）

## 1. v1.4.4実環境ログで確定した原因

`duo-subtitle-interaction (16).json`（extensionVersion 1.4.4）で、唯一の音声
senderがこう報告していた。

```
micEvidence:      false      ← v1.4.4で追加した判定
externalEvidence: true
externalReasons:  ["remote-receiver"]
sourceReasons:    ["get-user-media", "remote-receiver"]
eligibleCount:    0
selectionMethod:  none
```

**`micEvidence`が`false`なのに、`sourceReasons`には`get-user-media`がある。**
この矛盾が原因をそのまま示していた。

v1.4.4では`micEvidence`をグラフ最上段の`r.mic`から読んでいた。しかし`mic`は
**証明フラグ**であり、上流に証明できないものが1つでもあると`false`になる。
Teamsの送信経路は多段だった。

```
マイク ─┐
        ├→ 中間のMediaStreamAudioDestinationNode → 再source化 → 送信用destination
受信音声┘
```

中間のトラックを`inspect`すると、マイクと受信音声が混ざっているため
`mic:false`（証明できない）を返す。v1.4.4はその`mic:false`を見て
「マイクの証拠なし」と結論していた。実際には1段上にマイクがあり、
`sourceReasons`にはその痕跡が残り続けていた。

`nodeTypes`が`[Destination, Source]`の2種類だけだったため多段に見えなかったが、
`graphTypes`はコンストラクター名で重複を除くので、多段でも平坦でも同じ2種類に
なる。ここが見落としの入口だった。

## 2. 修正

### conference-adapters/mic-provenance.js

**`micEvidence`を証明フラグとは独立に伝播させる。** `walkNode`と`inspect`の
各段で`r.mic || r.micEvidence`として上流へ運ぶ。証明（`mic`）の意味は従来
どおり変えない。

- 証明（`mic`）… 上流のすべてがマイクである。厳格。
- 証拠（`micEvidence`）… 上流のどこかにマイクがある。多段でも消えない。

## 3. 判定の整理

| selectionMethod | 条件 | 性質 |
| --- | --- | --- |
| `microphone-provenance` | 上流すべてがマイク | 証明 |
| `mic-in-processed-mix` | マイクの証拠があり、外部由来が`remote-receiver`のみ。音声sender1本・接続済み・マイク取得1系統・画面共有なし | 推定 |
| `unique-processed-sender` | 外部由来の証拠が一切なく、上記の一意性条件を満たす | 推定 |
| `none` | 上記以外 | 拒否 |

画面共有（`display-capture`）、生成音声（`generated-audio`）が混ざる場合は
多段であっても従来どおり拒否する。

## 4. 検証

Node VMテスト115件成功（v1.4.4は112件）。JavaScript31ファイルの構文チェック成功。
詳細は`validation-v1.4.5.json`。

追加3件：

- v1.4.4ログの多段トポロジーを再現し、v1.4.4判定で拒否・現判定で接続と
  ミュート同期と復帰
- 多段でもマイクだけのグラフは推定ではなく証明として通る
- 多段にしても画面共有・生成音声は混入させられない

`tests/fixtures/teams-v144-discovery.json`に実ログを記録した。
v1.4.3のログは`teams-v143-discovery.json`に残してある。

**未検証：** 実ブラウザーの音声サンプル、ICE/DTLS/RTPの疎通、実Teams会議で相手
に音声が届くこと。作業環境にChromiumがなく実機E2Eは実施していない。

## 5. これで接続が成立した場合、次に見る箇所

候補選定はこれで通る見込みだが、**選定が通ることと相手に音声が届くことは別**
である。接続後に無音だった場合の調査順は以下。

1. `teams.js`の`syncMute()`。置換トラックは元トラックの`enabled`と`muted`を
   そのまま反映する。元の加工トラックが`muted`を報告すると、接続成功のまま
   TTSが無音になる。
2. HTML側`ConferenceMicBus`のゲート。`active`受信まで`gain=0`で閉じている。
   診断の`webConferenceMicEnabled`が`true`になったかで判別できる。
3. `output()`が返す`activeTrack.clone()`に実際に音声があるか。ブリッジの
   受信側で`getStats`により区間を分ける。

診断JSONに`selectionMethod`と`webConferenceMicEnabled`の両方が出るので、
候補選定で止まったのか、その先で止まったのかは次のログで切り分けられる。
