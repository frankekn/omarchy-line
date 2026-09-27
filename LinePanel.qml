import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// 這個外掛的面板視窗。兩種擺法，由設定裡的 Panel position 決定：
//   centered=false  卡片吊在 bar 按鈕正下方（跟其他 bar 面板一致）
//   centered=true   卡片放在螢幕正中央（像 emojis / clipboard 那種 overlay）
//
// 為什麼不直接用 Ui 的 KeyboardPanel：它只做得到前者。卡片位置來自它的
// `cardOrigin`，那是 readonly，外面改不掉；內建的 `centerOnBar` 只做水平置中，
// 垂直仍貼著 bar；想靠灌大 `gap` 把卡片推到中間也不行 —— `gap` 同時決定
// `_barStripSize`，也就是「這個點擊算不算落在 bar 上」的範圍，灌大會讓螢幕
// 上半部的點擊不再關閉面板。所以自己開一個鋪滿螢幕的 layer-shell 視窗，
// 位置自己算。API 與 KeyboardPanel 相同，面板內容不用改。
//
// ponytail: bar 模式的定位邏輯是照 KeyboardPanel 抄的。上游改了這裡不會跟著改，
// 但只有幾何運算，看得出來對不對。
PanelWindow {
  id: root

  required property Item anchorItem
  required property QtObject bar
  property var owner: null
  property bool centered: false
  property int margin: Style.gapsOut
  property int gap: Style.gapsOut          // bar 邊緣與面板之間的距離
  property int padding: Style.spacing.popupPadding
  property int contentWidth: Style.space(280)
  property int contentHeight: Style.space(200)
  property var borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
  property bool open: false

  // 視窗映射完才有東西能接鍵盤事件，跟 KeyboardPanel 一樣只在 open 時指派一次。
  property Item focusTarget: null
  property bool focusPrimed: false

  default property alias contentItem: contentHolder.children
  // 內容真正掛在哪一個 Item 上。App window 模式時面板內容會搬到 LineWindow，
  // 搬回來要有一個對外講得出來的落點 —— contentItem 是 children 的 alias，
  // 指不到容器本身。
  readonly property alias contentSlot: contentHolder

  readonly property var coordinatorKey: owner || root
  readonly property var anchorWindow: anchorItem ? anchorItem.QsWindow.window : null
  readonly property string barPos: bar ? bar.position : "top"
  readonly property real screenW: screen ? screen.width : 0
  readonly property real screenH: screen ? screen.height : 0
  readonly property real barW: anchorWindow ? anchorWindow.width : 0
  readonly property real barH: anchorWindow ? anchorWindow.height : 0
  readonly property bool barVertical: barPos === "left" || barPos === "right"
  readonly property real barStrip: bar
    ? Math.max(bar.barSize, barVertical ? barW : barH) + gap
    : 0

  function close() {
    if (owner && "close" in owner) owner.close()
    else root.open = false
  }

  // 跟 KeyboardPanel 同名同義，面板內容照原樣呼叫。置中時卡片兩邊都要留白，
  // 吊在 bar 下時只有 bar 那一側要扣。
  readonly property real availableCardWidth: Math.max(120, screenW -
    (barVertical ? (centered ? (barStrip + margin) * 2 : barStrip + margin) : margin * 2))
  readonly property real availableCardHeight: Math.max(120, screenH -
    (barVertical ? margin * 2 : (centered ? (barStrip + margin) * 2 : barStrip + margin)))
  readonly property real verticalContentInset:
    padding * 2 + Border.top(borderSpec) + Border.bottom(borderSpec)

  function fittedContentWidth(width, cap) {
    var desired = Math.max(1, Number(width) || 1)
    var maxWidth = availableCardWidth
    if (cap !== undefined && Number(cap) > 0) maxWidth = Math.min(maxWidth, Number(cap))
    return Math.round(Math.min(desired, maxWidth))
  }

  function fittedContentHeight(implicitHeight, cap) {
    var desired = Math.max(verticalContentInset, (Number(implicitHeight) || 0) + verticalContentInset)
    var maxHeight = availableCardHeight
    if (cap !== undefined && Number(cap) > 0) maxHeight = Math.min(maxHeight, Number(cap))
    return Math.round(Math.min(desired, maxHeight))
  }

  // bar 按鈕在畫面上的位置。mapToItem 是一次性的，靠 TransformWatcher 讓
  // 中間任何一層移動／改大小時這個綁定重算。
  TransformWatcher {
    id: anchorWatcher
    a: anchorWindow ? anchorWindow.contentItem : null
    b: anchorItem
  }

  readonly property point cardOrigin: {
    if (centered || !anchorItem || !bar || !anchorWindow)
      return Qt.point(Math.round((screenW - contentWidth) / 2),
                      Math.round((screenH - contentHeight) / 2))

    anchorWatcher.transform            // 這行是為了讓下面的 mapToItem 具反應性
    var pos = anchorItem.mapToItem(anchorWindow.contentItem, 0, 0)
    var x = 0, y = 0
    if (barPos === "bottom") {
      x = pos.x + anchorItem.width / 2 - contentWidth / 2
      y = screenH - barH - contentHeight - gap
    } else if (barPos === "left") {
      x = barW + gap
      y = pos.y + anchorItem.height / 2 - contentHeight / 2
    } else if (barPos === "right") {
      x = screenW - barW - contentWidth - gap
      y = pos.y + anchorItem.height / 2 - contentHeight / 2
    } else {                           // top
      x = pos.x + anchorItem.width / 2 - contentWidth / 2
      y = barH + gap
    }
    x = Math.max(margin, Math.min(x, screenW - contentWidth - margin))
    y = Math.max(margin, Math.min(y, screenH - contentHeight - margin))
    return Qt.point(Math.round(x), Math.round(y))
  }

  screen: anchorWindow ? anchorWindow.screen : null
  visible: open || card.opacity > 0
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  anchors { top: true; bottom: true; left: true; right: true }

  WlrLayershell.namespace: "omarchy-line-panel"
  WlrLayershell.layer: WlrLayer.Overlay
  // 先用 Exclusive 搶到焦點再退回 OnDemand。純 OnDemand 在「視窗還在淡出時
  // 又被叫開」那次拿不到焦點；純 Exclusive 則會讓 Hyprland 把所有指標事件都
  // 送給這個 surface，別的螢幕就點不到東西。理由同 KeyboardPanel。
  WlrLayershell.keyboardFocus: open
    ? (focusPrimed ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.Exclusive)
    : WlrKeyboardFocus.None

  // 輸入區塊避開 bar 那一條，點別的 bar 圖示才能一次就切過去
  // （否則第一下只是關掉這個面板）。
  mask: Region {
    x: root.barPos === "left" ? root.barStrip : 0
    y: root.barPos === "top" ? root.barStrip : 0
    width: root.barVertical ? root.screenW - root.barStrip : root.screenW
    height: root.barVertical ? root.screenH : root.screenH - root.barStrip
  }

  Timer {
    id: focusPrimeTimer
    interval: 75
    onTriggered: if (root.open) root.focusPrimed = true
  }

  onBackingWindowVisibleChanged: if (open && backingWindowVisible) focusPrimeTimer.restart()

  onOpenChanged: {
    if (open) {
      focusPrimed = false
      if (backingWindowVisible) focusPrimeTimer.restart()
      if (focusTarget) Qt.callLater(function() {
        if (root.open && root.focusTarget) root.focusTarget.forceActiveFocus()
      })
      if (bar) bar.requestPopout(coordinatorKey)
    } else {
      focusPrimeTimer.stop()
      focusPrimed = false
      if (bar) bar.releasePopout(coordinatorKey)
    }
  }

  // 點卡片外面關閉。淡出期間停用，免得將死的覆蓋層吞掉本來要給底下應用程式的點擊。
  MouseArea {
    anchors.fill: parent
    enabled: root.open
    acceptedButtons: Qt.AllButtons
    onPressed: root.close()
  }

  BorderSurface {
    id: card
    x: root.cardOrigin.x
    y: root.cardOrigin.y
    width: root.contentWidth
    height: root.contentHeight
    color: Color.popups.background
    borderSpec: root.borderSpec
    padding: root.padding
    radius: Style.cornerRadius
    opacity: root.open ? 1.0 : 0

    Behavior on opacity {
      NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
    }

    // 擋住冒泡，否則點卡片會被上面那個關閉用的 MouseArea 收走。
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.AllButtons
    }

    Item {
      id: contentHolder
      anchors.fill: parent
      anchors.topMargin: card.contentTopInset
      anchors.rightMargin: card.contentRightInset
      anchors.bottomMargin: card.contentBottomInset
      anchors.leftMargin: card.contentLeftInset
    }
  }
}
