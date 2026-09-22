<#
  Jev（TypeSafe System One）への疎通を Windows から確定させる。

  なぜ要るか。
  ブラウザは CORS・DNS・遮断のどれで失敗しても TypeError: Failed to fetch
  しか投げず、status を付けない。つまり「404 なのか、鍵が違うのか、そもそも
  ブラウザから呼べないのか」をブラウザ側から区別する手段が無い。
  区別するには非ブラウザから同じ URL を叩くしかない。それがこのスクリプト。

  使い方（PowerShell）:
    cd <このフォルダ>
    Set-ExecutionPolicy -Scope Process Bypass -Force   # この窓の中だけ許可する
    .\probe-jev.ps1

  Windows の既定では署名の無い .ps1 は実行できない。上の1行はこの PowerShell の
  窓を閉じるまでしか効かないので、PC の設定は変わらない。
  窓を開くのも面倒なら、これ1行でも同じ:
    powershell -ExecutionPolicy Bypass -File .\probe-jev.ps1

  キーは伏せ字で聞く。画面にも履歴にもファイルにも残さない。

  注意: PowerShell の `curl` は Invoke-WebRequest の別名で、-H も ^ も通らない。
  ここで使うのは実物の `curl.exe`。Windows 10 1803 以降なら標準で入っている。
  Windows PowerShell 5.1 と PowerShell 7 の両方で動く書き方だけを使っている。
#>
param(
  [string]$Key,
  [string]$Base   = 'https://api.typesafe.ai',
  [string]$Route  = '/v1/systemone',
  # Duo の HTML を置いている場所。preflight の判定はこのオリジンに対して行われる。
  [string]$Origin = 'https://hide-1925.github.io'
)

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Host 'curl.exe が見つかりません。' -ForegroundColor Red
  exit 1
}

function Fallback($value, $alt) {
  if ($value) { return $value }
  return $alt
}

function Get-HeaderValue($lines, [string]$name) {
  $rx = '^(?i)' + [regex]::Escape($name) + ':\s*(.*)$'
  foreach ($l in $lines) {
    if ($l -match $rx) { return $Matches[1].Trim() }
  }
  return $null
}

# curl の出力をストリーム混在で読むと 5.1 で ErrorRecord が混ざって壊れる。
# ヘッダ・本文・stderr をそれぞれファイルへ落とし、状態は -w で数値だけ受ける。
function Invoke-Curl {
  param([string[]]$CurlArgs)
  $hf = [System.IO.Path]::GetTempFileName()
  $bf = [System.IO.Path]::GetTempFileName()
  $ef = [System.IO.Path]::GetTempFileName()
  try {
    $out = & curl.exe -s -m 60 -D $hf -o $bf --stderr $ef -w '%{http_code}' @CurlArgs
    $exit = $LASTEXITCODE
    $codeStr = (($out | Out-String)).Trim()
    $status = 0
    if ($codeStr -match '^\d+$') { $status = [int]$codeStr }
    $headers = @()
    if ((Test-Path $hf) -and (Get-Item $hf).Length -gt 0) {
      $headers = @(Get-Content -Path $hf -ErrorAction SilentlyContinue)
    }
    $body = ''
    if ((Test-Path $bf) -and (Get-Item $bf).Length -gt 0) {
      $body = [string](Get-Content -Path $bf -Raw -ErrorAction SilentlyContinue)
    }
    $err = ''
    if ((Test-Path $ef) -and (Get-Item $ef).Length -gt 0) {
      $err = [string](Get-Content -Path $ef -Raw -ErrorAction SilentlyContinue)
    }
    return New-Object psobject -Property @{
      Status = $status; Exit = $exit; Headers = $headers; Body = $body; Err = $err.Trim()
    }
  } finally {
    Remove-Item $hf, $bf, $ef -Force -ErrorAction SilentlyContinue
  }
}

if (-not $Key) {
  $sec = Read-Host -Prompt 'TypeSafe の API キー（入力は表示されません）' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $Key) { Write-Host 'キーが空です。' -ForegroundColor Red; exit 1 }

