# Realtime STT マルチプロバイダ 開発仕様書

起点：HTML v1.49.39 / Chrome・Edge 拡張 1.4.50（2026-09-29 時点）
状態：**仕様（未実装）**。この文書を足しただけでは挙動は変わりません。§18 の決定（2026-09-29）を反映済みです。
元資料：起草された「Duo Interpreter Realtime STT Multi-Provider 実装計画書」（以下「計画書」。`計画書§n` は計画書の節番号）

---

## 0. この文書について

計画書の目的と方針（Provider を交換可能にする、Provider 固有の設定を共通の値に偽装しない、
TTTR で評価する）はそのまま引き継ぎます。そのうえで、**計画書を今のコードに当てはめたときに
合わないところを直した**のが本書です。

- 計画書§52 の「Phase 1 — コード監査」は本書 §2 で済ませました。
- 計画書から変えた点は §0.1 に一覧にしました。理由はどれも、コード・`SECURITY.md`・公式情報のどれかに基づきます。
- 外部 API の記述を公式情報と照合した結果は **付録A** にあります。

> **外部 API の確認について。** この作業環境からは各社の公式ドキュメント
> （developers.openai.com・elevenlabs.io・assemblyai.com・soniox.com）を直接読めず、
> **検索エンジンの要約で照合しました。** 判断層（Jev）の Phase 2 初版は検索結果から組んだために
> 要求と応答の形を取り違え、正規化が実際の応答をすべて拒否していました
> （`次期仕様実装状況.md`「API 契約を公式リファレンスに合わせました」）。同じことを起こさないため、
> **各 Provider の実装は Phase 0 の契約確認（§17）を通ってから始めます。**
> 本書で「**要原典確認**」と書いた値は、原典を読むまで決め打ちしません。

### 0.1 計画書から変えた点

|#|計画書|本書|理由|
|---|---|---|---|
|1|§51 `src/stt/*.js` などにファイルを分ける|`index.html` と `extension/app.js` の**両方へ同じコードを最上位ブロックとして置く**。製品コードの新ファイルは作らない（Node の検証ツールを除く）|ビルド手順が無く、2ファイルを手で同期して `test-file-sync.cjs` で一致を検査している。HTML は1ファイルで配布し、設定を埋め込んで書き出す|
|2|§28–33 Token Backend を置く。§33 localStorage へのキー保存を禁止|一時資格情報の発行経路を3つ用意する（direct／relay／broker、§8.3）。既定の direct は**今の gpt-live と同じ**で、利用者のキーでブラウザが一時トークンを発行し、WebSocket には一時トークンだけを使う。キーの保存は既存の方針（区分ごとの「このブラウザに保存する」）に従う|Duo は「サーバーを持たず、ブラウザの中だけで動く」（`SECURITY.md` 冒頭）。Backend を必須にすると GitHub Pages 版も拡張版も単体で動かなくなる。localStorage への保存は現行と同じく可とする（**D-1 決定**）|
|3|§6 OpenAI の delay 初期値は `medium`|既定は **`low`**|今のコードは `delay:'low'` 固定（`RealtimeTranscriptionEngine.prototype.config`、app.js:9897）。既定を変えると既存の利用者の挙動が変わる。`medium` は比較試験で評価する（**D-4 決定**）|
|4|§48 自動フォールバック既定 ON|既定 **OFF**。明示的に ON にしたときだけ|フォールバックは音声の送り先の会社を変える。`SECURITY.md` §2「送り先は利用者が選んだプロバイダだけ」に反し、別契約の料金も発生する（**D-3 決定**）|
|5|§34–35 Duo Turn Controller を新設し、§59 Phase 8 で partial を Jev へつなぐ|**新設しない。** 既存の segment 層（`segUpdate`／`segCheck`）と判断層（`TurnDecision`）がその役割を持つ。新 Provider の partial をここへ流せば、partial → 判断 → 翻訳開始は既定の `segmentMode=balanced` でそのまま成立する|gpt-live の経路はすでに partial を `segUpdate` へ流し、安定した前半から逐次翻訳している（`segLiveEvent` app.js:15846、`segCheck` app.js:15197）|
|6|§8 AssemblyAI の3モードのプリセット値表を Duo が持つ|**Duo はプリセット値を持たない。** `mode` だけを送り、利用者が上書きした項目だけを追加で送る|公式情報で確認できたのは balanced の一部（min 128ms／max 1280ms）だけ。値を持つと、公式が変えたときに画面の表示が嘘になる|
|7|§24 ElevenLabs の VAD 既定値（1.5／0.4／100／100）に依存|4項目とも**接続時に必ず明示して送る**|検索の要約に、API 側の既定値が SDK と食い違う記述（250ms／2500ms）があった。明示して送れば既定値の差に左右されない（要原典確認）|
|8|§47 Benchmark 画面に CER を常時表示|CER／WER はオフラインの検証ツールで算出する。画面には参照原稿を読み込んだときだけ出す|参照原稿なしに誤り率は計算できない。計画書自身の「実測値のみ表示」に従う|
|9|§61 Phase 1 の完了条件に全 Provider の接続まで含む|フェーズごとに完了条件を分け、**フェーズごとに版を上げて出荷**する|中身を変えた出荷ごとに版を上げる運用を `versions.json` と `test-release-manifest.cjs` で縛っている|
|10|§26 Soniox の `is_final=true` token を「committed token」とする|正規化イベントの `committed` は「区間の確定」だけに使う。final token は partial の `stableChars`（今後変わらない先頭の文字数）として渡す|token 単位で committed を出すと、下流で「カードを閉じる」と「前半が確定した」を区別できない|
|11|§31 Soniox の `max_session_duration`|`max_session_duration_seconds`|検索の要約で確認したフィールド名|
|12|記載なし|新 Provider は、自分のキーが空のとき**翻訳のキーを借りない**|今の `sttKey()` は翻訳のキーへ落ちる（app.js:2919）。別の会社のキーを別の会社へ送ることになる。OpenRouter の STT はすでにこれを避けている（`openrouterSTT` の注記）|
|13|§57 Phase 6 で設定 UI をまとめて作る|各 Provider の設定 UI は**その Provider のフェーズで一緒に出す**|UI の無い Provider は性能設定を試せず、フェーズ単独で出荷できない|
|14|§58 Phase 7 で計測を作る|カード単位の計測ログは **Phase 1 で先に入れる**|新 Provider を足す前に、基準系（gpt-live）の数字を同じ物差しで取っておく必要がある|

---

## 1. 目的と範囲

### 1.1 目的

1. リアルタイム STT を交換可能にする。**OpenAI `gpt-live-transcribe` を基準系として残し**、
   ElevenLabs `scribe_v2_realtime`、AssemblyAI `universal-3-5-pro`、Soniox `stt-rt-v5` を足す。
2. 各 Provider の**ネイティブの**速度・精度設定を設定画面から選べるようにする。
3. 同じ音声条件で比べ、Duo の既定の Provider と設定値を**実測で**決める。主指標は TTTR（§11）。
4. 次の Provider を足すときに、Adapter を1つ書けば済む形にする。

計画書§65 のとおり、求めるのは「最終文字起こしが一番正確な STT」ではなく
「**翻訳できる意味を最も早く、後から壊さずに出せる STT**」です。

### 1.2 範囲外

- Duo 独自の Global Preset（計画書§23。計画書でも Phase 1 対象外）
- 予測翻訳・投機的 TTS（計画書§60。`次期仕様実装状況.md` で「入れていない」と決めた領域）
- Token Broker サーバーそのものの実装（契約だけ §8.4 で定める）
- 判断層（Jev）の質問文・`state`・閾値の変更（凍結中。§15 INV-STT-09）
- `gpt-realtime-translate`（`sttProvider=realtime`）、録音分割 REST（gpt-4o 系・Groq・xAI・OpenRouter・Gemini）、Web Speech の変更
- 話者分離・声紋

---

## 2. 現行実装の監査（計画書§52 の12項目）

行番号は v1.49.39 の `extension/app.js`。`index.html` は同じコードを持ちます（行番号は異なる）。

