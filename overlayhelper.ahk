#Requires AutoHotkey v2.0
#SingleInstance Force
;
;  Duo Interpreter 字幕オーバーレイ補助スクリプト（Windows用）
;  ------------------------------------------------------------------
;  ブラウザの窓そのものは透明にできないため、Windows側から
;  「最前面に固定 ＋ 半透明 ＋ クリックを下へ通す」を掛けるためのもの。
;
;  使い方
;   1. AutoHotkey v2 を入れて、このファイルをダブルクリック
;   2. Duo Interpreter のウィンドウを選んだ状態で Ctrl+Alt+T
;   3. Ctrl+Alt+↑ / ↓ で濃さを調整、もう一度 Ctrl+Alt+T で解除
;
;  ※ クリック透過中はそのウィンドウを操作できません（クリックが下の
;     アプリに通るため）。アプリ側の設定は先に済ませてから掛けてください。
;     解除はキー操作なので、操作できなくなっても Ctrl+Alt+T で戻せます。
;

global gWin := 0            ; 重ねモードを掛けているウィンドウ
global gAlpha := 200        ; 0(透明) 〜 255(不透明)

^!t:: ToggleOverlay()
^!Up:: AdjustAlpha(20)
^!Down:: AdjustAlpha(-20)

ToggleOverlay() {
    global gWin, gAlpha
    if gWin {
        try {
            WinSetExStyle("-0x20", gWin)        ; クリック透過を解除
            WinSetTransparent("Off", gWin)
            WinSetAlwaysOnTop(false, gWin)
        }
        gWin := 0
        Tip("重ねモード：解除")
        return
    }
    hwnd := WinExist("A")
    if !hwnd {
        Tip("対象のウィンドウが見つかりません")
        return
    }
    gWin := hwnd
    try {
        WinSetAlwaysOnTop(true, gWin)
        WinSetTransparent(gAlpha, gWin)
        WinSetExStyle("+0x20", gWin)            ; WS_EX_TRANSPARENT：クリックを下へ通す
    } catch as e {
        gWin := 0
        Tip("適用できませんでした：" e.Message)
        return
    }
    Tip("重ねモード：ON（濃さ " Round(gAlpha / 255 * 100) "%）`nCtrl+Alt+↑↓ で濃さ / Ctrl+Alt+T で解除")
}

AdjustAlpha(delta) {
    global gWin, gAlpha
    if !gWin {
        Tip("先に Ctrl+Alt+T で重ねモードにしてください")
        return
    }
    gAlpha := Max(40, Min(255, gAlpha + delta))   ; 薄くしすぎて見失わないよう下限を設ける
    try WinSetTransparent(gAlpha, gWin)
    Tip("濃さ " Round(gAlpha / 255 * 100) "%")
}

Tip(text) {
    ToolTip(text)
    SetTimer(() => ToolTip(), -1600)
}