$url = $Base.TrimEnd('/') + $Route
$bodyFile = Join-Path $PSScriptRoot 'probe-jev-body.json'
if (-not (Test-Path $bodyFile)) {
  Write-Host ('本文ファイルがありません: ' + $bodyFile) -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host ('対象     : ' + $url)
Write-Host ('オリジン : ' + $Origin)
Write-Host ('キー     : ' + $Key.Length + ' 文字（内容は出しません）')

Write-Host ''
Write-Host '-- 1. preflight (OPTIONS) --------------------------------'
$pre = Invoke-Curl @('-X', 'OPTIONS', $url,
  '-H', ('Origin: ' + $Origin),
  '-H', 'Access-Control-Request-Method: POST',
  '-H', 'Access-Control-Request-Headers: authorization,content-type')
Write-Host ('  HTTP                         : ' + (Fallback $pre.Status '応答なし'))
Write-Host ('  Access-Control-Allow-Origin  : ' + (Fallback (Get-HeaderValue $pre.Headers 'Access-Control-Allow-Origin')  '（無し）'))
Write-Host ('  Access-Control-Allow-Headers : ' + (Fallback (Get-HeaderValue $pre.Headers 'Access-Control-Allow-Headers') '（無し）'))
Write-Host ('  Access-Control-Allow-Methods : ' + (Fallback (Get-HeaderValue $pre.Headers 'Access-Control-Allow-Methods') '（無し）'))
if ($pre.Err) { Write-Host ('  curl: ' + $pre.Err) }

Write-Host ''
Write-Host '-- 2. 本リクエスト (POST) -------------------------------'
# キーをコマンド行に置くと同じ PC の他プロセスから見える（タスクマネージャの
# コマンド行列、ps）。curl の設定ファイル経由で渡し、終わったら必ず消す。
$cfg = Join-Path $env:TEMP ('jev-probe-' + [guid]::NewGuid().ToString('N') + '.cfg')
try {
  Set-Content -Path $cfg -Value ('header = "Authorization: Bearer {0}"' -f $Key) -Encoding ascii
  $post = Invoke-Curl @('-X', 'POST', $url, '-K', $cfg,
    '-H', 'Content-Type: application/json',
    '-H', ('Origin: ' + $Origin),
    '--data-binary', ('@' + $bodyFile))
} finally {
  Remove-Item $cfg -Force -ErrorAction SilentlyContinue
}
$postOrigin = Get-HeaderValue $post.Headers 'Access-Control-Allow-Origin'
Write-Host ('  HTTP                        : ' + (Fallback $post.Status '応答なし'))
Write-Host ('  Access-Control-Allow-Origin : ' + (Fallback $postOrigin '（無し）'))
if ($post.Err) { Write-Host ('  curl: ' + $post.Err) }
if ($post.Body) {
  $cut = $post.Body
  if ($cut.Length -gt 800) { $cut = $cut.Substring(0, 800) + ' …（以下省略）' }
  Write-Host '  応答本文:'
  Write-Host ('    ' + $cut.Replace("`r", '').Replace("`n", "`n    "))
}

Write-Host ''
Write-Host '-- 判定 -------------------------------------------------'
if ($post.Status -eq 0) {
  Write-Host '  サーバまで届いていません。DNS・ファイアウォール・TLS のいずれか。' -ForegroundColor Red
  Write-Host '  この PC からそもそも到達できないので、ブラウザ側の設定では直りません。'
} elseif (($post.Status -eq 401) -or ($post.Status -eq 403)) {
  Write-Host '  サーバまで届いています。キーが通っていません。' -ForegroundColor Yellow
  Write-Host '  → キーの発行先・有効期限・前後の空白を確認してください。'
} elseif ($post.Status -eq 404) {
  Write-Host '  サーバまで届いていますが、この経路が存在しません。' -ForegroundColor Yellow
  Write-Host ('  → Base URL か経路（' + $Route + '）が違います。')
} elseif ($post.Status -ge 400) {
  Write-Host ('  サーバまで届いています。HTTP ' + $post.Status + ' で拒否されました。') -ForegroundColor Yellow
  Write-Host '  → 上の応答本文が理由を書いています。'
} else {
  Write-Host '  API は動いています。' -ForegroundColor Green
  if ($postOrigin) {
    Write-Host '  ブラウザからも読めます。⚙→音声→判断層の「この経路へ疎通を試す」が通るはずです。' -ForegroundColor Green
  } else {
    Write-Host '  ただし CORS 応答ヘッダがありません。ブラウザからは結果を読めません。' -ForegroundColor Yellow
    Write-Host '  → ブラウザ直叩きは成立しません。Chrome 拡張を経由させる経路が必要です。'
    Write-Host '     （拡張は権限内のホストに対して CORS の制約を受けません）'
  }
}
Write-Host ''