|#|項目|現在の場所|要点|
|---|---|---|---|
|1|音声取得の開始|`startAll()`（10635）|入力の取得は1か所。エンジンには `MediaStream` を渡す。`segmentMode` の既定は `balanced`|
|2|マイク経路|`startAll` 内、`ensureMic()`（8733）|マイクは1回だけ掴んで共有する。`isLiveTranscribe()` なら `RealtimeTranscriptionEngine(seat\|null, micStream)`、Web Speech なら `startWebSpeech()`、それ以外は録音分割の `StreamEngine`|
|3|共有音声（システム音声）経路|`getDisplayAudioForStt()`（10608）、`effectiveDisplaySttRoute()`（5127）|`displaySttRoute`＝auto（選んだ STT を使う）／direct（Web Speech で Track を直接認識）／vb（仮想ケーブルの録音デバイス）。画面取込オーバーレイの Track があれば使い回す|
|4|gpt-live の接続|`RealtimeTranscriptionEngine`（9878〜）|ブラウザが利用者のキーで `POST /v1/realtime/client_secrets` → 一時シークレットで `POST /v1/realtime/calls`（SDP）→ WebRTC、DataChannel `oai-events`。設定は `delay:'low'` 固定、`languages`、`prompt`（コンテキスト600字）、`keywords`（用語集60語）、`turn_detection:null`|
|5|partial の処理|`onEvent`（10148）→ `segLiveEvent`（15846）|delta を連結して全文を作り、`segUpdate(entry, 全文, false)`。segment 層が off なら `render` だけ|
|6|final の処理|`completed` → `segLiveReconcile` または `finalizeSegment`|サーバーの completed は遅いことがあるので、端末側でも区切る：80ms 周期の `checkBoundaries`、`boundaryContext`／`boundaryPolicy`（文末らしさで 650〜1500ms 待つ）、`segLiveBoundaries`（15792）、判断層の `TurnDecision.liveClose`（INV-13）|
|7|Jev の入力位置|`segCheck` → `TurnDecision.rules`／`TurnDecision.boundary`（15222）、読み上げ開始は `TurnDecision.floor`|判断層は STT の種類を知らない。渡すのは本文・安定長・無音・言語・方針だけ。既定 `turnDecisionMode=off`|
|8|翻訳の開始位置|segment 有効：`segCheck` の commit → `SEG.queue` → `segPump`／`segTranslate`。無効：`finalizeSegment` → `translate()`|partial の安定した前半から逐次翻訳する仕組みがすでにある|
|9|TTS の回り込み防止|`isEcho()`（4191）、`segEchoCandidate()`（15058）、`preventSelfRecognition`（VB）|直近30秒の読み上げ文と本文の類似度で除外。**認識は読み上げ中も止めない**（`S.speaking` は目印だけ）|
|10|APIキー|`KEYS`、`sttKey()`（2919）、`KEY_SCOPES`|区分（trans／stt／tts）ごとに「このブラウザに保存する」。`sttKey()` は翻訳のキーへ落ちる。診断ログの伏せ字は `redact()`（3414）|
|11|拡張側|`extension/app.js`・`app.html`（`index.html` の変換結果）、`manifest.json`、`service-worker.js`、`turn-proxy.js`|拡張ページの CSP は `connect-src https://* wss://*`。判断層の往復は、CORS を返さない相手のために拡張が中継している（`turn-proxy.js`）|
|12|変更対象|§16|—|

### 2.1 監査で分かった前提

1. **gpt-live の経路では、接続（WebRTC）とカード管理・区切り判定・計測が1つのコンストラクタに同居しています。**
   新 Provider は接続以外を共有したいので、ここを分けます（Phase 1）。
2. **segment 層は全文置換型です。** `segUpdate(e,text,final)` は前回の本文との共通の前後を取り、
   置き換わった範囲を改訂として扱い、確定済みの区間を写像し直します。
   **正規化した partial は、開いている区間の全文でなければなりません**（§5.3）。
3. **判断層は STT に依存しません。** 新 Provider の partial を `segUpdate` へ流せば、Rules・Jev ともそのまま働きます。
4. **音声の取得は `startAll` の3経路で1回だけ**行い、各エンジンは受け取った `MediaStream` から
   自前の `AudioContext` で解析します。新 Provider もこの形に従えば、キャプチャは複製されません（計画書§50）。
5. **PCM を WebSocket で送る仕組みはまだありません。** AudioWorklet を Blob から読み込む前例は、
   TTS の再生側にあります（`di-openai-pcm-player`、app.js:4745 付近）。
6. **キーが空のとき翻訳のキーを借りる**経路があります（`sttKey()`）。新 Provider では使いません（§8.5）。
7. **伏せ字の規則は、URL の `token=` と JSON の `"api_key": "…"` をすでに伏せます**（app.js:3425–3426）。
   WebSocket の URL に入る一時トークンと、Soniox の最初の設定メッセージはこの規則に掛かりますが、検査で固定します。
8. `isLiveTranscribe()` の呼び出しは **15か所**（3235, 9872, 10697, 10751, 10766, 10772, 10776, 10785, 10794,
   10817, 13016, 13019, 13020, 13050, 13117）。多くは「ストリーミング型の STT か」を聞いているだけなので、
   新 Provider でも同じ扱いが要ります（§16）。

---

## 3. 用語

|語|意味|
|---|---|
|partial|開いている区間の、その時点の**全文**。後で変わりうる|
|committed|Provider が区間を確定した通知と、その確定本文|
|endpoint|Provider が「発話（ターン）が終わった」と判断した通知|
|`stableChars`|partial の先頭から、Provider が今後変えないと表明した文字数。表明しない Provider は `null`|
|カード|会話欄の1枚（`S.entries` の1要素）|
|区間|カードの中で翻訳・読み上げの単位になる部分（`e.segments`）|
|カードを閉じる|`segUpdate(e, text, true)` で確定させる。以後の本文は次のカードへ|
|Provider|STT の事業者と接続方式の組。`openai`（gpt-live）、`elevenlabs`、`assemblyai`、`soniox`|
|Host|新設する `SttLiveHost`。カード・区切り・計測・再接続を持つ（§6）|
|Adapter|Provider ごとの接続と正規化だけを持つ部分（§5）|

---

## 4. 構成

```text
startAll（既存・変えない）
  ├─ マイク       ensureMic()
  ├─ 共有音声     getDisplayAudioForStt()
  └─ VB-CABLE     openInputDevice()
         │  MediaStream（取得は1回。Provider ごとに取り直さない）
         ▼
  SttLiveHost（新設。RealtimeTranscriptionEngine のカード管理・区切り・計測を切り出す）
    ├─ 端末側の音量判定と話し方解析（既存の startBoundaryMonitor を移す）
    ├─ SttPcmTap（新設。WebSocket 系だけ。PCM16・16kHz・モノラルへ変換）
    └─ Adapter：STT_LIVE_PROVIDERS.openai / elevenlabs / assemblyai / soniox
          接続・一時資格情報・送信形式・受信の正規化だけ
         │  正規化イベント（§5.3）
         ▼
  Host がカードへ反映
    segUpdate / segLiveClose 相当 / 最終ゲート（句読点・発話判定・回り込み・席の推定）
         ▼
  segCheck → TurnDecision（Rules／Jev）→ 翻訳 → TurnDecision.floor → 読み上げ（既存）
         └→ 診断（dlog 'stt'、SttLiveMetrics）
```

### 4.1 置き場所と書き方

- コードは `index.html` と `extension/app.js` の両方へ、**列0の `}` か `};` で閉じる最上位ブロック**として書きます。
  検査はブロックを行頭一致で取り出し、`vm` で動かします（`test-4o-cards.cjs` と同じ方式）。
- 足したブロックは `test-file-sync.cjs` の `SHARED` に登録します。
- 新しい名前：`STT_LIVE_PROVIDERS`、`SttLiveHost`、`SttPcmTap`、`sttPcmDownsample`、`sttPcmToInt16`、
  `sttLiveKey`、`sttLiveCredential`、`sttLiveOptions`、`SttLiveMetrics`、`isStreamingStt`。
- markup を足すのは `sttProvider` の選択肢だけです（`index.html` に書き、`extension/app.html` は変換で作り直す）。
  Provider ごとの設定欄は JS から注入します（§10）。

---

## 5. Adapter の契約

### 5.1 形

```js
var STT_LIVE_PROVIDERS={
  soniox:{
    id:'soniox', label:'Soniox', defaultModel:'stt-rt-v5',
    transport:'websocket',                 // openai だけ 'webrtc'
    audio:{encoding:'pcm_s16le', sampleRate:16000, channels:1, frame:'binary'},  // 'binary' | 'json-base64'
    caps:{endpoint:'turn', stable:'tokens', languageId:true, manualCommit:true, terms:true},
    options:function(cfg){ /* CFG から Provider 固有の設定を作る。秘密を含めない。診断にそのまま出す */ },
    credential:function(key,opts,route){ /* → Promise<{secret, expiresAt, route}>（§8） */ },
    url:function(opts,cred){ /* 接続先 URL */ },
    hello:function(opts,cred){ /* 接続直後に送るメッセージ。無ければ null */ },
    frame:function(int16){ /* 音声1フレーム → 送る値（ArrayBuffer か文字列） */ },
    map:function(st,msg){ /* 受信1件 → 正規化イベントの配列。純関数。st は Adapter 専用の状態 */ },
    commit:function(st){ /* 手動確定のメッセージ。無ければ null */ },
    close:function(st){ /* 終わりに送るメッセージ。無ければ null */ },
    classify:function(err){ /* 'auth' | 'config' | 'rate' | 'transient' | 'closed' */ }
  }
};
```

`caps.endpoint` は `'none'`（出さない）／`'completed'`（遅れて出ることがある）／`'turn'`（発話ごとに出す）。
`caps.stable` は `'none'`／`'words'`／`'tokens'`。

計画書§4 の `STTProvider` クラスとの対応：

|計画書|本書|
|---|---|
|`connect` / `disconnect`|`SttLiveHost.start` / `stop`（`credential` → `url` → `hello`、終わりに `close`）|
|`sendAudio`|`frame`（Host が `SttPcmTap` から受けて送る）|
|`commit` / `forceEndpoint`|`commit`（ElevenLabs の手動確定、Soniox の finalize）|
|`updateConfig`|Phase 1〜5 では**次の開始から反映**（接続し直す）。接続中の変更は扱わない|
|`onPartial` ほか5つのコールバック|`map` の戻り値の `type`|

コールバックではなく純関数 `map` にするのは、**WebSocket 無しで受信列を流して検査できる**からです。
既存コードの書き方（`var` と prototype、最上位ブロック）にも合います。

### 5.2 Adapter の中でしてはいけないこと

DOM に触る、`addEntry`・`render`・`translate`・`speak`・`segUpdate`・`TurnDecision` を呼ぶ、`toast` を出す、
`localStorage`・`KEYS` を直接読む（キーは Host から受け取る）、`dlog` に本文を書く。
（計画書§62「Provider 内部に翻訳・Jev・字幕 DOM を書かない」を、呼んではいけない関数の名前で固定したもの。）

