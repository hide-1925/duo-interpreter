# Duo Interpreter Chrome/Edge 拡張 v1.4.4

対象：Web版TeamsへTTS音声を送出できない問題
前提：HTML v1.47.0（変更なし）

## 1. v1.4.3実環境ログで確定した原因

`duo-subtitle-interaction (15).json`（extensionVersion 1.4.3）で、唯一の音声
senderがこう報告されていた。

```
mic:              false
reason:           unproven-web-audio
processed:        true
externalEvidence: true
sourceReasons:    ["get-user-media", "remote-receiver"]
nodeTypes:        ["MediaStreamAudioDestinationNode", "MediaStreamAudioSourceNode"]
eligibleCount:    0
selectionMethod:  none
```

`sourceReasons`が示すとおり、Teamsの送信音声を作っているWeb Audioグラフには
**マイク（get-user-media）と受信トラック（remote-receiver）の両方**が入って
いた。v1.4.3の候補選定は2経路ともこれを拒否する。

- `microphone-provenance`経路：全ての上流がマイクであることを要求する。受信
  トラックが混ざると`unknown`となり不成立。
- `unique-processed-sender`経路：`!externalEvidence`を要求する。受信トラック
  の証拠があるため不成立。

結果、候補0件で`start()`が
`Teamsの送信音声をマイク由来と確認できません`を投げていた。

**これはv1.4.3が直した問題とは別物である。** v1.4.3は「出所不明」を「外部由来」
と誤判定する不具合を直した。今回の`externalEvidence`は誤判定ではなく、実際に
remote-receiverと印を付けたトラックがグラフ内に存在していた。

`tests/fixtures/teams-v143-discovery.json`に記録し、
`tests/test-mic-discovery.cjs`で旧判定の拒否と新判定の接続を両方検証している。

## 2. 修正

### conference-adapters/mic-provenance.js

**MediaStreamAudioSourceNodeが読むトラックは1本だけ。**
仕様上、ノードはstreamの音声トラックをid順に並べた先頭1本のみを入力とする。
従来は`stream.getAudioTracks()`を全部上流として記録していたため、ノードが
読みもしないトラックの出所がグラフに混入していた。マイクだけのグラフが
他人の音声の証拠を持つには、これだけで十分だった。

**`externalReasons`を追加。** 外部由来の証拠を真偽値ではなく種類で返す
（`remote-receiver` / `display-capture` / `generated-audio` / `graph-cycle`）。
**`micEvidence`を追加。** グラフ内にマイクが存在するかを単独で示す。

### conference-adapters/teams.js

選定方法`mic-in-processed-mix`を追加した。以下をすべて満たす場合のみ採用する。

1. 由来を証明できたマイク候補がない
2. 有効な音声senderが1本だけ
3. PeerConnectionがconnected
4. Web Audio加工トラックである
5. **グラフ内にマイクの証拠がある**（`micEvidence`）
6. **外部由来の証拠が`remote-receiver`のみ**（画面共有・生成音声が混ざれば不採用）
7. 生きたマイク取得元が1系統
8. アクティブな画面共有がない

つまり「相手の音声がグラフにある」だけでは拒否しない。相手の音声しかない、
画面共有が混ざる、生成音声が混ざる場合は従来どおり拒否する。

`usable()`が`unique-processed-sender`だけを許可していたため、そのままでは
接続直後に100msの監視タイマーが`mic-in-processed-mix`を不正とみなして即座に
切断していた。選定方法を問わず、現在も候補に残っているかで判定するよう修正した。

画面共有の音声が原因で拒否された場合は、その旨を名指しするエラーに変更した。

## 3. 検証

Node VMテスト112件成功（v1.4.3は106件）。JavaScript31ファイルの構文チェック成功。
詳細は`validation-v1.4.4.json`。

追加した6件：

- v1.4.3ログのトポロジーを再現し、旧判定で拒否・新判定で接続とミュート同期と復帰
- streamに余分なトラックがあっても出所を偽装しない
- 画面共有がマイクのグラフに混ざる場合は拒否
- 生成音声がマイクのグラフに混ざる場合は拒否
- マイクの証拠がない相手音声だけのグラフは拒否
- 音声sender1本・マイク取得1系統という条件は維持

**未検証：** 実ブラウザーの音声サンプル、ICE/DTLS/RTPの疎通、実Teams会議で相手
に音声が届くこと。作業環境にChromiumがなく実機E2Eは実施していない。
Node VMテストの成功を実音声の到達と解釈しないこと。

## 4. 次のログで確認できること

実Teamsが2つのグラフ形状のどちらだったかは、次回ログの`selectionMethod`で判別
できる。

- `microphone-provenance` … 1つのsourceノードに複数トラックのstreamが渡されて
  いた形。ノードが読む1本はマイクなので、完全な証明として通る。
- `mic-in-processed-mix` … マイクと受信音声が別々のsourceノードから同じ
  destinationへ接続されている形。一意性による推定として通る。

**`mic-in-processed-mix`は推定であり、追跡できない音声が確実にマイクである
ことの証明ではない。**

接続が成立した後に音声が届かない場合、次に見る箇所は`teams.js`の`syncMute()`
である。置換トラックは元トラックの`enabled`と`muted`をそのまま反映するため、
元の加工トラックが`muted`を報告すると、接続は成功しているのにTTSが無音になる。
今回は候補選定で止まっていたためこの区間は未到達で、実機ログがない。
