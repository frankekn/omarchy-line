// The list pane's tool row (placement, A−/A+, scroll, read, sync, log out)
// must stay inside the pane at the default plugin text scale, in both
// languages, at every placement. The shipped row is right-anchored, so when
// its natural width exceeds the pane it hangs out of the left edge and the
// pane clips it: with the shell at base-size 16 the en row read
// "croll 2× Read 100 Sync Log out" in the two-pane window.
//
// The row is now a Flow that takes the pane's width once the tools stack, so
// an over-wide row wraps onto a second line instead of leaving the pane.
//
// The shape below is a copy of Panel.qml's scaleRow with the shell-only bits
// (Style/Color/MouseArea/Accessible) stripped; the labels come from the real
// Strings.js. Pane widths are the panel's own formulas evaluated by hand:
//   font px   = round(base * 0.917)                 (Style.font.bodySmall)
//   space(n)  = round(n * base / 12)                (Style.space)
//   two-pane  = min(space(300), (1040 - 2*space(14) - space(24) - 1) * 0.35)
//               (listPaneWidth at the default 1040px window)
//   one-pane  = space(420) - 2*space(14)            (LinePanel contentWidth)
//
//   QT_QPA_PLATFORM=offscreen qmltestrunner -input tst_toolbar_fit.qml
import QtQuick 2.15
import QtTest 1.15
import "../../../Strings.js" as Strings

Item {
  id: harness
  width: 600; height: 300
  visible: true

  property string lang: "en"
  property string placement: "app"
  property int base: 16

  readonly property int fontPx: Math.round(base * 0.917)
  function space(n) { return Math.max(1, Math.round(n * base / 12)) }
  function tr(key) { return Strings.t(key, lang) }
  function fmt(key, a) { return Strings.fmt(key, lang, a) }

  readonly property bool twoPane: placement !== "bar"
  readonly property int paneWidth: twoPane
    ? Math.round(Math.min(space(300), (1040 - 2 * space(14) - space(24) - 1) * 0.35))
    : space(420) - 2 * space(14)

  Item {
    id: listPane
    width: harness.paneWidth
    height: 200
    clip: true

    // toolsStacked(): the search box moves above the row once the pane is
    // narrower than the row plus space(160).
    readonly property bool stackedTools: width < scaleRow.naturalWidth + harness.space(160)

    Flow {
      id: scaleRow
      readonly property real naturalWidth: {
        var w = 0, n = 0
        for (var i = 0; i < children.length; i++) {
          var c = children[i]
          if (!c.visible || c.implicitWidth === 0) continue
          w += c.implicitWidth
          n++
        }
        return w + spacing * Math.max(0, n - 1)
      }
      x: listPane.stackedTools ? 0 : parent.width - width
      width: listPane.stackedTools ? parent.width : naturalWidth
      y: 40
      spacing: harness.space(8)

      Text {
        text: harness.tr("place." + harness.placement)
        font.family: "monospace"; font.pixelSize: harness.fontPx
      }
      Repeater {
        model: [{ label: "A−" }, { label: "A+" }]
        Text {
          required property var modelData
          text: modelData.label
          font.family: "monospace"; font.pixelSize: harness.fontPx
        }
      }
      Text {
        text: harness.fmt("label.scroll", "2×")
        font.family: "monospace"; font.pixelSize: harness.fontPx
      }
      Text {
        text: harness.fmt("label.history", "100")
        font.family: "monospace"; font.pixelSize: harness.fontPx
      }
      Text {
        text: harness.tr("sync")
        font.family: "monospace"; font.pixelSize: harness.fontPx
      }
      Text {
        text: harness.tr("logout")
        font.family: "monospace"; font.pixelSize: harness.fontPx
      }
    }
  }

  TestCase {
    name: "toolbarFit"
    when: windowShown

    function overflow() {
      var worst = 0
      for (var i = 0; i < scaleRow.children.length; i++) {
        var c = scaleRow.children[i]
        if (!c.visible || c.width === 0) continue
        var p = scaleRow.mapToItem(listPane, c.x, c.y)
        worst = Math.max(worst, -p.x, p.x + c.width - listPane.width)
      }
      return worst
    }

    function test_fits_data() {
      var rows = []
      var langs = ["en", "zh"], places = ["app", "center", "bar"], bases = [12, 16]
      for (var l = 0; l < langs.length; l++)
        for (var p = 0; p < places.length; p++)
          for (var b = 0; b < bases.length; b++)
            rows.push({ tag: langs[l] + "/" + places[p] + "/base" + bases[b],
                        lang: langs[l], placement: places[p], base: bases[b] })
      return rows
    }

    function test_fits(d) {
      harness.lang = d.lang
      harness.placement = d.placement
      harness.base = d.base
      waitForRendering(listPane)
      var over = overflow()
      verify(over <= 0,
             d.tag + ": row natural width " + scaleRow.implicitWidth
             + " in a " + listPane.width + "px pane overflows by " + over + "px")
      for (var i = 0; i < scaleRow.children.length; i++) {
        var c = scaleRow.children[i]
        if (c.visible && c.width > 0)
          verify(c.font.pixelSize === harness.fontPx, d.tag + ": no shrunken text")
      }
    }
  }
}