### 5.3 正規化イベント

```js
{ v:1,
  type:'partial',            // 'partial' | 'committed' | 'endpoint' | 'status' | 'error'
  provider:'soniox', model:'stt-rt-v5',
  key:'s3',                  // Provider 側の区間の識別（item_id / turn_order / Adapter が振る連番）
  text:'今回のcontrol valveの',  // partial・committed：その区間の全文。それ以外は ''
  stableChars:9,             // 先頭の変わらない文字数。表明が無ければ null
  language:'ja',             // Provider が返した言語。無ければ null
  audioStartMs:null, audioEndMs:null,  // Provider の音声時間軸。無ければ null
  reason:'',                 // endpoint の理由（下記）、status・error の種別
  receivedAt:0,              // Date.now()。Host が付ける
  raw:{type:'tokens'}        // 診断用。種別名と数値だけ。本文とキーは入れない
}
```

規則：

- **`text` は常に全文です。** 追記差分を下流へ渡しません（計画書§26 の ElevenLabs の注意を全 Provider に広げたもの）。
  OpenAI の delta は Adapter の状態で連結して全文にします。
- 下流（Host より先）は `raw` を読まず、Provider 固有の種別名で分岐しません。
- 同じ `key` の `committed` が2回来ることがあります（AssemblyAI の整形済みターン）。2回目は同じ区間の改訂として扱います。
- `endpoint.reason`：`server-completed`（OpenAI の completed）、`vad`（ElevenLabs の VAD 確定）、
  `manual`（Duo が送った確定への応答）、`end-of-turn`（AssemblyAI）、`semantic`（Soniox の `<end>`）、`finalize`（Soniox の `<fin>`）。

### 5.4 Provider ごとの対応表（計画書§26 を補正）

#### OpenAI `gpt-live-transcribe`（`caps.endpoint='completed'`、`caps.stable='none'`）

|受信|正規化|
|---|---|
|`conversation.item.input_audio_transcription.delta`（と `input_audio_transcription.delta`）|状態の本文へ連結 → `partial`（全文、`key`=item_id）|
|`…transcription.completed`|`committed`（`transcript`）＋ `endpoint('server-completed')`。本文が delta の連結と違えば committed を正とし、Host が写像し直す（今の `segLiveReconcile`）|
|`input_audio_buffer.speech_started` / `speech_stopped`|`status`（時刻の記録だけ）|
|`error`|`error`|

gpt-live-transcribe は turn detection に対応していません（今のコードも `turn_detection:null` 固定）。
completed は長く来ないことがあるため、`sttCardClose=provider`（§6.3）は選べません。

#### ElevenLabs `scribe_v2_realtime`（`caps.endpoint='turn'`、`caps.stable='none'`）

|受信|正規化|
|---|---|
|`session_started`|`status('open')`。返ってきた設定を診断へ|
|`partial_transcript`|`partial`（**全文置換**。`key`＝Adapter の連番）|
|`committed_transcript`|`committed` ＋ `endpoint`（`commit_strategy` が vad なら `vad`、manual なら `manual`）。連番を進める|
|`committed_transcript_with_timestamps`（`include_timestamps` のとき）|直前の committed の付帯情報（言語・語の時刻）。本文は `committed_transcript` を正とする|
|エラー（種別名は要原典確認）|`error`|

送信は JSON：`{"message_type":"input_audio_chunk","audio_base_64":"…","sample_rate":16000}`（形は要原典確認）。
手動確定の送り方も要原典確認。

#### AssemblyAI `universal-3-5-pro`（`caps.endpoint='turn'`、`caps.stable='words'`）

|受信|正規化|
|---|---|
|`Begin`|`status('open')`。セッション ID と期限を診断へ|
|`Turn`（`end_of_turn=false`）|`partial`（`transcript` の全文、`key`=`turn_order`）。`stableChars` は最後の語を除いた語までの文字数（`word_is_final` は「最後の語以外は常に true」と説明されている）|
|`Turn`（`end_of_turn=true`）|`committed` ＋ `endpoint('end-of-turn')`。`end_of_turn_confidence` は `raw` へ|
|`Turn`（`turn_is_formatted=true`、同じ `turn_order`）|`committed`（同じ区間の改訂）|
|`Termination`|`status('closed')`|
|エラー（close code と本文）|`error`|

**区間の同一性は `turn_order` で判定し、本文で判定しません。** 本文で判定して、同じ言葉の繰り返しを
落としたり整形済みターンを二重にしたりした外部の事例があります。日本語で `words` がどう区切られるかは要原典確認で、
区切りが得られないなら `stableChars=null` にします。

#### Soniox `stt-rt-v5`（`caps.endpoint='turn'`、`caps.stable='tokens'`）

状態として `finalText`（前回の `<end>` 以降に確定した token の連結）と `pending`（最新の非確定 token の連結）を持ちます。

|受信|正規化|
|---|---|
|`tokens[]` の `is_final=true`（通常の文字）|`finalText` へ連結|
|`tokens[]` の `is_final=false`|`pending` を置き換え|
|上の処理のあと|`partial`（`text`=`finalText`＋`pending`、`stableChars`=`finalText` の長さ、`language`＝token の言語の多数）|
|`<end>` token|`committed(finalText)` ＋ `endpoint('semantic')`。`finalText` と `pending` を空にし、`key` を進める|
|`<fin>` token|`endpoint('finalize')`（Duo が送った finalize への応答）|
|`finished:true`|`status('closed')`|
|`error_code`／`error_message`|`error`|

`<end>`・`<fin>` は**本文に入れません。** `<end>` を翻訳開始の命令として使わず、必ず正規化した
endpoint として Host に渡します（計画書§17）。

### 5.5 接続時に送る設定

言語コードは今の書き方（`L(lang).g.split('-')[0]`）で `ja`・`en` にします。
AUTO で2人の言語が違うとき（`sttAutoDetect()` と同じ条件）は両方を渡すか、言語を固定しません。

|Provider|送るもの|
|---|---|
|OpenAI|今の `config()` のまま。`delay` だけ `sttLiveDelay` にする。**`low` のときは v1.49.39 とバイト単位で同じ設定を送る**（INV-STT-01）|
|ElevenLabs（URL のクエリ）|`model_id`、`token`、`audio_format=pcm_16000`、`commit_strategy`、`vad_silence_threshold_secs`、`vad_threshold`、`min_speech_duration_ms`、`min_silence_duration_ms`（4つとも毎回明示）、`language_code`（言語を固定するときだけ）|
|AssemblyAI（URL のクエリ）|`token`、`speech_model=universal-3-5-pro`、`sample_rate=16000`、`encoding=pcm_s16le`、`mode`、`continuous_partials=true`（固定）。`min_turn_silence`・`max_turn_silence`・`interruption_delay` は**利用者が上書きしたときだけ**。用語集を送る項目名（`keyterms_prompt` など）、整形（`format_turns`）の扱い、言語の指定の有無は要原典確認|
|Soniox（接続直後の JSON）|`api_key`（**一時キー**）、`model`、`audio_format=pcm_s16le`、`sample_rate=16000`、`num_channels=1`、`language_hints`（`langA`・`langB`）、`enable_language_identification=true`、`enable_endpoint_detection=true`（固定）、`endpoint_latency_adjustment_level`、`endpoint_sensitivity`、`max_endpoint_delay_ms`。用語集とコンテキストを渡す `context` の形は要原典確認|

用語集とコンテキストは、今の gpt-live と同じ出どころ（`CFG.glossary` の先頭60語、`CFG.ctx` の先頭600字）から
各 Adapter の `options` が Provider の形へ変えます。Provider ごとに別の語彙を持ちません（計画書§11 の STT Context Manager は、
この「出どころを1つにする」ことで満たします）。

---

## 6. Host（`SttLiveHost`）

### 6.1 責務

- 開始：`start(seat, stream, opts)`。`sessionGen`・`S.running`・自分の `dead` を見て、止めたあとに届いた結果を捨てる
  （今の `stale-result-drop` と同じ）。
- 一時資格情報 → 接続 → `hello` → `SttPcmTap` の開始。
- 受信 → `adapter.map` → 正規化イベントの処理（§6.2）。
- 端末側の音量判定と話し方解析（今の `startBoundaryMonitor`／`checkBoundaries` を移す。80ms 周期、`segVoice`）。
- 計測（§11）、再接続とフォールバック（§14）、停止。

### 6.2 イベントの処理

|イベント|segment 層が有効|segment 層が無効（`segmentMode=off`）|
|---|---|---|
|`partial`|`key` が変われば前のカードの扱いを決める → `ensureEntry` → Duo がすでに閉じた部分を除いた残りで `segUpdate(entry, 残り, false)`、`duoLiveAssignSeat`|`entry.srcText=text; render(entry)`|
|`committed`|その `key` で Duo が先に閉じたカードがあれば、確定本文を今の `segMapCardEnds` で写像し直す → 開いているカードを閉じる|最終ゲートを通して `speakSrcNow`／`translate`（今の `finalizeSegment` と同じ）|
|`endpoint`|`sttCardClose`（§6.3）に従う|同左|
|`status`／`error`|診断へ。`error` は §14 の分類へ|同左|

**最終ゲート**は今の gpt-live と同じものを通します：`punctuateTranscript`、`hasSpeechContent`、`isEcho`
（segment 層では `segEchoCandidate`）、AUTO のときの席の推定（`guessSeatFromText`／`duoLiveAssignSeat`）、
`attachProsody`。`dlog('stt','live-result',…)` には provider・model・字数だけを書き、本文は書きません。

