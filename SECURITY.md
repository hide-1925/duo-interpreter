# セキュリティとプライバシー

Duo Interpreter はサーバーを持たず、ブラウザ（と Chrome/Edge 拡張）の中だけで動きます。
このページは「何を端末に残すか」「何をどこへ送るか」「書き出したファイルに何が入るか」をまとめたものです。

## 1. 端末の中に保存するもの

| 保存するもの | 場所 | 消し方 |
|---|---|---|
| 設定・用語集・コンテキスト | ブラウザの `localStorage`（`di.*`） | ブラウザのサイトデータ削除 |
| 翻訳・音声認識・読み上げの APIキー | `localStorage`（`di.keys.trans` / `di.keys.stt` / `di.keys.tts`）。**区分ごとに「キーを記憶する」がONのときだけ** | その区分の「記憶する」をOFFにすると、その区分の保存値を消す |
| 判断層（発話交代）の APIキー | `localStorage`（`di.tdKeys.local`）。翻訳用のキーとは別に持つ | 判断層の設定の「消す」 |
| 拡張の状態（字幕の対象タブ、HTML本体のURL、判断層の中継先） | `chrome.storage` | 拡張の削除、または各設定の解除 |

- 会話ログ・診断ログ・議事録は、**ボタンを押して書き出したときだけ**ファイルになります。自動では保存しません。
- カメラ翻訳の写真は保存しません。
- 共用PCでは「キーを記憶する」をOFFにしてください。

## 2. APIキーと会話をどこへ送るか

送り先は **利用者が選んだプロバイダだけ** です。開発者のサーバーはありません。

| 用途 | 送り先（選んだときだけ） | 送るもの |
|---|---|---|
| 翻訳 | OpenAI・Anthropic・Google (Gemini)・xAI・Groq・DeepSeek・OpenRouter・Mistral・Together、または独自の互換API（Base URL） | 認識した本文、用語集、コンテキスト、APIキー |
| 無料翻訳 | Google 翻訳の非公式エンドポイント（`translate.googleapis.com`）、MyMemory | 認識した本文（APIキーなし） |
| 音声認識 | ブラウザ内蔵（Chrome は音声を Google へ送ります）、OpenAI、Groq、OpenRouter、ElevenLabs・AssemblyAI・Soniox（ストリーミング） | 音声、APIキー（ストリーミングの3社は下の一時資格情報） |
| 読み上げ | OpenAI・Aivis・ElevenLabs・xAI・Google Cloud TTS・OpenRouter・Groq・VOICEVOX（tts.quest またはローカル）・ブラウザ内蔵 | 訳文、APIキー |
| 判断層（既定OFF） | TypeSafe（Jev）など、利用者が選んだ経路 | 未確定の本文の末尾、音響特徴の要約、APIキー |
| 議事録生成 | 翻訳に選んだプロバイダ | 会話の本文 |

APIキーは、そのキーの発行元の API にだけ `Authorization` などのヘッダで送ります。

ストリーミング認識（gpt-live-transcribe・ElevenLabs・AssemblyAI・Soniox）は、接続のたびに**その会社の発行元で有効期間の短い一時資格情報を作り**、音声の接続（WebRTC／WebSocket）にはその一時資格情報だけを使います。長期のキーは WebSocket の URL や最初のメッセージに入りません。一時資格情報は接続ごとに作り直し、使い回しません。ElevenLabs・AssemblyAI・Soniox のキーは、欄が空でも翻訳のキーを借りません（ElevenLabs だけは、同じ会社の読み上げ用キーを使います）。
拡張の判断層の中継（`turn-proxy.js`）は、利用者がポップアップで許可した **1つのオリジン** にだけ転送し、ヘッダは既知のものだけを通し、記録しません。

## 3. 書き出したファイルに入るもの

| 書き出し | 入るもの | 入らないもの |
|---|---|---|
| 設定・用語集を埋め込んだHTML（既定） | 設定、用語集、コンテキスト | **APIキー**。判断層のキー（`portable:false`）。手元のキーと同じ文字列が1つでも入っていれば書き出しを止めます |
| 同上・「APIキーも埋め込む」ON | 上に加えて翻訳・音声認識・読み上げの APIキー（**平文**） | 判断層のキー |
| 診断ログ（既定＝共有用） | 環境、設定、動作の記録（本文は字数だけ）、件数 | 会話の本文、訳文、参加者名、デバイス名、APIキー |
| 診断ログ（完全版・確認あり） | 上に加えて会話の本文・訳文・参加者名・デバイス名 | APIキー |
| 拡張の「字幕操作ログ」 | 拡張の版、字幕レイヤーの接続状態、フレームのオリジン | 会話の本文、APIキー |
| 会話ログ（TXT/CSV）・議事録 | 会話の本文と訳文 | APIキー |

