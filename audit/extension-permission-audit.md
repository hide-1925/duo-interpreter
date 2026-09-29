# Chrome / Edge 拡張の権限の監査

対象: `extension/manifest.json`（1.4.50）。理由は `SECURITY.md` §5 に利用者向けに書いた。

## permissions

| 権限 | 使っている所 | 判断 |
|---|---|---|
| `activeTab` | ポップアップで押したタブへの字幕レイヤー | 必要 |
| `scripting` | 字幕レイヤー・HTML本体との接続スクリプトの差し込み（`service-worker.js`・`html-host.js`・`html-tab-audio.js`） | 必要 |
| `storage` | 対象タブ・HTML本体のURL・判断層の中継先 | 必要。APIキーは入れていない |
| `tabCapture` | HTML本体のタブの音声（`html-tab-audio.js`・`service-worker.js`） | 必要 |
| `webNavigation` | 字幕を重ねるフレームの列挙（`overlay-frames.js`・`audio-bridge/controller.js`） | 必要 |

## host_permissions

| オリジン | 理由 | 判断 |
|---|---|---|
| 各社の API（OpenAI・xAI・Anthropic・Gemini・Groq・DeepSeek・OpenRouter・Mistral・Together・Google 翻訳・MyMemory・Aivis・ElevenLabs・tts.quest） | 拡張のページから API を呼ぶ | 必要。使わない会社のものも入っているが、呼ぶのは利用者が選んだものだけ |
| `streaming.assemblyai.com`・`api.soniox.com`（1.4.52 で追加） | ストリーミング認識の一時資格情報を拡張のページから作る（CORS に左右されない）。音声の WebSocket 自体は CSP の `connect-src wss://*` で足り、権限は要らない | 必要。呼ぶのは利用者が AssemblyAI／Soniox を選んだときだけ |
| `127.0.0.1` / `localhost`（http） | ローカルの読み上げエンジン | 必要 |
| `hide-1925.github.io` | 既定の HTML本体（Pages） | 必要 |
| Teams（3ドメイン） | 会議のマイク送出・話者の検出 | 必要 |

## optional_host_permissions: `https://*/*`（F-08）

| 確認 | 結果 |
|---|---|
| インストール時に付与されるか | されない（optional） |
| 要求は利用者の操作からか | はい。`popup.js` の click ハンドラから直接 `chrome.permissions.request`（`registerHtml`・`allowTurn`・`setTarget`・`conferenceMic`・`openHtml`） |
| 要求の範囲 | 押したタブ・登録したURL・許可した中継先の**オリジン単位**（`url.origin + '/*'`）。`https://*/*` そのものは要求しない |
| URL の検査 | `https:` のみ、`user:pass@` を含む URL は拒否 |
| 使う前の確認 | `chrome.permissions.contains` で確かめてから差し込む・中継する（`html-host.js`・`overlay-frames.js`・`turn-proxy.js`） |
| 取り消し | **拡張の中には無い**（`chrome.permissions.remove` を呼ぶ所が無い）。Chrome の「サイトへのアクセス」から取り消せる |

提案（未実装）: ポップアップに「許可したサイトの一覧と取り消し」を置く。機能の追加になるので今回は入れていない。

## content_scripts

| matches | world | 判断 |
|---|---|---|
| Teams の3ドメインだけ | MAIN（`mic-provenance.js`・`teams.js`・`audio-bridge/target.js`）と ISOLATED（`target-content.js`・`teams-speakers.js`） | 全サイトには入らない。`all_frames: true` は Teams のフレーム構成のため |

## CSP（extension_pages）

```
script-src 'self'; object-src 'self'; connect-src 'self' https://* wss://* http://127.0.0.1:* http://localhost:*; …
```

- `script-src 'self'` で外部スクリプト・インラインスクリプトは実行されない
- `connect-src https://* wss://*` は広いが、利用者が Base URL を指定できる独自の互換 API と Realtime（WebRTC の SDP 交換・WebSocket）のため。狭めると独自 API が使えなくなる。**理由を文書化して現状維持**

## 拡張のポップアップの「字幕操作ログ」（F-09）

中身は `extensionVersion`・`workerVersion`・`generatedAt`・`responseFields`（欄の名前だけ）・`conference`・`overlay`。
`overlay` には対象タブのフレームのオリジンと全画面の履歴が入る。会話の本文と APIキーは入らないことを `test-secret-guard` で固定した。