### 6.3 カードを閉じる合図（`sttCardClose`）

|値|カードを閉じる合図|選べる Provider|
|---|---|---|
|`first`（既定）|Provider の endpoint と、Duo の区切り（無音・文末らしさ・文字の停止・判断層 INV-13）の**早い方**|すべて。OpenAI では今の挙動そのもの|
|`provider`|Provider の endpoint だけ。安全弁として Duo の「文字が止まって一定時間」と「最長30秒」は残す|`caps.endpoint='turn'` の Provider|
|`duo`|Duo の区切りだけ。Provider の endpoint は記録するだけ|すべて|

計画書§35 の「Provider の endpoint だけ／Jev だけ／両方」を比べるための設定です。
既定は `first` です（**D-6 決定**。判断を一任されたため本書で決めた）。理由は2つあります。OpenAI では今の挙動そのものに
なり、既存の利用者に変化が無いこと。新 Provider でも、Provider と Duo のどちらかの区切りが遅れたとき、遅い方に引きずられないこと。
segment 層が有効なとき、**翻訳の開始はカードを閉じるのを待ちません**（`segCheck` が安定した前半を確定する）。
カードを閉じる時刻が効くのは、末尾の確定と、読み上げを文ごとにまとめる判断です。

ElevenLabs を手動確定（`commit_strategy=manual`）で使うときは、Duo がカードを閉じた時点で `adapter.commit()` を送り、
Provider の確定を Duo の区切りに合わせます。

### 6.4 停止

`adapter.close()` を送り、最後の `committed` を最大1秒待ってから接続を閉じます。区間を持たない未確定のカードは
今と同じく消します。`SttPcmTap` と `AudioContext` を閉じ、Host が自分で取った Stream だけを止めます（`ownsStream`）。

---

## 7. 音声の取り出し（`SttPcmTap`）

- 入力は Host が受け取った `MediaStream`。**新たに `getUserMedia`／`getDisplayMedia` を呼びません**（INV-STT-03）。
- `AudioContext`（端末の既定のレート）→ `MediaStreamSource` → `AudioWorkletNode`。Worklet は Blob URL から
  `addModule` します（TTS 再生側の前例と同じ）。
- Worklet の中で：モノラル化（平均）→ **低域通過を掛けてから 16kHz へ間引く**（48kHz→16kHz は1/3。44.1kHz など
  整数比でないときは補間）→ `[-1,1]` を Int16 LE へ（範囲外は切る）→ `sttChunkMs`（既定100ms＝1,600サンプル＝3,200バイト）
  ごとにメインスレッドへ渡す。
- 変換の関数（`sttPcmDownsample`・`sttPcmToInt16`）は**最上位ブロックとして1回だけ書き**、Worklet のソースは
  その関数の文字列から組み立てます。同じコードを `vm` で検査できます。
- 送り方：AssemblyAI と Soniox はバイナリ、ElevenLabs は JSON（base64）。
- **無音のあいだも送り続けます。** Provider は無音を聞いて endpoint を判断するので、止めると区切りが出ません。
  無音の時間も課金されるかは Phase 0 で確認し、README に書きます。
- 詰まり：`bufferedAmount` が1秒分（32,000バイト）を超えたら `dlog('stt','stream-backpressure')`（5秒に1回まで）。
  5秒分を超えたら通信障害として再接続します（§14）。黙って捨てません。
- `AudioContext` が suspended なら `resume()` します（iOS。`StreamEngine` と同じ）。
- AudioWorklet が無いブラウザでは開始せず、理由をトーストで出します。ScriptProcessor の代替は作りません。
- 5秒ごとに、送った秒数・バイト数・入力レートを記録します（今の `live-audio-transport` と同じ形）。
- AssemblyAI の1回の送信の長さの制約（50〜1000ms と言われる）は要原典確認。既定の100ms はその範囲に入ります。

---

## 8. 認証と鍵

### 8.1 原則

1. キーをソース・HTML・拡張に埋め込みません（計画書§63）。
2. 長期のキーを WebSocket の URL・最初のメッセージ・診断に入れません。WebSocket には一時資格情報だけを使います。
3. **別の会社のキーへ落ちません**（§0.1 #12）。
4. 一時資格情報は1回の接続ごとに発行し直し、使い回しません（計画書§49）。
5. 🔍 確認ボタンは「一時資格情報の発行が通ること」を確かめます。キーの有効性と発行経路（CORS）を同時に試せ、音声は送りません。

### 8.2 Provider ごとの一時資格情報

|Provider|発行|認証|有効期間|使い方|
|---|---|---|---|---|
|OpenAI（今のまま）|`POST https://api.openai.com/v1/realtime/client_secrets`（session 設定を含む）|`Authorization: Bearer <key>`|—|`POST /v1/realtime/calls` の SDP 交換|
|ElevenLabs|`POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe`|`xi-api-key: <key>`|15分・1回限り|`wss://api.elevenlabs.io/v1/speech-to-text/realtime?…&token=…`|
|AssemblyAI|`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=60`（1〜600）。`max_session_duration_seconds`（60〜10800、既定10800）|`Authorization: <key>`|指定した秒数|`wss://streaming.assemblyai.com/v3/ws?token=…&…`|
|Soniox|`POST https://api.soniox.com/v1/auth/temporary-api-key` `{"usage_type":"transcribe_websocket","expires_in_seconds":60,"single_use":true}`（`max_session_duration_seconds` は任意）|`Authorization: Bearer <key>`|1〜3600秒|`wss://stt-rt.soniox.com/transcribe-websocket` の最初の JSON の `api_key`|

認証ヘッダの正確な形と応答のフィールド名は要原典確認です。

### 8.3 発行経路（`sttCredentialRoute`）

|値|何が発行を頼むか|注意|
|---|---|---|
|`direct`（既定）|ページが利用者のキーで発行元へ直接頼む|今の OpenAI と同じ。発行元が CORS を許さないと、HTML 版（GitHub Pages）では失敗する|
|`relay`|拡張の service worker が**発行の要求だけ**を中継する|中継先は §8.2 の固定 URL だけで、任意のオリジンへは中継しない。`turn-proxy.js` と同じく、頼めるのは拡張自身のページと登録済みの HTML 本体のタブだけ。本文とキーを記録しない。拡張の `host_permissions` に発行元を足す|
|`broker`|利用者が指定した HTTPS の Token Broker が発行する。ページは Provider のキーを持たない|組織で配るとき向け。Duo はサーバーを同梱しない。契約は §8.4|

CORS が問題になるのは **HTML 版（GitHub Pages のタブ）だけ**です。拡張の中のページ（`app.html`）は、
`host_permissions` にある発行元へは CORS に関係なく要求を送れるので、direct のままで通ります（§8.7 で発行元を足す）。

HTML 版で direct が通らない Provider をどう扱うかは、**実装後の挙動を見て決めます（D-2 決定）**。判断できるように、
次のことを実装に含めます。

- Phase 0 で各発行元の CORS を実測し（GitHub Pages のオリジンと拡張ページ）、付録A に書く。
- 発行に失敗したとき、🔍 確認と診断ログで原因を分けて出す。応答を受け取れずに失敗した（`fetch` が HTTP の状態を持たずに
  失敗した）ときは「ブラウザから発行元へ届きません（CORS の可能性）。拡張から使うか、発行経路を変えてください」、
  401・403 のときは「キーが無効か、音声認識の権限がありません」。**2つを同じ文言にしません。**

### 8.4 Token Broker の契約

```text
POST {sttBrokerUrl}/token/stt/{provider}      provider = elevenlabs | assemblyai | soniox | openai
Content-Type: application/json
{"model":"stt-rt-v5"}                          （openai は {"model":…, "session":{…}} ＝ client_secrets に渡す設定）
→ 200 {"token":"…","expires_at":"…"}
```

- HTTPS のみ。認証情報を含む URL は受け付けません（`turn-proxy.js` の `normalizeTurnOrigin` と同じ規則）。
- Duo は Cookie を送りません（`credentials:'omit'`）。Broker が利用者をどう認証するかは、**実装後の挙動を見て決めます（D-8 決定）**。
  Phase 5 では上の契約（URL・要求・応答）だけを実装します。
- Broker の応答は診断に書きません。

### 8.5 キーの持ち方

- 新しいキーの名前：`stt:elevenlabs`、`stt:assemblyai`、`stt:soniox`。区分は stt で、**現行と同じく**「このブラウザに保存する」が ON のとき `localStorage`（`di.keys.stt`）に保存します（**D-1 決定**）。
  計画書§33 の「localStorage 禁止」は採りません。
- `sttLiveKey(provider)`：
  - `elevenlabs` → `KEYS['stt:elevenlabs']`、空なら `KEYS['eleven']`（同じ会社の読み上げ用キー）。
    ElevenLabs のキーは既定で権限が絞られるので（app.js:3311 の注記）、音声認識の権限が無ければ 🔍 確認がそう言うようにします。
  - `assemblyai`・`soniox` → 自分の区分だけ。
  - `openai` → 今の `sttKey()` のまま（互換のため変えない）。
- 書き出し：既存のキーと同じく `portable` ではありません。「APIキーも埋め込む」を ON にしたときは stt 区分として入ります（既存の挙動）。

### 8.6 診断と伏せ字

- 接続中の一時資格情報も、伏せ字の第1段（手元の実値との完全一致）に登録します。
- 第2段の既存の規則（URL の `token=`、JSON の `"api_key": "…"`）に掛かることを検査で固定します。

### 8.7 拡張

