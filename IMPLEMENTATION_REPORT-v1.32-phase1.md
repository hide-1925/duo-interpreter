# Duo Interpreter v1.32.1 Phase 1 実装・実行可否レポート

作成日：2026-08-29  
入力：Duo Interpreter v1.31 単一HTML、話者性保存・音声表現・オーバーレイ機能仕様書

## 結論

全体仕様は実行可能。ただし「第1段階」は一括実装すべきではない。今回の実装範囲は、仕様書末尾の「最初の作業」1～8および優先順位の Phase 1A に相当する。

実装済み：Pitch / Energy / Pause / Speech Rate の取得、`S.entries[].prosody` への保存、ON/OFF、失敗時フォールバック、発話終了時の要約ログ、設定UI・診断ログ。

追加実装：共通ProsodyMapper、ブラウザ標準TTSへの速度・音量・語尾傾向の反映、Aivisへの話速・緩急・音量の反映。

未実装：Emphasis抽出、意味対応、ElevenLabs・xAIのTTS制御。したがって、第1段階の受入条件10項目すべてを満たした状態ではないが、「計測基盤＋発話全体のルールベース再現」までは完成している。

## 実行可否

| 機能 | 判定 | 根拠・条件 |
|---|---|---|
| Pitch / F0 | 実行可能 | Web Audio APIで波形を読み、YINで65～450Hzを推定できる。雑音、無声音、オートゲインの影響は残る |
| Energy | 実行可能 | RMSからdBFS相当値を算出できる。マイクのAGCがONなので絶対音圧ではなく同一環境内の比較値 |
| Pause | 実行可能 | VAD（Voice Activity Detection：発話区間検出）の発話境界から算出できる。単語間Pauseにはword timestampが必要 |
| Speech Rate | 実行可能 | 発話時間とSTT本文から近似可能。日本語等は文字/秒、欧文は単語/秒。mora/s・syllable/sは辞書または言語別解析器が必要 |
| 発話単位の保存 | 実行可能・実装済み | 既存 `S.entries` に後方互換な任意フィールドとして追加 |
| Web Speech連携 | 実行可能・実装済み | 最終認識イベントで直近音声区間を確定。複数確定文が同時に返る場合は文字数比で時間を按分 |
| API STT連携 | 実行可能・実装済み | `MediaRecorder` のVADカット時点で物理量を確定し、STT完了後に話速を追加 |
| Realtime連携 | 実行可能・実装済み | input transcript完了イベントで直近区間を紐付け。両方向2接続の同一本文には短期キャッシュを再利用 |
| ブラウザ標準TTS反映 | 部分実装済み | `SpeechSynthesisUtterance.rate / volume / pitch`へ小さく反映。単語単位制御は不可 |
| Aivis反映 | 部分実装済み | `speaking_rate / tempo_dynamics / volume`へ反映。ユーザーの手動設定を基準値として維持 |
| Emphasis抽出 | 条件付きで可能・未実装 | 強調の音響検出は可能だが、強調区間を単語へ結び付けるにはword timestampまたは強制アラインメントが必要 |
| 翻訳後の意味対応 | 実行可能・未実装 | LLMで対応語だけをJSON取得できる。ただし遅延・費用・誤対応を評価する必要がある |
| ElevenLabs反映 | 実行可能・未実装 | Eleven v3はAudio Tags対応。ただし通常v3は対話用途には高遅延。Flash v2.5の低遅延と、v3系の表現力を実機比較すべき |
| xAI反映 | 実行可能・未実装 | REST TTSがpause、pitch、speed、emphasis等のタグを公式にサポート |
| 第2段階の状態推定 | 実行可能だが実験設計が必要 | 「感情正解率」ではなく、人間評価による話者印象保存スコアを目的変数にする必要がある |
| 出力音声の再解析 | 実行可能 | 生成BlobをWeb Audioでデコードし、同じ解析器へ通せる。追加遅延は再生前処理と非同期評価の分離で回避可能 |

## 外部API仕様の確認結果

