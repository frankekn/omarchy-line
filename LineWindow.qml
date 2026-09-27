import QtQuick
import Quickshell
import qs.Commons

// App window 模式的宿主：一個真正的 toplevel 視窗，Hyprland 當成一般應用程式管
// （照使用者的規則平鋪或浮動、alt-tab 切得到、有自己的焦點），class 是
// `org.quickshell`、title 是 `LINE`。
//
// 為什麼要有這一種：另外兩種擺法都是 WlrLayer.Overlay 的 LinePanel。那層永遠
// 蓋在所有視窗上面，所以 xdg-open 起來的檢視器只能先把面板關掉才看得到；
// 也不能平鋪、alt-tab 切不過去。這裡沒有那些限制。
//
// 這個檔案裡沒有任何 LINE 的東西：面板內容只存在一份，Panel.qml 把它掛到
// contentSlot 上。換模式是搬家，不是重畫一份 —— 重畫會把捲動位置、草稿、
// 開著的對話全部弄丟。
FloatingWindow {
  id: root

  // 誰在管開關。視窗自己的關閉鈕只動得了 visible，狀態還是要回去改。
  property var owner: null
  // owner 想不想看到這個視窗；visible 直接綁它。所以「visible 掉了但 wanted
  // 還是 true」就代表這一次是使用者（或合成器）關的，要回報 owner；owner 自己
  // 收起來的那次 wanted 已經是 false，不會再繞回去關第二遍。
  property bool wanted: false
  // 視窗映射完才有東西能接鍵盤事件，跟 LinePanel 的 focusTarget 同一條規則。
  property Item focusTarget: null

  readonly property alias contentSlot: slot

  // 尺寸安定下來才通知一次。拉一次邊框會丟出上百個 width/height 變更，
  // 每一個都寫回 shell.json 的話等於一直在存檔。
  signal sizeSettled(int w, int h)

  title: "LINE"
  color: Color.popups.background
  minimumSize: Qt.size(560, 480)
  visible: wanted

  onVisibleChanged: {
    if (visible) {
      // 跟 dev-gallery 一樣要 callLater：這一刻內容才剛掛進來，還沒鋪好，
      // 看不見的東西拿不到焦點。
      if (focusTarget) Qt.callLater(function() {
        if (root.visible && root.focusTarget) root.focusTarget.forceActiveFocus()
      })
    } else {
      sizeSettleTimer.stop()
      if (wanted && owner && "close" in owner) owner.close()
    }
  }

  // 隱藏時 width/height 還是會被 implicitWidth 的重算碰到，那不是使用者調的。
  onWidthChanged: if (visible) sizeSettleTimer.restart()
  onHeightChanged: if (visible) sizeSettleTimer.restart()

  Timer {
    id: sizeSettleTimer
    interval: 800
    onTriggered: if (root.visible) root.sizeSettled(Math.round(root.width), Math.round(root.height))
  }

  Item {
    id: slot
    anchors.fill: parent
    // 卡片模式的留白來自 BorderSurface 的 padding；視窗沒有卡片，自己留。
    anchors.margins: Style.spacing.popupPadding
  }
}