- `manifest.json` の `host_permissions` に `https://streaming.assemblyai.com/*` と `https://api.soniox.com/*` を足します
  （`api.elevenlabs.io` はあります）。拡張ページから発行元を CORS に関係なく呼ぶためです。
- WebSocket に `host_permissions` は要りません。CSP の `connect-src` には `wss://*` があります。
- `SECURITY.md`（§2 の音声認識の送り先、§5 の権限）と `audit/extension-permission-audit.md` を直します。
- 各社のデータ保持・学習への利用の設定は Phase 0 で確認し、README に書きます。

---

## 9. 設定（`CONFIG_SCHEMA` に足すもの）

保存キーは「`di.` に続けて設定名を省略せず書く」規則に従います（`CONFIG_SCHEMA` の注記）。
既定値の方針は3つです：**(1) 既存の挙動がある設定は今の値、(2) 新 Provider は公式の既定値、(3) 実測のあとに見直す**（**D-5 決定**）。

**性能に関わる設定は、すべてプルダウンで選びます（D-5 決定）。** 数値を打ち込む欄は作りません。
選択肢には必ず次の2つを入れます。

- 公式の既定値（画面では「（既定）」と書く）
- 計画書が挙げた値（ElevenLabs の 0.3〜1.0秒、AssemblyAI の min_latency とモードごとの値の候補、Soniox の公式の低遅延の出発点など）

これで、比較試験（§13.2）の条件をすべて画面から選べます。選択肢の値は、Phase 0 で原典の範囲と照らして見直します
（範囲外と分かった値は外す）。

|prop|保存キー|既定|選択肢|
|---|---|---|---|
|`sttProvider`（既存）|`di.sttp`|`webspeech`|`elevenlabs`・`assemblyai`・`soniox` を足す。gpt-live は今と同じく `openai`＋モデル名で選ぶ|
|`sttModel`（既存）|`di.sttm`|Provider ごと|`scribe_v2_realtime`／`universal-3-5-pro`／`stt-rt-v5`。モデル名の直接入力も今と同じく残す（新しい版が出ても追える。性能設定ではないため）|
|`sttLiveDelay`|`di.sttLiveDelay`|**`low`**|`minimal`・`low`・`medium`・`high`・`xhigh`|
|`sttElevenLabsCommitStrategy`|`di.sttElevenLabsCommitStrategy`|`vad`|`vad`・`manual`|
|`sttElevenLabsVadSilenceSecs`|`di.sttElevenLabsVadSilenceSecs`|`1.5`|0.3・0.5・0.7・1.0・1.5・2.0・3.0 秒|
|`sttElevenLabsVadThreshold`|`di.sttElevenLabsVadThreshold`|`0.4`|0.2・0.3・0.4・0.5・0.6（範囲は要原典確認）|
|`sttElevenLabsMinSpeechMs`|`di.sttElevenLabsMinSpeechMs`|`100`|50・100・250・500 ms（要原典確認）|
|`sttElevenLabsMinSilenceMs`|`di.sttElevenLabsMinSilenceMs`|`100`|50・100・250・500 ms（要原典確認）|
|`sttAssemblyAiMode`|`di.sttAssemblyAiMode`|`balanced`|`min_latency`・`balanced`・`max_accuracy`|
|`sttAssemblyAiMinTurnSilenceMs`|`di.sttAssemblyAiMinTurnSilenceMs`|モードの既定（空）|モードの既定・100・128・160・256・400・512 ms|
|`sttAssemblyAiMaxTurnSilenceMs`|`di.sttAssemblyAiMaxTurnSilenceMs`|モードの既定（空）|モードの既定・640・900・1280・1600・2000・2560 ms|
|`sttAssemblyAiInterruptionDelayMs`|`di.sttAssemblyAiInterruptionDelayMs`|モードの既定（空）|モードの既定・0・250・500 ms（意味は要原典確認）|
|`sttSonioxEndpointLevel`|`di.sttSonioxEndpointLevel`|`0`|0・1・2・3（上限は要原典確認）|
|`sttSonioxEndpointSensitivity`|`di.sttSonioxEndpointSensitivity`|`0.0`|−1.0・−0.5・−0.3・0.0・+0.3・+0.5・+1.0|
|`sttSonioxMaxEndpointDelayMs`|`di.sttSonioxMaxEndpointDelayMs`|`2000`|500・1000・1500・2000・2500・3000 ms|
|`sttCardClose`|`di.sttCardClose`|`first`|`first`・`provider`・`duo`|
|`sttCredentialRoute`|`di.sttCredentialRoute`|`direct`|`direct`・`relay`・`broker`|
|`sttBrokerUrl`|`di.sttBrokerUrl`|空|HTTPS の URL（性能設定ではないので入力欄）|
|`sttAutoFallback`|`di.sttAutoFallback`|`0`（OFF）|OFF・ON|
|`sttFallbackProvider`|`di.sttFallbackProvider`|`openai`|ストリーミング型の Provider|
|`sttChunkMs`|`di.sttChunkMs`|`100`|50・100・200 ms|

AssemblyAI の選択肢に並べた 128・512・640・1280・2560 ms などは、計画書がモードごとのプリセット値として挙げた数字を
**個別に選べるようにしたもの**です。「モードの既定」を選んでいる項目は送らず、モードの中身を Duo が決め打ちすることはしません（§0.1 #6）。

- 選択肢に無い値（古い保存値や書き換えられた値）は、`coerce` で既定へ戻します（検査する）。
- 反映は**次の開始から**です。実行中に変えたら、今の `rtCardSeconds` と同じくトーストで知らせます（app.js:12672）。
- 計画書§24 の入れ子の `sttConfig` は、`sttLiveOptions()` が上の平らな設定から組み立てます。
  診断の `performance` には **Provider 自身のパラメータ名**で書きます（計画書§37 の形）。

---

## 10. 設定画面

`設定UI設計指針.md` に従います（文字は3段、`details.adv.panel-form`、既定値を選択肢に書く、失うものを書く、単位と範囲を添える）。

### 10.1 サービスとモデル

- `sttProvider` に選択肢を3つ足します：「ElevenLabs Scribe v2 Realtime（ストリーミング）」
  「AssemblyAI Universal-3.5 Pro Realtime（ストリーミング）」「Soniox v5 Realtime（ストリーミング）」。
- 新 Provider では「🔄 更新」（モデル一覧の取得）を出しません。モデル名の直接入力（`sttModelCustom`）は使えます。
- APIキー欄の説明は「空欄なら翻訳プロバイダのキーを使用」ではなく、Provider ごとの実際の扱い（§8.5）を書きます。

### 10.2 Provider ごとの欄（JS で注入：`details.adv.panel-form#sttLivePanel`）

判断層のパネル（`turnDecisionSettings`、app.js:498）と同じく JS から注入し、選んだ Provider に応じて中身を入れ替えます。
**欄はすべてプルダウン（`select`）です**（D-5 決定）。選択肢は §9 の表のとおりで、既定の値には「（既定）」を付けます。

**OpenAI（モデルが gpt-live-transcribe のとき）**

|項目|選択肢|
|---|---|
|文字が出る速さと精度（delay）|最小（minimal）／低（low・既定）／中（medium）／高（high）／最高（xhigh）|

説明：「高いほど文字が出るのが遅れ、難しい音声で精度が上がることがあります。段ごとのミリ秒は公式に決まっていないので、
実測で比べてください。」

**ElevenLabs**

|項目|選択肢|
|---|---|
|確定のしかた|VAD（無音で確定・既定）／手動（Duo の区切りで確定）|
|確定までの無音|0.3／0.5／0.7／1.0／1.5（既定）／2.0／3.0秒|
|詳細：声の判定しきい値|0.2／0.3／0.4（既定）／0.5／0.6|
|詳細：最短の発話|50／100（既定）／250／500ms|
|詳細：最短の無音|50／100（既定）／250／500ms|

失うもの：「短くすると文の途中の息継ぎで確定し、1文が複数に割れます。」

**AssemblyAI**

|項目|選択肢|
|---|---|
|性能モード|最小遅延（min_latency）／バランス（balanced・既定）／最大精度（max_accuracy）|
|詳細：ターン終了の最短無音|モードの既定（既定）／100／128／160／256／400／512ms|
|詳細：ターン終了の最長無音|モードの既定（既定）／640／900／1280／1600／2000／2560ms|
|詳細：interruption_delay|モードの既定（既定）／0／250／500ms|

詳細の1つでも「モードの既定」以外を選ぶと、見出しに「カスタム（モード＋上書き）」と出します。モードごとの値は画面に出しません（§0.1 #6）。
失うもの：「最短無音を短くすると、電話番号のように続く数字が途中で割れることがあります。」（要原典確認）

**Soniox**

|項目|選択肢|
|---|---|
|組み合わせ|公式の既定（Level 0 ／ 0.0 ／ 2000ms）（既定）／公式の低遅延の出発点（Level 2 ／ +0.3 ／ 1500ms）／個別に選ぶ|
|区切りの速さ（Endpoint Speed）|Level 0 — 標準（既定）／1 — 速め／2 — 低遅延／3 — 最も積極的|
|詳細：区切りやすさ（endpoint_sensitivity）|−1.0／−0.5／−0.3／0.0（既定）／+0.3／+0.5／+1.0|
|詳細：区切りの最大待ち|500／1000／1500／2000（既定）／2500／3000ms|

- この設定を「**認識精度**」と呼びません。区切りを出す速さの設定で、上げると語の精度がわずかに下がることがある、と書きます（計画書§12）。
- 「組み合わせ」は3つの欄をまとめて変えるプルダウンで、保存はしません（3つの欄の値から表示を決める）。
  3つのどれかを個別に変えると「個別に選ぶ」になります。「公式の低遅延の出発点」は **Soniox の公式ドキュメントが示す出発点**であり、
  Duo が決めた最適値ではないと説明に書きます。