- [OpenAI Create transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)：`timestamp_granularities` は `word` / `segment` を指定できるが、`response_format=verbose_json` が必要。モデルごとのresponse format制約があるため、プロバイダ能力判定が必要。
- [ElevenLabs Text to Speech guide](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)：Eleven v3はAudio Tags対応。通常v3は高遅延・変動性のため対話用途に不向きと公式が明記。一方、Flash v2.5は低遅延、Eleven v3 Conversationalは対話向けとして掲載されている。
- [xAI TTS API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice)：`[pause]`、`[long-pause]`、`<higher-pitch>`、`<lower-pitch>`、`<slow>`、`<fast>`、`<emphasis>` 等をサポート。
- [xAI Custom Voices](https://docs.x.ai/developers/model-capabilities/audio/custom-voices)：2026-08-29時点で米国限定（Illinois除外）。日本でのVoice Clone本命にはできない。

## 実装内容

### 1. ProsodyAnalyzer

外部ライブラリなしの単一HTML内モジュールとして追加した。

- 60～80ms周期で波形を観測
- Pitch計算は2フレームに1回に抑制
- Pitch：YIN、65～450Hz
- Energy：RMS、dBFS相当
- Pause：前回の有効発話終了から今回の開始まで
- Pitch contour：発話全体を8区間へ正規化
- 高頻度フレームは最大約45～70秒分だけメモリ保持
- `dlog()` へは発話終了時の要約のみ出力

### 2. 保存データ

発話確定後、既存エントリへ次の形で追加する。

```json
{
  "prosody": {
    "available": true,
    "durationMs": 1260,
    "pauseBeforeMs": 300,
    "speechRate": 4.76,
    "speechRateUnit": "word/s",
    "speechUnits": 6,
    "pitch": {
      "available": true,
      "meanHz": 220,
      "rangeHz": 0,
      "relativeRange": 0,
      "contour": [0, 0, 0, 0, 0, 0, 0, 0]
    },
    "energy": {
      "available": true,
      "meanDb": -21.4,
      "peakDb": -21.4,
      "rangeDb": 0
    },
    "analyzer": {
      "source": "microphone:webspeech",
      "pitchAlgorithm": "YIN",
      "frameMs": 60
    }
  }
}
```

解析不能時は次の形で保存し、通常処理を続ける。

```json
{
  "prosody": {
    "available": false,
    "reason": "no_voiced_frames"
  }
}
```

### 3. UI・設定

⚙ → 音声へ次を追加した。

- `元音声の話し方を解析する［実験］`
- 折りたたみの取得状態表示
- 設定保存キー `di.prosody`
- HTML埋め込み書き出しへの設定保持

既定値はOFF。OFF時はProsodyAnalyzerを生成せず、既存のSTT・翻訳・TTS経路を変更しない。

### 3.1 ProsodyMapperとTTS反映（v1.32.1）

物理量を共通制御値 `rate / volume / pitch / dynamics` へ変換する `prosodyMapForTts()` を追加した。

- Speech Rate：元言語の基準速度に対する倍率へ正規化し、0.88～1.12倍に制限
- Volume：Energy平均から0.92～1.04倍に制限
- Pitch：絶対F0は使わず、Pitch contourの語尾成分だけを0.95～1.05倍に制限
- Dynamics：Pitch rangeとEnergy rangeから0.92～1.10倍に制限
- Pause：観測・ログ保存のみ。追加の会話遅延を避けるためTTSへは未適用

ブラウザ標準TTSでは既存速度1.05倍へ補正値を掛け、最終的な `rate / pitch / volume` を診断ログへ出す。

Aivisでは利用者の手動設定を上書きせず、次の形で合成する。

```text
effective speaking_rate  = manual speaking_rate  × prosody rate
effective tempo_dynamics = manual tempo_dynamics × prosody dynamics
effective volume         = manual volume         × prosody volume
```

`emotional_intensity` は物理量から感情を決めることになるため変更しない。APIへ送るJSONには診断用の内部マップを混入させない。

### 4. 診断ログ

発話終了時だけ次の要約を1件出力する。

```text
[prosody] analyzed
seat=A
durationMs=1260
pauseBeforeMs=300
speechRate=4.76
speechRateUnit=word/s
pitchMeanHz=220
pitchRangeHz=0
energyMeanDb=-21.4
energyRangeDb=0
```

診断ファイルへ `## Prosody Analysis` を追加し、発話単位の成功・失敗と要約値を表形式で出力する。

## 検証結果

| 検証 | 結果 |
|---|---|
| JavaScript構文検査 | 合格 |
| HTMLのDOCTYPE・閉じタグ | 合格 |
| 静的DOM参照 | 参照168件、欠落ID 0、重複ID 0 |
| 合成波形Pitch | 90→90.00Hz、125→125.00Hz、220→220.01Hz、330→330.02Hz |
| 発話要約 | Duration 1260ms、Pause 300ms、Speech Rate 4.76 word/s、Energy -21.4dBを期待どおり算出 |
| 無音フォールバック | `available=false / no_voiced_frames` を確認 |
| OFF互換 | OFF時の解析フレーム生成0を確認 |
| ブラウザTTSマッピング | rate 1.176 / pitch 1.05 / volume 1.00への反映をモック検証 |
| Aivisマッピング | 手動話速1.2に補正1.12を掛け、`speaking_rate=1.344`、`tempo_dynamics=1.082`、`volume=1.01`を生成 |
| Aivis API本文 | 診断用 `_prosodyMap` がJSONへ混入しないことを確認 |
| TTS側OFF互換 | Prosody OFF時は手動設定 `speaking_rate=1.2` だけを維持し、動的補正なし |
| Pitch計算負荷 | この検証環境で平均0.416ms/回。120ms周期換算の単純推定約0.35% CPU |

## 未検証・受入前の実機項目

次はソースコード検証では代替できない。

1. PC Chrome / Edgeで各30発話
2. iPhone Safari / ホーム画面版で各30発話
3. Web Speech / OpenAI STT / xAI STT / Realtimeの各経路
4. 静かな部屋・会議室・周囲雑音ありの3条件
5. Prosody OFF対ONでSTT欠落率、確定遅延、UI操作遅延、電池消費を比較

合格基準案：

- STT確定発話数：OFF比 -2%以内
- 発話確定遅延の中央値：OFF比 +50ms以内
- Prosody summary生成率：有声音を含む発話の95%以上
- Pitch取得率：通常発声の90%以上（ささやき声・極端な雑音は除外）
- UI long task：100ms超の増加が1分あたり1件未満
- 解析失敗による翻訳・TTS停止：0件

## 既知の限界

1. EnergyはマイクのAGC・ノイズ抑制後の値であり、物理音圧ではない。
2. 日本語Speech Rateは現状character/sであり、厳密なmora/sではない。
3. Web Speechには標準化されたword timestampがないため、今回の実装は発話単位。複数確定文が同時に返る場合は時間を文字数比で按分する。
4. Pitchは無声音、ささやき、強い反響、音楽、複数話者の重なりでは失敗しうる。
5. 単語単位Emphasisは未実装。音響的ピークを対応語へ結び付ける機構が別途必要。
6. Prosody値は話者基準で正規化していない。Speaker Baselineは第2段階。
7. ブラウザ標準TTSはOS・音声ごとに `rate / pitch / volume` の効き方が異なり、Pitchをほぼ無視する声もある。

## 次の一手

まず上記実機テストを1セッション実施し、診断ログを回収する。ログでSTT欠落・Pitch取得率・処理時間に問題がなければ、次の順で進める。

1. Phase 1B：音響区間ベースのEmphasis候補抽出
2. STT timestamp能力判定：`whisper-1 + verbose_json` 等、利用可能な経路だけword alignmentを有効化
3. Phase 1C：共通ProsodyMapperをxAI・ElevenLabs向け命令へ拡張
4. Phase 1D：xAIタグ制御を先に実装して動作確認
5. ElevenLabsはFlash v2.5、通常v3、v3 Conversationalを遅延・表現力・Voice Clone互換で比較してから採用経路を決める

第2段階へ進む条件は、今回の実機ログで「物理量が安定して取れる」「STTを悪化させない」の2点が確認できたこと。これを満たさずに状態推定を足すと、推定AIが計測不良を感情差と誤認する。