診断ログの伏せ字は2段です。
1. **いま手元にあるキーの実値**（翻訳・音声認識・読み上げ・判断層・埋め込みHTMLから読んだキー）を完全一致で `***REDACTED***` にする。形式の決まっていないキーもここで消えます。
   接続中のストリーミング認識の一時資格情報も、ここで伏せます。
2. そのあと形式で伏せる：`Authorization` / `Bearer`、`Cookie` / `Set-Cookie`、`client_secret`、`credential`、URL の `?key=` `token=` `secret=` `auth=`、URL の `user:pass@`、各社のキー形式（`sk-` `sk_` `gsk_` `xai-` `AIza` `hf_` `ghp_` `ek_` JWT など）。

それでも、**共有する前に中身を目で確認してください。**

## 4. 「APIキーも埋め込む」の危険性

- 書き出したHTMLには **APIキーが平文で入ります**。開ければ誰でも読めます。
- ファイル名は `duo-interpreter-PRIVATE-WITH-KEYS-YYYYMMDD-HHMM.html` になり、`.gitignore` で除外しています。**Git に commit しないでください。人に渡さないでください。**
- 書き出す前に確認を出し、書き出したあとは自動でOFFに戻ります。
- 人に配るファイルは、必ずOFFのまま書き出してください。

## 5. 拡張の権限と理由

| 権限 | 理由 |
|---|---|
| `activeTab`・`scripting` | 押したタブにだけ字幕レイヤーを差し込む |
| `storage` | 字幕の対象タブ・HTML本体のURL・判断層の中継先を覚える |
| `tabCapture` | HTML本体のタブの音声を認識に回す |
| `webNavigation` | 字幕を重ねるフレームを見つける |
| `host_permissions`（各社の API） | 拡張のページから翻訳・音声認識・読み上げの API を呼ぶ。`streaming.assemblyai.com` と `api.soniox.com` は、ストリーミング認識の一時資格情報を作るため |
| `host_permissions`（`127.0.0.1` / `localhost`） | ローカルの読み上げエンジン（VOICEVOX 等） |
| `host_permissions`（`hide-1925.github.io`） | 既定の HTML本体（GitHub Pages）との接続 |
| `host_permissions`（Teams） | 会議のマイク送出と話者の検出。**content script は Teams のドメインにだけ入ります** |
| `optional_host_permissions: https://*/*` | 利用者が選んだサイト（字幕を重ねるタブ、HTML本体の置き場所、判断層の中継先）。**インストール時には付与されず**、ポップアップのボタンを押したときに**そのオリジンだけ**を求めます |

一度許可したサイトは、Chrome の「拡張機能の管理 → Duo Interpreter → サイトへのアクセス」から取り消せます。

## 6. 脆弱性の報告

公開の Issue には書かないでください。GitHub の **Security → Report a vulnerability**（非公開の報告）から送ってください。
APIキーなどの秘密が見えてしまう不具合は、再現手順だけを書き、**実際のキーは貼らないでください**。

## 7. 秘密を誤って push してしまったら

1. **まずキーを失効・再発行する。** 履歴から消しても、一度公開されたキーは安全になりません（clone・fork・キャッシュに残ります）。各社のコンソールで失効させてください。
2. そのあと履歴から消す（`git filter-repo`）。PR の参照（`refs/pull/*`）は利用者には消せないので、必要なら GitHub Support に削除を依頼します。
3. `node tools/security-scan.cjs` で作業ツリー・全履歴・commit のメタデータを確かめる。

push の前に `node tools/security-scan.cjs --tree` を走らせると、キー・メールアドレス・Claude Code の session URL などを検出できます（`node extension/tests/run-all.cjs` にも含まれています）。
実名・勤務先などの語は、リポジトリ直下の `.audit-private-terms.txt`（`.gitignore` 済み）に1行1語で書くと一緒に探します。