- Duo 独自のプリセット（計画書§16 の Stable／Fast／Aggressive）は、Phase 7 の実測のあと必要なら足します。
  足すときは UI とコードのコメントに「Duo 独自」と明記します。

**新 Provider に共通**

|項目|選択肢|
|---|---|
|カードを閉じる合図|早い方（既定）／Provider の区切りだけ／Duo の区切りだけ|
|一時キーの発行|直接（既定）／拡張が中継／Token Broker（URL）|
|自動フォールバック|OFF（既定）／ON（切替先）。ON の説明に「音声の送り先の会社が変わります」|

### 10.3 検査

- `test-settings-style.cjs` が通ること（注入パネルに `panel-form`、`#id` に文字サイズを書かない）。
- `test-app-html-sync.cjs` が通ること（`sttProvider` の選択肢を `index.html` に足し、`app.html` を変換で作り直す）。
- 実ブラウザで、Provider の切替で欄が入れ替わる・既定値が出る・保存される・再読込で戻ることを E2E で固定します（`test-settings-ui.cjs` と同じ形）。
- 性能に関わる欄がすべて `select` であること、各 `select` の選択肢が §9 の表と一致し、既定の選択肢にだけ「（既定）」が付くことを検査します。
- Soniox の「組み合わせ」を選ぶと3つの欄が変わり、3つのどれかを変えると「個別に選ぶ」に戻ることを検査します。

---

## 11. 計測と診断

### 11.1 時刻と指標

基準時刻は **Provider によらず端末側の同じ判定**で取ります。Provider ごとの `speech_started` を使うと、判定の違いが
そのまま指標の差に混ざり、比較になりません（Provider の時刻も併せて記録はします）。

|記号|定義|
|---|---|
|`T_speech`|発話開始。端末側の音量判定（`CFG.vad` の閾値、80ms 周期）で、その席の無音が続いたあと最初に声を検出した時刻|
|`T_end`|発話終了。同じ判定で、声を最後に検出した時刻|

無音が何 ms 続けば「続いた」とするかは Phase 1 で決め、定数として記録します。

|指標|定義|取る場所|
|---|---|---|
|TTFP|最初の空でない partial − `T_speech`|カードの `firstPartialAt`（今の `duoSttTiming`）|
|TTStable|開いている区間の先頭が segment 方針の最小長（`p.min`）に達し、`p.stability` ms 変わらなかった最初の時刻 − `T_speech`|`segCheck` の安定長の計算|
|**TTTR**|そのカードで**最初の区間が確定して翻訳の待ち行列へ入った時刻** − `T_speech`。segment 層が無効なら `translate()` を呼んだ時刻|`segCheck` の commit（`dlog('segment','commit')`）。`decisionSource`（rules／provider）を併記し、Jev が決めたかを残す|
|TTEndpoint|Provider の endpoint を受けた時刻 − `T_end`|正規化 `endpoint`|
|TTCommit|Provider の committed を受けた時刻 − `T_end`|正規化 `committed`|
|TTClose|カードを閉じた時刻 − `T_end` と、閉じた理由|Host|
|partial 数|カードあたりの partial の数|Host|
|改訂数|`segUpdate` で、すでに表示していた文字が書き換わった回数|`segUpdate` の共通前後の計算|
|PRR（partial 改訂率）|Σ（表示済みで、後の partial で置換・削除された文字数）÷ 最終本文の文字数|同上|
|確定後訂正|翻訳へ出した区間の本文が、あとで変わった回数|既存の `SEG.corrected`・`correctedBySource`|
|再接続・エラー|回数と種別（`auth`・`config`・`rate`・`transient`）、429 の回数|Host|
|音声|入力レート、送信レート（16kHz）、`sttChunkMs`、送った秒数とバイト数、詰まりの回数|`SttPcmTap`|

計画書§38 の「value → valve」のような書き換えは、翻訳へ出る前なら PRR に、出たあとなら確定後訂正に数えます。
**翻訳に効くのは後者です。** 両方を分けて出します。

計画書§36 は TTEndpoint・TTCommit の起点を書いておらず、§47 の例では発話開始からの値と並んでいます。本書では
この2つを**発話終了から**測ります。発話開始から測ると話の長さがそのまま足され、endpoint の遅れを比べられないためです。

### 11.2 記録

- カードを閉じるたびに `dlog('stt','live-metrics',{cardId, provider, model, ttfp, ttstable, tttr, decisionSource,
  ttendpoint, ttcommit, ttclose, closeReason, partials, revisions, prr, chars})`。**本文は入れません。**
- 開始時の `dlog('session','START',…)` と診断の設定欄に、`provider`・`model`・`performance`（Provider のパラメータ名のまま）・
  発行経路・`sttCardClose` を出します。
- 共有用の診断ログは今の規則のまま（本文は字数だけ）です。

### 11.3 計測の画面

診断モードで、今のセッションの各指標の**件数・中央値・p90**を出します。複数の条件を比べたときは条件ごとに1行にします。
**実測した値だけを出し、計画書§47 の例の数字は見本としても画面に置きません。** CER／WER は参照原稿を読み込んだときだけ出します。

---

## 12. 精度の評価（オフライン）

- 検証ツール `extension/tools/stt-bench.js`（Node、依存なし）を足します。
- 入力：比較試験（§13）の結果の書き出し（カードの本文を含むので完全版扱い。ファイル名 `stt-bench-*.json` を `.gitignore` に足す）と、
  参照原稿（音声ごとの `*.ref.txt`）。
- 出力：日本語は CER、英語は WER、固有名詞・数字・専門用語の正解率（用語の一覧は用語集か別ファイル）、
  言語が混ざる発話の正解率（計画書§39）。試行ごとと、条件ごとの集計。
- 正規化：NFKC。日本語は句読点と空白を除いて文字で比べる。英語は小文字にし、句読点を除いて語で比べる。
  数字の表記（「三」と「3」）は揃えない値と揃えた値を別の列に出します。
- `test-stt-bench-tool.cjs`（小さな参照と仮説で CER／WER が期待値になる）を gate に入れます。

---

## 13. 比較試験（A/B/C/D、計画書§41–46）

### 13.1 同じ音声で比べる方法

- 診断モードに「ベンチ入力」を足します。音声ファイルを `decodeAudioData` → `AudioBufferSourceNode` →
  `MediaStreamAudioDestinationNode` で Track にし、**同じ Track を複数の Host へ同時に渡します。**
  同じ時刻・同じ回線の条件で比べられます。帯域が足りなければ条件ごとに順番に流すこともできます。
- 1倍速で流します（リアルタイムの API は実時間の送出を前提にしている）。
- ベンチ中は翻訳・読み上げ・会議送出をせず、カードは本体の会話欄ではなくベンチの欄に出します。自動フォールバックは切ります。
- 実行前に、**送り先の会社の一覧と、送る音声の秒数**を出して、**実行のたびに**確認を取ります（料金と送り先のため。**D-9 決定**）。
- ファイルの音はマイクの経路を通らないので、実際のマイクと共有音声でのセッションも別に行います。

### 13.2 試験する条件

|系|条件|
|---|---|
|A OpenAI gpt-live-transcribe|delay 5段（minimal／low／medium／high／xhigh）|
|B ElevenLabs|VAD の無音 0.3／0.5／0.7／1.0／1.5秒、手動確定|
|C AssemblyAI|min_latency／balanced／max_accuracy|
|D Soniox|Level 0〜3、Level 2 で sensitivity 0.0／0.3／0.5、公式の出発点（2／+0.3／1500ms）|
|共通|endpoint を出す Provider では `sttCardClose` の first／provider／duo|

### 13.3 試験音声

計画書§46 の15種（日本語のみ、英語のみ、日本語＋英単語、英語＋日本語の固有名詞、技術会議、数字、型番、人名、速い発話、
ゆっくりした発話、長い間、短い間、雑音あり、システム音声、マイク）。
「今回の control valve の stroke time ですが」のような言語の混ざる発話を必ず含めます。

- **リポジトリに置く試験素材は合成音声だけ**です（**D-9 決定**）。権利を持つ録音は手元で使い、commit しません。
  実際の会議の音声も commit しません（`bench-audio/` を `.gitignore` に足す）。合成音声の素材は `extension/tests/fixtures/stt-audio/` に置きます。
- 参照原稿は音声と一緒に用意します。

### 13.4 集計と採用の判断

- 各条件3回以上。中央値・p90・件数を出し、日付・版・回線・Provider が返したモデル名をそのまま添えます。
- **採用は、実装後に実際に使ったときの使用感で owner が判断します（D-7 決定）。** 本書は数値の合否基準を置きません。
- 判断の材料として、TTTR の中央値、確定後訂正の率、CER／WER を、基準系（OpenAI・low）と並べて出します。
  主に見る数字は TTTR の中央値です。
- 結果は `次期仕様実装状況.md` に節を足して残します。

---

## 14. 再接続とフォールバック

### 14.1 エラーの分類（`classify`）

|分類|例|動き|
|---|---|---|
|`auth`|401・403、無効な一時資格情報|再試行しない。キーの確認を案内する|
|`config`|400・422、未対応のパラメータ・モデル・言語|再試行しない。Provider の文言を出す|
|`rate`|429、同時接続数の超過|2秒・4秒・8秒で最大3回|
|`transient`|異常切断（1006 など）、通信断、5xx、接続前の期限切れ、セッション上限による切断|0.5秒・1秒・2秒で、60秒あたり最大3回|
|`closed`|こちらから閉じた（1000）|何もしない|

Provider ごとのエラーコードとの対応は要原典確認です。

### 14.2 再接続

- 毎回、一時資格情報を発行し直します（1回限りのものは使い回せない）。
- 開いているカードは、その時点の本文で理由 `reconnect` として閉じ、途切れた時間を記録します。
- 途切れていたあいだの音声は送り直しません（Phase 5 で要否を判断）。

### 14.3 フォールバック

- `sttAutoFallback` が ON で、`rate`・`transient` の再試行を使い切ったときだけ切り替えます。
  `auth`・`config` では切り替えません（設定の誤りを隠さないため）。
- 同じ `MediaStream` のまま、切替先の Host を始めます。開始時に切替先のキーがあるかを確かめ、無ければ警告します。
- 切り替えたら「音声の送り先を X から Y へ切り替えました」とトーストを出し、記録します。
- ベンチ中は使いません。

---

## 15. 不変条件（検査で固定する）

|ID|条件|検査|
|---|---|---|
|INV-STT-01|`sttProvider` が既存の値のとき、挙動は v1.49.39 と同じ。gpt-live で `sttLiveDelay=low` のとき、送る session 設定はバイト単位で同じ|`test-stt-live-parity.cjs`|
|INV-STT-02|Adapter は DOM・翻訳・読み上げ・判断層・カードに触れない|`test-stt-live-adapters.cjs`（Adapter のブロックを、それらの関数の無い `vm` で動かす）|
|INV-STT-03|Provider ごとに `getUserMedia`／`getDisplayMedia` を呼ばない|同上＋ Host の検査|
|INV-STT-04|下流は Provider 固有の種別名を見ない。`raw` は診断だけ|同上|
|INV-STT-05|正規化した partial は全文。ElevenLabs の partial を連結しない|同上|
|INV-STT-06|Provider の endpoint から直接翻訳を始めない。カードを閉じる → `segUpdate(final)` → `segCheck` の順を通る|`test-stt-live-host.cjs`|
|INV-STT-07|長期のキーを WebSocket の URL・最初のメッセージ・診断に入れない。別の会社のキーへ落ちない|`test-stt-credentials.cjs`|
|INV-STT-08|利用者が ON にしない限り、音声の送り先の会社を変えない|`test-stt-live-host.cjs`|
|INV-STT-09|判断層の質問文・`state`・閾値は変えない（`questionSetHash` が変わらない）|既存の `test-turn-providers.cjs`|
|INV-STT-10|計測の画面は実測値だけを出す|`test-stt-metrics.cjs`|

計画書§63 の禁止事項は、上の INV と §8.1 に対応させています。

---

## 16. 変更対象

|ファイル|変更|
|---|---|
|`index.html`・`extension/app.js`（同じコード）|`STT_ADAPTER_CAPABILITIES`（新 Provider：マイク・共有音声・Track とも可）、`STT_MODELS`、`CONFIG_SCHEMA`、新しいブロック（§4.1）、`RealtimeTranscriptionEngine` を Host と OpenAI Adapter に分ける、`startAll` のマイク・VB・共有音声の分岐、`startVU` の話し方解析の共有条件、`verifySttKey`、`sttCall` の拒否（ストリーミング専用モデルを録音 API へ送らない）、`refreshProviderUI`、診断の設定欄（13014〜13061 付近）、`isLiveTranscribe()` 15か所のうち「ストリーミング型か」を聞いている箇所を `isStreamingStt()` へ、`duoValidateInputs` のトーストの Provider 名|
|`index.html`（markup）|`sttProvider` の選択肢。`extension/app.html` は変換で作り直す|
|`extension/manifest.json`|`host_permissions` に AssemblyAI・Soniox の発行元。版|
|`extension/service-worker.js`|relay 経路（§8.3）。固定 URL だけを中継する|
|`extension/tests/`|新しい検査（下表）、`test-file-sync.cjs` の `SHARED`、`test-input-validation.cjs` の組合せ、`run-all.cjs` の `GATE`|
|`extension/tests/fixtures/`|Phase 0 で記録した受信列（合成音声なので本文を含んでよい。キーは含めない）|
|`extension/tools/stt-bench.js`|§12|
|`SECURITY.md`・`README.md`・`受入確認手順.md`・`次期仕様実装状況.md`・`audit/extension-permission-audit.md`|送り先、権限、手順、状況|
|`versions.json`・`extension/README-v*.md`|出荷ごと|
|`.gitignore`|`stt-bench-*.json`、`bench-audio/`|

新しい検査：

|検査|gate／E2E|内容|
|---|---|---|
|`test-stt-live-adapters.cjs`|gate|受信列 → 正規化イベント列。特殊 token を除く、全文置換、`turn_order` で同一性を判定、Soniox の final／非 final、ElevenLabs の partial を連結しない|
|`test-stt-live-parity.cjs`|gate|gpt-live の session 設定がバイト一致。記録した DataChannel の受信列を旧実装と新実装に流し、カードの本文・閉じた理由・記録の種類と順が一致|
|`test-stt-pcm.cjs`|gate|モノラル化・16kHz への間引き（正弦波で振幅と周波数）・Int16 変換と切り捨て・フレーム長|
|`test-stt-credentials.cjs`|gate|別の会社のキーへ落ちない、WebSocket の URL と Soniox の設定メッセージが伏せ字になる、Broker の URL の検査|
|`test-stt-live-host.cjs`|gate|`sttCardClose` の3値、Duo が先に閉じたあとの committed の写像、止めたあとの結果を捨てる、再接続でカードを閉じる、フォールバックの条件|
|`test-stt-metrics.cjs`|gate|TTFP・TTTR・PRR の計算|
|`test-stt-bench-tool.cjs`|gate|CER／WER|
|`test-stt-settings-ui.cjs`|E2E|§10.3|

---

## 17. フェーズ

各フェーズは単独で出荷できる単位です。出荷のたびに `APP_VERSION`／`APP_BUILD`／拡張の版を上げ、`versions.json` と
`extension/README-v*.md` を足し、`node extension/tests/run-all.cjs` と `node tools/security-scan.cjs --tree` を通します。

### Phase 0 — 契約の確認（製品コードの変更なし）

- 原典を読み、付録A の「要原典確認」を埋める：URL、パラメータ名・範囲・既定値、送受信のメッセージとフィールド、エラー、
  セッションの上限、課金の単位（無音の時間を含むか）、データ保持・学習への利用。
- 実測：各発行元へ direct で発行できるか（GitHub Pages のオリジンと拡張ページ、CORS）。短い合成音声で接続し、受信の列を記録して fixture にする。

完了条件：□ 付録A の要原典確認が埋まっている □ Provider ごとの fixture がある □ 各発行元の CORS の実測結果が付録A にある（D-2 の判断材料）
□ §9 の選択肢の値が原典の範囲に収まっている（外れた値は外す）

### Phase 1 — gpt-live を Adapter 化し、delay を選べるようにする（計画書 Phase 2）

- `RealtimeTranscriptionEngine` を `SttLiveHost` と `STT_LIVE_PROVIDERS.openai` に分ける。`isStreamingStt()` を入れる。
- `sttLiveDelay`（既定 low）と設定欄。
- カード単位の計測ログ（§11.2）を入れ、基準系の数字を取れるようにする。

完了条件：□ INV-STT-01（バイト一致と受信列の再生の一致） □ 5段の delay で接続できる（実機） □ マイク・共有音声（auto）・VB の3経路（実機）
□ `segmentMode` の off と balanced の両方 □ 判断層 shadow の記録が今と同じ形で出る □ 既存の gate がすべて通る

### Phase 2 — `SttPcmTap` と ElevenLabs（計画書 Phase 3）

### Phase 3 — AssemblyAI（計画書 Phase 4）

### Phase 4 — Soniox（計画書 Phase 5）

Phase 2〜4 の完了条件（Provider ごと）：
□ 契約の検査（fixture → 正規化イベント列） □ 拡張版で direct の一時資格情報の発行が通る
□ HTML 版で direct を試し、通らないときは 🔍 確認と診断が「届かない（CORS の可能性）」と「キーの問題」を分けて出す（D-2 の判断材料） □ マイク・共有音声・VB
□ partial の表示、committed、endpoint の正規化 □ 性能設定をプルダウンで切り替え、送った値が診断に出る（§9 の選択肢すべて）
□ キーが WebSocket の URL・診断に平文で出ない □ 翻訳・読み上げ・判断層（shadow）・会議送出が壊れていない
□ `SECURITY.md`・`README.md`・`受入確認手順.md` を更新

### Phase 5 — 共通の仕組み

再接続（§14.2）、自動フォールバック（§14.3）、relay と broker の経路（§8.3–8.4）、`sttCardClose` の3値。
Broker は契約（§8.4）だけを実装し、利用者認証は実装後の挙動を見て決めます（D-8）。

完了条件：□ 異常切断・期限切れ・429 を模擬して、分類どおりに動く □ フォールバックは ON のときだけ □ relay は固定 URL 以外を中継しない
□ HTML 版で relay・broker を使ったときの挙動を実機で確かめ、D-2・D-8 の判断材料として `次期仕様実装状況.md` に残す

### Phase 6 — 比較の道具（計画書 Phase 7）

ベンチ入力（§13.1）、計測の画面（§11.3）、`stt-bench.js`（§12）。

完了条件：□ 同じ音声ファイルを複数の Provider へ同時に流せる □ 画面に実測値だけが出る □ 参照原稿から CER／WER を出せる

### Phase 7 — 比較試験の実施と既定値の見直し

§13.2 の条件で測り、結果を `次期仕様実装状況.md` に残す。既定の Provider と設定値を変えるかは、測った数字を材料に、
実際に使ったときの使用感で owner が決めます（D-5・D-7）。

### Phase 8 — 判断層との比較（shadow、計画書 Phase 8）

- Provider の endpoint・Rules・Jev がカードを閉じようとした時刻を並べて記録する。
- `stableChars` を判断の材料として shadow で記録する。
- **Jev の質問文と `state` は変えません**（INV-STT-09）。材料に足すかは校正のやり直しを伴うので、記録を見て別途決めます。

計画書 Phase 9（予測翻訳）は範囲外です（§1.2）。

---

## 18. 決定事項（2026-09-29）

owner の回答で決まったことと、本書のどこへ反映したかです。「実装後の挙動で確認」とした項目は、判断に要る材料を
実装に含めることにしました。

|ID|論点|決定|反映先|
|---|---|---|---|
|D-1|新 Provider のキーを localStorage に保存してよいか（計画書§33 は禁止）|**現行と同じくローカル保存可**（区分ごとの「このブラウザに保存する」が ON のとき）|§0.1 #2、§8.5|
|D-2|HTML 版で direct が CORS で通らない Provider をどう扱うか|**実装後の挙動で確認して決める**|§8.3（失敗の原因を分けて出す）、§17 Phase 0・2〜5 の完了条件|
|D-3|自動フォールバックの既定|**OFF**|§0.1 #4、§9、§14.3|
|D-4|OpenAI の delay の既定|**low**（今のまま）。medium は比較試験で評価|§0.1 #3、§9|
|D-5|新 Provider の初期値|**公式の既定値**（ElevenLabs 1.5秒、AssemblyAI balanced、Soniox Level 0）。**性能設定はすべてプルダウンで選べるようにし**、計画書の値（0.5秒、min_latency、公式の低遅延の出発点など）も選択肢に入れる|§9、§10.2、§10.3|
|D-6|`sttCardClose` の既定|Claude に一任 → **first**（早い方）。OpenAI では今の挙動のままで、新 Provider でも遅い方の区切りに引きずられないため|§6.3、§9|
|D-7|採用の判断基準|**実装後の使用感で owner が判定する**。数値の合否基準は置かず、測った数字は判断の材料として出す|§13.4、§17 Phase 7|
|D-8|Token Broker の利用者認証|**実装後の挙動で確認して決める**。Phase 5 は契約だけを実装|§8.4、§17 Phase 5|
|D-9|比較試験の費用と試験素材|**費用は実行のたびに確認画面で確かめる。リポジトリに置く素材は合成音声だけ**|§13.1、§13.3|

---

## 付録A 公式仕様の照合状況

照合は検索エンジンの要約によります（§0）。「一致」は要約が計画書または本書の記述と合ったもの、「未確認」は要約に記述が無かったもの、
「食い違い」は要約どうし、または要約と計画書が合わなかったものです。**Phase 0 で原典に当たり、この表を更新します。**

|Provider|項目|計画書・本書の記述|照合|
|---|---|---|---|
|OpenAI|`delay` の値|minimal／low／medium／high／xhigh|一致。低いほど早く partial を出し、高いほど音声の文脈を多く使う。段ごとの ms は固定されていない|
|OpenAI|調整項目|`delay`・`prompt`・`keywords`・`languages`|一致（今のコードも同じ4つを使う）|
|OpenAI|turn detection|非対応|今のコードの注記どおり（`turn_detection:null`）。原典未確認|
|ElevenLabs|接続先|`wss://api.elevenlabs.io/v1/speech-to-text/realtime`|一致|
|ElevenLabs|受信の種別|`partial_transcript`・`committed_transcript`・`committed_transcript_with_timestamps`|一致。partial は開いている区間の全文|
|ElevenLabs|音声形式|`pcm_16000`（ほかに 8000〜48000、`ulaw_8000`）|一致|
|ElevenLabs|一時トークン|`POST /v1/single-use-token/realtime_scribe`、15分、1回限り|一致（計画書には発行先の記載なし）|
|ElevenLabs|`vad_silence_threshold_secs`|0.3〜3.0、既定1.5|一致（SDK の検査範囲）|
|ElevenLabs|`vad_threshold`・最短発話・最短無音の範囲と既定|0.1〜0.9／50〜2000／50〜2000、既定 0.4／100／100|**食い違い**：範囲は未確認。既定は SDK が 100／100、API の説明の要約が 250／2500。→ 毎回明示して送る（§5.5）|
|ElevenLabs|日本語|—|対応（90以上の言語）|
|AssemblyAI|モデル ID|`universal-3-5-pro`（`speech_model`）|一致。後継の版（3.6 Pro）の言及もあり、要原典確認|
|AssemblyAI|接続先|`wss://streaming.assemblyai.com/v3/ws`|一致|
|AssemblyAI|`mode`|min_latency／balanced（既定）／max_accuracy|一致。mode は `min_turn_silence` と `interruption_delay` の既定を決め、各項目は上書きできる|
|AssemblyAI|モードごとの値|min_latency 128/640/0、balanced 128/1280/500、max_accuracy 512/2560/500|**一部だけ一致**（balanced の 128／1280）。ほかは未確認 → Duo は値を持たない（§0.1 #6）|
|AssemblyAI|`continuous_partials`|true で発話中の partial を返す|一致|
|AssemblyAI|Turn のフィールド|`turn_order`・`turn_is_formatted`・`end_of_turn`・`transcript`・`end_of_turn_confidence`・`words`（`word_is_final`）|一致。`word_is_final` は最後の語以外は常に true|
|AssemblyAI|一時トークン|`GET /v3/token`、`expires_in_seconds` 1〜600、`max_session_duration_seconds` 60〜10800（既定10800）|一致。公式は「ブラウザへキーを出さず、サーバー側で発行する」を推奨|
|AssemblyAI|ブラウザからの発行（CORS）|—|未確認 → Phase 0 で実測|
|AssemblyAI|日本語|—|Universal-3.5 Pro Realtime の対応19言語に日本語を含む。言語の切替（code-switching）に単一パスで対応|
|Soniox|モデル ID|`stt-rt-v5`|一致|
|Soniox|接続先|`wss://stt-rt.soniox.com/transcribe-websocket`|一致|
|Soniox|`endpoint_latency_adjustment_level`|0〜3、既定0|既定0（意味的な区切りのまま）は一致。**上限は未確認**。上げると区切りが速くなり、語の精度がわずかに下がりうる。v5 が必要|
|Soniox|`endpoint_sensitivity`|−1.0〜1.0、既定0.0|一致。高いほど早く区切る。level>0 のときに効く|
|Soniox|`max_endpoint_delay_ms`|500〜3000、既定2000|一致|
|Soniox|低遅延の出発点|2／0.3／1500|一致|
|Soniox|`is_final`・`<end>`・`<fin>`・`finished`|—|一致。`<end>` は区間の終わりに1回だけ、常に final|
|Soniox|一時キー|`POST /v1/auth/temporary-api-key`、`usage_type=transcribe_websocket`、`expires_in_seconds` 1〜3600、`single_use`、`max_session_duration_seconds`|一致（計画書の `max_session_duration` は名前違い）。期限は新しい接続を開ける期間で、開いた接続は切らない|
|Soniox|ブラウザからの発行（CORS）|—|未確認 → Phase 0 で実測|

照合に使った検索の出典（いずれも要約経由）：
[OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)、
[ElevenLabs Realtime API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)、
[ElevenLabs Create Single Use Token](https://elevenlabs.io/docs/api-reference/tokens/create)、
[ElevenLabs Transcripts and commit strategies](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)、
[AssemblyAI Universal-3.5 Pro](https://www.assemblyai.com/docs/getting-started/universal-3-5-pro)、
[AssemblyAI Generate temporary streaming token](https://www.assemblyai.com/docs/api-reference/streaming/create-temporary-token)、
[AssemblyAI Message Sequence](https://www.assemblyai.com/docs/streaming/message-sequence)、
[Soniox WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)、
[Soniox Endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection)、
[Soniox Temporary API keys](https://soniox.com/docs/guides/temporary-api-keys)

---

## 付録B 計画書の節との対応

|計画書|本書|
|---|---|
|§1–3 目的・設計原則・Provider 一覧|§1、§4、付録A|
|§4 STT Provider Interface|§5.1|
|§5–22 性能設定と UI|§9、§10|
|§23 Global Preset|範囲外（§1.2）|
|§24 共通設定 Schema|§9（平らな `CONFIG_SCHEMA` と `sttLiveOptions()`）|
|§25–26 正規化イベントと対応表|§5.3、§5.4|
|§27 Audio Pipeline|§7|
|§28–33 認証・Token Broker・キー|§8|
|§34–35 翻訳・endpoint と Jev の分離|§6.2、§6.3、§0.1 #5|
|§36–40 診断・部分結果の安定性・精度・TTTR|§11、§12|
|§41–46 比較試験|§13|
|§47 Benchmark 画面|§11.3|
|§48–49 フォールバック・再接続|§14|
|§50 音声のループ防止|§2 #9、§6.2 の最終ゲート、INV-STT-03|
|§51 ファイル構成|§4.1、§16|
|§52–60 フェーズ|§17（§2 が §52 の監査）|
|§61 完了条件|§17 の各フェーズ|
|§62–63 重要指示・禁止事項|§5.2、§8.1、§15|
|§64–65 最終構成・本質|§4、§1.1|
