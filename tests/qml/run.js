// Panel.qml behaviour harness. Node, zero dependencies, no daemon, no socket,
// no state dir: it slices the real function bodies out of Panel.qml on disk and
// drives them with stub objects.
//
//   node tests/qml/run.js
//
// Reading Panel.qml from disk (not `git show HEAD:Panel.qml`) is deliberate:
// the harness must fail on an uncommitted regression, not pass because the bad
// edit is not staged yet.
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PANEL = path.join(REPO, "Panel.qml");

const src = fs.readFileSync(PANEL, "utf8");
// EventLog.js is a real .pragma library the panel imports; the harness loads the
// real file so the sliced delegates exercise the same code that ships.
const EventLog = new Function(
  fs.readFileSync(path.join(REPO, "EventLog.js"), "utf8")
    .replace(/^\.pragma library\s*/, "") +
    "; return { eventsSince, withFields, mergeMessage, applyEdit, applyHistory," +
    " applyRead, applyReaction, applyUnsend, readText, reactionEmoji, myReaction," +
    " isSystemEvent, systemEventText, canActOn, oneLine, quoteText," +
    " withDay, dayStart, dayLabel, firstUnreadIndex, mergeFailedMessages," +
    " recordFailure, showAvatarAt };",
)();
// Strings.js is the same file the panel imports; zh is the historical wire
// language, so binding tr/trErr to "zh" keeps every old assertion verbatim-true.
const Strings = new Function(
  fs.readFileSync(path.join(REPO, "Strings.js"), "utf8") +
    "; return { STRINGS, normalizeLang, t, fmt, err };",
)();
const Tzh = (key, ...a) => Strings.fmt(key, "zh", ...a);
const Ezh = (x) => Strings.err(x, "zh");

const kitSrc = fs.readFileSync(path.join(REPO, "PanelKit.js"), "utf8");
const PanelKit = new Function(
  kitSrc.replace(/^\.pragma library\s*/, "") +
    "; return { placementMode, clampWindowSize, clampScroll, clampHistory," +
    " placementLabel, nextStep, scrollLabel, historyLabel, wheelDistance," +
    " wheelTargetY, chatRows, rowSubtitle, mediaUsable, mediaLabel," +
    " pictureList, zoomAt, clampPan, isDrag, outsidePicture, lightboxCaption," +
    " escapeAction, agoText, escapeHtml, linkify, markupBody, mentionRanges," +
    " bodyText, bodyHtml, linkTarget, mentionQuery, mentionRank," +
    " mentionMatches, mentionInsert, deriveMentions, isSendCmd," +
    " isMessageSendCmd, hasPendingBubble, nearOlderEdge, anchoredContentY," +
    " partialListNoticeText, linkNoticeText, listNoticeText," +
    " loginErrorDetail, avatarColor, avatarInitial, chatMenuItems," +
    " listPaneWidth, toolsStacked, stickerStill, stickerCells," +
    " stickerTabIndex, stickerPack, stickerPackName, stickerTabClamp," +
    " stickerTabScroll, stickerTabInView, storedRecent, stickerRequest," +
    " recentPush, stickerGridHeight, stickerStatusText, nextPlacement," +
    " chatById, accountsWithAmbiguous };",
)();

// Helpers take a trailing `tr` translator for visible strings. Old call sites
// in this harness (and the language-agnostic assertions below) exercise the zh
// default: append Tzh whenever a caller leaves `tr` off.
for (const [lib, names] of [
  [PanelKit, ["placementLabel", "rowSubtitle", "mediaLabel", "lightboxCaption",
    "agoText", "bodyText", "bodyHtml", "mentionMatches", "partialListNoticeText",
    "linkNoticeText", "listNoticeText", "loginErrorDetail", "chatMenuItems",
    "stickerPackName", "stickerStatusText"]],
  [EventLog, ["readText", "systemEventText", "quoteText", "dayLabel"]],
]) {
  for (const name of names) {
    const orig = lib[name];
    lib[name] = (...a) =>
      orig(...(a.length >= orig.length ? a : [...a, Tzh]));
  }
}

const lines = src.split("\n");

// Slice from the line after `<header>` to the line before its closing `  }`
// (functions in Panel.qml sit at two-space indent, so `  }` at column 0-2 ends one).
function body(header) {
  const start = lines.findIndex((l) => l.trimEnd() === header);
  if (start < 0) throw new Error("not found in " + PANEL + ": " + header);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "  }") return lines.slice(start + 1, i).join("\n");
  }
  throw new Error("unterminated: " + header);
}

// submit() is not a root function -- it lives inside the reply box at 14-space
// indent -- so it is sliced against its own closing brace instead.
function nested(header, closer) {
  const start = lines.findIndex((l) => l.trimEnd() === header);
  if (start < 0) throw new Error("not found in " + PANEL + ": " + header);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === closer) return lines.slice(start + 1, i).join("\n");
  }
  throw new Error("unterminated: " + header);
}

const B = {
  parseState: body("  function parseState(content) {"),
  replaceChatSnapshot: body("  function replaceChatSnapshot(incoming) {"),
  clearStateAfterLoadFailure: body("  function clearStateAfterLoadFailure() {"),
  request: body("  function request(cmd, extra, msgId) {"),
  onReply: body("  function onReply(line) {"),
  backToList: body("  function backToList() {"),
  // onOpenedChanged is a handler, not a function; slice its `else { ... }` branch
  // by taking the whole handler body and running it with `opened` in scope.
  onOpenedChanged: body("  onOpenedChanged: {"),
  rememberHistory: body("  function rememberHistory(mid, list) {"),
  clearSession: body("  function clearSession() {"),
  pendingDraftSend: body("  function pendingDraftSend(chat, draftVersion) {"),
  deferredDraftSend: body("  function deferredDraftSend(chat) {"),
  draftVersionInFlight: body(
    "  function draftVersionInFlight(chat, version, generation) {",
  ),
  flushDeferredDraftActions: body("  function flushDeferredDraftActions() {"),
  flushDeferredDraftPickers: body("  function flushDeferredDraftPickers() {"),
  rebindPickerDraft: body(
    "  function rebindPickerDraft(account, chat, generation, revision) {",
  ),
  handleDraftLoaded: body("  function handleDraftLoaded(content) {"),
  handleDraftLoadFailure: body("  function handleDraftLoadFailure(error) {"),
  loadDraftStore: body("  function loadDraftStore(content) {"),
  markDraftStoreUnavailable: body("  function markDraftStoreUnavailable() {"),
  stageExhaustedComposer: body("  function stageExhaustedComposer() {"),
  writeDraftStore: body("  function writeDraftStore(next) {"),
  confirmDraftSaved: body("  function confirmDraftSaved(content) {"),
  accountsWithAmbiguous: body(
    "  function accountsWithAmbiguous(accounts, account, byChat, changedChats, removedByChat, clearAll) {",
  ),
  persistAmbiguousSends: body(
    "  function persistAmbiguousSends(account, byChat, changedChats, clearAll, removedByChat) {",
  ),
  restoreAmbiguousSends: body("  function restoreAmbiguousSends(account) {"),
  resetComposerAfterSuccessfulSend: body(
    "  function resetComposerAfterSuccessfulSend() {",
  ),
  restorePendingComposer: body(
    "  function restorePendingComposer(chat, draft, version) {",
  ),
  composerGenerationFor: body("  function composerGenerationFor(chat) {"),
  draftRecoveryHeld: body(
    "  function draftRecoveryHeld(chat, version, generation, composerGeneration) {",
  ),
  saveActiveDraft: body("  function saveActiveDraft(removeEmpty) {"),
  restoreDraft: body("  function restoreDraft(chat) {"),
  clearDraftAccount: body("  function clearDraftAccount(account) {"),
  scheduleDraftSave: body("  function scheduleDraftSave() {"),
  pruneDraftAccountsExcept: body(
    "  function pruneDraftAccountsExcept(keepAccount) {",
  ),
  clearAllDrafts: body("  function clearAllDrafts() {"),
  clearDraft: body(
    "  function clearDraft(chat, expectedVersion, expectedGeneration, expectedGenerationOwner) {",
  ),
  openChat: body("  function openChat(chat) {"),
  loadOlder: body("  function loadOlder() {"),
  openMedia: body("  function openMedia(id, intent) {"),
  markOpen: body("  function markOpen(id, intent) {"),
  dropInFlight: body("  function dropInFlight() {"),
  reconcileAfterConnect: body("  function reconcileAfterConnect() {"),
  settleConfirmedSends: body(
    "  function settleConfirmedSends(chat, confirmed) {",
  ),
  reconcileAmbiguous: body(
    "  function reconcileAmbiguous(chat, list, completedHistoryGeneration) {",
  ),
  preserveAmbiguousBubbles: body(
    "  function preserveAmbiguousBubbles(chat, list) {",
  ),
  fetchPreview: body("  function fetchPreview(m, invalidate) {"),
  retryPreview: body("  function retryPreview(id, automatic) {"),
  retainImage: body("  function retainImage(url) {"),
  releaseImage: body("  function releaseImage(url) {"),
  scheduleImageRetry: body("  function scheduleImageRetry(url, invalidate) {"),
  schedulePreviewRetry: body(
    "  function schedulePreviewRetry(id, invalidate, chat) {",
  ),
  finishPreviewRetry: body("  function finishPreviewRetry(id) {"),
  finishPreviewDecode: body("  function finishPreviewDecode(id) {"),
  forgetOpen: body("  function forgetOpen(id) {"),
  syncNow: body("  function syncNow() {"),
  clockText: body("  function clockText(ms) {"),
  // Lightbox: the picture strip, the zoom math, and the two routing decisions
  // (where Esc goes, where a finished download goes) are all root-level so the
  // harness can drive them without a scene graph.
  pictureList: body("  function pictureList(messages) {"),
  zoomAt: body("  function zoomAt(scale, panX, panY, cx, cy, factor) {"),
  clampPan: body(
    "  function clampPan(x, y, scale, paintedW, paintedH, stageW, stageH) {",
  ),
  isDrag: body("  function isDrag(dx, dy) {"),
  outsidePicture: body(
    "  function outsidePicture(mx, my, stageW, stageH, panX, panY, scale, paintedW, paintedH) {",
  ),
  lightboxCaption: body("  function lightboxCaption() {"),
  mediaLabel: body("  function mediaLabel(m) {"),
  mediaUsable: body("  function mediaUsable(m) {"),
  openPicture: body("  function openPicture(id, source, name, index) {"),
  showPicture: body("  function showPicture(id, source, name) {"),
  stepPicture: body("  function stepPicture(dx) {"),
  closeLightbox: body("  function closeLightbox() {"),
  escapeAction: body("  function escapeAction() {"),
  deliverMedia: body("  function deliverMedia(id, path, intent) {"),
  openExternally: body("  function openExternally() {"),
  // Placement: which of the three modes a settings string means, what the
  // button cycles to next, and the App window's remembered size.
  placementMode: body("  function placementMode(value) {"),
  nextPlacement: body("  function nextPlacement(mode) {"),
  placementLabel: body("  function placementLabel(mode) {"),
  clampWindowSize: body("  function clampWindowSize(value, fallback, min) {"),
  togglePlacement: body("  function togglePlacement() {"),
  saveWindowSize: body("  function saveWindowSize(w, h) {"),
  pickerComposerStillOwned: body(
    "  function pickerComposerStillOwned(chat, version, generation) {",
  ),
  // U64: how far one wheel notch goes. Flickable has no such setting, so the
  // three scrolling views compute contentY themselves through these -- all root
  // functions, so the harness drives them against a stub view with no scene.
  clampScroll: body("  function clampScroll(value) {"),
  wheelDistance: body("  function wheelDistance(angleDeltaY, pixelDeltaY) {"),
  wheelScroll: body("  function wheelScroll(view, angleDeltaY, pixelDeltaY) {"),
  nextScroll: body("  function nextScroll(percent) {"),
  scrollLabel: body("  function scrollLabel(percent) {"),
  stepScrollSpeed: body("  function stepScrollSpeed() {"),
  // U69: how many messages a page is, and how early the next one is asked for.
  // loadHistory is sliced rather than stubbed now that it carries the setting:
  // a copy here would pass while the panel opened chats on a different number
  // from the one it pages back with.
  clampHistory: body("  function clampHistory(value) {"),
  nextHistory: body("  function nextHistory(count) {"),
  historyLabel: body("  function historyLabel(count) {"),
  stepHistoryPage: body("  function stepHistoryPage() {"),
  nearOlderEdge: body(
    "  function nearOlderEdge(contentY, originY, contentHeight, height) {",
  ),
  anchoredContentY: body(
    "  function anchoredContentY(afterY, originY, keep, contentHeight, height) {",
  ),
  loadHistory: body("  function loadHistory(mid, markRead) {"),
  // The prefetch trigger itself, sliced against its own closing brace like
  // submit(). contentY/originY/contentHeight/height are the ListView's own
  // properties, so it is driven under `with (msgList)` -- the way QML resolves
  // them -- rather than by rewriting the sliced source.
  onContentYChanged: nested("          onContentYChanged: {", "          }"),
  // U42: the message body is markup now, so the escaping, the link wrapping and
  // the two ways out of a bubble (xdg-open, wl-copy) are all root-level.
  bodyText: body("  function bodyText(m) {"),
  escapeHtml: body("  function escapeHtml(t) {"),
  linkify: body("  function linkify(text, linkColor) {"),
  bodyHtml: body("  function bodyHtml(m) {"),
  linkTarget: body("  function linkTarget(url) {"),
  openLink: body("  function openLink(url) {"),
  copyText: body("  function copyText(text) {"),
  flushCopy: body("  function flushCopy() {"),
  messageMenuItems: body("  function messageMenuItems(link, m) {"),
  runMenuAction: body("  function runMenuAction(action) {"),
  dropBodyFocus: body("  function dropBodyFocus() {"),
  // U45: the @ picker. Everything the picker decides is a pure root function
  // -- which rows match, what an insertion does to the text and the caret,
  // and which of the recorded picks are still in the text when Enter is hit.
  mentionRank: body("  function mentionRank(names, q) {"),
  mentionQuery: body("  function mentionQuery(text, cursor) {"),
  mentionMatches: body("  function mentionMatches(members, query) {"),
  mentionInsert: body("  function mentionInsert(text, cursor, row) {"),
  deriveMentions: body("  function deriveMentions(text, picks) {"),
  moveMention: body("  function moveMention(step) {"),
  takeMention: body("  function takeMention(index) {"),
  dismissMention: body("  function dismissMention() {"),
  loadMembers: body("  function loadMembers(mid) {"),
  markupBody: body("  function markupBody(text, spans, color) {"),
  mentionRanges: body("  function mentionRanges(mentions, len) {"),
  // Pure status-text functions: no socket, no env, just root properties.
  // U48: the message pane is a ListView now, so where the view stops after a
  // model swap is decided by root functions the harness can drive, and the two
  // separators (date, unread) come from pure functions.
  setMessages: body("  function setMessages(list, follow) {"),
  clearSwap: body("  function clearSwap() {"),
  withDay: body("  function withDay(list) {"),
  firstUnreadIndex: body("  function firstUnreadIndex(messages, unread) {"),
  dayStart: body("  function dayStart(ms) {"),
  dayLabel: body("  function dayLabel(ms, nowMs) {"),
  isSystemEvent: body("  function isSystemEvent(m) {"),
  agoText: body("  function agoText(ms) {"),
  linkNoticeText: body("  function linkNoticeText() {"),
  // U49: the panel eats the daemon's event ring instead of refetching a page of
  // history per message. Everything an event does to the list is a pure function
  // over that list, so the harness applies them to a fixture and looks at what
  // came back -- the ListView never has to exist.
  eventsSince: body(
    "  function eventsSince(events, bootId, seenBootId, seenSeq) {",
  ),
  applyEvents: body("  function applyEvents(list) {"),
  onPushedEvent: body("  function onPushedEvent(res) {"),
  consumeEventsFile: body("  function consumeEventsFile(evState) {"),
  parseEventsText: body("  function parseEventsText(content) {"),
  finishEventsSync: body("  function finishEventsSync() {"),
  applyChatPatch: body(
    "  function applyChatPatch(row, revision, boot) {",
  ),
  withFields: body("  function withFields(m, patch) {"),
  rememberFailedMessage: body(
    "  function rememberFailedMessage(chat, message) {",
  ),
  mergeFailedMessages: body("  function mergeFailedMessages(chat, list) {"),
  mergeMessage: body("  function mergeMessage(list, m) {"),
  applyRead: body("  function applyRead(list, upTo, by) {"),
  applyReaction: body("  function applyReaction(list, id, rows) {"),
  applyUnsend: body("  function applyUnsend(list, id) {"),
  applyEdit: body("  function applyEdit(list, m) {"),
  applyHistory: body("  function applyHistory(list, fresh) {"),
  readText: body("  function readText(m) {"),
  reactionEmoji: body("  function reactionEmoji(type) {"),
  myReaction: body("  function myReaction(m) {"),
  canActOn: body("  function canActOn(m) {"),
  toggleReaction: body("  function toggleReaction(m, type) {"),
  unsendMessage: body("  function unsendMessage(m) {"),
  startReply: body("  function startReply(m) {"),
  quoteText: body("  function quoteText(r) {"),
  scrollToMessage: body("  function scrollToMessage(id) {"),
  isSendCmd: body("  function isSendCmd(cmd) {"),
  isMessageSendCmd: body("  function isMessageSendCmd(cmd) {"),
  appendPending: body("  function appendPending(body, mentions, replyTo) {"),
  oneLine: body("  function oneLine(t) {"),
  // The reply box's own send path: which command a draft becomes.
  submit: nested("              function submit() {", "              }"),
  listNoticeText: body("  function listNoticeText() {"),
  loginErrorDetail: body("  function loginErrorDetail() {"),
  partialListNoticeText: body("  function partialListNoticeText() {"),
  // U53: the two list-pane layout rules are root functions, so the numbers can
  // be checked here instead of by squinting at a screenshot.
  listPaneWidth: body("  function listPaneWidth(parentWidth, fontScale) {"),
  toolsStacked: body("  function toolsStacked(paneWidth, toolsWidth) {"),
  // U51: what a face looks like when there is no picture, and which message in
  // a run wears one, are pure functions; so is the notification hand-off, which
  // is the only thing that decides whether a click on a notification lands.
  // U54: the sticker picker. Everything it decides -- which cells a package
  // has, which picture a cell draws, what a click puts on the wire, what the
  // recently-used row remembers, and when the picker is open -- is a root
  // function, so the grid never has to exist for the harness to drive it.
  stickerStill: body("  function stickerStill(url) {"),
  stickerCells: body("  function stickerCells(pack) {"),
  stickerTabIndex: body("  function stickerTabIndex(id) {"),
  stickerPack: body("  function stickerPack(id) {"),
  stickerPackName: body("  function stickerPackName(pack) {"),
  // U63: the package row is a horizontal Flickable, so where it is scrolled to
  // is a number the panel computes -- wheel, arrow button, keyboard and "show
  // the selected package" all go through these, and none of them needs a scene.
  stickerTabClamp: body(
    "  function stickerTabClamp(x, viewWidth, contentWidth) {",
  ),
  stickerTabScroll: body(
    "  function stickerTabScroll(contentX, angleY, pixelY, step, viewWidth, contentWidth) {",
  ),
  stickerTabInView: body(
    "  function stickerTabInView(contentX, itemX, itemWidth, viewWidth, contentWidth) {",
  ),
  stepStickerTab: body("  function stepStickerTab(dx) {"),
  recentPush: body("  function recentPush(list, item, max) {"),
  storedRecent: body("  function storedRecent(store, mid) {"),
  loadStickerStore: body("  function loadStickerStore(content) {"),
  stickerRequest: body("  function stickerRequest(chat, sticker) {"),
  stickerStatusText: body("  function stickerStatusText() {"),
  stickerGridHeight: body(
    "  function stickerGridHeight(count, width, cell, maxRows) {",
  ),
  setStickerOpen: body("  function setStickerOpen(on) {"),
  toggleSticker: body("  function toggleSticker() {"),
  loadStickers: body("  function loadStickers(refresh) {"),
  sendSticker: body("  function sendSticker(cell) {"),
  rememberSticker: body("  function rememberSticker(item) {"),
  pendingBubble: body("  function pendingBubble(fields) {"),
  appendPendingSticker: body("  function appendPendingSticker(url) {"),
  hasPendingBubble: body("  function hasPendingBubble(cmd) {"),
  avatarColor: body("  function avatarColor(mid) {"),
  avatarInitial: body("  function avatarInitial(text) {"),
  showAvatarAt: body("  function showAvatarAt(list, i) {"),
  takeWanted: body("  function takeWanted() {"),
  // U59: Ctrl+V. The panel cannot read the Wayland clipboard, so what the key
  // does is decided in two halves -- one frame out, one answer back -- and both
  // halves are root functions the harness can drive.
  pasteClipboard: body("  function pasteClipboard() {"),
  clipboardBusy: body("  function clipboardBusy() {"),
  // U66: 隱藏聊天. All pure but clampSelection(), which reads the model it is
  // clamping against off root.
  chatRows: body("  function chatRows(all, query, up) {"),
  rowSubtitle: body("  function rowSubtitle(c) {"),
  clampSelection: body("  function clampSelection() {"),
  chatMenuItems: body("  function chatMenuItems(c) {"),
  menuItems: body("  function menuItems() {"),
  setChatHidden: body("  function setChatHidden(c, hide) {"),
  chatHidden: body("  function chatHidden(mid) {"),
  hiddenSinceOpened: body("  function hiddenSinceOpened(chat, openedHidden) {"),
  openChat: body("  function openChat(chat) {"),
  openChatMenu: body("  function openChatMenu(item, x, y, c) {"),
  openMessageMenu: body("  function openMessageMenu(item, x, y, m) {"),
};

// The three status-text functions above need none of makeEnv's machinery -- a
// bare root with the properties they read is the whole world they see.
// Read straight out of Panel.qml: a harness that kept its own copy of the six
// names would happily pass while the panel shipped five.
const REACTION_TYPES = JSON.parse(
  /readonly property var reactionTypes: (\[[^\]]*\])/.exec(src)[1].replace(
    /'/g,
    '"',
  ),
);

// U64: the wheel-speed steps the button cycles, read out of Panel.qml for the
// same reason -- a copy here would pass while the button walked another list.
const SCROLL_STEPS = JSON.parse(
  /readonly property var scrollSteps: (\[[^\]]*\])/.exec(src)[1],
);

// U69: the page sizes the 讀取 button cycles, read out of Panel.qml for the
// same reason as SCROLL_STEPS above.
const HISTORY_STEPS = JSON.parse(
  /readonly property var historySteps: (\[[^\]]*\])/.exec(src)[1],
);

// U59: the daemon's sentence for "the clipboard holds no picture" is the one
// refusal the panel turns into an ordinary paste, so it is a contract, not a
// message. Read out of Panel.qml for the same reason as the six reaction types
// -- a harness holding its own copy would pass while the panel compared against
// something the daemon never says. It is pinned against both daemons below.
const CLIPBOARD_EMPTY =
  /readonly property string clipboardEmpty: "([^"]*)"/.exec(src)[1];

function makeStatusRoot(opts) {
  opts = opts || {};
  const root = {
    nowMs: opts.nowMs === undefined ? 1700000000000 : opts.nowMs,
    state: opts.state === undefined ? null : opts.state,
    online: opts.online === undefined ? true : opts.online,
    notice: opts.notice === undefined ? "" : opts.notice,
    twoPane: !!opts.twoPane,
    search: opts.search || "",
    chats: opts.state && Array.isArray(opts.state.chats)
      ? opts.state.chats
      : [],
  };
  root.loginInfo = root.state && root.state.login ? root.state.login : null;
  // agoText() reads a bare `nowMs` (QML resolves it on root), so it is passed
  // as a parameter rather than rewriting the sliced body.
  const ago = (ms) =>
    new Function("root", "PanelKit", "ms", "tr", B.agoText)(root, PanelKit, ms, Tzh);
  const notice = new Function("root", "PanelKit", "tr", B.linkNoticeText);
  const partial = new Function("root", "PanelKit", "tr", B.partialListNoticeText);
  const detail = new Function("root", "PanelKit", "tr", "trErr", B.loginErrorDetail);
  const listNotice = new Function("root", "PanelKit", "tr", B.listNoticeText);
  root.agoText = (ms) => ago(ms);
  root.partialListNoticeText = () => partial(root, PanelKit, Tzh);
  root.linkNoticeText = () => notice(root, PanelKit, Tzh);
  root.listNoticeText = () => listNotice(root, PanelKit, Tzh);
  root.loginErrorDetail = () => detail(root, PanelKit, Tzh, Ezh);
  return root;
}

const ARGS = [
  "root",
  "sock",
  "replyField",
  "searchField",
  "listFlick",
  "msgList",
  "Qt",
  "console",
  "backToList",
  "opened",
  "clearSession",
  // loadOlder() calls the bare `request(...)` that QML resolves on root
  "request",
  // the lightbox grabs/returns focus through the key catcher, and hands
  // finished downloads to Quickshell.execDetached (the old `opener`
  // Process could only ever run one viewer at a time)
  "keyCatcher",
  "Quickshell",
  // the two settings written straight back to shell.json: the
  // placement enum and the App window's remembered size
  "settingWriter",
  "sizeWriter",
  // U42: wl-copy's stdin, the right-click menu, and the theme
  // colour the link markup carries (TextEdit has no linkColor)
  "clipWriter",
  "msgMenu",
  "Color",
  // U48: setMessages() measures the viewport in Style.space() units
  "Style",
  // U49: scrollToMessage() asks the view to centre a row
  "ListView",
  // U54: the recently-used stickers are persisted through a FileView
  "stickerFile",
  "draftFile",
  "DraftStore",
  "DraftWriter",
  "EventLog",
  "PanelKit",
  // sliced bodies translate UI text through these two (zh-bound here)
  "tr",
  "trErr",
];

function makeEnv(opts) {
  opts = opts || {};
  const sent = []; // JSON strings written to the socket
  const historyCalls = [];
  const sock = {
    connected: opts.connected !== false,
    write(s) {
      sent.push(JSON.parse(s.trim()));
    },
  };
  const root = {
    // Panel.qml reads the socket through sockLoader.item now: the loader
    // recreates the socket on every retry, so the file only ever touches
    // sockConnected / sockSend. Both delegate to the one sock stub, and
    // `e.sock.connected = X` in a test keeps meaning the same thing.
    get sockConnected() {
      return sock.connected;
    },
    sockSend(req) {
      if (!sock.connected) return false;
      sock.write(JSON.stringify(req) + "\n");
      return true;
    },
    nextId: 1,
    pending: {},
    messages: [],
    state: null,
    chats: [],
    sessionMid: "",
    chatSnapshot: [],
    chatRevisionSeen: -1,
    chatBootSeen: "",
    notice: "",
    loading: false,
    loadingOlder: false,
    noMoreOlder: false,
    loadedAt: 1000,
    sessionEpoch: 1,
    resumeAttemptBootId: "",
    sessionEndHandledKey: "",
    clearLastDraftOnLoad: false,
    // U70. The generation of the history on screen. loadHistory bumps it and
    // request() stamps every frame with it, so here it is just a number.
    historyGen: 0,
    atBottom: true,
    prependAnchorIndex: -1,
    keepContentY: -1,
    unreadMarkCount: 0,
    unreadMarkId: "",
    openWanted: {},
    selectedIndex: 3,
    imagePaths: {},
    imageRequests: {},
    imageRetryQueue: {},
    imageRetryAttempts: {},
    imageConsumers: {},
    imageRetries: [],
    previewRequests: {},
    previewRetries: [],
    previewRefreshNeeded: false,
    previewRetryAttempts: {},
    previewRetryQueue: {},
    historyRefreshNeeded: false,
    historyRefreshRemovedByChat: {},
    historyReloadAfterGeneration: 0,
    historyReloadChat: "",
    reconciliationEpoch: 0,
    reconciliationAttemptedEpoch: -1,
    ambiguousSendsByChat: {},
    pendingAmbiguousByAccount: {},
    previewDecodeRetries: {},
    myMid: "ME",
    view: opts.view || "chat",
    twoPane: !!opts.twoPane,
    draftStore: opts.draftStore || {},
    draftLastAccount: opts.draftLastAccount || "",
    draftRevision: opts.draftRevision === undefined ? 0 : opts.draftRevision,
    draftWrites: [],
    draftStoreLoaded: true,
    draftStoreUnavailable: false,
    deferredDraftRequests: [],
    deferredDraftPickers: [],
    sessionEstablished: false,
    sessionBootId: "",
    initialIdleDraftHandled: false,
    settledIdleBeforeDraftLoad: false,
    settledIdleDraftAccount: "",
    settledIdleDraftRevision: 0,
    settledIdleDraftAt: 0,
    pendingDraftAccountClears: {},
    pendingDraftComposers: {},
    composerEditedBeforeDraftLoad: false,
    restoringDraft: false,
    resettingComposerAfterSend: false,
    panelInstanceId: "panel-test",
    composerGeneration: 0,
    composerGenerationByChat: {},
    composerDirtyByChat: {},
    composerDraftVersionByChat: {},
    draftRecoveryHolds: {},
    draftRestoreEpoch: 0,
    moduleName: "io.github.frankekn.line",
    // placement is the derived mode ("bar" | "center" | "app"); appWindow is
    // the boolean the media paths branch on.
    placement: opts.placement || "bar",
    appWindow: !!opts.appWindow,
    windowWidth: opts.windowWidth === undefined ? 1040 : opts.windowWidth,
    windowHeight: opts.windowHeight === undefined ? 720 : opts.windowHeight,
    placementMode(v) {
      return api.placementMode(v);
    },
    nextPlacement(m) {
      return api.nextPlacement(m);
    },
    placementLabel(m) {
      return api.placementLabel(m);
    },
    clampWindowSize(v, f, min) {
      return api.clampWindowSize(v, f, min);
    },
    // U64. scrollPercent and scrollSpeed are bindings in Panel.qml (the setting
    // run through the clamp); here they are plain, so a test can put the panel
    // on any step. scrollSteps is the panel's own list, read above.
    scrollSteps: SCROLL_STEPS,
    scrollPercent: opts.scrollPercent === undefined ? 100 : opts.scrollPercent,
    get scrollSpeed() {
      return root.scrollPercent / 100;
    },
    clampScroll(v) {
      return api.clampScroll(v);
    },
    wheelDistance(ad, pd) {
      return api.wheelDistance(ad, pd);
    },
    wheelScroll(view, ad, pd) {
      api.wheelScroll(view, ad, pd);
    },
    nextScroll(p) {
      return api.nextScroll(p);
    },
    scrollLabel(p) {
      return api.scrollLabel(p);
    },
    // U69. historyPage is a binding in Panel.qml (the setting run through the
    // clamp); plain here so a test can put the panel on any page size.
    historySteps: HISTORY_STEPS,
    historyPage: opts.historyPage === undefined ? 60 : opts.historyPage,
    clampHistory(v) {
      return api.clampHistory(v);
    },
    nextHistory(n) {
      return api.nextHistory(n);
    },
    historyLabel(n) {
      return api.historyLabel(n);
    },
    nearOlderEdge(cy, oy, ch, h) {
      return api.nearOlderEdge(cy, oy, ch, h);
    },
    // The trigger calls it by name off root, and its guards are the point.
    loadOlder() {
      api.loadOlder();
    },
    historyCache: {},
    failedMessagesByChat: {},
    syncing: false,
    syncedAt: 0,
    loggedIn: true,
    clockText(ms) {
      return api.clockText(ms);
    },
    lightbox: opts.lightbox === undefined ? null : opts.lightbox,
    lightScale: 1,
    lightX: 0,
    lightY: 0,
    needsLogin: false,
    closed: 0,
    rememberHistory(mid, list) {
      api.rememberHistory(mid, list);
    },
    // clearSession() cancels the last account's requests through the real,
    // sliced dropInFlight -- a copy here would pass while the panel forgot one.
    dropInFlight() {
      api.dropInFlight();
    },
    reconcileAfterConnect() {
      return api.reconcileAfterConnect();
    },
    settleConfirmedSends(chat, confirmed) {
      api.settleConfirmedSends(chat, confirmed);
    },
    reconcileAmbiguous(chat, list, completedHistoryGeneration) {
      api.reconcileAmbiguous(chat, list, completedHistoryGeneration);
    },
    preserveAmbiguousBubbles(chat, list) {
      return api.preserveAmbiguousBubbles(chat, list);
    },
    // U48. setMessages is the only way messages is replaced, so every path that
    // touches the list goes through the real, sliced one.
    setMessages(list, follow) {
      api.setMessages(list, follow);
    },
    clearSwap() {
      api.clearSwap();
    },
    withDay(list) {
      return api.withDay(list);
    },
    firstUnreadIndex(list, unread) {
      return api.firstUnreadIndex(list, unread);
    },
    dayStart(ms) {
      return api.dayStart(ms);
    },
    dayLabel(ms, now) {
      return api.dayLabel(ms, now);
    },
    isSystemEvent(m) {
      return api.isSystemEvent(m);
    },
    close() {
      root.closed++;
    },
    // U49. The event watermark and the reply target are plain properties;
    // reactionTypes and readerCount are bindings, mirrored here the same way
    // focusLanding/mentionCapable are (and pinned against the source below).
    lastBootId: "",
    lastSeq: 0,
    replyTarget: null,
    eventsSyncing: false,
    queuedPushes: [],
    eventsLive: false,
    eventsConsumed: false,
    // U51. `opened` is the Panel base class's own property; the hand-off reads
    // it because the daemon opens the panel over IPC and the state write often
    // lands first.
    opened: opts.opened !== false,
    wantedBootId: "",
    honouredWanted: 0,
    pendingWanted: "",
    // U54. The plain properties are plain here too; recentStickers and
    // stickerGridModel are bindings in Panel.qml, written here as the same rule
    // once (like focusLanding above) and pinned against the source below.
    stickerPacks: opts.stickerPacks || [],
    stickerOpen: false,
    stickerLoading: false,
    stickerError: "",
    stickerTab: opts.stickerTab || "",
    stickerStore: opts.stickerStore || {},
    recentStickerMax: 16,
    get recentStickers() {
      return api.storedRecent(root.stickerStore, root.myMid);
    },
    get stickerGridModel() {
      return api.stickerCells(api.stickerPack(root.stickerTab));
    },
    stickerStill(u) {
      return api.stickerStill(u);
    },
    stickerCells(pack) {
      return api.stickerCells(pack);
    },
    stickerTabIndex(id) {
      return api.stickerTabIndex(id);
    },
    stickerPack(id) {
      return api.stickerPack(id);
    },
    stickerPackName(pack) {
      return api.stickerPackName(pack);
    },
    stickerTabClamp(x, v, c) {
      return api.stickerTabClamp(x, v, c);
    },
    stickerTabScroll(x, a, px, s, v, c) {
      return api.stickerTabScroll(x, a, px, s, v, c);
    },
    stickerTabInView(x, ix, iw, v, c) {
      return api.stickerTabInView(x, ix, iw, v, c);
    },
    stepStickerTab(dx) {
      return api.stepStickerTab(dx);
    },
    recentPush(l, i, m) {
      return api.recentPush(l, i, m);
    },
    storedRecent(store, mid) {
      return api.storedRecent(store, mid);
    },
    stickerRequest(chat, st) {
      return api.stickerRequest(chat, st);
    },
    stickerStatusText() {
      return api.stickerStatusText();
    },
    stickerGridHeight(c, w, cell, r) {
      return api.stickerGridHeight(c, w, cell, r);
    },
    setStickerOpen(on) {
      return api.setStickerOpen(on);
    },
    toggleSticker() {
      return api.toggleSticker();
    },
    loadStickers(refresh) {
      return api.loadStickers(refresh);
    },
    sendSticker(cell) {
      return api.sendSticker(cell);
    },
    rememberSticker(item) {
      api.rememberSticker(item);
    },
    pendingBubble(fields) {
      return api.pendingBubble(fields);
    },
    appendPendingSticker(url) {
      return api.appendPendingSticker(url);
    },
    hasPendingBubble(cmd) {
      return api.hasPendingBubble(cmd);
    },
    pendingDraftSend(chat, version) {
      return api.pendingDraftSend(chat, version);
    },
    deferredDraftSend(chat) {
      return api.deferredDraftSend(chat);
    },
    pickerBusy() {
      return false;
    },
    loadDraftStore(content) {
      return api.loadDraftStore(content);
    },
    draftVersionInFlight(chat, version, generation) {
      return api.draftVersionInFlight(chat, version, generation);
    },
    flushDeferredDraftActions() {
      return api.flushDeferredDraftActions();
    },
    flushDeferredDraftPickers() {
      return api.flushDeferredDraftPickers();
    },
    draftRecoveryHeld(chat, version, generation, composerGeneration) {
      return api.draftRecoveryHeld(
        chat,
        version,
        generation,
        composerGeneration,
      );
    },
    saveActiveDraft(remove) {
      api.saveActiveDraft(remove);
    },
    noteComposerEdit() {
      if (!root.restoringDraft && !root.resettingComposerAfterSend) {
        root.composerGeneration++;
        if (root.activeChat) {
          root.composerGenerationByChat[String(root.activeChat.mid || "")] =
            root.composerGeneration;
        }
        if (root.activeChat) {
          root.composerDirtyByChat[String(root.activeChat.mid || "")] = true;
        }
        if (!root.draftStoreLoaded) root.composerEditedBeforeDraftLoad = true;
      }
    },
    composerGenerationFor(chat) {
      return Number(root.composerGenerationByChat[String(chat || "")] || 0);
    },
    resetComposerAfterSuccessfulSend() {
      root.resettingComposerAfterSend = true;
      replyField.text = "";
      root.mentionPicks = [];
      root.replyTarget = null;
      root.resettingComposerAfterSend = false;
    },
    restorePendingComposer(chat, draft, version) {
      api.restorePendingComposer(chat, draft, version);
    },
    scheduleImageRetry(url, invalidate) {
      root.imageRetries.push({ url, invalidate: invalidate === true });
      return true;
    },
    finishImageRetry(url) {
      delete root.imageRetryAttempts[String(url || "")];
    },
    restoreDraft(chat) {
      api.restoreDraft(chat);
    },
    clearDraft(chat, version, generation, owner) {
      api.clearDraft(chat, version, generation, owner);
    },
    clearDraftAccount(account) {
      api.clearDraftAccount(account);
    },
    clearAllDrafts() {
      api.clearAllDrafts();
    },
    accountsWithAmbiguous(
      accounts,
      account,
      byChat,
      changedChats,
      removedByChat,
      clearAll,
    ) {
      return api.accountsWithAmbiguous(
        accounts,
        account,
        byChat,
        changedChats,
        removedByChat,
        clearAll,
      );
    },
    persistAmbiguousSends(
      account,
      byChat,
      changedChats,
      clearAll,
      removedByChat,
    ) {
      api.persistAmbiguousSends(
        account,
        byChat,
        changedChats,
        clearAll,
        removedByChat,
      );
    },
    restoreAmbiguousSends(account) {
      api.restoreAmbiguousSends(account);
    },
    writeDraftStore(next) {
      root.draftRevision++;
      root.draftStore = next;
      root.draftWrites.push(JSON.parse(JSON.stringify(next)));
      if (root.myMid && next[root.myMid]) root.draftLastAccount = root.myMid;
    },
    avatarColor(mid) {
      return api.avatarColor(mid);
    },
    avatarInitial(t) {
      return api.avatarInitial(t);
    },
    showAvatarAt(l, i) {
      return api.showAvatarAt(l, i);
    },
    takeWanted() {
      return api.takeWanted();
    },
    // U59. onReply compares the daemon's refusal against this, so it is the
    // panel's own literal here too rather than a second copy.
    clipboardEmpty: CLIPBOARD_EMPTY,
    // pasteClipboard() asks this before it sends, and it is the real, sliced one
    // -- the debounce is only worth anything if it reads the same `pending` that
    // request() writes and onReply() empties.
    clipboardBusy() {
      return api.clipboardBusy();
    },
    openChat(c) {
      api.openChat(c);
    },
    reactionTypes: REACTION_TYPES,
    get readerCount() {
      return !root.activeChat
        ? 0
        : (/^u/.test(String(root.activeChat.mid || ""))
          ? 1
          : root.members.length);
    },
    eventsSince(e, b, sb, sq) {
      return api.eventsSince(e, b, sb, sq);
    },
    applyEvents(l) {
      api.applyEvents(l);
    },
    withFields(m, patch) {
      return api.withFields(m, patch);
    },
    rememberFailedMessage(chat, message) {
      api.rememberFailedMessage(chat, message);
    },
    mergeFailedMessages(chat, list) {
      return api.mergeFailedMessages(chat, list);
    },
    mergeMessage(l, m) {
      return api.mergeMessage(l, m);
    },
    applyRead(l, u, by) {
      return api.applyRead(l, u, by);
    },
    applyReaction(l, id, rows) {
      return api.applyReaction(l, id, rows);
    },
    applyUnsend(l, id) {
      return api.applyUnsend(l, id);
    },
    readText(m) {
      return api.readText(m);
    },
    reactionEmoji(t) {
      return api.reactionEmoji(t);
    },
    myReaction(m) {
      return api.myReaction(m);
    },
    canActOn(m) {
      return api.canActOn(m);
    },
    toggleReaction(m, t) {
      api.toggleReaction(m, t);
    },
    unsendMessage(m) {
      api.unsendMessage(m);
    },
    startReply(m) {
      api.startReply(m);
    },
    quoteText(r) {
      return api.quoteText(r);
    },
    scrollToMessage(id) {
      return api.scrollToMessage(id);
    },
    isSendCmd(c) {
      return api.isSendCmd(c);
    },
    isMessageSendCmd(c) {
      return api.isMessageSendCmd(c);
    },
    appendPending(b, m, r) {
      return api.appendPending(b, m, r);
    },
    oneLine(t) {
      return api.oneLine(t);
    },
    eventsSince(e, b, sb, sq) { return api.eventsSince(e, b, sb, sq); },
    applyEvents(l) { api.applyEvents(l); },
    onPushedEvent(r) { api.onPushedEvent(r); },
    consumeEventsFile(s) { api.consumeEventsFile(s); },
    parseEventsText(c) { api.parseEventsText(c); },
    finishEventsSync() { api.finishEventsSync(); },
    applyChatPatch(row, revision, boot) {
      api.applyChatPatch(row, revision, boot);
    },
    withFields(m, patch) { return api.withFields(m, patch); },
    rememberFailedMessage(chat, message) { api.rememberFailedMessage(chat, message); },
    mergeFailedMessages(chat, list) { return api.mergeFailedMessages(chat, list); },
    mergeMessage(l, m) { return api.mergeMessage(l, m); },
    applyRead(l, u, by) { return api.applyRead(l, u, by); },
    applyReaction(l, id, rows) { return api.applyReaction(l, id, rows); },
    applyUnsend(l, id) { return api.applyUnsend(l, id); },
    applyEdit(l, m) { return api.applyEdit(l, m); },
    applyHistory(l, fresh) { return api.applyHistory(l, fresh); },
    readText(m) { return api.readText(m); },
    reactionEmoji(t) { return api.reactionEmoji(t); },
    myReaction(m) { return api.myReaction(m); },
    canActOn(m) { return api.canActOn(m); },
    toggleReaction(m, t) { api.toggleReaction(m, t); },
    unsendMessage(m) { api.unsendMessage(m); },
    startReply(m) { api.startReply(m); },
    quoteText(r) { return api.quoteText(r); },
    // /file with no path opens the picker; the tests only care that it was hit.
    pickFile(submit, generation, chat, version) {
      root.picked++;
      root.pickedRequests.push({ submit, generation, chat, version });
    },
    picked: 0,
    pickedRequests: [],
    // the real one, sliced -- lightboxCaption's size text is only meaningful
    // if it goes through the same formatter the message rows use
    mediaLabel(m) {
      return api.mediaLabel(m);
    },
    // pictureList and the delegate both ask this before showing a picture, so
    // the strip and the rows cannot disagree about what is viewable.
    mediaUsable(m) {
      return api.mediaUsable(m);
    },
    pictureList(list) {
      return api.pictureList(list);
    },
    zoomAt(s, px, py, cx, cy, f) {
      return api.zoomAt(s, px, py, cx, cy, f);
    },
    openPicture(id, src, name, idx) {
      api.openPicture(id, src, name, idx);
    },
    stepPicture(dx) {
      api.stepPicture(dx);
    },
    closeLightbox() {
      api.closeLightbox();
    },
    escapeAction() {
      return api.escapeAction();
    },
    deliverMedia(id, path, intent) {
      api.deliverMedia(id, path, intent);
    },
    openMedia(id, intent) {
      api.openMedia(id, intent);
    },
    markOpen(id, intent) {
      api.markOpen(id, intent);
    },
    // U42. focusLanding is a binding in Panel.qml; here it is the same rule
    // written once so dropBodyFocus() can be checked against it.
    pendingCopy: "",
    copyStarted: false,
    get focusLanding() {
      return root.view === "chat" ? replyField : searchField;
    },
    bodyText(m) {
      return api.bodyText(m);
    },
    escapeHtml(t) {
      return api.escapeHtml(t);
    },
    linkify(t, c) {
      return api.linkify(t, c);
    },
    // U45. members/membersError are plain properties; the five derived ones are
    // bindings in Panel.qml, written here as the same rule once (like
    // focusLanding above) so the key handling can be driven. The binding text
    // itself is pinned by a source assertion further down.
    members: opts.members === undefined ? [] : opts.members,
    membersError: opts.membersError || "",
    mentionPicks: [],
    mentionIndex: 0,
    mentionDismissedAt: -1,
    get mentionCapable() {
      return !!root.activeChat &&
        /^[cr]/.test(String(root.activeChat.mid || ""));
    },
    get mentionToken() {
      return root.mentionCapable && replyField.activeFocus
        ? api.mentionQuery(replyField.text, replyField.cursorPosition)
        : null;
    },
    get mentionRows() {
      return root.mentionToken
        ? api.mentionMatches(root.members, root.mentionToken.query)
        : [];
    },
    get mentionOpen() {
      return !!root.mentionToken &&
        root.mentionToken.start !== root.mentionDismissedAt &&
        (root.mentionRows.length > 0 || root.membersError.length > 0);
    },
    get mentionPicking() {
      return root.mentionOpen && root.mentionRows.length > 0;
    },
    get mentionSelected() {
      return Math.max(
        0,
        Math.min(root.mentionIndex, root.mentionRows.length - 1),
      );
    },
    mentionRank(n, q) {
      return api.mentionRank(n, q);
    },
    mentionQuery(t, c) {
      return api.mentionQuery(t, c);
    },
    mentionMatches(m, q) {
      return api.mentionMatches(m, q);
    },
    mentionInsert(t, c, r) {
      return api.mentionInsert(t, c, r);
    },
    deriveMentions(t, p) {
      return api.deriveMentions(t, p);
    },
    moveMention(s) {
      api.moveMention(s);
    },
    takeMention(i) {
      return api.takeMention(i);
    },
    dismissMention() {
      api.dismissMention();
    },
    loadMembers(mid) {
      api.loadMembers(mid);
    },
    markupBody(t, s, c) {
      return api.markupBody(t, s, c);
    },
    mentionRanges(ms, len) {
      return api.mentionRanges(ms, len);
    },
    linkTarget(u) {
      return api.linkTarget(u);
    },
    openLink(u) {
      api.openLink(u);
    },
    copyText(t) {
      return api.copyText(t);
    },
    flushCopy() {
      api.flushCopy();
    },
    messageMenuItems(l, m) {
      return api.messageMenuItems(l, m);
    },
    activeChat: opts.activeChat === undefined ? { mid: "C1" } : opts.activeChat,
    chatById(mid) {
      for (const c of root.chats) if (c.mid === mid) return c;
      return null;
    },
    // Reimplemented here like chatById above, because openChat() reads it and
    // the sliced copy below is declared further down the file. (x8) drives the
    // real one.
    hiddenOnOpen: "",
    chatHidden(mid) {
      const c = root.chatById(String(mid || ""));
      return !!c && !!c.hidden;
    },
    dropMessage(id) {
      root.messages = root.messages.filter((m) => m.id !== id);
    },
    // request() answers whether the frame actually went out; openMedia only
    // records an intent when it did, so the stub must pass that back.
    request(c, ex, m) {
      return api.request(c, ex, m);
    },
    forgetOpen(id) {
      api.forgetOpen(id);
    },
    // The real, sliced one -- it carries the page size and clears the
    // "nothing older left" flag, and both are only worth anything if every
    // path that reopens a conversation goes through them. markRead rides
    // along too: the reopen/refetch paths pass false, and dropping the
    // argument here would silently turn their frames back into read marks.
    loadHistory(mid, markRead) {
      historyCalls.push(mid);
      api.loadHistory(mid, markRead);
    },
  };
  if (opts.draftRevision === undefined) {
    for (const account of Object.values(root.draftStore)) {
      for (const draft of Object.values(account || {})) {
        root.draftRevision = Math.max(
          root.draftRevision,
          Number(draft.version || 0),
        );
      }
    }
  }
  Object.defineProperties(root, {
    loginInfo: {
      get: () => root.state && root.state.login ? root.state.login : null,
    },
    loginStatus: {
      get: () => root.loginInfo ? String(root.loginInfo.status || "") : "",
    },
  });
  root.schedulePreviewRetry = (id) =>
    root.previewRetries.push(String(id || ""));
  root.finishPreviewRetry = (id) => {
    delete root.previewRetryAttempts[String(id || "")];
  };
  root.clearPreviewRetries = () => {
    root.previewRetries = [];
    root.previewRetryQueue = {};
  };
  // cursorPosition and activeFocus are what the @ picker's bindings read.
  // paste() is the TextArea's own, and the whole point of U59 is when it is
  // called and when it is not -- so it is counted rather than performed (the
  // harness has no clipboard, and the caret arithmetic is Qt's).
  const replyField = {
    text: "",
    cursorPosition: 0,
    activeFocus: true,
    forceActiveFocus() {},
    get length() {
      return this.text.length;
    },
    pastes: 0,
    paste() {
      replyField.pastes++;
    },
  };
  const searchField = { text: "", forceActiveFocus() {} };
  const listFlick = { contentY: 99 };
  // originY is 0 on a settled list; it only drifts while a virtualised ListView
  // is still realising the items above the viewport.
  const positioned = [];
  const msgList = {
    contentHeight: 0,
    contentY: 0,
    originY: 0,
    height: 100,
    positionViewAtIndex(i) {
      positioned.push(i);
    },
  };
  // Only the two enum members the code names.
  const ListView = { Center: 1, Beginning: 0, End: 2 };
  // Style.space() is a DPI scale in the shell; the harness only needs the
  // thresholds to be comparable, so it is the identity here.
  const Style = { space: (n) => n };
  const execed = []; // argv vectors handed to Quickshell.execDetached
  const focused = []; // who was asked for focus, in order
  const keyCatcher = {
    forceActiveFocus() {
      focused.push("keyCatcher");
    },
  };
  replyField.forceActiveFocus = () => focused.push("replyField");
  searchField.forceActiveFocus = () => focused.push("searchField");
  const Quickshell = {
    execDetached(argv) {
      execed.push(argv.slice());
    },
  };
  // Quickshell Processes: the code only ever assigns command then running.
  const settingWriter = { command: null, running: false };
  const sizeWriter = { command: null, running: false };
  // wl-copy's Process. Every assignment is logged in order so a test can see
  // that stdin is opened, the text written, and stdin closed again -- wl-copy
  // waits for EOF, so a missed close is a copy that never lands.
  const clipLog = [];
  const clipWriter = {
    command: ["wl-copy"],
    writes: [],
    _running: false,
    _stdin: true,
    get running() {
      return this._running;
    },
    set running(v) {
      this._running = v;
      clipLog.push("running=" + v);
    },
    get stdinEnabled() {
      return this._stdin;
    },
    set stdinEnabled(v) {
      this._stdin = v;
      clipLog.push("stdin=" + v);
    },
    write(s) {
      this.writes.push(s);
      clipLog.push("write");
    },
  };
  const msgMenu = {
    body: "",
    link: "",
    msg: null,
    closed: 0,
    close() {
      msgMenu.closed++;
    },
  };
  // The recently-used stickers' FileView. setText is the only call the panel
  // makes on it, and every write is kept so a test can read what would have
  // reached the disk -- the harness never touches a real state directory.
  const stickerFile = {
    writes: [],
    setText(s) {
      stickerFile.writes.push(s);
    },
  };
  const draftFile = { path: "/tmp/panel-drafts.json" };
  const DraftStore = {
    allocateRevision: () => ++root.draftRevision,
    load(content) {
      const parsed = JSON.parse(String(content || "{}"));
      return {
        accounts: parsed.accounts || {},
        lastAccount: parsed.lastAccount || "",
      };
    },
    merge(_before, next, lastAccount) {
      return { accounts: next, lastAccount: lastAccount || "" };
    },
    serialize() {
      return JSON.stringify({ version: 1, accounts: root.draftStore });
    },
    snapshot: () => ({
      revision: root.draftRevision,
      accounts: JSON.parse(JSON.stringify(root.draftStore || {})),
      lastAccount: root.draftLastAccount || "",
    }),
  };
  const DraftWriter = {
    writes: [],
    save(file, content) {
      this.writes.push({ file, content });
    },
  };
  // Only the accent is read, and only to be flattened into a CSS colour.
  const Color = { accent: { r: 0.2, g: 0.6, b: 1.0, a: 1 } };
  // clockText() is the only caller of formatDateTime, and it asks for one format.
  const deferred = [];
  const Qt = {
    // U48: setMessages() arms clearSwap() as a backstop for the case where the
    // new list is identical and the ListView never emits modelChanged. Recording
    // them (rather than running them) keeps every existing test unchanged.
    callLater(f) {
      deferred.push(f);
    },
    rgba(r, g, b, a) {
      const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
      const s = "#" + h(r) + h(g) + h(b);
      return { r, g, b, a, toString: () => s };
    },
    formatDateTime(d, fmt) {
      if (fmt !== "HH:mm") throw new Error("unstubbed format: " + fmt);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes());
    },
  };
  const q = (fn, opened) =>
    fn(
      root,
      sock,
      replyField,
      searchField,
      listFlick,
      msgList,
      Qt,
      console,
      () => api.back(),
      opened,
      () => api.clearSession(),
      (c, ex, m) => api.request(c, ex, m),
      keyCatcher,
      Quickshell,
      settingWriter,
      sizeWriter,
      clipWriter,
      msgMenu,
      Color,
      Style,
      ListView,
      stickerFile,
      draftFile,
      DraftStore,
      DraftWriter,
      EventLog,
      PanelKit,
      Tzh,
      Ezh,
    );
  const mk = (name, params) =>
    new Function(...ARGS, ...(params || []), B[name]);
  const fBack = mk("backToList");
  const fOpened = mk("onOpenedChanged");
  const fRequest = mk("request", ["cmd", "extra", "msgId"]);
  const fOnReply = mk("onReply", ["line"]);
  const fParse = mk("parseState", ["content"]);
  const fRemember = mk("rememberHistory", ["mid", "list"]);
  const fClear = mk("clearSession");
  const fPendingDraftSend = mk("pendingDraftSend", ["chat", "draftVersion"]);
  const fDeferredDraftSend = mk("deferredDraftSend", ["chat"]);
  const fLoadDraftStore = mk("loadDraftStore", ["content"]);
  const fDraftVersionInFlight = mk(
    "draftVersionInFlight",
    ["chat", "version", "generation"],
  );
  const fFlushDeferredDraftActions = mk("flushDeferredDraftActions");
  const fFlushDeferredDraftPickers = mk("flushDeferredDraftPickers");
  const fDraftRecoveryHeld = mk(
    "draftRecoveryHeld",
    ["chat", "version", "generation", "composerGeneration"],
  );
  const fAccountsWithAmbiguous = mk("accountsWithAmbiguous", [
    "accounts",
    "account",
    "byChat",
    "changedChats",
    "removedByChat",
    "clearAll",
  ]);
  const fPersistAmbiguousSends = mk("persistAmbiguousSends", [
    "account",
    "byChat",
    "changedChats",
    "clearAll",
    "removedByChat",
  ]);
  const fRestoreAmbiguousSends = mk("restoreAmbiguousSends", ["account"]);
  const fSaveActiveDraft = mk("saveActiveDraft", ["removeEmpty"]);
  const fRestoreDraft = mk("restoreDraft", ["chat"]);
  const fRestorePendingComposer = mk(
    "restorePendingComposer",
    ["chat", "draft", "version"],
  );
  const fClearDraftAccount = mk("clearDraftAccount", ["account"]);
  const fClearDraft = mk("clearDraft", [
    "chat",
    "expectedVersion",
    "expectedGeneration",
    "expectedGenerationOwner",
  ]);
  const fClearAllDrafts = mk("clearAllDrafts");
  const fOpenChat = mk("openChat", ["chat"]);
  const fLoadOlder = mk("loadOlder");
  const fOpenMedia = mk("openMedia", ["id", "intent"]);
  const fMarkOpen = mk("markOpen", ["id", "intent"]);
  const fDropInFlight = mk("dropInFlight");
  const fReconcileAfterConnect = mk("reconcileAfterConnect");
  const fSettleConfirmedSends = mk("settleConfirmedSends", [
    "chat",
    "confirmed",
  ]);
  const fReconcileAmbiguous = mk(
    "reconcileAmbiguous",
    ["chat", "list", "completedHistoryGeneration"],
  );
  const fPreserveAmbiguousBubbles = mk("preserveAmbiguousBubbles", [
    "chat",
    "list",
  ]);
  const fForgetOpen = mk("forgetOpen", ["id"]);
  const fSyncNow = mk("syncNow");
  const fClockText = mk("clockText", ["ms"]);
  const fPictureList = mk("pictureList", ["messages"]);
  const fZoomAt = mk("zoomAt", ["scale", "panX", "panY", "cx", "cy", "factor"]);
  const fOpenPicture = mk("openPicture", ["id", "source", "name", "index"]);
  const fShowPicture = mk("showPicture", ["id", "source", "name"]);
  const fStepPicture = mk("stepPicture", ["dx"]);
  const fCloseLightbox = mk("closeLightbox");
  const fEscapeAction = mk("escapeAction");
  const fDeliverMedia = mk("deliverMedia", ["id", "path", "intent"]);
  const fOpenExternally = mk("openExternally");
  const fClampPan = mk("clampPan", [
    "x",
    "y",
    "scale",
    "paintedW",
    "paintedH",
    "stageW",
    "stageH",
  ]);
  const fIsDrag = mk("isDrag", ["dx", "dy"]);
  const fOutside = mk("outsidePicture", [
    "mx",
    "my",
    "stageW",
    "stageH",
    "panX",
    "panY",
    "scale",
    "paintedW",
    "paintedH",
  ]);
  const fCaption = mk("lightboxCaption");
  const fMediaLabel = mk("mediaLabel", ["m"]);
  const fMediaUsable = mk("mediaUsable", ["m"]);
  const fPlacementMode = mk("placementMode", ["value"]);
  const fNextPlacement = mk("nextPlacement", ["mode"]);
  const fPlacementLabel = mk("placementLabel", ["mode"]);
  const fClampWindow = mk("clampWindowSize", ["value", "fallback", "min"]);
  const fTogglePlacement = mk("togglePlacement");
  const fSaveWindowSize = mk("saveWindowSize", ["w", "h"]);
  const fClampScroll = mk("clampScroll", ["value"]);
  const fWheelDistance = mk("wheelDistance", ["angleDeltaY", "pixelDeltaY"]);
  const fWheelScroll = mk("wheelScroll", [
    "view",
    "angleDeltaY",
    "pixelDeltaY",
  ]);
  const fNextScroll = mk("nextScroll", ["percent"]);
  const fScrollLabel = mk("scrollLabel", ["percent"]);
  const fStepScroll = mk("stepScrollSpeed");
  const fClampHistory = mk("clampHistory", ["value"]);
  const fNextHistory = mk("nextHistory", ["count"]);
  const fHistoryLabel = mk("historyLabel", ["count"]);
  const fStepHistory = mk("stepHistoryPage");
  const fNearOlderEdge = mk("nearOlderEdge", [
    "contentY",
    "originY",
    "contentHeight",
    "height",
  ]);
  const fAnchoredContentY = mk("anchoredContentY", [
    "afterY",
    "originY",
    "keep",
    "contentHeight",
    "height",
  ]);
  const fLoadHistory = mk("loadHistory", ["mid", "markRead"]);
  const fBodyText = mk("bodyText", ["m"]);
  const fEscapeHtml = mk("escapeHtml", ["t"]);
  const fLinkify = mk("linkify", ["text", "linkColor"]);
  const fBodyHtml = mk("bodyHtml", ["m"]);
  const fLinkTarget = mk("linkTarget", ["url"]);
  const fOpenLink = mk("openLink", ["url"]);
  const fCopyText = mk("copyText", ["text"]);
  const fFlushCopy = mk("flushCopy");
  const fMenuItems = mk("messageMenuItems", ["link", "m"]);
  const fRunMenuAction = mk("runMenuAction", ["action"]);
  const fDropBodyFocus = mk("dropBodyFocus");
  const fMentionRank = mk("mentionRank", ["names", "q"]);
  const fMentionQuery = mk("mentionQuery", ["text", "cursor"]);
  const fMentionMatches = mk("mentionMatches", ["members", "query"]);
  const fMentionInsert = mk("mentionInsert", ["text", "cursor", "row"]);
  const fDeriveMentions = mk("deriveMentions", ["text", "picks"]);
  const fMoveMention = mk("moveMention", ["step"]);
  const fTakeMention = mk("takeMention", ["index"]);
  const fDismissMention = mk("dismissMention");
  const fLoadMembers = mk("loadMembers", ["mid"]);
  const fMarkupBody = mk("markupBody", ["text", "spans", "color"]);
  const fMentionRanges = mk("mentionRanges", ["mentions", "len"]);
  const fSetMessages = mk("setMessages", ["list", "follow"]);
  const fClearSwap = mk("clearSwap");
  const fWithDay = mk("withDay", ["list"]);
  const fFirstUnread = mk("firstUnreadIndex", ["messages", "unread"]);
  const fDayStart = mk("dayStart", ["ms"]);
  const fDayLabel = mk("dayLabel", ["ms", "nowMs"]);
  const fIsSystemEvent = mk("isSystemEvent", ["m"]);
  const fEventsSince = mk("eventsSince", [
    "events",
    "bootId",
    "seenBootId",
    "seenSeq",
  ]);
  const fApplyEvents = mk("applyEvents", ["list"]);
  const fApplyChatPatch = mk("applyChatPatch", ["row", "revision", "boot"]);
  const fWithFields = mk("withFields", ["m", "patch"]);
  const fRememberFailedMessage = mk("rememberFailedMessage", [
    "chat",
    "message",
  ]);
  const fMergeFailedMessages = mk("mergeFailedMessages", ["chat", "list"]);
  const fMergeMessage = mk("mergeMessage", ["list", "m"]);
  const fApplyRead = mk("applyRead", ["list", "upTo", "by"]);
  const fApplyReaction = mk("applyReaction", ["list", "id", "rows"]);
  const fApplyUnsend = mk("applyUnsend", ["list", "id"]);
  const fApplyEdit = mk("applyEdit", ["list", "m"]);
  const fApplyHistory = mk("applyHistory", ["list", "fresh"]);
  const fOnPushedEvent = mk("onPushedEvent", ["res"]);
  const fConsumeEventsFile = mk("consumeEventsFile", ["evState"]);
  const fParseEventsText = mk("parseEventsText", ["content"]);
  const fFinishEventsSync = mk("finishEventsSync", []);
  const fReadText = mk("readText", ["m"]);
  const fReactionEmoji = mk("reactionEmoji", ["type"]);
  const fMyReaction = mk("myReaction", ["m"]);
  const fCanActOn = mk("canActOn", ["m"]);
  const fToggleReaction = mk("toggleReaction", ["m", "type"]);
  const fUnsendMessage = mk("unsendMessage", ["m"]);
  const fStartReply = mk("startReply", ["m"]);
  const fQuoteText = mk("quoteText", ["r"]);
  const fScrollTo = mk("scrollToMessage", ["id"]);
  const fIsSendCmd = mk("isSendCmd", ["cmd"]);
  const fIsMessageSendCmd = mk("isMessageSendCmd", ["cmd"]);
  const fAppendPending = mk("appendPending", ["body", "mentions", "replyTo"]);
  const fOneLine = mk("oneLine", ["t"]);
  const fStickerStill = mk("stickerStill", ["url"]);
  const fStickerCells = mk("stickerCells", ["pack"]);
  const fStickerTabIndex = mk("stickerTabIndex", ["id"]);
  const fStickerPack = mk("stickerPack", ["id"]);
  const fStickerPackName = mk("stickerPackName", ["pack"]);
  const fStickerTabClamp = mk("stickerTabClamp", [
    "x",
    "viewWidth",
    "contentWidth",
  ]);
  const fStickerTabScroll = mk("stickerTabScroll", [
    "contentX",
    "angleY",
    "pixelY",
    "step",
    "viewWidth",
    "contentWidth",
  ]);
  const fStickerTabInView = mk("stickerTabInView", [
    "contentX",
    "itemX",
    "itemWidth",
    "viewWidth",
    "contentWidth",
  ]);
  const fStepStickerTab = mk("stepStickerTab", ["dx"]);
  const fRecentPush = mk("recentPush", ["list", "item", "max"]);
  const fStoredRecent = mk("storedRecent", ["store", "mid"]);
  const fLoadStickerStore = mk("loadStickerStore", ["content"]);
  const fStickerRequest = mk("stickerRequest", ["chat", "sticker"]);
  const fStickerStatus = mk("stickerStatusText");
  const fStickerGridHeight = mk("stickerGridHeight", [
    "count",
    "width",
    "cell",
    "maxRows",
  ]);
  const fSetStickerOpen = mk("setStickerOpen", ["on"]);
  const fToggleSticker = mk("toggleSticker");
  const fLoadStickers = mk("loadStickers", ["refresh"]);
  const fSendSticker = mk("sendSticker", ["cell"]);
  const fRememberSticker = mk("rememberSticker", ["item"]);
  const fPendingBubble = mk("pendingBubble", ["fields"]);
  const fAppendPendingSticker = mk("appendPendingSticker", ["url"]);
  const fHasPendingBubble = mk("hasPendingBubble", ["cmd"]);
  const fAvatarColor = mk("avatarColor", ["mid"]);
  const fAvatarInitial = mk("avatarInitial", ["text"]);
  const fShowAvatarAt = mk("showAvatarAt", ["list", "i"]);
  const fTakeWanted = mk("takeWanted");
  const fPasteClipboard = mk("pasteClipboard");
  const fClipboardBusy = mk("clipboardBusy");
  // `text` inside submit() is the TextArea's own property; `with` makes the
  // sliced source read and write the stub's the way the real one does.
  const fSubmit = new Function(...ARGS, "with (replyField) {" + B.submit + "}");
  const fContentY = new Function(
    ...ARGS,
    "with (msgList) {" + B.onContentYChanged + "}",
  );
  const api = {
    root,
    sock,
    replyField,
    searchField,
    listFlick,
    msgList,
    sent,
    historyCalls,
    deferred,
    flushLater: () => {
      const d = deferred.splice(0);
      d.forEach((f) => f());
    },
    execed,
    focused,
    settingWriter,
    sizeWriter,
    clipWriter,
    clipLog,
    msgMenu,
    request: (c, e, m) => q((...a) => fRequest(...a, c, e, m)),
    onReply: (l) => q((...a) => fOnReply(...a, l)),
    parseState: (c) => q((...a) => fParse(...a, c)),
    rememberHistory: (m, l) => q((...a) => fRemember(...a, m, l)),
    back: () => q(fBack),
    clearSession: () => q(fClear),
    pendingDraftSend: (chat, version) =>
      q((...a) => fPendingDraftSend(...a, chat, version)),
    deferredDraftSend: (chat) => q((...a) => fDeferredDraftSend(...a, chat)),
    loadDraftStore: (content) => q((...a) => fLoadDraftStore(...a, content)),
    draftVersionInFlight: (chat, version, generation) =>
      q((...a) => fDraftVersionInFlight(...a, chat, version, generation)),
    flushDeferredDraftActions: () => q(fFlushDeferredDraftActions),
    flushDeferredDraftPickers: () => q(fFlushDeferredDraftPickers),
    draftRecoveryHeld: (chat, version, generation, composerGeneration) =>
      q((...a) =>
        fDraftRecoveryHeld(
          ...a,
          chat,
          version,
          generation,
          composerGeneration,
        )
      ),
    accountsWithAmbiguous: (
      accounts,
      account,
      byChat,
      changedChats,
      removedByChat,
      clearAll,
    ) =>
      q((...a) =>
        fAccountsWithAmbiguous(
          ...a,
          accounts,
          account,
          byChat,
          changedChats,
          removedByChat,
          clearAll,
        )
      ),
    persistAmbiguousSends: (
      account,
      byChat,
      changedChats,
      clearAll,
      removedByChat,
    ) =>
      q((...a) =>
        fPersistAmbiguousSends(
          ...a,
          account,
          byChat,
          changedChats,
          clearAll,
          removedByChat,
        )
      ),
    restoreAmbiguousSends: (account) =>
      q((...a) => fRestoreAmbiguousSends(...a, account)),
    saveActiveDraft: (remove) => q((...a) => fSaveActiveDraft(...a, remove)),
    restoreDraft: (chat) => q((...a) => fRestoreDraft(...a, chat)),
    restorePendingComposer: (chat, draft, version) =>
      q((...a) => fRestorePendingComposer(...a, chat, draft, version)),
    clearDraftAccount: (account) =>
      q((...a) => fClearDraftAccount(...a, account)),
    clearDraft: (chat, version, generation, owner) =>
      q((...a) =>
        fClearDraft(
          ...a,
          chat,
          version,
          generation,
          owner === undefined ? root.panelInstanceId : owner,
        )
      ),
    clearAllDrafts: () => q(fClearAllDrafts),
    openChat: (c) => q((...a) => fOpenChat(...a, c)),
    loadOlder: () => q(fLoadOlder),
    openMedia: (id, intent) => q((...a) => fOpenMedia(...a, id, intent)),
    markOpen: (id, intent) => q((...a) => fMarkOpen(...a, id, intent)),
    dropInFlight: () => q(fDropInFlight),
    reconcileAfterConnect: () => q(fReconcileAfterConnect),
    settleConfirmedSends: (chat, confirmed) =>
      q((...a) => fSettleConfirmedSends(...a, chat, confirmed)),
    reconcileAmbiguous: (c, l, completed) =>
      q((...a) => fReconcileAmbiguous(...a, c, l, completed)),
    preserveAmbiguousBubbles: (c, l) =>
      q((...a) => fPreserveAmbiguousBubbles(...a, c, l)),
    forgetOpen: (id) => q((...a) => fForgetOpen(...a, id)),
    syncNow: () => q(fSyncNow),
    clockText: (ms) => q((...a) => fClockText(...a, ms)),
    pictureList: (l) => q((...a) => fPictureList(...a, l)),
    zoomAt: (s, px, py, cx, cy, f) =>
      q((...a) => fZoomAt(...a, s, px, py, cx, cy, f)),
    openPicture: (id, src, n, i) =>
      q((...a) => fOpenPicture(...a, id, src, n, i)),
    showPicture: (id, src, n) => q((...a) => fShowPicture(...a, id, src, n)),
    stepPicture: (dx) => q((...a) => fStepPicture(...a, dx)),
    closeLightbox: () => q(fCloseLightbox),
    escapeAction: () => q(fEscapeAction),
    deliverMedia: (id, p, intent) =>
      q((...a) => fDeliverMedia(...a, id, p, intent)),
    openExternally: () => q(fOpenExternally),
    clampPan: (x, y, s, pw, ph, sw, sh) =>
      q((...a) => fClampPan(...a, x, y, s, pw, ph, sw, sh)),
    isDrag: (dx, dy) => q((...a) => fIsDrag(...a, dx, dy)),
    outsidePicture: (...args) => q((...a) => fOutside(...a, ...args)),
    lightboxCaption: () => q(fCaption),
    mediaLabel: (m) => q((...a) => fMediaLabel(...a, m)),
    mediaUsable: (m) => q((...a) => fMediaUsable(...a, m)),
    placementMode: (v) => q((...a) => fPlacementMode(...a, v)),
    nextPlacement: (m) => q((...a) => fNextPlacement(...a, m)),
    placementLabel: (m) => q((...a) => fPlacementLabel(...a, m)),
    clampWindowSize: (v, f, min) => q((...a) => fClampWindow(...a, v, f, min)),
    togglePlacement: () => q(fTogglePlacement),
    saveWindowSize: (w, h) => q((...a) => fSaveWindowSize(...a, w, h)),
    clampScroll: (v) => q((...a) => fClampScroll(...a, v)),
    wheelDistance: (ad, pd) => q((...a) => fWheelDistance(...a, ad, pd)),
    wheelScroll: (v, ad, pd) => q((...a) => fWheelScroll(...a, v, ad, pd)),
    nextScroll: (p) => q((...a) => fNextScroll(...a, p)),
    scrollLabel: (p) => q((...a) => fScrollLabel(...a, p)),
    stepScrollSpeed: () => q(fStepScroll),
    clampHistory: (v) => q((...a) => fClampHistory(...a, v)),
    nextHistory: (n) => q((...a) => fNextHistory(...a, n)),
    historyLabel: (n) => q((...a) => fHistoryLabel(...a, n)),
    stepHistoryPage: () => q(fStepHistory),
    nearOlderEdge: (cy, oy, ch, h) =>
      q((...a) => fNearOlderEdge(...a, cy, oy, ch, h)),
    anchoredContentY: (ay, oy, k, ch, h) =>
      q((...a) => fAnchoredContentY(...a, ay, oy, k, ch, h)),
    loadHistory: (mid, markRead) =>
      q((...a) => fLoadHistory(...a, mid, markRead)),
    bodyText: (m) => q((...a) => fBodyText(...a, m)),
    escapeHtml: (t) => q((...a) => fEscapeHtml(...a, t)),
    linkify: (t, c) => q((...a) => fLinkify(...a, t, c)),
    bodyHtml: (m) => q((...a) => fBodyHtml(...a, m)),
    linkTarget: (u) => q((...a) => fLinkTarget(...a, u)),
    openLink: (u) => q((...a) => fOpenLink(...a, u)),
    copyText: (t) => q((...a) => fCopyText(...a, t)),
    flushCopy: () => q(fFlushCopy),
    messageMenuItems: (l, m) => q((...a) => fMenuItems(...a, l, m)),
    runMenuAction: (x) => q((...a) => fRunMenuAction(...a, x)),
    dropBodyFocus: () => q(fDropBodyFocus),
    mentionRank: (n, x) => q((...a) => fMentionRank(...a, n, x)),
    mentionQuery: (t, c) => q((...a) => fMentionQuery(...a, t, c)),
    mentionMatches: (m, x) => q((...a) => fMentionMatches(...a, m, x)),
    mentionInsert: (t, c, r) => q((...a) => fMentionInsert(...a, t, c, r)),
    deriveMentions: (t, p) => q((...a) => fDeriveMentions(...a, t, p)),
    moveMention: (st) => q((...a) => fMoveMention(...a, st)),
    takeMention: (i) => q((...a) => fTakeMention(...a, i)),
    dismissMention: () => q(fDismissMention),
    loadMembers: (mid) => q((...a) => fLoadMembers(...a, mid)),
    markupBody: (t, sp, c) => q((...a) => fMarkupBody(...a, t, sp, c)),
    mentionRanges: (ms, len) => q((...a) => fMentionRanges(...a, ms, len)),
    setMessages: (l, f) => q((...a) => fSetMessages(...a, l, f)),
    clearSwap: () => q(fClearSwap),
    withDay: (l) => q((...a) => fWithDay(...a, l)),
    firstUnreadIndex: (l, u) => q((...a) => fFirstUnread(...a, l, u)),
    dayStart: (ms) => q((...a) => fDayStart(...a, ms)),
    dayLabel: (ms, now) => q((...a) => fDayLabel(...a, ms, now)),
    isSystemEvent: (m) => q((...a) => fIsSystemEvent(...a, m)),
    positioned,
    eventsSince: (e, b, sb, sq) =>
      q((...a) => fEventsSince(...a, e, b, sb, sq)),
    applyEvents: (l) => q((...a) => fApplyEvents(...a, l)),
    applyChatPatch: (row, revision, boot) =>
      q((...a) => fApplyChatPatch(...a, row, revision, boot)),
    withFields: (m, patch) => q((...a) => fWithFields(...a, m, patch)),
    rememberFailedMessage: (chat, message) =>
      q((...a) => fRememberFailedMessage(...a, chat, message)),
    mergeFailedMessages: (chat, list) =>
      q((...a) => fMergeFailedMessages(...a, chat, list)),
    mergeMessage: (l, m) => q((...a) => fMergeMessage(...a, l, m)),
    applyRead: (l, u, by) => q((...a) => fApplyRead(...a, l, u, by)),
    applyReaction: (l, id, rows) =>
      q((...a) => fApplyReaction(...a, l, id, rows)),
    applyUnsend: (l, id) => q((...a) => fApplyUnsend(...a, l, id)),
    applyEdit: (l, m) => q((...a) => fApplyEdit(...a, l, m)),
    applyHistory: (l, fresh) => q((...a) => fApplyHistory(...a, l, fresh)),
    onPushedEvent: (r) => q((...a) => fOnPushedEvent(...a, r)),
    consumeEventsFile: (s) => q((...a) => fConsumeEventsFile(...a, s)),
    parseEventsText: (c) => q((...a) => fParseEventsText(...a, c)),
    finishEventsSync: () => q(fFinishEventsSync),
    readText: (m) => q((...a) => fReadText(...a, m)),
    reactionEmoji: (t) => q((...a) => fReactionEmoji(...a, t)),
    myReaction: (m) => q((...a) => fMyReaction(...a, m)),
    canActOn: (m) => q((...a) => fCanActOn(...a, m)),
    toggleReaction: (m, t) => q((...a) => fToggleReaction(...a, m, t)),
    unsendMessage: (m) => q((...a) => fUnsendMessage(...a, m)),
    startReply: (m) => q((...a) => fStartReply(...a, m)),
    quoteText: (r) => q((...a) => fQuoteText(...a, r)),
    scrollToMessage: (id) => q((...a) => fScrollTo(...a, id)),
    isSendCmd: (c) => q((...a) => fIsSendCmd(...a, c)),
    isMessageSendCmd: (c) => q((...a) => fIsMessageSendCmd(...a, c)),
    appendPending: (b, m, r) => q((...a) => fAppendPending(...a, b, m, r)),
    oneLine: (t) => q((...a) => fOneLine(...a, t)),
    stickerFile,
    stickerStill: (u) => q((...a) => fStickerStill(...a, u)),
    stickerCells: (p) => q((...a) => fStickerCells(...a, p)),
    stickerTabIndex: (id) => q((...a) => fStickerTabIndex(...a, id)),
    stickerPack: (id) => q((...a) => fStickerPack(...a, id)),
    stickerPackName: (p) => q((...a) => fStickerPackName(...a, p)),
    stickerTabClamp: (x, v, c) => q((...a) => fStickerTabClamp(...a, x, v, c)),
    stickerTabScroll: (x, ang, px, s, v, c) =>
      q((...a) => fStickerTabScroll(...a, x, ang, px, s, v, c)),
    stickerTabInView: (x, ix, iw, v, c) =>
      q((...a) => fStickerTabInView(...a, x, ix, iw, v, c)),
    stepStickerTab: (dx) => q((...a) => fStepStickerTab(...a, dx)),
    recentPush: (l, i, m) => q((...a) => fRecentPush(...a, l, i, m)),
    storedRecent: (st, m) => q((...a) => fStoredRecent(...a, st, m)),
    loadStickerStore: (c) => q((...a) => fLoadStickerStore(...a, c)),
    stickerRequest: (c, st) => q((...a) => fStickerRequest(...a, c, st)),
    stickerStatusText: () => q(fStickerStatus),
    stickerGridHeight: (c, w, cell, r) =>
      q((...a) => fStickerGridHeight(...a, c, w, cell, r)),
    setStickerOpen: (on) => q((...a) => fSetStickerOpen(...a, on)),
    toggleSticker: () => q(fToggleSticker),
    loadStickers: (r) => q((...a) => fLoadStickers(...a, r)),
    sendSticker: (cell) => q((...a) => fSendSticker(...a, cell)),
    rememberSticker: (i) => q((...a) => fRememberSticker(...a, i)),
    pendingBubble: (f) => q((...a) => fPendingBubble(...a, f)),
    appendPendingSticker: (u) => q((...a) => fAppendPendingSticker(...a, u)),
    hasPendingBubble: (c) => q((...a) => fHasPendingBubble(...a, c)),
    avatarColor: (m) => q((...a) => fAvatarColor(...a, m)),
    avatarInitial: (t) => q((...a) => fAvatarInitial(...a, t)),
    showAvatarAt: (l, i) => q((...a) => fShowAvatarAt(...a, l, i)),
    takeWanted: () => q(fTakeWanted),
    pasteClipboard: () => q(fPasteClipboard),
    clipboardBusy: () => q(fClipboardBusy),
    submit: (draft) => {
      replyField.text = draft;
      root.noteComposerEdit();
      return q(fSubmit);
    },
    submitDisplayed: () => q(fSubmit),
    contentYChanged: () => q(fContentY),
    open: () => q(fOpened, true),
    close: () => q(fOpened, false),
  };
  return api;
}

let failed = 0;
function ok(cond, msg) {
  console.log((cond ? "PASS  " : "FAIL  ") + msg);
  if (!cond) failed++;
}
function group(t) {
  console.log("\n-- " + t);
}

// ---------------------------------------------------------------- (a) restore
group("(a) failed send restores the typed text");
let e = makeEnv({});
e.request("send", { chat: "C1", text: "hello" }, "pending-7");
e.root.messages = [{ id: "pending-7", text: "hello", pending: true }];
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.root.messages.length === 0, "optimistic bubble dropped");
ok(
  e.replyField.text === "hello",
  "text restored: " + JSON.stringify(e.replyField.text),
);
ok(e.root.notice === "boom", "notice shows the daemon error");

e = makeEnv({});
e.request("send", { chat: "C1", text: "hello" }, "pending-7");
e.root.messages = [{ id: "pending-7", text: "hello", pending: true }];
e.replyField.text = "already typing this";
e.onReply(JSON.stringify({ id: 1, ok: false }));
ok(
  e.replyField.text === "already typing this",
  "a non-empty box is never clobbered",
);
ok(
  e.root.messages.length === 1 && e.root.messages[0].failed === true &&
    e.root.messages[0].text === "hello",
  "the failed text remains visible when a newer composer occupies the input",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.submit("A");
const failedA = e.sent[0];
e.replyField.text = "B";
e.replyField.cursorPosition = 1;
e.root.noteComposerEdit();
e.root.saveActiveDraft(false);
e.onReply(JSON.stringify({ id: failedA.id, ok: false, error: "offline" }));
ok(
  e.replyField.text === "B" && e.root.draftStore.ME.C1.text === "B",
  "A failing after B is typed preserves B in the composer and durable draft",
);
ok(
  e.root.messages.some((m) =>
    m.text === "A" &&
    m.pending === true && m.failed === true
  ),
  "A remains surfaced as a failed selectable bubble",
);
ok(
  src.includes('text: tr("send.failedKept")') &&
    src.includes("visible: modelData.failed === true"),
  "the failed bubble is visibly distinguished from a delivered message",
);
e.request("sync", {});
e.onReply(JSON.stringify({ id: 2, ok: true, data: { chats: 1, link: "up" } }));
const refreshedHistory = e.sent.find((frame) =>
  frame.id === 3 && frame.cmd === "history"
);
ok(!!refreshedHistory, "sync requests a fresh history page after A failed");
e.onReply(JSON.stringify({
  id: 3,
  ok: true,
  data: [{
    id: "m-real",
    chat: "C1",
    from: "THEM",
    text: "delivered",
    time: 2,
  }],
}));
ok(
  e.root.messages.some((m) => m.text === "A" && m.failed === true) &&
    e.root.messages.some((m) => m.id === "m-real"),
  "a normal history replacement retains failed A beside delivered messages",
);
ok(
  e.replyField.text === "B" && e.root.draftStore.ME.C1.text === "B",
  "refresh recovery still preserves B in the composer and durable draft",
);
e.root.messages = [
  {
    id: "pending-old",
    from: "ME",
    text: "A",
    time: 1,
    pending: true,
    failed: true,
  },
  { id: "m-oldest-server", from: "THEM", text: "first server row", time: 2 },
  { id: "m-newer", from: "THEM", text: "newer", time: 3 },
];
e.root.loading = false;
e.root.loadingOlder = false;
e.root.noMoreOlder = false;
e.loadOlder();
const recoveryOlder = e.sent.filter((frame) =>
  frame.cmd === "history" && frame.before
).pop();
ok(
  recoveryOlder && recoveryOlder.before === "m-oldest-server",
  "older-history cursor skips a retained local failure",
);
e.root.loadingOlder = false;
e.root.messages = [{ id: "pending-only", pending: true, failed: true }];
const beforeLocalOnly = e.sent.length;
e.loadOlder();
ok(
  e.sent.length === beforeLocalOnly && e.root.loadingOlder === false,
  "local recovery rows alone do not issue an invalid older-history request",
);

// NEW: a reload wiped the bubble before the failure came back
e = makeEnv({});
e.request("send", { chat: "C1", text: "vanished" }, "pending-7");
e.root.messages = [{ id: "pending-7", text: "vanished", pending: true }];
e.root.messages = [{ id: "real-1", text: "someone else" }]; // history reload replaced it
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.replyField.text === "vanished",
  "text restored from pending entry after a reload wiped the bubble",
);

e = makeEnv({ activeChat: { mid: "C1" } });
const recoveryMentionMid = "u" + "2".repeat(32);
e.root.mentionPicks = [{ name: "Amy", mid: recoveryMentionMid, start: 0 }];
e.submit("@Amy A");
const mentionedSend = e.sent[0];
e.replyField.text = "B";
e.root.noteComposerEdit();
e.root.messages = [{
  id: "m-other",
  from: "THEM",
  text: "history replaced it",
}];
e.onReply(
  JSON.stringify({ id: mentionedSend.id, ok: false, error: "offline" }),
);
const reconstructedMention = e.root.messages.find(
  (m) => m.text === "@Amy A" && m.failed === true,
);
ok(
  reconstructedMention && reconstructedMention.failed === true &&
    reconstructedMention.mentions.length === 1 &&
    reconstructedMention.mentions[0].start === 0 &&
    reconstructedMention.mentions[0].end === 4,
  "a failed bubble rebuilt after history keeps renderable mention spans",
);
ok(
  e.bodyHtml(reconstructedMention)
    .includes('<span style="color:#3399ff">@Amy</span>'),
  "the reconstructed mention remains highlighted in rich-text rendering",
);

e = makeEnv({
  draftStore: {
    ME: {
      C1: {
        text: "failed",
        cursor: 6,
        mentions: [{ start: 0, end: 1 }],
        replyTo: { id: "quoted" },
        version: 7,
      },
    },
  },
  draftRevision: 7,
});
e.replyField.text = "failed";
e.root.mentionPicks = [{ start: 0, end: 1 }];
e.root.replyTarget = { id: "quoted" };
e.root.composerGeneration = 1;
e.root.composerGenerationByChat.C1 = 1;
e.root.composerDraftVersionByChat.C1 = 7;
e.request("send", { chat: "C1", text: "failed" }, "pending-failed");
e.root.messages = [{ id: "pending-failed", text: "failed", pending: true }];
e.replyField.text = "";
e.root.mentionPicks = [];
e.root.replyTarget = null;
e.root.composerGeneration = 2;
e.root.composerGenerationByChat.C1 = 2;
e.root.composerDirtyByChat.C1 = true;
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
e.saveActiveDraft(false);
ok(
  e.root.draftRecoveryHolds.C1.version === 7 &&
    e.root.draftRecoveryHolds.C1.emptyGeneration === 2 &&
    e.root.draftStore.ME.C1.text === "failed" &&
    e.root.draftStore.ME.C1.mentions.length === 1 &&
    e.root.draftStore.ME.C1.replyTo.id === "quoted",
  "a failed draft survives after a newer composer edit is erased",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.submit("A");
const erasedNewerSend = e.sent[0];
e.replyField.text = "B";
e.replyField.cursorPosition = 1;
e.root.noteComposerEdit();
e.root.saveActiveDraft(false);
ok(
  e.root.draftStore.ME.C1.text === "B",
  "typing B while A is pending replaces the persisted recovery draft",
);
e.replyField.text = "";
e.replyField.cursorPosition = 0;
e.root.noteComposerEdit();
e.root.saveActiveDraft(false);
ok(
  e.root.draftStore.ME.C1.text === "B",
  "erasing B keeps its saved revision while A is still pending",
);
e.onReply(
  JSON.stringify({ id: erasedNewerSend.id, ok: false, error: "offline" }),
);
ok(
  e.replyField.text === "" && e.root.draftStore.ME.C1.text === "B" &&
    e.root.messages.some((m) => m.text === "A" && m.failed === true),
  "A remains recoverable when the newer composer generation is empty",
);
e.openChat({ mid: "C2" });
e.openChat({ mid: "C1" });
ok(
  e.root.messages.some((m) => m.text === "A" && m.failed === true),
  "switching away and back keeps the failed A recovery row",
);

// ------------------------------------------------------------ (b) one fetch
group("(b) a successful send fetches history exactly once");
e = makeEnv({});
e.request("send", { chat: "C1", text: "hi" }, "pending-7");
e.root.messages = [{ id: "pending-7", text: "hi", pending: true }];
e.onReply(JSON.stringify({ id: 1, ok: true }));
ok(
  e.historyCalls.length === 0,
  "send reply issues no history request (" + e.historyCalls.length + ")",
);
ok(
  e.root.messages.length === 1,
  "optimistic bubble kept until the reload replaces it",
);
// daemon's refreshChats rewrites state.json -> parseState -> the one reload
e.root.chats = [{ mid: "C1", lastTime: 5000 }];
e.parseState(JSON.stringify({ chats: [{ mid: "C1", lastTime: 5000 }] }));
ok(
  e.historyCalls.length === 1,
  "parseState issues exactly one history request",
);
ok(
  e.sent.filter((r) => r.cmd === "history").length === 1,
  "exactly one history frame on the wire",
);

e = makeEnv({});
e.request("sendFile", { chat: "C1", path: "/x" });
e.onReply(JSON.stringify({ id: 1, ok: true }));
ok(e.historyCalls.length === 0, "sendFile reply issues no history request");

// ------------------------------------------------- (c) twoPane Esc / close
group("(c) twoPane keeps the conversation pane populated");
e = makeEnv({ twoPane: true });
e.root.messages = [{ id: "m1" }];
e.root.replyTarget = { id: "quoted", fromName: "A", text: "keep quote" };
e.root.mentionPicks = [{ name: "B", mid: "u2", start: 0 }];
e.back();
ok(e.root.view === "list", "view goes back to list");
ok(
  e.root.activeChat !== null && e.root.messages.length === 1,
  "conversation kept",
);
ok(
  e.root.replyTarget.id === "quoted" && e.root.mentionPicks[0].mid === "u2",
  "two-pane list focus keeps the retained chat's complete composer state",
);
ok(
  e.listFlick.contentY === 0 && e.root.selectedIndex === 0,
  "list scroll/selection still reset",
);

e = makeEnv({ twoPane: false });
e.root.messages = [{ id: "m1" }];
e.back();
ok(
  e.root.activeChat === null && e.root.messages.length === 0,
  "single pane still clears",
);

// ------------------------------------- regression: closed panel must be quiet
group("regression: a message arriving while the panel is closed");
e = makeEnv({ twoPane: true });
e.root.messages = [{ id: "m1" }];
e.close(); // backToList keeps activeChat in twoPane
e.sock.connected = false; // Socket.connected is bound to root.opened
e.root.chats = [{ mid: "C1", lastTime: 9000 }];
e.parseState(JSON.stringify({ chats: [{ mid: "C1", lastTime: 9000 }] }));
ok(
  e.sent.length === 0,
  "no request while closed (" + e.sent.length + " frames)",
);
ok(
  e.root.notice === "",
  "no false 「daemon 沒在跑」 banner: " + JSON.stringify(e.root.notice),
);
ok(e.root.loading === false, "not left stuck in loading");

group("regression: reopening refreshes the kept conversation");
e.sock.connected = true; // socket reconnects with the panel
e.open();
ok(
  e.historyCalls.length === 1,
  "exactly one history request on reopen (" + e.historyCalls.length + ")",
);
ok(e.historyCalls[0] === "C1", "…for the kept chat");
ok(e.root.notice === "", "any stale banner cleared on reopen");

group(
  "regression: reopening before the socket is up defers instead of failing",
);
e = makeEnv({ twoPane: true });
e.root.messages = [{ id: "m1" }];
e.close();
e.sock.connected = false;
e.open(); // socket connect is async: still down here
ok(e.sent.length === 0, "no doomed request while the socket is still down");
ok(e.root.notice === "", "no false banner on reopen");
ok(
  e.root.loadedAt === 0,
  "loadedAt reset so the next heartbeat parseState refetches",
);
e.sock.connected = true;
e.root.chats = [{ mid: "C1", lastTime: 9000 }];
e.parseState(JSON.stringify({ chats: [{ mid: "C1", lastTime: 9000 }] }));
ok(
  e.historyCalls.length === 1,
  "the heartbeat picks it up once the socket is back",
);

// ------------------------------------------------ (d) U14: stale history reply
group("(d) a history reply for a chat that is no longer open is ignored");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.loadHistory("A"); // id 1, chat A
e.root.activeChat = { mid: "B" }; // user opens B before A comes back
e.root.loadHistory("B"); // id 2, chat B
ok(
  e.sent.length === 2 && e.sent[0].chat === "A" && e.sent[1].chat === "B",
  "two history frames in flight, for A then B",
);
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }, { id: "a2" }] }),
);
ok(
  e.root.messages.length === 0,
  "A's late reply does not touch messages (" + e.root.messages.length + ")",
);
ok(
  Object.keys(e.root.historyCache).length === 0,
  "A's late reply does not cache anything under B: " +
    JSON.stringify(Object.keys(e.root.historyCache)),
);
ok(e.root.loading === true, "B's spinner is still running");
e.onReply(JSON.stringify({ id: 2, ok: true, data: [{ id: "b1" }] }));
ok(
  e.root.messages.length === 1 && e.root.messages[0].id === "b1",
  "B's own reply lands",
);
ok(e.root.loading === false, "spinner cleared by B's reply");
ok(
  Object.keys(e.root.historyCache).join() === "B" &&
    e.root.historyCache.B.messages.map((m) => m.id).join() === "b1",
  "cache holds B's messages under B",
);

group("(d2) normal path unchanged: reply for the still-open chat lands");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.loadHistory("A");
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }] }));
ok(e.root.messages.map((m) => m.id).join() === "a1", "messages replaced");
ok(e.root.loading === false, "loading cleared");
ok(
  e.root.historyCache.A.messages.map((m) => m.id).join() === "a1",
  "cached under A",
);

group("(d3) a stale `older` page is not prepended");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.messages = [{ id: "a5" }];
e.request("older", { chat: "A", count: 30, before: "a5" });
e.root.activeChat = { mid: "B" };
e.root.messages = [{ id: "b5" }];
e.root.loadingOlder = true;
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: [{ id: "a3" }, { id: "a4" }] }),
);
ok(
  e.root.messages.map((m) => m.id).join() === "b5",
  "B's messages untouched: " + e.root.messages.map((m) => m.id).join(),
);
ok(
  e.root.loadingOlder === true,
  "B's loadingOlder left alone by A's stale page",
);

group(
  "(d4) replies with no chat on the pending entry still work (send/download)",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.request("history", {}); // no chat key -> never treated as stale
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "x1" }] }));
ok(
  e.root.messages.map((m) => m.id).join() === "x1",
  "untagged history reply is not dropped",
);

group(
  "(d5) no active chat: a late reply clears the spinner instead of hanging",
);
e = makeEnv({ twoPane: false, activeChat: { mid: "A" } });
e.root.loadHistory("A");
e.root.activeChat = null; // backToList in single pane
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }] }));
ok(e.root.messages.length === 0, "messages untouched");
ok(e.root.loading === false, "loading cleared when nothing is open");

// ------------------------------- (e) U18: stale FAILED send must not leak into B
group(
  "(e) stale failed send: text not restored into the other chat's box, no notice",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.request("send", { chat: "A", text: "for A only" }, "pending-7");
e.root.messages = [{ id: "pending-7", text: "for A only", pending: true }];
e.root.activeChat = { mid: "B" }; // user switches before the failure lands
e.root.messages = [{ id: "b1", text: "B's own" }];
e.replyField.text = "";
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.replyField.text === "",
  "A's lost text is NOT restored into B's box: " +
    JSON.stringify(e.replyField.text),
);
ok(
  e.root.notice === "",
  "no error banner for B: " + JSON.stringify(e.root.notice),
);
ok(e.root.messages.map((m) => m.id).join() === "b1", "B's messages untouched");

group("(e2) stale failed send still drops its own optimistic bubble by id");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.request("send", { chat: "A", text: "for A only" }, "pending-7");
e.root.activeChat = { mid: "B" };
e.root.messages = [{ id: "pending-7", text: "for A only", pending: true }, {
  id: "b1",
}];
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.root.messages.map((m) => m.id).join() === "b1",
  "the dead bubble is gone by id: " + e.root.messages.map((m) => m.id).join(),
);
ok(
  e.replyField.text === "" && e.root.notice === "",
  "still no restore, still no notice",
);

group("(e3) stale failed history does not clear the open chat's spinner");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.loadHistory("A");
e.root.activeChat = { mid: "B" };
e.root.loadHistory("B"); // B's spinner is the live one
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.root.loading === true, "B's spinner still running");
ok(
  e.root.notice === "",
  "no banner from A's failure: " + JSON.stringify(e.root.notice),
);

group("(e4) stale failed older touches nothing at all");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.messages = [{ id: "a5" }];
e.request("older", { chat: "A", count: 30, before: "a5" });
e.root.activeChat = { mid: "B" };
e.root.loadingOlder = true;
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.root.loadingOlder === true,
  "B's loadingOlder left alone by A's stale failure",
);
ok(e.root.notice === "", "no banner");

group("(e5) NON-stale failure is unchanged");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.request("send", { chat: "A", text: "hello" }, "pending-7");
e.root.messages = [{ id: "pending-7", text: "hello", pending: true }];
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.replyField.text === "hello", "text restored for the still-open chat");
ok(e.root.notice === "boom", "notice shown");
ok(e.root.messages.length === 0, "bubble dropped");

e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.draftStore = {
  ME: {
    A: {
      text: "old send",
      version: 1,
      replyTo: { id: "old", fromName: "Old", text: "old" },
    },
  },
};
e.request("send", { chat: "A", text: "old send" }, "pending-8");
e.root.messages = [{ id: "pending-8", text: "old send", pending: true }];
e.root.composerGeneration++;
e.root.composerGenerationByChat.A = e.root.composerGeneration;
e.root.replyTarget = { id: "new", fromName: "New", text: "new quote" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.replyField.text === "" && e.root.replyTarget.id === "new",
  "a late send failure does not overwrite a newer quote-only composer",
);

e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.loadHistory("A");
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.root.loading === false, "non-stale history failure clears loading");
ok(e.root.notice === "boom", "non-stale history failure shows the notice");

// an untagged failure (no chat on the pending entry) is never stale
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.request("send", { text: "untagged" }, "pending-9");
e.root.messages = [{ id: "pending-9", text: "untagged" }];
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.replyField.text === "untagged" && e.root.notice === "boom",
  "untagged failure behaves as before",
);

// ------------------------------- (f) U20: logout / account switch wipes state
const S = (status, mid, chats) =>
  JSON.stringify({
    login: { status: status, ...(status === "idle" ? { settled: true } : {}) },
    me: { mid: mid },
    chats: chats || [],
    updatedAt: Date.now(),
  });

group("(f) logging out drops every trace of the previous session");
e = makeEnv({ twoPane: true, activeChat: null, view: "list" });
e.sock.connected = false; // keep parseState off the wire
e.parseState(S("ok", "X"));
ok(
  e.root.sessionMid === "X",
  "session mid remembered: " + JSON.stringify(e.root.sessionMid),
);
// user opens a chat and reads some history
e.root.activeChat = { mid: "C1" };
e.root.view = "chat";
e.root.messages = [{ id: "m1", text: "…" }, { id: "m2", text: "…" }];
e.root.rememberHistory("C1", e.root.messages);
e.root.notice = "boom";
e.root.loading = true;
e.root.loadingOlder = true;
e.replyField.text = "half typed";
ok(
  Object.keys(e.root.historyCache).join() === "C1",
  "cache populated before logout",
);

e.parseState(S("idle", ""));
ok(e.root.activeChat === null, "activeChat cleared");
ok(
  e.root.messages.length === 0,
  "messages cleared (" + e.root.messages.length + ")",
);
ok(
  Object.keys(e.root.historyCache).length === 0,
  "historyCache cleared: " + JSON.stringify(Object.keys(e.root.historyCache)),
);
ok(e.root.view === "list", "view back to list");
ok(
  e.root.notice === "" && !e.root.loading && !e.root.loadingOlder,
  "notice and spinners reset",
);
ok(
  e.replyField.text === "",
  "reply box emptied: " + JSON.stringify(e.replyField.text),
);
ok(e.root.sessionMid === "", "session mid forgotten");

group("(f2) logging back in as a different account starts empty");
e.parseState(S("ok", "Y"));
ok(
  e.root.activeChat === null && e.root.messages.length === 0,
  "still empty after the new login",
);
ok(
  Object.keys(e.root.historyCache).length === 0,
  "no cache carried over: " + JSON.stringify(Object.keys(e.root.historyCache)),
);
ok(e.root.sessionMid === "Y", "new session mid tracked");

group("(f3) switching account without an idle state in between also wipes");
e = makeEnv({ twoPane: true, activeChat: null, view: "list" });
e.sock.connected = false;
e.parseState(S("ok", "X"));
e.root.activeChat = { mid: "C1" };
e.root.messages = [{ id: "m1" }];
e.root.rememberHistory("C1", e.root.messages);
e.parseState(S("ok", "Y")); // ok -> ok, different mid
ok(
  e.root.activeChat === null && e.root.messages.length === 0,
  "direct account swap clears",
);
ok(Object.keys(e.root.historyCache).length === 0, "cache dropped on the swap");

group("(f4) an ordinary heartbeat for the same account clears nothing");
e = makeEnv({ twoPane: true, activeChat: null, view: "list" });
e.sock.connected = false;
e.parseState(S("ok", "X"));
e.root.activeChat = { mid: "C1" };
e.root.view = "chat";
e.root.messages = [{ id: "m1" }];
e.root.rememberHistory("C1", e.root.messages);
e.replyField.text = "half typed";
e.parseState(S("ok", "X", [{ mid: "C1", lastTime: 1 }]));
ok(
  e.root.activeChat !== null && e.root.messages.length === 1,
  "open chat survives the heartbeat",
);
ok(Object.keys(e.root.historyCache).join() === "C1", "cache survives");
ok(e.replyField.text === "half typed", "draft survives");

group("(f4b) a daemon restart refreshes chats even when revision repeats");
e = makeEnv();
e.sock.connected = false;
e.parseState(JSON.stringify({
  bootId: "boot-a",
  chatsRevision: 1,
  login: { status: "ok" },
  me: { mid: "X" },
  chats: [{ mid: "A" }],
}));
e.parseState(JSON.stringify({
  bootId: "boot-b",
  chatsRevision: 1,
  login: { status: "ok" },
  me: { mid: "X" },
  chats: [{ mid: "B" }],
}));
ok(
  e.root.chatSnapshot.length === 1 && e.root.chatSnapshot[0].mid === "B",
  "bootId participates in the revision key",
);

group("(f4c) a failed state-file read cannot leave another account visible");
const failedStateRoot = {
  state: { me: { mid: "OLD" } },
  chatSnapshot: [{ mid: "OLD-CHAT", unread: 9 }],
  chatRevisionSeen: 12,
  chatBootSeen: "old-boot",
};
new Function("root", B.clearStateAfterLoadFailure)(failedStateRoot);
ok(
  failedStateRoot.state === null && failedStateRoot.chatSnapshot.length === 0 &&
    failedStateRoot.chatRevisionSeen === -1 &&
    failedStateRoot.chatBootSeen === "",
  "load failure clears the cached rows and revision identity",
);
ok(
  /onLoadFailed: root\.clearStateAfterLoadFailure\(\)/.test(src),
  "FileView routes read failures through the snapshot invalidation",
);

group("(f5) a state file with no login block is not mistaken for a logout");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" }, view: "chat" });
e.sock.connected = false;
e.root.messages = [{ id: "m1" }];
e.parseState(JSON.stringify({ chats: [] })); // pre-login-block state.json
ok(
  e.root.messages.length === 1 && e.root.activeChat !== null,
  "nothing cleared without a prior session",
);

group("(f6) a new login cannot cancel cleanup waiting on the draft file");
e = makeEnv();
e.sock.connected = false;
e.root.draftStoreLoaded = false;
e.root.clearLastDraftOnLoad = true;
e.parseState(S("ok", "NEW"));
ok(
  e.root.clearLastDraftOnLoad === true,
  "delayed cleanup remains armed until loadDraftStore applies it",
);

// ------------------------- (g) U21: loadingOlder never leaks across chats
group("(g) openChat resets loadingOlder so the new chat can page back");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.messages = [{ id: "a5" }];
e.loadOlder(); // A's older page goes out
ok(
  e.root.loadingOlder === true,
  "loadingOlder set while A's page is in flight",
);
const older = (r) => r.cmd === "history" && r.before !== undefined;
ok(
  e.sent.length === 1 && older(e.sent[0]) && e.sent[0].chat === "A",
  "one older frame for A on the wire",
);
e.openChat({ mid: "B" }); // switch before A's page returns
ok(e.root.loadingOlder === false, "loadingOlder cleared by openChat");
e.onReply(JSON.stringify({ id: 2, ok: true, data: [{ id: "b9" }] })); // B's history lands
ok(
  e.root.loading === false && e.root.messages.map((m) => m.id).join() === "b9",
  "B's history in place",
);
e.loadOlder();
ok(
  e.sent.filter((r) => older(r) && r.chat === "B" && r.before === "b9")
    .length === 1,
  "loadOlder() for B issues a request: " +
    JSON.stringify(e.sent.filter(older).map((r) => r.chat + "/" + r.before)),
);

group("(g2) the stale page arriving afterwards is still a no-op for B");
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "a3" }] }));
ok(
  e.root.messages.map((m) => m.id).join() === "b9",
  "A's late page not prepended to B: " +
    e.root.messages.map((m) => m.id).join(),
);

group("(g3) backToList resets loadingOlder");
e = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
e.root.messages = [{ id: "a5" }];
e.loadOlder();
ok(e.root.loadingOlder === true, "in flight before leaving");
e.back();
ok(e.root.loadingOlder === false, "loadingOlder cleared by backToList");
ok(e.root.loading === false, "loading still cleared too");

group("(g4) openChat is otherwise unchanged");
e = makeEnv({ twoPane: true, activeChat: null, view: "list" });
e.root.historyCache = { C1: { at: 1, messages: [{ id: "c1" }] } };
e.openChat({ mid: "C1" });
ok(
  e.root.messages.map((m) => m.id).join() === "c1",
  "cached messages pasted in",
);
ok(
  e.root.view === "chat" && e.root.activeChat.mid === "C1",
  "view switched to the chat",
);
ok(e.historyCalls.join() === "C1", "history still refetched once");

// ------------- (h) U22: a stale `older` reply never touches loadingOlder
// U21 resets the flag on openChat, so the flag always belongs to the chat that
// is open now. A late reply clearing it would let the open chat fire a second
// concurrent older page and break dedup / the prepend anchor.
const olderFrame = (r) => r.cmd === "history" && r.before !== undefined;

function envWithBothOlderInFlight() {
  const x = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
  x.root.messages = [{ id: "a5" }];
  x.loadOlder(); // id 1, A's older
  x.openChat({ mid: "B" }); // id 2, B's history
  x.onReply(JSON.stringify({ id: 2, ok: true, data: [{ id: "b9" }] }));
  x.loadOlder(); // id 3, B's older
  return x;
}

group("(h1) stale older FAILURE leaves B's loadingOlder set");
e = envWithBothOlderInFlight();
ok(e.root.loadingOlder === true, "B's older is in flight");
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.root.loadingOlder === true, "still in flight after A's stale failure");
ok(e.root.notice === "", "no banner for B");
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 2,
  "no third older frame — B's page is still deduped: " +
    JSON.stringify(
      e.sent.filter(olderFrame).map((r) => r.chat + "/" + r.before),
    ),
);

group("(h2) stale older SUCCESS leaves B's loadingOlder set");
e = envWithBothOlderInFlight();
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: [{ id: "a3" }, { id: "a4" }] }),
);
ok(e.root.loadingOlder === true, "still in flight after A's stale page");
ok(
  e.root.messages.map((m) => m.id).join() === "b9",
  "A's page not prepended to B: " + e.root.messages.map((m) => m.id).join(),
);
ok(e.root.prependAnchorIndex === -1, "no prepend anchor armed");
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 2,
  "still no duplicate older frame for B",
);

group("(h3) B's own older reply still clears the flag and prepends");
e = envWithBothOlderInFlight();
e.msgList.contentHeight = 400;
e.onReply(
  JSON.stringify({ id: 3, ok: true, data: [{ id: "b7" }, { id: "b8" }] }),
);
ok(e.root.loadingOlder === false, "loadingOlder cleared by B's own reply");
ok(
  e.root.messages.map((m) => m.id).join() === "b7,b8,b9",
  "B's older page prepended",
);
ok(
  e.root.prependAnchorIndex === 2,
  "the anchor is the index the old first message moved to",
);
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 3,
  "B can page back again once the flag is clear",
);

group("(h4) B's own older FAILURE still clears the flag");
e = envWithBothOlderInFlight();
e.onReply(JSON.stringify({ id: 3, ok: false, error: "boom" }));
ok(e.root.loadingOlder === false, "loadingOlder cleared by B's own failure");
ok(e.root.notice === "", "an older failure stays silent");

// ---- (h5) U70: a reload of the SAME chat outdates the older page in flight
// The check above is per-chat, so an `older` reply that lands after the same
// conversation was reloaded underneath it looked perfectly current -- and any
// of a new message, 同步, a reconnect or a reopened panel reloads it, none of
// them cancelling or even noticing the page already in flight. Its dedup is
// computed when the reply arrives, against the messages the reload has just
// put on screen, so a page of genuinely old messages is spliced in front of
// new ones: a gap in the middle of the conversation and no error anywhere.
// It cannot happen today only because the daemon answers one request at a
// time (daemon/dispatch_test.ts pins that end); the panel no longer relies on
// it -- every older frame carries the generation it was asked in.

function envReloadedUnderOlder() {
  const x = makeEnv({ twoPane: true, activeChat: { mid: "A" } });
  x.root.messages = [{ id: "a5" }, { id: "a6" }];
  x.loadOlder(); // id 1, the page above a5
  x.root.loadHistory("A"); // id 2, the same chat, reloaded
  x.onReply(JSON.stringify({ id: 2, ok: true, data: [{ id: "a9" }] }));
  return x;
}

group("(h5) the outdated page is dropped whole, not prepended");
e = envReloadedUnderOlder();
ok(
  e.root.messages.map((m) => m.id).join() === "a9",
  "the reload is what is on screen",
);
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }, { id: "a2" }] }),
);
ok(
  e.root.messages.map((m) => m.id).join() === "a9",
  "a1,a2 not glued in front of the reloaded history: " +
    e.root.messages.map((m) => m.id).join(),
);
ok(e.root.prependAnchorIndex === -1, "no prepend anchor armed");
ok(e.root.noMoreOlder === false, "noMoreOlder untouched");

group("(h6) an outdated EMPTY page is not 'there is nothing older'");
e = envReloadedUnderOlder();
e.onReply(JSON.stringify({ id: 1, ok: true, data: [] }));
ok(
  e.root.noMoreOlder === false,
  "the empty answer was about the page above a5, which is not what is on screen",
);

group("(h7) the chat can still page back after an outdated page is dropped");
e = envReloadedUnderOlder();
ok(
  e.root.loadingOlder === false,
  "the reload took the flag over from the dropped trip",
);
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }] }));
ok(
  e.root.loadingOlder === false,
  "still clear after the outdated page is dropped",
);
e.loadOlder();
// Read the frames out once: with the hand-over broken this list is short, and
// an assertion that indexes into it blindly reports a TypeError instead of the
// failure it was written for.
const pagedAgain = e.sent.filter(olderFrame);
ok(
  pagedAgain.length === 2,
  "a second older frame goes out: " +
    JSON.stringify(pagedAgain.map((r) => r.before)),
);
ok(
  pagedAgain.length === 2 && pagedAgain[1].before === "a9",
  "and it is anchored on the reloaded history, not on the old messages[0]: " +
    JSON.stringify(pagedAgain.map((r) => r.before)),
);

group("(h8) the page asked for after the reload still lands");
e = envReloadedUnderOlder();
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }] })); // dropped
e.loadOlder(); // id 3
e.onReply(
  JSON.stringify({ id: 3, ok: true, data: [{ id: "a7" }, { id: "a8" }] }),
);
ok(
  e.root.messages.map((m) => m.id).join() === "a7,a8,a9",
  "the current generation's page is prepended as before: " +
    e.root.messages.map((m) => m.id).join(),
);
ok(e.root.prependAnchorIndex === 2, "the anchor is the index a9 moved to");
ok(e.root.loadingOlder === false, "and its own reply clears the flag");

// Two older trips in flight in one chat -- the dropped one must not clear a
// flag it no longer owns, or the chat fires a second concurrent page and the
// dedup / anchor breakage this whole section is about happens anyway.
function envSameChatBothOlderInFlight() {
  const x = envReloadedUnderOlder();
  x.loadOlder(); // id 3, the current generation
  return x;
}

group("(h9) an outdated older SUCCESS leaves the current page's flag set");
e = envSameChatBothOlderInFlight();
ok(e.root.loadingOlder === true, "the current older page is in flight");
e.onReply(JSON.stringify({ id: 1, ok: true, data: [{ id: "a1" }] }));
ok(e.root.loadingOlder === true, "still in flight after the outdated page");
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 2,
  "no third older frame — the current page is still deduped: " +
    JSON.stringify(
      e.sent.filter(olderFrame).map((r) => r.chat + "/" + r.before),
    ),
);

group("(h10) an outdated older FAILURE leaves the current page's flag set");
e = envSameChatBothOlderInFlight();
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.root.loadingOlder === true, "still in flight after the outdated failure");
ok(e.root.notice === "", "an older failure stays silent");
e.loadOlder();
ok(e.sent.filter(olderFrame).length === 2, "still no duplicate older frame");

let keys;
// ------------------------------------------------- (i) history cache stays <= 20
// Found in review: only one entry was evicted per call, so a cache that ever went
// over 20 (older builds, or several chats remembered in one burst) never came back
// down; and `at` could be undefined or a string, which sorted the wrong entries out.

function seededCache(n) {
  const c = {};
  for (let i = 0; i < n; i++) {
    let at = i; // K0 is the oldest, K{n-1} the newest
    if (i === 3 || i === 7) at = undefined; // pre-`at` entries from an older build
    if (i === 11 || i === 12) at = String(i); // JSON round-trip left it a string
    c["K" + i] = { at: at, messages: [{ id: "m" + i }] };
  }
  return c;
}

group("(i1) 25 seeded entries with mixed/undefined `at` end at exactly 20");
e = makeEnv();
const before = seededCache(25);
e.root.historyCache = before;
e.root.rememberHistory("NEW", [{ id: "n1" }]);
keys = Object.keys(e.root.historyCache);
ok(keys.length === 20, "cache size is exactly 20, got " + keys.length);
ok(e.root.historyCache !== before, "a new object was assigned (binding fires)");

group("(i2) the newest entries survive, the oldest are the ones dropped");
ok(!!e.root.historyCache["NEW"], "the chat just remembered is kept");
ok(
  !!e.root.historyCache["K24"] && !!e.root.historyCache["K23"],
  "newest seeds kept",
);
ok(!!e.root.historyCache["K5"], "K5 is the oldest survivor");
["K0", "K1", "K2", "K4"].forEach((k) =>
  ok(!(k in e.root.historyCache), k + " (low `at`) evicted")
);
["K3", "K7"].forEach((k) =>
  ok(!(k in e.root.historyCache), k + " (undefined `at` -> 0) evicted")
);
ok(
  !!e.root.historyCache["K11"] && !!e.root.historyCache["K12"],
  "string `at` is compared as a number, not lexically, so K11/K12 stay",
);
ok(
  e.root.historyCache["K24"].messages[0].id === "m24",
  "survivors keep their messages",
);

group("(i3) a single call can shed however many entries it takes");
e = makeEnv();
e.root.historyCache = seededCache(40);
e.root.rememberHistory("NEW", []);
ok(
  Object.keys(e.root.historyCache).length === 20,
  "40 + 1 collapses to 20 in one call, got " +
    Object.keys(e.root.historyCache).length,
);

group(
  "(i4) under the cap nothing is evicted, and re-remembering does not grow it",
);
e = makeEnv();
e.root.historyCache = seededCache(19);
e.root.rememberHistory("NEW", []);
ok(Object.keys(e.root.historyCache).length === 20, "19 + 1 = 20, no eviction");
e.root.rememberHistory("K5", []);
keys = Object.keys(e.root.historyCache);
ok(
  keys.length === 20,
  "remembering an existing chat replaces in place, got " + keys.length,
);
ok(keys.filter((k) => k === "K5").length === 1, "no duplicate key for K5");
ok(
  e.root.historyCache["K5"].at > 0,
  "the refreshed entry gets a real timestamp",
);

group("(i5) optimistic bubbles are still stripped before caching");
e = makeEnv();
e.root.rememberHistory("C9", [{ id: "a" }, { id: "b", pending: true }]);
ok(
  e.root.historyCache["C9"].messages.map((m) => m.id).join() === "a",
  "pending message not cached",
);

// --------------------------------------------------- (j) link / login.reason
// Both fields are optional in the contract: stub.py and any older daemon send
// neither, and the panel has to render identically when they are absent. That
// is what (j1) and (j5, first case) exist to hold down.
const NOW = 1700000000000;
const stateWith = (extra) =>
  Object.assign({
    updatedAt: NOW,
    me: { mid: "ME" },
    login: { status: "ok" },
    chats: [],
  }, extra);
const notice = (opts) => makeStatusRoot(opts).linkNoticeText();

group("(j1) link absent reads as healthy, never as broken");
ok(notice({ state: null }) === "", "no state at all -> no notice");
ok(notice({ state: stateWith({}) }) === "", "state without link -> no notice");
ok(
  notice({ state: stateWith({ link: {} }) }) === "",
  "link with no push -> no notice",
);
ok(
  notice({ state: stateWith({ link: { push: "??" } }) }) === "",
  "an unknown push value is not treated as down",
);

group("(j2) link up says nothing");
ok(
  notice({ state: stateWith({ link: { push: "up", since: NOW - 60000 } }) }) ===
    "",
  "push up -> no notice",
);

group("(j3) link down says so, with how long it has been down");
// The trailing 「，點此立即重連」 is the affordance: the line is the button, and
// nothing else on screen says so. It has to survive every branch below.
ok(
  notice({
    state: stateWith({ link: { push: "down", since: NOW - 180000 } }),
  }) ===
    "LINE 連線中斷，重連中（3 分），點此立即重連",
  "down 3 minutes ago",
);
ok(
  notice({
    state: stateWith({ link: { push: "down", since: NOW - 5000 } }),
  }) ===
    "LINE 連線中斷，重連中（剛剛），點此立即重連",
  "down seconds ago",
);
ok(
  notice({
    state: stateWith({ link: { push: "down", since: NOW - 2 * 3600000 } }),
  }) ===
    "LINE 連線中斷，重連中（2 時），點此立即重連",
  "down two hours ago",
);
// agoText returns "" for a missing/zero timestamp, and an empty 「（）」 would
// read as a rendering bug rather than a missing field.
ok(
  notice({ state: stateWith({ link: { push: "down" } }) }) ===
    "LINE 連線中斷，重連中，點此立即重連",
  "down without `since` drops the parenthetical, keeps the affordance",
);

group("(j4) DAEMON 離線 outranks the link line");
ok(
  notice({
    online: false,
    state: stateWith({ link: { push: "down", since: NOW - 60000 } }),
  }) ===
    "",
  "an offline daemon shows its own hero, not a link notice",
);

group("(j5) login.reason picks the advice; without it the old text stands");
const detailFor = (extra) =>
  makeStatusRoot({
    state: stateWith({
      login: Object.assign(
        { status: "error", error: "RequestError: boom" },
        extra,
      ),
    }),
  }).loginErrorDetail();
ok(
  detailFor({}) === "RequestError: boom",
  "no reason -> the raw daemon text, as before",
);
ok(
  detailFor({ reason: "token_expired" }) === "登入已過期，請重新掃描",
  "token_expired",
);
ok(detailFor({ reason: "network" }) === "連不上 LINE，稍後重試", "network");
ok(
  detailFor({ reason: "unknown" }) === "RequestError: boom",
  "unknown -> the raw text",
);
ok(
  detailFor({ reason: "wat" }) === "RequestError: boom",
  "an unrecognised reason falls back rather than showing nothing",
);
ok(
  makeStatusRoot({ state: null }).loginErrorDetail() === "",
  "no login object -> empty",
);
ok(
  makeStatusRoot({ state: stateWith({ login: { status: "error" } }) })
    .loginErrorDetail() === "",
  'no error text either -> empty, not "undefined"',
);

// --------------------------------------------------- (j6-j9) U73: refresh
// The talk side's health. `refresh` is optional like `link`, and it is a
// different wire: on 09-11 push was rebuilt healthy on resume while every
// getMessageBoxes round sat on a dead pooled connection -- link "up", chats
// 22 hours old, and the panel said nothing for 18 minutes.
group("(j6) refresh absent or healthy says nothing -- the field is optional");
ok(
  notice({ state: stateWith({}) }) === "",
  "state without refresh -> no notice",
);
ok(
  notice({ state: stateWith({ refresh: {} }) }) === "",
  "refresh with no failures -> no notice",
);
ok(
  notice({
    state: stateWith({ refresh: { at: NOW - 600000, failures: 0 } }),
  }) === "",
  "failures 0 -> no notice",
);

group("(j7) one failure stays quiet, two say the list may be stale");
// One 30s timeout happens on a mobile hotspot; a single miss must not shout.
ok(
  notice({
    state: stateWith({
      refresh: { at: NOW - 600000, failures: 1, reason: "network" },
    }),
  }) ===
    "",
  "a single failure is not worth a banner",
);
// The trailing 「，點此立即重連」 is the same affordance as the link line: the
// line is the button, wired to the same syncNow.
ok(
  notice({
    state: stateWith({
      refresh: { at: NOW - 600000, failures: 2, reason: "network" },
    }),
  }) ===
    "LINE 清單可能過期（最後更新 10 分前），點此立即重連",
  "two failures, 10 minutes stale",
);
// 09-11's acceptance: at the second timeout (10:41:14) the last success was
// ~22 hours old, and this exact state has to put words on screen -- the real
// outage showed 連線正常 until 10:57:36.
ok(
  notice({
    state: stateWith({
      refresh: { at: NOW - 22 * 3600000, failures: 2, reason: "network" },
    }),
  }) ===
    "LINE 清單可能過期（最後更新 22 時前），點此立即重連",
  "the 09-11 shape shows the banner",
);
ok(
  notice({
    state: stateWith({
      refresh: { at: NOW - 3 * 86400000, failures: 33, reason: "network" },
    }),
  }) ===
    "LINE 清單可能過期（最後更新 3 天前），點此立即重連",
  "a long streak reads the same way",
);
// agoText returns "" for a missing/zero `at` and 「剛剛」 inside a minute;
// 「最後更新剛剛前」 is not a sentence, and an empty 「（）」 reads as a bug.
ok(
  notice({
    state: stateWith({ refresh: { failures: 2, reason: "network" } }),
  }) ===
    "LINE 清單可能過期，點此立即重連",
  "no `at` drops the parenthetical, keeps the affordance",
);
ok(
  notice({
    state: stateWith({
      refresh: { at: NOW - 5000, failures: 2, reason: "network" },
    }),
  }) ===
    "LINE 清單可能過期，點此立即重連",
  "an update seconds ago drops it too, rather than saying 剛剛前",
);

group("(j7b) an incomplete server page is explicit, including search scope");
ok(
  notice({
    state: stateWith({ chatList: { complete: false, loaded: 500 } }),
  }) ===
    "目前顯示 500 個聊天室，尚有聊天室未載入",
  "hasNext is visible rather than silently looking complete",
);
ok(
  notice({
    search: "媽媽",
    state: stateWith({ chatList: { complete: false, loaded: 500 } }),
  }) ===
    "目前顯示 500 個聊天室，尚有聊天室未載入；搜尋範圍僅限已載入資料",
  "search says its result set is partial",
);
ok(
  notice({
    online: false,
    search: "媽媽",
    state: stateWith({ chatList: { complete: false, loaded: 500 } }),
  }) ===
    "目前顯示 500 個聊天室，尚有聊天室未載入；搜尋範圍僅限已載入資料",
  "an offline heartbeat cannot hide the incomplete search scope",
);
ok(
  notice({
    state: stateWith({
      link: { push: "down", since: NOW - 180000 },
      chatList: { complete: false, loaded: 500 },
    }),
  }).includes("LINE 連線中斷") &&
    notice({
      state: stateWith({
        link: { push: "down", since: NOW - 180000 },
        chatList: { complete: false, loaded: 500 },
      }),
    }).includes("尚有聊天室未載入"),
  "a down link keeps the independent incomplete-list warning",
);
ok(
  notice({
    search: "媽媽",
    state: stateWith({
      chatList: { complete: false, loaded: 500 },
      refresh: { at: NOW - 600000, failures: 2, reason: "network" },
    }),
  }).includes("LINE 清單可能過期") &&
    notice({
      search: "媽媽",
      state: stateWith({
        chatList: { complete: false, loaded: 500 },
        refresh: { at: NOW - 600000, failures: 2, reason: "network" },
      }),
    }).includes("搜尋範圍僅限已載入資料"),
  "refresh failures keep the incomplete-list and search-scope warning",
);
ok(
  notice({
    state: stateWith({ chatList: { complete: true, loaded: 500 } }),
  }) === "",
  "a complete page adds no banner",
);

group(
  "(j8) the link line outranks the refresh line, and offline outranks both",
);
// A down link cannot fetch a list either, and it is the more fundamental of
// the two -- printing both would say the same thing twice.
ok(
  notice({
    state: stateWith({
      link: { push: "down", since: NOW - 180000 },
      refresh: { at: NOW - 600000, failures: 5, reason: "network" },
    }),
  }) ===
    "LINE 連線中斷，重連中（3 分），點此立即重連",
  "both broken -> the link line only",
);
ok(
  notice({
    state: stateWith({
      link: { push: "up", since: NOW - 60000 },
      refresh: { at: NOW - 600000, failures: 2, reason: "network" },
    }),
  }) ===
    "LINE 清單可能過期（最後更新 10 分前），點此立即重連",
  "push up + refresh failing is exactly the 09-11 hole, and now it has words",
);
ok(
  notice({
    online: false,
    state: stateWith({ refresh: { at: 1, failures: 9, reason: "network" } }),
  }) ===
    "",
  "an offline daemon shows its own hero, not a stale-list notice",
);

group("(j9) the unread badge never reads refresh -- stale is not zero");
// The counts were fetched before the outage; they are real, just old. The
// badge rules are one-liner bindings, so pin structurally that neither one
// can see the field at all. (rhs and lines are hoisted from the (x3) block.)
ok(
  !/refresh/.test(rhs("readonly property var unreadChats:")),
  "unreadChats does not read state.refresh",
);
ok(
  !/refresh/.test(rhs("readonly property int totalUnread:")),
  "totalUnread does not read state.refresh",
);

// ------------------------------------------- (k) U33: attachments actually open
group(
  "(k) openMedia sends chat -- without it LINE answers Invalid messageBoxId",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9");
const dl = e.sent.filter((r) => r.cmd === "download");
ok(dl.length === 1, "one download frame on the wire (" + dl.length + ")");
ok(
  dl[0] && dl[0].chat === "C1",
  "download carries chat: " + JSON.stringify(dl[0] && dl[0].chat),
);
ok(
  dl[0] && dl[0].messageId === "m9" && dl[0].preview === false,
  "messageId + preview:false kept",
);
ok(
  e.root.openWanted["m9"].intent === "external",
  "the id is marked wanted, with what to do when it lands: " +
    JSON.stringify(e.root.openWanted["m9"]),
);

e = makeEnv({ twoPane: true, activeChat: null });
e.openMedia("m9");
ok(e.sent.length === 0, "no chat open -> nothing is sent");

group("(k2b) a retired session's late download cannot open its file");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9");
e.root.sessionEpoch++; // the session that asked ended before the bytes landed
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/x.pdf" } }));
ok(
  e.execed.length === 0 && e.root.openWanted["m9"] === undefined,
  "the wanted file of an ended session is dropped, not opened",
);

group("(k2) the reply still opens the file after the user switched chat");
// Changed in U36: the viewer used to be a single reused `opener` Process, which
// meant a second file could not open while the first viewer lived. It is now
// execDetached, and the panel closes first -- it is a full-screen Overlay, so an
// xdg-open window that came up behind it was invisible.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9");
e.root.activeChat = { mid: "C2" }; // download is now "stale" by chat
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/x.pdf" } }));
ok(
  e.execed.length === 1 && e.execed[0][0] === "xdg-open" &&
    e.execed[0][1] === "/tmp/x.pdf",
  "xdg-open ran anyway: " + JSON.stringify(e.execed),
);
ok(e.root.closed === 1, "the panel closed first so the viewer is visible");
ok(e.root.openWanted["m9"] === undefined, "the wanted mark is cleared");

group("(k4) a failed download is never silent, even after switching chat");
// The ok:true path deliberately ignores `stale` (the user asked, so open it);
// the failure path has to be symmetric or a stale error vanishes with no notice.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9");
e.root.activeChat = { mid: "C2" }; // stale by chat, as in (k2)
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.root.notice === "boom",
  "a stale download failure still shows: " + JSON.stringify(e.root.notice),
);
ok(e.root.openWanted["m9"] === undefined, "and the wanted mark is cleared");
ok(
  e.execed.length === 0 && e.root.closed === 0,
  "nothing is opened on a failure",
);

e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9");
e.root.activeChat = { mid: "C2" };
e.onReply(JSON.stringify({ id: 1, ok: false }));
ok(
  e.root.notice === "下載失敗",
  'no error text -> a default notice, not "undefined"',
);

e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9");
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" })); // not stale
ok(e.root.notice === "boom", "a plain download failure still shows");
ok(e.root.openWanted["m9"] === undefined, "and clears the mark too");

// The other stale failures stay silent: a send that failed in chat A must not
// put a notice on chat B's pane.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{ id: "t1", text: "hi" }];
e.request("send", { chat: "C1", text: "hi" }, "t1");
e.root.activeChat = { mid: "C2" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.root.notice === "",
  "a stale send failure leaves notice untouched: " +
    JSON.stringify(e.root.notice),
);
ok(e.root.messages.length === 0, "but the optimistic bubble is still dropped");
ok(e.replyField.text === "", "and chat B's input box is not touched");

group("(k3) the picker reports a missing zenity instead of doing nothing");
// The picker is a Process declaration, not a function, so it is asserted against
// the source text: the guard has to survive future edits to that block.
const pickerBlock = src.slice(
  src.indexOf("    id: picker"),
  src.indexOf(
    "  function pickFile(submitComposer, expectedGeneration, expectedChat, expectedVersion)",
  ),
);
ok(
  /command\s*:\s*\["sh",\s*"-c"/.test(pickerBlock),
  "the picker runs through sh -c",
);
ok(pickerBlock.includes("command -v zenity"), "sh -c checks for zenity first");
ok(
  pickerBlock.includes("__NO_ZENITY__"),
  "a missing zenity prints the sentinel",
);
ok(
  pickerBlock.includes("exec zenity --file-selection"),
  "zenity still replaces the shell, so stdout is the chosen path",
);
ok(
  /path === "__NO_ZENITY__"/.test(pickerBlock) &&
    pickerBlock.includes('tr("zenity.missing")'),
  "the sentinel becomes a visible notice",
);
// Cancel prints nothing; that must stay silent rather than nag.
ok(
  pickerBlock.includes("picker.originAccount === root.myMid") &&
    pickerBlock.includes("picker.originSession === root.sessionEpoch") &&
    /else if \(path\.length > 0\)/.test(pickerBlock),
  "an empty stdout (cancel) is still silent",
);

// ------------------------------------------------------------- (l) lightbox
group(
  "(l1) clicking a picture opens the lightbox at once and asks for the original",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [
  {
    id: "m1",
    contentType: "IMAGE",
    hasMedia: true,
    mediaPath: "/p/a.jpg",
    fileName: "a.jpg",
  },
  { id: "m2", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/b.jpg" },
];
e.showPicture("m1", "file:///p/a.jpg", "a.jpg");
ok(e.root.lightbox !== null, "the lightbox is open");
ok(
  e.root.lightbox.source === "file:///p/a.jpg",
  "it shows the preview immediately: " + JSON.stringify(e.root.lightbox.source),
);
ok(
  e.root.lightbox.id === "m1" && e.root.lightbox.index === 0,
  "id and position are recorded",
);
const lbDl = e.sent.filter((r) => r.cmd === "download");
ok(
  lbDl.length === 1 && lbDl[0].chat === "C1" && lbDl[0].messageId === "m1" &&
    lbDl[0].preview === false,
  "the full-size download still carries chat + preview:false",
);
ok(
  e.focused[e.focused.length - 1] === "keyCatcher",
  "focus moves to the key catcher so Esc/arrows are not eaten by the reply box",
);
ok(
  e.root.lightScale === 1 && e.root.lightX === 0,
  "zoom and pan start neutral",
);

group("(l2) the download reply swaps in the original without closing anything");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } }));
ok(
  e.root.lightbox.source === "file:///full/a.jpg",
  "source swapped to the full-size file: " +
    JSON.stringify(e.root.lightbox.source),
);
ok(e.execed.length === 0, "no external viewer is launched for a picture");
ok(e.root.closed === 0, "and the panel stays open");
ok(
  e.root.openWanted["m1"] === undefined,
  "the wanted mark is cleared either way",
);

// A failed download leaves the preview on screen -- an empty lightbox would be
// worse than a slightly smaller picture.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.root.lightbox.source === "file:///p/a.jpg",
  "the preview is still showing",
);
ok(e.root.notice === "boom", "and the failure is visible");

group("(l3) files open externally, and a second one is no longer a no-op");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("f1");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
ok(e.root.closed === 1, "close() ran before the viewer");
ok(
  e.execed.length === 1 && e.execed[0].join(" ") === "xdg-open /tmp/one.pdf",
  "execDetached got the argv: " + JSON.stringify(e.execed[0]),
);
// The old `opener` Process was a single instance: while the first viewer lived,
// `opener.running = true` was a no-op and the second click opened nothing.
e.openMedia("f2");
e.onReply(JSON.stringify({ id: 2, ok: true, data: { path: "/tmp/two.pdf" } }));
ok(
  e.execed.length === 2 && e.execed[1].join(" ") === "xdg-open /tmp/two.pdf",
  "a second file opens too: " + JSON.stringify(e.execed[1]),
);
ok(e.root.closed === 2, "and the panel is closed for it as well");

// `o` in the lightbox: hand the picture to the external viewer and get out of
// the way. The lightbox closes first, so the reply cannot land back in it.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } })); // original landed
e.openExternally();
ok(e.root.lightbox === null, "the lightbox is gone");
ok(
  e.root.closed === 1 && e.execed.length === 1 &&
    e.execed[0].join(" ") === "xdg-open /full/a.jpg",
  "the original, with the file:// prefix stripped: " +
    JSON.stringify(e.execed[0]),
);

group("(l4) pictureList keeps order, drops what cannot be shown");
e = makeEnv({});
const pl = e.pictureList([
  { id: "t", contentType: "NONE", text: "hi" },
  {
    id: "m1",
    contentType: "IMAGE",
    hasMedia: true,
    mediaPath: "/p/a.jpg",
    fileName: "a.jpg",
  },
  { id: "m2", contentType: "IMAGE", hasMedia: true }, // preview not fetched yet
  { id: "m3", contentType: "VIDEO", hasMedia: true, mediaPath: "/p/v.mp4" },
  {
    id: "m4",
    contentType: "FLEX",
    flexImages: ["https://c/1.png", "https://c/2.png"],
  },
  { id: "m5", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/b.jpg" },
]);
ok(
  pl.length === 4,
  "four viewable pictures out of six messages (" + pl.length + ")",
);
ok(
  pl[0].source === "file:///p/a.jpg" && pl[0].id === "m1" &&
    pl[0].name === "a.jpg",
  "the IMAGE keeps its id and file name",
);
ok(
  pl[1].source === "https://c/1.png" && pl[2].source === "https://c/2.png",
  "each FLEX bubble is its own step, in order",
);
ok(
  pl[1].id === "" && pl[2].id === "",
  "FLEX pictures carry no id: there is no original to download",
);
ok(pl[3].source === "file:///p/b.jpg", "the later IMAGE comes last");
ok(pl.every((p) => p.source.indexOf("v.mp4") < 0), "a video is not a picture");
ok(
  e.pictureList(undefined).length === 0,
  "a missing message list is empty, not a crash",
);

// ←/→ walk that list and stop at both ends rather than wrapping.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [
  { id: "m1", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/a.jpg" },
  { id: "m4", contentType: "FLEX", flexImages: ["https://c/1.png"] },
];
e.showPicture("", "https://c/1.png", "圖片");
ok(
  e.root.lightbox.index === 1,
  "showPicture found the FLEX picture's position",
);
e.stepPicture(-1);
ok(
  e.root.lightbox.index === 0 && e.root.lightbox.source === "file:///p/a.jpg",
  "left steps back to the earlier picture",
);
e.stepPicture(-1);
ok(e.root.lightbox.index === 0, "and stops at the first one");
e.stepPicture(1);
e.stepPicture(1);
ok(e.root.lightbox.index === 1, "right stops at the last one");

group("(l5) zoomAt clamps to 1x-4x and keeps the point under the cursor still");
e = makeEnv({});
let z = e.zoomAt(1, 0, 0, 0, 0, 2);
ok(
  z.scale === 2 && z.x === 0 && z.y === 0,
  "zooming on the centre needs no pan",
);
z = e.zoomAt(1, 0, 0, 50, 20, 2);
ok(
  z.scale === 2 && z.x === -50 && z.y === -20,
  "zooming on a corner pans it back: " + z.x,
);
// The screen position of the content point under the cursor must not move:
// pos = centre + p*scale + pan, so (cx - pan)/scale is invariant.
const fixedBefore = (50 - 0) / 1, fixedAfter = (50 - z.x) / z.scale;
ok(
  Math.abs(fixedBefore - fixedAfter) < 1e-9,
  "the pixel under the cursor is the same one: " + fixedAfter,
);
ok(e.zoomAt(3.5, 0, 0, 0, 0, 4).scale === 4, "4x is the ceiling");
z = e.zoomAt(1.2, 30, 30, 10, 10, 0.1);
ok(z.scale === 1 && z.x === 0 && z.y === 0, "falling to 1x resets the pan too");
ok(e.zoomAt(1, 0, 0, 0, 0, 0.5).scale === 1, "1x is the floor");

group("(l6) Esc closes the lightbox only, and gives focus back");
e = makeEnv({ twoPane: true, view: "chat", activeChat: { mid: "C1" } });
ok(
  e.escapeAction() === "back",
  "with no lightbox, Esc in a chat still goes back to the list",
);
e.root.view = "list";
ok(e.escapeAction() === "close", "and from the list it still closes the panel");
e.root.view = "chat";
e.root.lightbox = {
  id: "m1",
  source: "file:///p/a.jpg",
  name: "圖片",
  index: 0,
};
ok(
  e.escapeAction() === "lightbox",
  "with the lightbox up, Esc belongs to the lightbox",
);
e.closeLightbox();
ok(e.root.lightbox === null, "it closed");
ok(
  e.escapeAction() === "back",
  "a second Esc goes back to the list, as before",
);
ok(
  e.focused[e.focused.length - 1] === "replyField",
  "focus returns to the reply box: " + JSON.stringify(e.focused),
);
e.root.view = "list";
e.root.lightbox = { id: "", source: "https://c/1.png", name: "圖片", index: 0 };
e.closeLightbox();
ok(
  e.focused[e.focused.length - 1] === "searchField",
  "from the list it returns to the search box",
);

group("(l7) clampPan keeps the scaled picture from leaving the stage");
e = makeEnv({});
// A 400x300 picture on a 400x300 stage at 2x: the scaled picture overhangs by
// 200x150 in total, so the pan can reach half of that in each direction.
let c = e.clampPan(500, 500, 2, 400, 300, 400, 300);
ok(
  c.x === 200 && c.y === 150,
  "pan stops where the far edge reaches the stage edge: " + c.x + "," + c.y,
);
c = e.clampPan(-500, -500, 2, 400, 300, 400, 300);
ok(c.x === -200 && c.y === -150, "and symmetrically the other way");
c = e.clampPan(30, -20, 2, 400, 300, 400, 300);
ok(c.x === 30 && c.y === -20, "a pan inside the bounds is left alone");
// At 1x (or whenever the picture is smaller than the stage) there is nothing to
// pan into view, so it stays centred instead of drifting into a corner.
c = e.clampPan(120, 90, 1, 400, 300, 400, 300);
ok(c.x === 0 && c.y === 0, "an unzoomed picture cannot be dragged off centre");
c = e.clampPan(120, 90, 2, 100, 50, 400, 300);
ok(
  c.x === 0 && c.y === 0,
  "a picture still smaller than the stage stays centred too",
);
// Axes are independent: tall pictures pan vertically only.
c = e.clampPan(120, 90, 2, 100, 300, 400, 300);
ok(
  c.x === 0 && c.y === 90,
  "each axis is clamped on its own: " + c.x + "," + c.y,
);
ok(
  e.clampPan(undefined, 0, 2, 400, 300, 400, 300).x === 0,
  "a NaN pan does not escape the clamp",
);

group("(l8) an inert drag at 1x does not count as a backdrop click");
e = makeEnv({});
ok(e.isDrag(0, 0) === false, "a still pointer is not a drag");
ok(e.isDrag(3, -3) === false, "a few px of hand tremor is not a drag");
ok(
  e.isDrag(5, 0) === true && e.isDrag(0, -5) === true,
  "past the threshold it is, on either axis",
);
// The threshold is deliberately independent of zoom: at 1x nothing pans, but the
// release of that drag still must not be read as "clicked the backdrop".
const stage = [400, 300, 0, 0, 1, 200, 150]; // stageW, stageH, panX, panY, scale, paintedW, paintedH
ok(
  e.outsidePicture(200, 150, ...stage) === false,
  "the centre is on the picture",
);
ok(
  e.outsidePicture(320, 150, ...stage) === true,
  "past the painted edge is the backdrop",
);
ok(
  e.outsidePicture(299, 150, ...stage) === false,
  "just inside the painted edge is not",
);
// Zooming grows the picture, so the same point can stop being backdrop.
ok(
  e.outsidePicture(320, 150, 400, 300, 0, 0, 2, 200, 150) === false,
  "at 2x that same point is on the picture",
);
// Panning moves the picture, so the same point can start being backdrop.
ok(
  e.outsidePicture(120, 150, 400, 300, 150, 0, 1, 200, 150) === true,
  "after panning right, a point on the left is backdrop again",
);

group("(l9) the lightbox caption names the picture and its position");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
  fileName: "a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "a.jpg");
ok(
  e.lightboxCaption() === "a.jpg",
  "one picture: just the name, no size, no 1 / 1",
);
// fileSize present -> the size comes from the same mediaLabel() the rows use.
e.root.messages = [
  {
    id: "m1",
    contentType: "IMAGE",
    hasMedia: true,
    mediaPath: "/p/a.jpg",
    fileName: "a.jpg",
    fileSize: 2048,
  },
  {
    id: "m2",
    contentType: "IMAGE",
    hasMedia: true,
    mediaPath: "/p/b.jpg",
    fileName: "b.jpg",
  },
];
e.showPicture("m1", "file:///p/a.jpg", "a.jpg");
ok(
  e.lightboxCaption() === "a.jpg  2 KB   1 / 2",
  "size and position: " + JSON.stringify(e.lightboxCaption()),
);
e.stepPicture(1);
ok(
  e.lightboxCaption() === "b.jpg   2 / 2",
  "no fileSize -> the name alone, position still there: " +
    JSON.stringify(e.lightboxCaption()),
);
// A FLEX picture has no message of its own to look up.
e.root.messages = [{
  id: "m4",
  contentType: "FLEX",
  flexImages: ["https://c/1.png", "https://c/2.png"],
}];
e.showPicture("", "https://c/2.png", "圖片");
ok(
  e.lightboxCaption() === "圖片   2 / 2",
  "FLEX: the fallback name plus position",
);
e.closeLightbox();
ok(e.lightboxCaption() === "", "no lightbox, no caption");

// ------------------------------------------------- (m) U37: force sync button
group("(m1) pressing 同步 puts one sync frame on the wire and says so");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
const syncs = e.sent.filter((r) => r.cmd === "sync");
ok(syncs.length === 1, "one sync frame (" + syncs.length + ")");
ok(
  syncs[0] && Object.keys(syncs[0]).sort().join(",") === "cmd,id",
  "no arguments beyond the envelope: " + JSON.stringify(syncs[0]),
);
ok(e.root.syncing === true, "syncing is set while it is in flight");
ok(
  e.root.notice === "同步中…",
  "and the wait is visible: " + JSON.stringify(e.root.notice),
);

group(
  "(m2) the reply clears the flag, stamps the time and refetches the open chat",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
const AT = new Date(2026, 8, 5, 14, 32, 10).getTime();
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { chats: 7, link: "up", at: AT } }),
);
ok(e.root.syncing === false, "syncing is cleared");
ok(
  e.root.syncedAt === AT,
  "syncedAt takes the daemon's clock: " + e.root.syncedAt,
);
ok(
  e.root.notice === "已同步 14:32",
  "notice reads 已同步 HH:MM: " + JSON.stringify(e.root.notice),
);
// The chat list rides on state.json, which the panel re-reads by itself; the
// open conversation has no such path, so sync has to ask for it again.
ok(
  e.historyCalls.length === 1 && e.historyCalls[0] === "C1",
  "the open chat is refetched: " + JSON.stringify(e.historyCalls),
);

// `at` is optional, the way every added field in this contract is.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
e.onReply(JSON.stringify({ id: 1, ok: true, data: { chats: 7, link: "up" } }));
ok(
  e.root.syncedAt > 0,
  "a reply without `at` falls back to the panel's own clock",
);
ok(
  /^已同步 \d\d:\d\d$/.test(e.root.notice),
  "and still reads 已同步 HH:MM: " + e.root.notice,
);

e = makeEnv({ twoPane: true, activeChat: null });
e.syncNow();
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { chats: 0, link: "up", at: AT } }),
);
ok(e.historyCalls.length === 0, "no chat open -> no history request");
ok(e.root.notice === "已同步 14:32", "the stamp still shows with no chat open");

group("(m3) a failed sync says why, and never silently");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
e.onReply(
  JSON.stringify({
    id: 1,
    ok: false,
    error: "同步失敗：連不上 LINE，稍後重試",
  }),
);
ok(e.root.syncing === false, "the button is released");
ok(
  e.root.notice === "同步失敗：連不上 LINE，稍後重試",
  "the daemon's reason is shown",
);
ok(e.historyCalls.length === 0, "nothing is refetched on a failure");

// sync belongs to no chat, so the "switched chat, stay quiet" rules must not
// swallow it -- the user pressed something and is owed an answer.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
e.root.activeChat = { mid: "C2" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: "尚未登入" }));
ok(
  e.root.notice === "尚未登入",
  "still shown after switching chat: " + JSON.stringify(e.root.notice),
);
ok(e.root.syncing === false, "and the flag is still cleared");

e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
e.onReply(JSON.stringify({ id: 1, ok: false }));
ok(
  e.root.notice === "同步失敗",
  'no error text -> a sync-specific default, not "失敗"',
);

group("(m4) a second press while it is in flight is ignored");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
e.syncNow();
ok(
  e.sent.filter((r) => r.cmd === "sync").length === 1,
  "still one frame on the wire",
);
ok(e.root.notice === "同步中…", "the notice is unchanged");
// ...and it is pressable again once the reply lands.
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { chats: 1, link: "up", at: AT } }),
);
e.syncNow();
ok(
  e.sent.filter((r) => r.cmd === "sync").length === 2,
  "the next press goes through",
);

group("(m5) no daemon -> the same complaint every other command makes");
e = makeEnv({ connected: false, twoPane: true, activeChat: { mid: "C1" } });
e.syncNow();
ok(e.sent.length === 0, "nothing is sent");
ok(
  e.root.notice === "daemon 沒在跑",
  "and it says so: " + JSON.stringify(e.root.notice),
);
ok(e.root.syncing === false, "the button is not left spinning");

group("(m6) the button, the key and the link line are actually wired to it");
// These are declarations, not functions, so they are asserted against source.
const scaleRowBlock = src.slice(
  src.indexOf("          Text {\n            id: syncLabel"),
  src.indexOf("            id: logoutLabel"),
);
ok(
  /text: root\.syncing \? tr\("syncing"\) : tr\("sync"\)/.test(scaleRowBlock),
  "the label shows the in-flight state",
);
ok(scaleRowBlock.includes("onClicked: root.syncNow()"), "clicking it syncs");
ok(
  /Keys\.onReturnPressed: root\.syncNow\(\)/.test(scaleRowBlock) &&
    /Keys\.onSpacePressed: root\.syncNow\(\)/.test(scaleRowBlock),
  "Enter and Space press it too",
);
ok(
  scaleRowBlock.includes("Accessible.role: Accessible.Button") &&
    scaleRowBlock.includes("Accessible.onPressAction: root.syncNow()"),
  "and it is a Button to assistive tech, not an unlabelled Text",
);
ok(
  scaleRowBlock.includes("visible: root.loggedIn"),
  "hidden when there is no session",
);

const keyBlock = src.slice(
  src.indexOf("      onTextKey: function(t) {"),
  src.indexOf("      onTabRequested:"),
);
ok(
  /if \(t === "r"\)/.test(keyBlock) && keyBlock.includes("root.syncNow()"),
  "r syncs from the key catcher",
);
ok(
  /if \(root\.loggedIn\) root\.syncNow\(\)/.test(keyBlock),
  "but only with a session, matching the button's own visibility",
);

const linkBlock = src.slice(
  src.indexOf("        Item {\n          id: linkNoticeSlot"),
  src.indexOf("        // 字級調整"),
);
ok(
  linkBlock.includes("onClicked: root.sockConnected ? root.syncNow() : root.kickDaemon(true)") &&
    linkBlock.includes("cursorShape: Qt.PointingHandCursor"),
  "the 連線中斷 line is clickable and looks it -- sync when connected, start the daemon when not",
);
// Socket.connected is a target state, not an auto-retry: after ECONNREFUSED the
// socket stays dead until the bound value makes a false→true round trip. The
// retry timer pulses sockHoldoff for that, and while the panel is open it also
// kicks the daemon (restart covers both "not running" and the orphaned-sock
// case), so clicking the bar icon against a dead daemon actually recovers.
ok(
  /active: root\.opened && !root\.sockHoldoff/.test(src) && /readonly property bool sockConnected/.test(src),
  "the socket can retry — the Loader wraps it and sockHoldoff forces a fresh connect",
);
ok(
  /id: sockRetryTimer/.test(src) && /running: root\.opened && !root\.sockConnected/.test(src),
  "a retry timer re-attempts the socket while the panel is open and disconnected",
);
ok(
  /execDetached\(\["systemctl", "--user", "restart", "enil"\]\)/.test(src) &&
    /function kickDaemon\(force\)/.test(src),
  "a dead daemon is restarted from inside the panel",
);
// U74: the height/topMargin bindings live on the wrapping Item, never on the
// Text. QQuickText re-runs layout (recomputing implicitHeight) the moment a
// height is assigned, so `height: visible ? implicitHeight : 0` on the Text
// itself is a guaranteed "Binding loop detected" the first time the line
// appears -- four journal hits in three days, always on a reconnect. The
// offscreen case in tests/qml/keytest reproduces the loop; this pins the
// shape so it cannot quietly move back.
const linkTextBlock = linkBlock.slice(linkBlock.indexOf("Text {"));
ok(
  !/\bheight:/.test(linkTextBlock),
  "the linkNotice Text carries no height binding of its own",
);
ok(
  linkBlock.includes(
    "height: linkNotice.visible ? linkNotice.implicitHeight : 0",
  ),
  "the slot reads the Text's implicitHeight instead",
);
ok(
  linkBlock.includes(
    "anchors.topMargin: linkNotice.visible ? Style.space(6) : 0",
  ),
  "and owns the collapsing top margin",
);
ok(
  /anchors\.top: linkNoticeSlot\.bottom/.test(src),
  "searchField stacks on the slot, not the Text",
);
ok(
  src.includes("linkNoticeSlot.height + linkNoticeSlot.anchors.topMargin"),
  "contentHeight reads the slot too, so the 6px margin is still counted once",
);
ok(
  /text: root\.listNoticeText\(\)/.test(linkBlock),
  "the rule for what it shows lives in listNoticeText(), not duplicated here",
);
// The colour is derived from the rendered text rather than recomputing the
// rule, so the two can never disagree about which mode the line is in.
ok(
  /color: \(root\.notice\.length > 0 && text\.indexOf\(root\.notice\) === 0\) \? root\.urgent/
    .test(linkBlock),
  "and the urgent colour follows whichever string actually won",
);

group(
  "(m6b) the notice only borrows this line where noticeLine cannot show it",
);
const listNotice = (opts) => makeStatusRoot(opts).listNoticeText();
const DOWN = stateWith({ link: { push: "down", since: NOW - 180000 } });
// Single pane: chatPane (and the noticeLine inside it) is hidden in list view,
// so this line is the only place a notice can appear.
ok(
  listNotice({ state: DOWN, notice: "同步中…" }) === "同步中…",
  "single pane -> the notice wins over the link line",
);
ok(
  listNotice({ state: stateWith({}), notice: "已同步 14:32" }) ===
    "已同步 14:32",
  "single pane, link healthy -> the notice still shows",
);
// Two panes: noticeLine is on screen whatever the view, so borrowing this line
// too would print the same string twice.
ok(
  listNotice({ twoPane: true, state: DOWN, notice: "同步中…" }) ===
    "LINE 連線中斷，重連中（3 分），點此立即重連",
  "two panes -> the link line stays, the notice is not duplicated",
);
ok(
  listNotice({ twoPane: true, state: stateWith({}), notice: "同步中…" }) === "",
  "two panes, link healthy -> nothing at all rather than a second copy",
);
// And with no notice at all both modes are exactly what they were before U37.
ok(
  listNotice({ state: DOWN }) ===
      "LINE 連線中斷，重連中（3 分），點此立即重連" &&
    listNotice({ twoPane: true, state: DOWN }) === listNotice({ state: DOWN }),
  "no notice -> the link line in both modes, unchanged",
);
ok(
  listNotice({
    state: stateWith({ chatList: { complete: false, loaded: 12 } }),
    notice: "已同步 14:32",
  }) === "已同步 14:32；目前顯示 12 個聊天室，尚有聊天室未載入",
  "an operation notice stays visible beside the incomplete-list warning",
);

// ------------------------------------------- (n) U38: the App window placement
group(
  "(n1) the placement setting picks one of three modes, unknown falls back",
);
e = makeEnv({});
const mode = (v) => e.placementMode(v);
ok(
  mode("Below the bar") === "bar" && mode("Center of screen") === "center" &&
    mode("App window") === "app",
  "the three manifest options map to the three modes",
);
ok(
  mode("APP WINDOW") === "app" && mode("center of screen") === "center",
  "case does not matter -- the option value is display text, not an identifier",
);
ok(
  mode("Wat") === "bar" && mode("") === "bar" && mode(undefined) === "bar" &&
    mode(null) === "bar" && mode(7) === "bar",
  "anything unrecognised (or hand-broken in shell.json) reads as Below the bar",
);
// The three booleans are one-liners off `placement`; assert them verbatim so the
// derivation cannot quietly drift away from placementMode().
ok(
  /readonly property string placement: placementMode\(setting\("placement", "Below the bar"\)\)/
    .test(src),
  "placement is derived from the setting through placementMode()",
);
ok(
  /readonly property bool centeredPanel: placement === "center"/.test(src),
  "centeredPanel is exactly the center mode",
);
ok(
  /readonly property bool appWindow: placement === "app"/.test(src),
  "appWindow is exactly the app mode",
);
ok(
  /readonly property bool twoPane: centeredPanel \|\| appWindow/.test(src),
  "two panes in both of the wide modes, one in Below the bar",
);

group("(n2) the position button cycles bar -> center -> app -> bar");
e = makeEnv({});
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"),
);
const placementSchema =
  manifest.barWidget.schema.filter((s) => s.key === "placement")[0];
const written = [];
let cur = "bar";
for (let i = 0; i < 4; i++) {
  e.root.placement = cur;
  e.togglePlacement();
  const cmd = e.settingWriter.command;
  written.push(cmd[cmd.length - 1]);
  cur = e.placementMode(cmd[cmd.length - 1]);
}
ok(
  written.join(" -> ") ===
    "Center of screen -> App window -> Below the bar -> Center of screen",
  "one press moves one step and wraps: " + written.join(" -> "),
);
ok(
  e.settingWriter.command.slice(0, 5).join(" ") ===
    "omarchy bar set io.github.frankekn.line placement",
  "written through `omarchy bar set`, the same path textScale uses: " +
    JSON.stringify(e.settingWriter.command),
);
ok(e.settingWriter.running === true, "and the writer is actually started");
// The values land in shell.json verbatim, so a typo here would silently mean
// "unrecognised" -> Below the bar. Check them against the manifest itself.
ok(
  placementSchema.options.length === 3 &&
    written.every((v) => placementSchema.options.indexOf(v) >= 0),
  "every value written is one of the manifest's options",
);
ok(
  placementSchema.options.map(mode).join(",") === "bar,center,app",
  "and the manifest's three options are three distinct modes",
);
ok(
  e.placementLabel("bar") === "貼齊 bar" &&
    e.placementLabel("center") === "置中" &&
    e.placementLabel("app") === "視窗",
  "the button names the mode it is in -- a cycle of three cannot be labelled by its next step",
);

group("(n3) App window mode never closes itself to open a file");
e = makeEnv({
  twoPane: true,
  appWindow: true,
  placement: "app",
  activeChat: { mid: "C1" },
});
e.openMedia("f1");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
ok(
  e.root.closed === 0,
  "the window stays put -- it is a toplevel, not an overlay",
);
ok(
  e.execed.length === 1 && e.execed[0].join(" ") === "xdg-open /tmp/one.pdf",
  "and the file still opens: " + JSON.stringify(e.execed[0]),
);
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.onReply(JSON.stringify({ id: 2, ok: true, data: { path: "/full/a.jpg" } }));
e.openExternally();
ok(
  e.root.lightbox === null && e.root.closed === 0 && e.execed.length === 2,
  "`o` in the lightbox likewise: lightbox gone, window kept, viewer launched",
);
// The popup modes are the ones that must get out of the way (see (l3)); assert
// the pair together so neither half can be changed alone.
e = makeEnv({ twoPane: true, appWindow: false, activeChat: { mid: "C1" } });
e.openMedia("f1");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
ok(e.root.closed === 1, "Below the bar / Center of screen still close first");

group(
  "(n4) the App window remembers its size, and only writes when it changed",
);
e = makeEnv({ windowWidth: 1040, windowHeight: 720 });
e.saveWindowSize(1040, 720);
ok(
  e.sizeWriter.command === null && e.sizeWriter.running === false,
  "nothing moved -> nothing written (writing would hot-reload and retrigger itself)",
);
e.saveWindowSize(1200, 800);
ok(e.sizeWriter.running === true, "a real resize is written");
const sizeCmd = e.sizeWriter.command;
ok(
  sizeCmd[0] === "sh" && sizeCmd[1] === "-c" && sizeCmd.length === 3,
  "one process, so the two `omarchy bar set` calls cannot race each other: " +
    JSON.stringify(sizeCmd.slice(0, 2)),
);
ok(
  sizeCmd[2] === "omarchy bar set io.github.frankekn.line windowWidth 1200" +
      " && omarchy bar set io.github.frankekn.line windowHeight 800",
  "width then height, in order: " + JSON.stringify(sizeCmd[2]),
);
// A settle can fire once the settings have caught up; that second pass is a no-op.
e.sizeWriter.command = null;
e.sizeWriter.running = false;
e.root.windowWidth = 1200;
e.root.windowHeight = 800;
e.saveWindowSize(1200, 800);
ok(
  e.sizeWriter.command === null,
  "a second settle at the same size writes nothing",
);
// shell.json is hand-editable and `omarchy bar set` does not validate, so the
// clamp is the only thing between a typo and an unusable window.
e = makeEnv({});
e.saveWindowSize(10, 10);
ok(
  /windowWidth 560 .. omarchy bar set io.github.frankekn.line windowHeight 480$/
    .test(e.sizeWriter.command[2]),
  "below the minimum clamps to 560x480: " +
    JSON.stringify(e.sizeWriter.command[2]),
);
e = makeEnv({});
e.saveWindowSize(99999, 99999);
ok(
  /windowWidth 4096 .. omarchy bar set io.github.frankekn.line windowHeight 4096$/
    .test(e.sizeWriter.command[2]),
  "above the maximum clamps to 4096: " +
    JSON.stringify(e.sizeWriter.command[2]),
);
e = makeEnv({});
e.saveWindowSize("nonsense", null);
ok(
  e.sizeWriter.command === null,
  "garbage falls back to the current size, which by definition has not changed",
);
ok(
  e.clampWindowSize(undefined, 1040, 560) === 1040 &&
    e.clampWindowSize(0, 1040, 560) === 1040 &&
    e.clampWindowSize("720.4", 1040, 560) === 720,
  "clampWindowSize: missing/zero take the fallback, numeric strings are rounded",
);
const wSchema =
  manifest.barWidget.schema.filter((s) => s.key === "windowWidth")[0];
const hSchema =
  manifest.barWidget.schema.filter((s) => s.key === "windowHeight")[0];
ok(
  wSchema && wSchema.type === "integer" && wSchema.min === 560 &&
    wSchema.max === 4096 &&
    hSchema && hSchema.type === "integer" && hSchema.min === 480 &&
    hSchema.max === 4096,
  "and the manifest schema declares the same bounds the clamp enforces",
);
ok(
  manifest.barWidget.defaults.windowWidth === 1040 &&
    manifest.barWidget.defaults.windowHeight === 720,
  "defaults match the fallbacks Panel.qml reads",
);

group(
  "(n5) one content tree, two hosts, and the mode decides which one shows it",
);
const winSrc = fs.readFileSync(path.join(REPO, "LineWindow.qml"), "utf8");
ok(
  /parent: root\.appWindow \? lineWindow\.contentSlot : panel\.contentSlot/
    .test(src),
  "the content is reparented between the hosts, never rebuilt (state would be lost)",
);
ok(
  src.indexOf("PanelKeyCatcher {") === src.lastIndexOf("PanelKeyCatcher {"),
  "and there is exactly one of it in the file",
);
ok(
  /^    open: root\.opened && !root\.appWindow$/m.test(src),
  "the overlay panel is out of the way in App window mode",
);
ok(
  /^    wanted: root\.opened && root\.appWindow$/m.test(src),
  "and the window is up only in App window mode",
);
ok(
  /^    implicitWidth: root\.windowWidth$/m.test(src) &&
    /^    implicitHeight: root\.windowHeight$/m.test(src),
  "the window opens at the remembered size",
);
ok(
  /^    onSizeSettled: function\(w, h\) \{ root\.saveWindowSize\(w, h\) \}$/m
    .test(src),
  "and hands the settled size back to be saved",
);
ok(
  /focusTarget: root\.focusLanding/.test(src) &&
    (src.match(/focusTarget: root\.focusLanding/g) || []).length === 2,
  "both hosts land the focus by the same rule, written once",
);
ok(
  /visible: wanted/.test(winSrc) &&
    /if \(wanted && owner && "close" in owner\) owner\.close\(\)/.test(winSrc),
  "the window's close button routes back through the owner, and an owner-driven" +
    " hide does not bounce back",
);
ok(
  /onWidthChanged: if \(visible\) sizeSettleTimer\.restart\(\)/.test(winSrc) &&
    /onHeightChanged: if \(visible\) sizeSettleTimer\.restart\(\)/.test(winSrc),
  "size is only tracked while the window is actually on screen",
);
ok(
  /interval: 800/.test(winSrc) && /id: sizeSettleTimer/.test(winSrc),
  "and only after it settles for 800ms, so dragging a border is not a save loop",
);
// A Hyprland retile changes width/height exactly like a border drag does. Only a
// floating window's size is the user's; a tiled one is whatever the layout gave it.
{
  const settle = winSrc.slice(winSrc.indexOf("id: sizeSettleTimer"),
    winSrc.indexOf("id: floatCheckTimer"));
  const check = winSrc.slice(winSrc.indexOf("id: floatCheckTimer"),
    winSrc.indexOf("function ownIpcObject()"));
  ok(
    /import Quickshell\.Hyprland/.test(winSrc) &&
      /Hyprland\.refreshToplevels\(\)/.test(settle) &&
      /floatCheckTimer\.restart\(\)/.test(settle),
    "a settled size first asks Hyprland for fresh window state",
  );
  ok(
    /ipc && ipc\.floating === true/.test(check) &&
      /root\.sizeSettled\(/.test(check),
    "and is only reported when Hyprland says the window floats",
  );
  ok(
    /Hyprland\.requestSocketPath === ""/.test(settle),
    "outside Hyprland there is no one to ask, so it falls back to saving",
  );
  ok(
    /floatCheckTimer\.stop\(\)/.test(winSrc),
    "hiding the window drops a pending float check too",
  );
  const winLines = winSrc.split("\n");
  const ownStart = winLines.findIndex((l) => l.trimEnd() === "  function ownIpcObject() {");
  const ownEnd = winLines.findIndex((l, i) => i > ownStart && l === "  }");
  const ownIpcObject = new Function("root", "Hyprland", "Quickshell",
    winLines.slice(ownStart + 1, ownEnd).join("\n"));
  const tl = (o) => ({ lastIpcObject: o });
  const hypr = { toplevels: { values: [
    tl({ pid: 7, title: "Omarchy dev gallery", class: "org.quickshell", floating: true }),
    tl({ pid: 9, title: "LINE", class: "org.quickshell", floating: true }),
    tl({ pid: 7, title: "LINE", class: "org.quickshell", floating: false }),
    tl({}),
  ] } };
  const own = ownIpcObject({ title: "LINE" }, hypr, { processId: 7 });
  ok(
    !!own && own.pid === 7 && own.title === "LINE" && own.floating === false,
    "the window finds its own Hyprland entry by pid, class and title -- the dev " +
      "gallery shares the class, another process may share the title",
  );
  ok(
    ownIpcObject({ title: "LINE" }, { toplevels: { values: [] } }, { processId: 7 }) === null,
    "no entry yet (IPC not answered) is null, which saves nothing",
  );
}
ok(
  /if \(!root\.appWindow\) root\.switchPanel\(direction\)/.test(src),
  "Tab is a bar-panel gesture; in a normal window it does nothing",
);

// --------------------------------- (o) U40: recalled and expired attachments
group(
  "(o1) mediaUsable: only an attachment that is actually there is clickable",
);
e = makeEnv({});
const usable = (m) => e.mediaUsable(m);
ok(
  usable({ hasMedia: true, mediaState: "ok" }) === true,
  "a live attachment is usable",
);
ok(
  usable({ hasMedia: true, mediaState: "expired" }) === false,
  "an expired one is not",
);
ok(
  usable({ hasMedia: true, mediaState: "unsent" }) === false,
  "a recalled one is not",
);
// The field arrived with U39; a daemon older than the panel omits it entirely,
// and refusing every attachment for that half-hour would be the worse bug.
ok(
  usable({ hasMedia: true }) === true,
  "no mediaState at all -> usable (older daemon)",
);
ok(
  usable({ hasMedia: false, mediaState: "ok" }) === false,
  "no media, nothing to open",
);
ok(
  usable({ hasMedia: false }) === false && usable({}) === false,
  "a plain text message is not media either",
);
ok(
  usable(null) === false && usable(undefined) === false,
  "a missing message is false, not a crash",
);
// mediaState is a string in the contract; anything else is not "ok".
ok(
  usable({ hasMedia: true, mediaState: "" }) === false &&
    usable({ hasMedia: true, mediaState: null }) === false &&
    usable({ hasMedia: true, mediaState: "OK" }) === false,
  "only the exact contract string counts as usable",
);

group("(o2) mediaLabel says why a file cannot be opened, after the name");
ok(
  e.mediaLabel({ fileName: "a.pdf", fileSize: 2048, mediaState: "ok" }) ===
    "a.pdf  2 KB",
  "a live file is unchanged: " +
    JSON.stringify(
      e.mediaLabel({ fileName: "a.pdf", fileSize: 2048, mediaState: "ok" }),
    ),
);
ok(
  e.mediaLabel({ fileName: "a.pdf", fileSize: 2048 }) === "a.pdf  2 KB",
  "and so is one from a daemon that never sends the field",
);
ok(
  e.mediaLabel({ fileName: "a.pdf", fileSize: 2048, mediaState: "expired" }) ===
    "a.pdf  2 KB（已過期）",
  "expired: the reason comes after the size",
);
ok(
  e.mediaLabel({ fileName: "a.pdf", mediaState: "expired" }) ===
    "a.pdf（已過期）",
  "no size -> the reason still lands",
);
ok(
  e.mediaLabel({ contentType: "FILE", mediaState: "expired" }) ===
    "[FILE]（已過期）",
  "no name either -> the contentType placeholder keeps the suffix",
);
// hasMedia is false on a recall so this cannot come up through the rows; the
// lightbox caption calls the same function, hence the guard.
ok(
  e.mediaLabel({ fileName: "a.pdf", mediaState: "unsent" }) ===
    "a.pdf（已收回）",
  "a recalled one would say so rather than offer a name alone",
);
ok(
  e.mediaLabel({
    fileName: "a.pdf",
    fileSize: 3 * 1024 * 1024,
    mediaState: "expired",
  }) ===
    "a.pdf  3.0 MB（已過期）",
  "MB formatting is untouched by the suffix",
);

group("(o3) the lightbox strip skips what the rows no longer draw");
e = makeEnv({});
const pl2 = e.pictureList([
  {
    id: "m1",
    contentType: "IMAGE",
    hasMedia: true,
    mediaState: "ok",
    mediaPath: "/p/a.jpg",
  },
  {
    id: "m2",
    contentType: "IMAGE",
    hasMedia: true,
    mediaState: "expired",
    mediaPath: "/p/b.jpg",
  },
  {
    id: "m3",
    contentType: "IMAGE",
    hasMedia: false,
    unsent: true,
    mediaState: "unsent",
    mediaPath: "/p/c.jpg",
  },
  {
    id: "m4",
    contentType: "FLEX",
    unsent: true,
    mediaState: "unsent",
    flexImages: ["https://c/1.png", "https://c/2.png"],
  },
  { id: "m5", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/d.jpg" }, // older daemon
]);
ok(
  pl2.length === 2,
  "only the live picture and the fieldless one (" + pl2.length + ")",
);
ok(
  pl2[0].source === "file:///p/a.jpg" && pl2[1].source === "file:///p/d.jpg",
  "in order, and it is those two: " + JSON.stringify(pl2.map((p) => p.source)),
);
ok(
  pl2.every((p) => p.source.indexOf("b.jpg") < 0),
  "an expired picture is not offered",
);
ok(pl2.every((p) => p.source.indexOf("c.jpg") < 0), "nor a recalled one");
// A recall leaves flexImages behind, and FLEX carries no hasMedia to key off.
ok(
  pl2.every((p) => p.source.indexOf("https://c/") < 0),
  "a recalled FLEX bubble drops its pictures too",
);
// ←/→ therefore walk two steps, not five: every stop has a row on screen.
e.root.messages = [
  {
    id: "m1",
    contentType: "IMAGE",
    hasMedia: true,
    mediaState: "ok",
    mediaPath: "/p/a.jpg",
  },
  {
    id: "m2",
    contentType: "IMAGE",
    hasMedia: true,
    mediaState: "expired",
    mediaPath: "/p/b.jpg",
  },
  {
    id: "m5",
    contentType: "IMAGE",
    hasMedia: true,
    mediaState: "ok",
    mediaPath: "/p/d.jpg",
  },
];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.stepPicture(1);
ok(
  e.root.lightbox.source === "file:///p/d.jpg" && e.root.lightbox.index === 1,
  "right steps over the expired picture: " +
    JSON.stringify(e.root.lightbox.source),
);
e.stepPicture(1);
ok(
  e.root.lightbox.source === "file:///p/d.jpg",
  "and stops there -- it is the last one",
);

group("(o4) the rows: no dead clicks, and a recall reads as a recall");
// The delegate is declarations, not functions, so it is asserted against source.
const msgRows = src.slice(
  src.indexOf("            id: msgDelegate"),
  src.indexOf("          id: attachButton"),
);
// A media MouseArea is one whose click acts on this message's own attachment;
// the FLEX one loads a public CDN url and has nothing to expire or recall.
// Brace-matched: U49 gave two of them an onClicked with a body of its own, so
// "up to the first }" now stops in the middle of one.
function blocks(text, opener) {
  const out = [];
  let at = 0;
  while ((at = text.indexOf(opener, at)) >= 0) {
    let i = at + opener.length, depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    out.push(text.slice(at + opener.length, i - 1));
    at = i;
  }
  return out;
}
const areas = blocks(msgRows, "MouseArea {");
const mediaAreas = areas.filter((b) =>
  b.includes("root.openMedia(modelData.id") ||
  b.includes("root.showPicture(modelData.id")
);
ok(
  mediaAreas.length === 2,
  "two MouseAreas open this message's attachment (" + mediaAreas.length +
    " of " + areas.length + ")",
);
// U49 needs the right button through on both of them, and `enabled: false`
// swallows every button -- so on the 📎 line the gate moved into the left-click
// branch. What has to stay true either way: no left click acts on an attachment
// the daemon is going to refuse.
ok(
  mediaAreas.every((b) =>
    /enabled: msgDelegate\.mediaOk/.test(b) ||
    /readonly property bool openable:\s*msgDelegate\.mediaOk/.test(b)
  ),
  "and every one of them is gated on mediaOk -- a dead click is worse than a greyed line",
);
ok(
  mediaAreas.every((b) => /root\.openMessageMenu\(/.test(b)),
  "while the right button opens the menu on both: a photo-only chat would " +
    "otherwise have no reply, no reaction and no recall at all",
);
// The sticker is the third one and it is invisible to the filter above: it has no
// left click at all (a sticker has no original to open), so it calls neither
// openMedia nor showPicture. Named here, or dropping it would break nothing.
ok(
  /id: stickerMenu/.test(msgRows) &&
    /root\.openMessageMenu\(stickerMenu/.test(msgRows) &&
    /acceptedButtons: Qt\.RightButton/.test(msgRows),
  "and the sticker answers the right button too -- once it loads, the text line " +
    "under it is hidden, so there is nothing else left to click",
);
// The url in the message is whatever the daemon resolved: an animated sticker
// someone else sent has always carried sticker_animation.png, and since 2.4.0
// (the daemon sends STKOPT) the echo of one I sent does too -- so the optimistic
// bubble would be repainted with a several-hundred-KB APNG that Qt shows as its
// first frame anyway. stickerStill is the one place that rule lives.
ok(
  /remoteSource: msgDelegate\.sticker\n\s+\? root\.stickerStill\(msgDelegate\.modelData\.stickerUrl\) : ""/
    .test(msgRows),
  "the bubble's picture goes through root.stickerStill, like every cell in the " +
    "picker -- an APNG only ever paints its first frame here, and it is the " +
    "download that is hundreds of KB",
);
ok(
  /readonly property bool mediaOk: root\.mediaUsable\(modelData\)$/m.test(
    msgRows,
  ),
  "which is root.mediaUsable(), asked once per row rather than four times",
);
ok(
  !/enabled: modelData\.hasMedia/.test(src),
  "hasMedia alone no longer decides a click -- it is true for an expired file",
);
ok(
  /readonly property bool openable:\s*msgDelegate\.mediaOk/.test(msgRows) &&
    /modelData\.contentType === "IMAGE"[\s\S]*root\.retryPreview\(modelData\.id, false\)/
      .test(msgRows),
  "the 📎 line retries a failed image instead of handing it to xdg-open",
);
ok(
  /source: msgDelegate\.mediaOk && modelData\.mediaPath/.test(msgRows),
  "and an unusable attachment draws no thumbnail either, so the strip and the rows agree",
);
ok(
  /readonly property bool recalled: modelData\.unsent === true/.test(msgRows),
  "the recall is read once, from the field U39 added",
);
ok(
  /readonly property bool sticker: !recalled/.test(msgRows) &&
    /visible: !msgDelegate\.recalled\s*\n\s*&& modelData\.flexImages !== undefined/
      .test(msgRows),
  "a recalled sticker or FLEX bubble is not drawn: the daemon leaves those URLs behind",
);
ok(
  /color: \(modelData\.decryptFailed \|\| modelData\.pending \|\| msgDelegate\.recalled\)/
    .test(msgRows) &&
    /font\.italic: msgDelegate\.recalled/.test(msgRows),
  "and the 已收回訊息 line is dim and italic -- LINE said it, not the sender",
);

// ------------------------------------------------- (q) download intent (PR #6)
// openPicture prefetches the original so the lightbox can swap the thumbnail for
// it. The reply used to be routed by "is the lightbox on this id right now?",
// which meant closing the lightbox before it landed dropped through to
// close() + xdg-open -- an external viewer nobody asked for. The mark now
// carries what the download was FOR, and the answer no longer depends on timing.
group("(q1) a prefetch that lands after the lightbox closed opens nothing");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [
  { id: "m1", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/a.jpg" },
  { id: "m2", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/b.jpg" },
];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
ok(
  e.root.openWanted["m1"].intent === "lightbox",
  "the prefetch is marked as the lightbox's: " +
    JSON.stringify(e.root.openWanted["m1"]),
);
e.closeLightbox(); // Esc, before the reply
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } }));
ok(e.execed.length === 0, "no external viewer: " + JSON.stringify(e.execed));
ok(e.root.closed === 0, "and the panel is not closed out from under the user");
ok(
  e.root.lightbox === null,
  "the lightbox stays closed -- it is not reopened by a late reply",
);
ok(e.root.openWanted["m1"] === undefined, "the mark is cleared all the same");

// Same reply, but the user has moved on to the next picture: still nothing to do
// (the file is in the daemon's cache; that is the whole benefit).
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [
  { id: "m1", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/a.jpg" },
  { id: "m2", contentType: "IMAGE", hasMedia: true, mediaPath: "/p/b.jpg" },
];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.stepPicture(1); // now showing m2
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } }));
ok(
  e.execed.length === 0 && e.root.closed === 0,
  "m1's late original opens nothing",
);
ok(
  e.root.lightbox.id === "m2" && e.root.lightbox.source === "file:///p/b.jpg",
  "and does not overwrite the picture now on screen: " +
    JSON.stringify(e.root.lightbox.source),
);

// Leaving the chat entirely is the same story.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.back();
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } }));
ok(
  e.execed.length === 0 && e.root.closed === 0 && e.root.lightbox === null,
  "back to the list before the reply: nothing opens either",
);

group("(q2) with the lightbox still on that picture, the original swaps in");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } }));
ok(
  e.root.lightbox.source === "file:///full/a.jpg",
  "swapped: " + e.root.lightbox.source,
);
ok(
  e.execed.length === 0 && e.root.closed === 0,
  "still nothing external, still open",
);

group("(q3) a file click is unaffected -- that intent really is external");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("f1", "external");
ok(e.root.openWanted["f1"].intent === "external", "marked external");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
ok(
  e.root.closed === 1 && e.execed.length === 1 &&
    e.execed[0].join(" ") === "xdg-open /tmp/one.pdf",
  "closes, then opens, as before",
);
// A caller that names no intent is a file/video caller: external is the default,
// so an added call site cannot silently become a lightbox prefetch.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("f1");
ok(
  e.root.openWanted["f1"].intent === "external",
  "no intent given -> external",
);
// An external reply opens even if a lightbox happens to be up: the user asked.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.openMedia("f1", "external");
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
ok(
  e.execed.length === 1 && e.execed[0][1] === "/tmp/one.pdf",
  "the file still opens while a picture is on screen",
);

group("(q4) `o` while the original is still in flight opens exactly once");
// The choice: upgrade the pending prefetch to "external" and wait for it, rather
// than opening the preview now and dropping the reply. `o` means "open this
// picture in a real viewer" -- handing imv the thumbnail would answer faster with
// the wrong file, and the panel stays up meanwhile so a failed download still has
// somewhere to show its error.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.openExternally(); // original not back yet
ok(
  e.root.lightbox === null,
  "the lightbox closes right away, so the key did something",
);
ok(
  e.execed.length === 0 && e.root.closed === 0,
  "but nothing opens on the thumbnail",
);
ok(
  e.root.openWanted["m1"].intent === "external",
  "the in-flight download is repurposed: " +
    JSON.stringify(e.root.openWanted["m1"]),
);
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/full/a.jpg" } }));
ok(
  e.execed.length === 1 && e.execed[0].join(" ") === "xdg-open /full/a.jpg",
  "exactly one viewer, on the original: " + JSON.stringify(e.execed),
);
ok(e.root.closed === 1, "and the panel gets out of the way for it");

// If that repurposed download fails, the panel is still up to say so.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.openExternally();
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(
  e.root.notice === "boom" && e.execed.length === 0 && e.root.closed === 0,
  "a failed original after `o` is visible, not silent: " +
    JSON.stringify(e.root.notice),
);

// A FLEX picture has no download in flight at all, so `o` opens the url now.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m4",
  contentType: "FLEX",
  flexImages: ["https://c/1.png"],
}];
e.showPicture("", "https://c/1.png", "圖片");
e.openExternally();
ok(
  e.execed.length === 1 && e.execed[0].join(" ") === "xdg-open https://c/1.png",
  "the CDN url goes straight out: " + JSON.stringify(e.execed[0]),
);

group("(q5) forgetOpen clears the intent, whatever it was");
e = makeEnv({});
e.markOpen("a", "lightbox");
e.markOpen("b", "external");
ok(
  e.root.openWanted.a.intent === "lightbox" &&
    e.root.openWanted.b.intent === "external",
  "both marked",
);
e.forgetOpen("a");
ok(e.root.openWanted.a === undefined, "the one asked for is gone");
ok(e.root.openWanted.b.intent === "external", "and the other is untouched");
e.forgetOpen("b");
ok(
  Object.keys(e.root.openWanted).length === 0,
  "clearing the last one leaves an empty map",
);
// Cleared means cleared: a duplicate reply for the same id does nothing, because
// the onReply branch is gated on the mark still being there.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("f1", "external");
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
e.onReply(JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/one.pdf" } }));
ok(e.execed.length === 1, "a repeated reply cannot open a second viewer");

// --------------------------------------- (r) nothing waits on a reply that cannot come
group("(r1) a disconnect drops every record of something in flight");
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.openMedia("f1", "external");
e.showPicture("m1", "file:///p/a.jpg", "圖片");
e.syncNow();
ok(
  Object.keys(e.root.pending).length === 3 &&
    Object.keys(e.root.openWanted).length === 2 &&
    e.root.syncing === true,
  "three requests are in flight, two of them downloads",
);
e.dropInFlight();
ok(Object.keys(e.root.pending).length === 0, "pending is emptied");
ok(Object.keys(e.root.openWanted).length === 0, "and so is the intent map");
ok(e.root.syncing === false, "the sync button is not left spinning");
// The lightbox is looking at a local thumbnail; the socket going away does not
// make it unviewable, and taking it off screen would just be rude.
ok(
  e.root.lightbox !== null && e.root.lightbox.source === "file:///p/a.jpg",
  "the picture on screen is left alone: " + JSON.stringify(e.root.lightbox),
);
// The wiring itself is a Socket handler, not a function, so it is asserted
// against source: whatever else that branch grows, it must go through here.
const sockBlock = src.slice(
  src.indexOf("    id: socketComponent"),
  src.indexOf("  function dropInFlight()"),
);
ok(
  /if \(!connected\) \{[^}]*root\.dropInFlight\(\)[^}]*return/.test(sockBlock),
  "losing the connection calls it",
);

// A server-side overload may close the socket after LINE accepted a send but
// before its acknowledgement. Keep that request visibly ambiguous until the
// reconnect reloads history; restoring it as a failure could duplicate it.
e = makeEnv({
  twoPane: true,
  activeChat: { mid: "C1" },
  draftStore: { ME: { C1: { text: "retry me", cursor: 8, version: 1 } } },
});
e.root.messages = [{
  id: "pending-1",
  text: "retry me",
  pending: true,
  requestId: "request-7",
}];
e.root.pending = {
  7: {
    cmd: "send",
    msgId: "pending-1",
    chat: "C1",
    spendsDraft: true,
    text: "retry me",
    requestId: "request-7",
    draftVersion: 1,
    draftGeneration: 0,
  },
};
e.dropInFlight();
ok(
  e.root.messages.length === 1 && e.root.messages[0].id === "pending-1",
  "disconnect keeps an unanswered optimistic bubble until reconciliation",
);
ok(
  e.replyField.text === "",
  "disconnect does not restore an ambiguous send into the composer",
);
ok(
  Object.keys(e.root.pending).length === 0,
  "ambiguous sends are no longer waiting for an acknowledgement",
);
ok(
  e.root.historyRefreshNeeded === true,
  "disconnect schedules history reconciliation after reconnect",
);
ok(
  e.pendingDraftSend("C1") === true,
  "an ambiguous send keeps its persisted draft protected",
);
ok(
  e.root.notice === "連線中斷，請確認訊息是否送出",
  "disconnect replaces an upload progress banner with an ambiguity notice",
);
ok(
  e.root.draftStore.ME.C1.ambiguousSends[0].requestId === "request-7" &&
    e.root.draftStore.ME.C1.ambiguousSends[0].bubble.id === "pending-1",
  "disconnect persists the token and optimistic bubble beside the draft",
);
const peerCollision = e.preserveAmbiguousBubbles("C1", [{
  id: "peer-message",
  from: "THEM",
  requestId: "request-7",
}]);
ok(
  peerCollision.length === 2 && peerCollision.some((m) => m.id === "pending-1"),
  "a peer row cannot hide an optimistic bubble by reusing its token",
);
e.reconcileAmbiguous("C1", peerCollision);
ok(
  e.root.historyRefreshNeeded === true && e.pendingDraftSend("C1") === true,
  "a peer row carrying the token cannot confirm our ambiguous send",
);
const reconcileCount = e.sent.length;
ok(
  e.reconcileAfterConnect() === true,
  "reconnect starts the required history reconciliation",
);
ok(
  e.sent.length === reconcileCount + 1 && e.sent.at(-1).cmd === "history",
  "reconciliation sends a history request for the active chat",
);
ok(
  e.root.historyRefreshNeeded === true,
  "the retry flag remains armed until history succeeds",
);
e.onReply(JSON.stringify({ id: e.sent.at(-1).id, ok: true, data: [] }));
ok(
  e.root.historyRefreshNeeded === true && e.pendingDraftSend("C1") === true,
  "a stale successful page does not claim the ambiguous send was observed",
);
ok(
  e.root.messages.length === 1 && e.root.messages[0].id === "pending-1",
  "a stale first page keeps the ambiguous optimistic bubble visible",
);
e.root.reconciliationEpoch++;
ok(
  e.reconcileAfterConnect() === true,
  "the unresolved send is retried on the next reconnect",
);
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [{
    id: "server-other",
    from: "ME",
    text: "retry me",
    requestId: "request-other",
    time: Date.now(),
  }],
}));
ok(
  e.root.historyRefreshNeeded === true && e.pendingDraftSend("C1") === true,
  "the same text from another request cannot consume an ambiguous send",
);
ok(
  e.root.draftStore.ME.C1.text === "retry me",
  "a mismatched history row cannot spend the persisted draft",
);
e.root.reconciliationEpoch++;
ok(
  e.reconcileAfterConnect() === true,
  "an exact-correlation retry remains scheduled",
);
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [{ id: "server-1", from: "ME", text: "", requestId: "request-7" }],
}));
ok(
  e.root.historyRefreshNeeded === false,
  "history carrying the exact request token clears the reconciliation retry flag",
);
ok(
  e.pendingDraftSend("C1") === false,
  "observed reconciliation releases the ambiguous draft marker",
);
ok(
  !e.root.draftStore.ME || !e.root.draftStore.ME.C1,
  "exact reconciliation spends the same persisted draft as an acknowledgement",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
const preLoadToken = {
  requestId: "sticker-before-load",
  spendsDraft: false,
  bubble: {
    id: "pending-sticker-before-load",
    pending: true,
    requestId: "sticker-before-load",
  },
};
e.root.ambiguousSendsByChat = { C1: [preLoadToken] };
e.persistAmbiguousSends("ME", { C1: [preLoadToken] }, { C1: true });
e.reconcileAmbiguous("C1", [{
  id: "server-sticker-before-load",
  from: "ME",
  requestId: "sticker-before-load",
}]);
ok(
  !e.root.pendingAmbiguousByAccount.ME.byChat.C1.length &&
    e.root.pendingAmbiguousByAccount.ME.removedByChat.C1["sticker-before-load"],
  "a pre-load confirmation records removal in the staged draft edits",
);
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  "replyField",
  B.loadDraftStore,
)(
  e.root,
  {
    allocateRevision: () => 1,
    load: () => ({
      accounts: { ME: { C1: { ambiguousSends: [preLoadToken] } } },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "confirmed",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  "ignored",
  e.replyField,
);
ok(
  (!e.root.draftStore.ME || !e.root.draftStore.ME.C1) &&
    Object.keys(e.root.ambiguousSendsByChat).length === 0 &&
    !e.preserveAmbiguousBubbles("C1", []).some(
      (m) => m.id === "pending-sticker-before-load",
    ),
  "draft loading cannot restore a confirmed pre-load token or bubble",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "same words",
        cursor: 10,
        mentions: [],
        replyTo: null,
        version: 6,
        ambiguousSends: [{
          requestId: "other-panel-send",
          spendsDraft: true,
          draftVersion: 6,
          draftGeneration: 4,
          draftGenerationOwner: "other-panel",
        }],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.root.composerGeneration = 4;
e.root.composerGenerationByChat = { C1: 4 };
e.root.composerDirtyByChat = { C1: true };
e.reconcileAmbiguous("C1", [{
  id: "server-other-panel",
  from: "ME",
  requestId: "other-panel-send",
}]);
ok(
  e.replyField.text === "same words" &&
    e.root.draftStore.ME.C1.text === "same words",
  "another panel's matching generation cannot erase an unsaved local edit",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "one durable write",
        version: 4,
        ambiguousSends: [{
          requestId: "atomic-4",
          spendsDraft: true,
          draftVersion: 4,
          draftGeneration: 0,
        }],
      },
    },
  },
});
e.restoreAmbiguousSends("ME");
e.root.draftWrites = [];
e.reconcileAmbiguous("C1", [{
  id: "server-atomic",
  from: "ME",
  requestId: "atomic-4",
}]);
ok(
  e.root.draftWrites.length === 1 &&
    (!e.root.draftWrites[0].ME || !e.root.draftWrites[0].ME.C1),
  "exact confirmation removes its token and matching draft in one durable snapshot",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "sent before restart",
        cursor: 19,
        mentions: [],
        replyTo: null,
        version: 6,
        ambiguousSends: [{
          requestId: "restart-generation",
          spendsDraft: true,
          draftVersion: 6,
          draftGeneration: 1,
        }],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.reconcileAmbiguous("C1", [{
  id: "server-restart-generation",
  from: "ME",
  requestId: "restart-generation",
}]);
ok(
  e.replyField.text === "" &&
    (!e.root.draftStore.ME || !e.root.draftStore.ME.C1),
  "a fresh panel clears an unchanged restored draft despite its foreign generation",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "newer confirmed send",
        cursor: 20,
        mentions: [],
        replyTo: null,
        version: 6,
        ambiguousSends: [
          {
            requestId: "older-v2",
            spendsDraft: true,
            draftVersion: 2,
            draftGeneration: 1,
          },
          {
            requestId: "current-v6",
            spendsDraft: true,
            draftVersion: 6,
            draftGeneration: 1,
          },
        ],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.reconcileAmbiguous("C1", [{
  id: "server-v6",
  from: "ME",
  requestId: "current-v6",
}]);
ok(
  e.replyField.text === "" &&
    e.root.draftStore.ME.C1.text === undefined &&
    e.root.draftStore.ME.C1.ambiguousSends.length === 1 &&
    e.root.draftStore.ME.C1.ambiguousSends[0].requestId === "older-v2",
  "confirming the restored revision clears it while an older token remains",
);
e.reconcileAmbiguous("C1", [{
  id: "server-v2",
  from: "ME",
  requestId: "older-v2",
}]);
ok(
  !e.root.draftStore.ME || !e.root.draftStore.ME.C1,
  "confirming the older token cannot resurrect the already-cleared newer draft",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        ambiguousSends: [{
          requestId: "media-1",
          spendsDraft: false,
          bubble: { id: "pending-media", pending: true },
        }],
      },
    },
  },
});
e.restoreAmbiguousSends("ME");
e.replyField.text = "temporary";
e.root.noteComposerEdit();
e.replyField.text = "";
e.root.noteComposerEdit();
e.saveActiveDraft(true);
ok(
  e.root.draftStore.ME.C1.ambiguousSends[0].requestId === "media-1",
  "erasing an edited composer preserves a media send's unresolved token",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "erase me",
        version: 1,
        ambiguousSends: [{
          requestId: "unresolved-v1",
          spendsDraft: true,
          draftVersion: 1,
        }],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.replyField.text = "";
e.root.noteComposerEdit();
e.saveActiveDraft(true);
e.replyField.text = "stale screen";
e.restoreDraft("C1");
e.flushLater();
ok(
  e.replyField.text === "" &&
    e.root.draftStore.ME.C1.text === undefined &&
    e.root.draftStore.ME.C1.ambiguousSends[0].requestId === "unresolved-v1",
  "deliberate draft deletion survives reopen while its unresolved token remains",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "newer draft",
        version: 4,
        ambiguousSends: [{
          requestId: "old-revision",
          spendsDraft: true,
          draftVersion: 2,
        }],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.replyField.text = "";
e.root.noteComposerEdit();
e.saveActiveDraft(true);
e.restoreDraft("C1");
e.flushLater();
ok(
  e.replyField.text === "" &&
    e.root.draftStore.ME.C1.text === undefined &&
    e.root.draftStore.ME.C1.ambiguousSends[0].requestId === "old-revision",
  "an old ambiguous revision preserves its token without resurrecting an erased newer draft",
);

// A shell restart restores both correlation and the visible bubble from the
// same atomic draft file, even though historyCache deliberately excludes it.
e = makeEnv({
  twoPane: true,
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "survive restart",
        version: 3,
        ambiguousSends: [{
          requestId: "restart-3",
          spendsDraft: true,
          draftVersion: 3,
          draftGeneration: 0,
          bubble: {
            id: "pending-restart",
            from: "ME",
            text: "survive restart",
            pending: true,
            requestId: "restart-3",
          },
        }],
      },
    },
  },
});
e.restoreAmbiguousSends("ME");
const restartedRows = e.preserveAmbiguousBubbles("C1", []);
ok(
  e.root.historyRefreshNeeded === true &&
    e.root.ambiguousSendsByChat.C1[0].requestId === "restart-3" &&
    restartedRows.length === 1 && restartedRows[0].id === "pending-restart",
  "a panel restart restores unresolved correlation and its bubble",
);

// Reconciliation must remove the marker before clearDraft handles a newer,
// now-empty composer generation; otherwise pendingDraftSend blocks deletion.
e.root.composerGeneration = 1;
e.reconcileAmbiguous("C1", [{
  id: "server-restart",
  from: "ME",
  requestId: "restart-3",
}]);
ok(
  !e.root.draftStore.ME || !e.root.draftStore.ME.C1,
  "exact history confirmation clears a stale draft after a generation change",
);

// Each panel writes only the chats it changed. A stale in-memory snapshot in
// one panel must not erase unresolved sends another panel just published.
const otherPanelToken = {
  requestId: "other-panel",
  spendsDraft: true,
  draftVersion: 4,
};
const thisPanelToken = {
  requestId: "this-panel",
  spendsDraft: true,
  draftVersion: 2,
};
let concurrentAccounts = e.accountsWithAmbiguous(
  {
    ME: {
      C1: { text: "shared", ambiguousSends: [otherPanelToken] },
      C2: { text: "other", ambiguousSends: [otherPanelToken] },
    },
  },
  "ME",
  { C1: [thisPanelToken] },
  { C1: true },
);
ok(
  concurrentAccounts.ME.C1.ambiguousSends.length === 2 &&
    concurrentAccounts.ME.C1.ambiguousSends.some((t) =>
      t.requestId === "this-panel"
    ) &&
    concurrentAccounts.ME.C1.ambiguousSends.some((t) =>
      t.requestId === "other-panel"
    ) &&
    concurrentAccounts.ME.C2.ambiguousSends[0].requestId === "other-panel",
  "two panels preserve both unresolved tokens in the same chat",
);
concurrentAccounts = e.accountsWithAmbiguous(
  concurrentAccounts,
  "ME",
  {},
  { C1: true },
  { C1: { "this-panel": true } },
);
ok(
  concurrentAccounts.ME.C1.text === "shared" &&
    concurrentAccounts.ME.C1.ambiguousSends.length === 1 &&
    concurrentAccounts.ME.C1.ambiguousSends[0].requestId === "other-panel" &&
    concurrentAccounts.ME.C2.ambiguousSends[0].requestId === "other-panel",
  "confirming one panel's token leaves same-chat and other-chat markers untouched",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: { ME: { C1: { text: "keep", version: 4 } } },
});
const memoryOnlyToken = {
  requestId: "revision-limit",
  spendsDraft: true,
  draftVersion: 4,
  bubble: { id: "pending-limit", pending: true, requestId: "revision-limit" },
};
e.root.writeDraftStore = () => false;
e.root.ambiguousSendsByChat = { C1: [memoryOnlyToken] };
e.persistAmbiguousSends("ME", { C1: [memoryOnlyToken] }, { C1: true });
e.root.ambiguousSendsByChat = {};
e.restoreAmbiguousSends("ME");
ok(
  e.root.pendingAmbiguousByAccount.ME.byChat.C1[0].requestId ===
      "revision-limit" &&
    e.root.ambiguousSendsByChat.C1[0].requestId === "revision-limit" &&
    e.preserveAmbiguousBubbles("C1", [])[0].id === "pending-limit",
  "a failed ambiguity write remains staged and cannot look confirmed on restore",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "sent on another panel",
        cursor: 21,
        version: 8,
        ambiguousSends: [{
          requestId: "shared-confirmed",
          spendsDraft: true,
          draftVersion: 8,
        }],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.root.draftStore = {}; // Panel A atomically confirmed and spent this draft.
e.restoreAmbiguousSends("ME");
ok(
  e.replyField.text === "" && e.root.composerDraftVersionByChat.C1 === 0,
  "another panel's confirmation clears the unchanged restored composer",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "sent on another panel",
        cursor: 21,
        version: 8,
        ambiguousSends: [{
          requestId: "shared-confirmed-edit",
          spendsDraft: true,
          draftVersion: 8,
        }],
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.restoreAmbiguousSends("ME");
e.replyField.text = "new local edit";
e.root.noteComposerEdit();
e.root.draftStore = {};
e.restoreAmbiguousSends("ME");
ok(
  e.replyField.text === "new local edit",
  "another panel's confirmation preserves a newer local composer edit",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "newer draft sent elsewhere",
        cursor: 27,
        version: 6,
        ambiguousSends: [{
          requestId: "foreign-v6",
          spendsDraft: true,
          draftVersion: 6,
          draftGeneration: 3,
          draftGenerationOwner: "other-panel",
        }],
      },
    },
  },
});
e.root.ambiguousSendsByChat = {
  C1: e.root.draftStore.ME.C1.ambiguousSends.slice(),
};
e.replyField.text = "older clean composer";
e.root.composerDraftVersionByChat = { C1: 4 };
e.root.composerDirtyByChat = { C1: false };
e.reconcileAmbiguous("C1", [{
  id: "server-foreign-v6",
  from: "ME",
  requestId: "foreign-v6",
}]);
ok(
  e.replyField.text === "older clean composer" &&
    (!e.root.draftStore.ME || !e.root.draftStore.ME.C1) &&
    Object.keys(e.root.ambiguousSendsByChat).length === 0,
  "a foreign confirmation spends its shared revision without replacing an older clean composer",
);

// The shared file is authoritative in both directions. When another panel has
// confirmed a token, the next FileView snapshot removes the local marker and
// reloads the open chat so its optimistic bubble can disappear as well.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.ambiguousSendsByChat = { C1: [thisPanelToken] };
e.root.historyRefreshNeeded = true;
e.root.draftStore = { ME: { C1: { text: "new shared snapshot" } } };
e.restoreAmbiguousSends("ME");
ok(
  Object.keys(e.root.ambiguousSendsByChat).length === 0 &&
    e.root.historyRefreshNeeded === true &&
    Number(e.root.historyRefreshRemovedByChat.C1) > 0,
  "a newer shared snapshot removes tokens another panel already confirmed",
);
ok(
  e.sent.length === 1 && e.sent[0].cmd === "history" && e.sent[0].chat === "C1",
  "removing a shared token reloads the open chat to discard its optimistic bubble",
);
e.onReply(JSON.stringify({ id: 1, ok: true, data: [] }));
ok(
  e.root.historyRefreshNeeded === false &&
    Object.keys(e.root.historyRefreshRemovedByChat).length === 0,
  "the compensating history reply completes the removed-token refresh obligation",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.historyRefreshRemovedByChat = { C1: true };
e.root.historyRefreshNeeded = true;
e.reconcileAmbiguous("C1", [{ id: "event", from: "THEM" }]);
ok(
  !!e.root.historyRefreshRemovedByChat.C1 &&
    e.root.historyRefreshNeeded === true,
  "an unrelated event cannot complete a full-history refresh obligation",
);
e.root.messages = [{ id: "newest", from: "THEM" }];
e.request("older", { chat: "C1", count: 30, before: "newest" });
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [{ id: "older", from: "THEM" }],
}));
ok(
  !!e.root.historyRefreshRemovedByChat.C1 &&
    e.root.historyRefreshNeeded === true,
  "an older page cannot complete a full-history refresh obligation",
);
e.root.loadHistory("C1");
e.onReply(JSON.stringify({ id: e.sent.at(-1).id, ok: true, data: [] }));
ok(
  !e.root.historyRefreshRemovedByChat.C1 &&
    e.root.historyRefreshNeeded === false,
  "the current full-history reply completes the refresh obligation",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadHistory("C1");
const olderRefresh = e.sent.at(-1);
e.root.ambiguousSendsByChat = { C1: [thisPanelToken] };
e.root.draftStore = { ME: { C1: { text: "confirmed during history" } } };
e.restoreAmbiguousSends("ME");
ok(
  e.sent.length === 1 && Number(e.root.historyRefreshRemovedByChat.C1) === 2,
  "a token removed during history requires a newer history generation",
);
e.onReply(JSON.stringify({ id: olderRefresh.id, ok: true, data: [] }));
ok(
  e.sent.length === 2 && e.sent.at(-1).cmd === "history" &&
    !!e.root.historyRefreshRemovedByChat.C1,
  "the pre-removal history reply retains the obligation and starts a newer request",
);
e.onReply(JSON.stringify({ id: e.sent.at(-1).id, ok: true, data: [] }));
ok(
  !e.root.historyRefreshRemovedByChat.C1 &&
    e.root.historyRefreshNeeded === false,
  "only the post-removal history generation completes the obligation",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.ambiguousSendsByChat = { C1: [thisPanelToken] };
e.root.historyRefreshNeeded = true;
e.root.reconciliationEpoch = 1;
ok(
  e.reconcileAfterConnect() === true && e.sent.length === 1,
  "reconnect starts the first ambiguous-send history request",
);
const failedSharedRefresh = e.sent[0];
e.root.draftStore = { ME: { C1: { text: "confirmed during failed history" } } };
e.restoreAmbiguousSends("ME");
ok(
  e.sent.length === 1 && Number(e.root.historyRefreshRemovedByChat.C1) === 2,
  "a shared confirmation during loading waits for a newer generation",
);
e.onReply(
  JSON.stringify({ id: failedSharedRefresh.id, ok: false, error: "offline" }),
);
ok(
  e.sent.length === 2 && e.sent.at(-1).cmd === "history" &&
    Number(e.sent.at(-1).id) !== Number(failedSharedRefresh.id),
  "a failed older history immediately starts the shared-marker refresh",
);
e.onReply(JSON.stringify({ id: e.sent.at(-1).id, ok: true, data: [] }));
ok(
  !e.root.historyRefreshRemovedByChat.C1 &&
    e.root.historyRefreshNeeded === false,
  "the newer history clears the shared-marker refresh after an older failure",
);

// A FileView update is shared by every panel. Resolving another chat must not
// reload the chat this panel is showing or move its viewport to the bottom.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.ambiguousSendsByChat = { C2: [otherPanelToken] };
e.root.draftStore = { ME: { C1: { text: "mine" }, C2: { text: "theirs" } } };
e.restoreAmbiguousSends("ME");
ok(
  e.sent.length === 0 && Number(e.root.historyRefreshRemovedByChat.C2) > 0,
  "a shared resolution in another chat does not reload the open chat",
);

e = makeEnv({ activeChat: { mid: "C1" }, connected: false });
e.root.ambiguousSendsByChat = { C1: [thisPanelToken] };
e.root.historyRefreshNeeded = true;
e.root.draftStore = { ME: { C1: { text: "confirmed while offline" } } };
e.restoreAmbiguousSends("ME");
ok(
  e.sent.length === 0 && e.root.historyRefreshNeeded === true &&
    Number(e.root.historyRefreshRemovedByChat.C1) > 0,
  "an offline token removal keeps its compensating history refresh pending",
);
e.sock.connected = true;
ok(
  e.reconcileAfterConnect() === true && e.sent.at(-1).cmd === "history",
  "reconnect performs the deferred refresh even though no ambiguous token remains",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.historyRefreshRemovedByChat = { C1: true };
e.root.historyRefreshNeeded = true;
e.root.pending = { 1: { cmd: "send", spendsDraft: true } };
e.dropInFlight();
ok(
  e.root.historyRefreshNeeded === true,
  "disconnect keeps a shared token-removal refresh armed for an old untagged send",
);

e = makeEnv({ activeChat: { mid: "C1" } });
const switchedId = e.appendPending("survive switch", []);
e.request("send", { chat: "C1", text: "survive switch" }, switchedId);
const switchedToken = e.sent.at(-1).requestId;
e.root.messages = []; // history cache/chat switch no longer contains pending rows
e.dropInFlight();
ok(
  e.root.draftStore.ME.C1.ambiguousSends[0].bubble.id === switchedId &&
    e.root.draftStore.ME.C1.ambiguousSends[0].bubble.requestId ===
      switchedToken,
  "the request record restores a bubble lost before the disconnect",
);

e = makeEnv({ activeChat: { mid: "C1" } });
const pushedId = e.appendPending("already pushed", []);
e.request("send", { chat: "C1", text: "already pushed" }, pushedId);
const pushedToken = e.sent.at(-1).requestId;
e.root.messages = [{
  id: "server-pushed",
  from: "ME",
  text: "already pushed",
  requestId: pushedToken,
  time: 100,
}];
e.dropInFlight();
e.root.loadHistory("C1");
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [
    { id: "server-newer-1", from: "THEM", text: "newer", time: 200 },
    { id: "server-newer-2", from: "THEM", text: "newest", time: 300 },
  ],
}));
ok(
  e.root.messages.map((m) => m.id).join(",") ===
      "server-newer-1,server-newer-2" &&
    e.root.historyRefreshNeeded === true,
  "a pushed server row outside the newest page is not appended out of order",
);
e.request("older", { chat: "C1", count: 30, before: "server-newer-1" });
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [
    {
      id: "server-pushed",
      from: "ME",
      text: "already pushed",
      requestId: pushedToken,
      time: 100,
    },
    { id: "server-newer-1", from: "THEM", text: "newer", time: 200 },
  ],
}));
ok(
  e.root.messages.map((m) => m.id).join(",") ===
      "server-pushed,server-newer-1,server-newer-2" &&
    e.root.messages.filter((m) => m.id === "server-pushed").length === 1 &&
    e.root.historyRefreshNeeded === false,
  "pagination restores the pushed row once, in chronological order, and settles its token",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: { OLD: { C1: { text: "old account", version: 1 } } },
});
e.root.sessionMid = "OLD";
e.root.pending = {
  9: {
    cmd: "send",
    chat: "C1",
    requestId: "old-account-9",
    spendsDraft: true,
    bubble: { id: "old-pending", pending: true, requestId: "old-account-9" },
  },
};
e.dropInFlight();
ok(
  e.root.draftStore.OLD.C1.ambiguousSends[0].requestId === "old-account-9" &&
    !e.root.draftStore.ME,
  "account replacement persists lost requests under their original owner",
);

// Empty-content sends use the same token. In particular, a file cannot be
// confirmed by comparing text because both sides legitimately have none.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.pending = {
  8: { cmd: "sendFile", chat: "C1", requestId: "file-8", spendsDraft: false },
};
e.dropInFlight();
ok(
  e.root.historyRefreshNeeded === true && e.pendingDraftSend("C1") === false,
  "a disconnected file send is reconciled without pretending it owns a draft",
);
e.reconcileAmbiguous("C1", [{
  id: "file-message",
  from: "ME",
  text: "",
  requestId: "file-8",
}]);
ok(
  e.root.historyRefreshNeeded === false,
  "an empty file message resolves by its exact token",
);

// A busy chat can push the token outside the first page. Every later source
// that can publish the matching row must therefore run the same exact check.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{ id: "newest", text: "new" }];
e.root.ambiguousSendsByChat = {
  C1: [{ requestId: "older-9", spendsDraft: false }],
};
e.root.historyRefreshNeeded = true;
e.request("older", { chat: "C1", count: 30, before: "newest" });
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [{ id: "older-message", from: "ME", text: "", requestId: "older-9" }],
}));
ok(
  e.root.historyRefreshNeeded === false,
  "an older history page resolves a token outside the newest page",
);

e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "pending-older",
  from: "ME",
  text: "same",
  pending: true,
  requestId: "older-visible",
}];
e.root.ambiguousSendsByChat = {
  C1: [{
    requestId: "older-visible",
    spendsDraft: false,
    bubble: e.root.messages[0],
  }],
};
e.root.historyRefreshNeeded = true;
e.request("older", { chat: "C1", count: 30, before: "pending-older" });
e.onReply(JSON.stringify({
  id: e.sent.at(-1).id,
  ok: true,
  data: [{
    id: "server-older",
    from: "ME",
    text: "same",
    requestId: "older-visible",
  }],
}));
ok(
  e.root.messages.length === 1 && e.root.messages[0].id === "server-older" &&
    e.root.historyRefreshNeeded === false,
  "an older exact match replaces rather than duplicates the optimistic bubble",
);

e.root.ambiguousSendsByChat = {
  C1: [{ requestId: "event-10", spendsDraft: false }],
};
e.root.historyRefreshNeeded = true;
e.applyEvents([{
  kind: "message",
  chat: "C1",
  message: { id: "event-message", from: "ME", text: "", requestId: "event-10" },
}]);
ok(
  e.root.historyRefreshNeeded === false,
  "a pushed self-message resolves its exact token without another reconnect",
);

// The point of clearing it: `o` must not sit waiting for a reply that can never
// arrive. With the intent gone it opens what is on screen, right away.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
ok(e.root.openWanted["m1"].intent === "lightbox", "the original is in flight");
e.dropInFlight(); // daemon went away
e.openExternally();
ok(
  e.execed.length === 1 && e.execed[0].join(" ") === "xdg-open /p/a.jpg",
  "`o` opens the preview now instead of waiting forever: " +
    JSON.stringify(e.execed),
);
ok(
  e.root.lightbox === null && e.root.closed === 1,
  "and the panel gets out of the way as usual",
);

// The picker's flag is the same kind of thing as `syncing`, and nothing else can
// clear it: `loadStickers` refuses to ask while it is set, so a list that never
// came back would leave the picker on 「載入中…」 for the rest of the session.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.toggleSticker();
ok(e.root.stickerLoading === true, "the sticker list is on its way");
e.dropInFlight();
ok(e.root.stickerLoading === false, "and the disconnect clears that flag too");
ok(
  e.setStickerOpen(true) === true && e.sent.length === 2,
  "so opening the picker again asks a second time instead of waiting on a reply " +
    "that can never arrive: " + JSON.stringify(e.sent),
);

group("(r2) with no daemon, nothing is recorded as being on its way");
e = makeEnv({ connected: false, twoPane: true, activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m1", "file:///p/a.jpg", "圖片");
ok(e.sent.length === 0, "no frame goes out");
ok(
  Object.keys(e.root.openWanted).length === 0,
  "and no intent is left behind: " + JSON.stringify(e.root.openWanted),
);
ok(
  e.root.notice === "daemon 沒在跑",
  "the usual complaint is still made: " + e.root.notice,
);
ok(
  e.root.lightbox !== null && e.root.lightbox.source === "file:///p/a.jpg",
  "the lightbox still opens -- the thumbnail is a local file, it needs no daemon",
);
// Nothing pending -> `o` takes the immediate path (U43's design: it only waits
// when there really is a download to wait for).
e.openExternally();
ok(
  e.execed.length === 1 && e.execed[0].join(" ") === "xdg-open /p/a.jpg",
  "`o` opens the preview: " + JSON.stringify(e.execed),
);
ok(e.root.closed === 1, "closing first, as in every other external open");
// A file click with no daemon likewise leaves nothing behind to confuse later.
e = makeEnv({ connected: false, twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("f1", "external");
ok(
  e.sent.length === 0 && Object.keys(e.root.openWanted).length === 0,
  "a file click with the socket down records nothing",
);

group(
  "(r3) connected: the frame goes out and the intent is recorded, as before",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
e.openMedia("m9", "lightbox");
const r3 = e.sent.filter((r) => r.cmd === "download");
ok(
  r3.length === 1 && r3[0].chat === "C1" && r3[0].messageId === "m9" &&
    r3[0].preview === false,
  "the same download frame as ever: " + JSON.stringify(r3[0]),
);
ok(e.root.openWanted["m9"].intent === "lightbox", "and the intent is recorded");
ok(
  Object.keys(e.root.pending).length === 1,
  "with a pending entry to match the reply to",
);
// Recording after the write is safe: a reply can only arrive on a later turn of
// the event loop, so the mark is always there before onReply looks for it.
e.root.messages = [{
  id: "m9",
  contentType: "IMAGE",
  hasMedia: true,
  mediaPath: "/p/a.jpg",
}];
e.showPicture("m9", "file:///p/a.jpg", "圖片");
e.onReply(JSON.stringify({ id: 2, ok: true, data: { path: "/full/a.jpg" } }));
ok(
  e.root.lightbox.source === "file:///full/a.jpg",
  "the reply still finds its intent and swaps",
);
// request() itself now answers whether it sent anything.
e = makeEnv({ twoPane: true, activeChat: { mid: "C1" } });
ok(e.request("history", { chat: "C1" }) === true, "connected -> true");
e = makeEnv({ connected: false, twoPane: true, activeChat: { mid: "C1" } });
ok(e.request("history", { chat: "C1" }) === false, "disconnected -> false");
ok(
  e.root.notice === "daemon 沒在跑",
  "and the notice it always showed is unchanged",
);

// ------------------- (p) U42: selectable body, clickable links, copy
// The body is markup now, so the invariant that matters most is that nothing
// the sender wrote can ever become markup. Everything else is built on it.
group(
  "(p1) linkify escapes first, then wraps -- sender text never becomes markup",
);
e = makeEnv({});
const lf = (t, c) => e.linkify(t, c);
// Strip only the tags linkify itself emits; anything left with a '<' in it
// came from the message and is a hole.
const noStrayMarkup = (h) =>
  h.replace(/<a [^>]*>|<a href="[^"]*">|<\/a>|<br>/g, "").indexOf("<") < 0;
ok(
  lf("a & b < c > d \" e ' f") === "a &amp; b &lt; c &gt; d &quot; e &#39; f",
  "the five characters are escaped: " +
    JSON.stringify(lf("a & b < c > d \" e ' f")),
);
ok(
  lf("<b>hi</b>") === "&lt;b&gt;hi&lt;/b&gt;",
  "a message that looks like markup shows as text",
);
const injected = lf('<a href="https://evil.example/">click</a>');
ok(
  injected.indexOf("&lt;a href=") === 0 && noStrayMarkup(injected),
  "a hand-written anchor cannot survive as an anchor: " +
    JSON.stringify(injected.slice(0, 24)),
);
ok(
  lf("see https://a.example/x") ===
    'see <a href="https://a.example/x">https://a.example/x</a>',
  "http(s) is wrapped: " + JSON.stringify(lf("see https://a.example/x")),
);
ok(
  lf("www.a.example/x") ===
    '<a href="https://www.a.example/x">www.a.example/x</a>',
  "www. gets https:// in the href but keeps its own text",
);
ok(
  lf("https://a.example/?x=1&y=2") ===
    '<a href="https://a.example/?x=1&amp;y=2">https://a.example/?x=1&amp;y=2</a>',
  "a query string keeps its & as an entity on both sides",
);
// Trailing punctuation belongs to the sentence.
ok(
  lf("go https://a.example/x.").indexOf(
    '<a href="https://a.example/x">https://a.example/x</a>.',
  ) === 3,
  "a full stop is not part of the url: " +
    JSON.stringify(lf("go https://a.example/x.")),
);
ok(
  lf("(https://a.example/x), y").indexOf("</a>), y") > 0,
  "nor a closing bracket",
);
ok(
  lf("「https://a.example/x」、好").indexOf("</a>」、好") > 0,
  "nor the CJK ones: " + JSON.stringify(lf("「https://a.example/x」、好")),
);
ok(lf("https://a.example/x。").indexOf("</a>。") > 0, "nor a full-width stop");
ok(
  lf("https://a.example/x!?,;:").indexOf('<a href="https://a.example/x">') ===
    0,
  "a run of them is trimmed in one go",
);
// ... but a trailing entity's own semicolon is not punctuation.
ok(
  lf("https://a.example/?x=1&").indexOf('href="https://a.example/?x=1&amp;"') >
    0,
  "&amp; keeps its semicolon -- trimming it would leave a half entity: " +
    JSON.stringify(lf("https://a.example/?x=1&")),
);
ok(
  lf("swww.a.example/x").indexOf("<a") < 0 &&
    lf("xhttps://a.example/x").indexOf("<a") < 0,
  "a url glued to a preceding word is not a url",
);
ok(
  lf("http://.") === "http://." && lf("www.,") === "www.,",
  "a bare scheme left after trimming is not a url either: " +
    JSON.stringify(lf("http://.")) + " " + JSON.stringify(lf("www.,")),
);
ok(
  (lf("https://a.example/ https://b.example/").match(/<a href=/g) || [])
        .length === 2 &&
    lf("https://a.example/ https://b.example/").indexOf("<a", 30) > 0,
  "two urls in one message make two anchors, not one nested pair: " +
    JSON.stringify(lf("https://a.example/ https://b.example/")),
);
ok(
  lf("a\nb\r\nc") === "a<br>b<br>c",
  "newlines become <br>: " + JSON.stringify(lf("a\nb\r\nc")),
);
ok(
  lf("") === "" && lf(undefined) === "" && lf(null) === "",
  "no text at all is the empty string, not a crash",
);
ok(
  lf("https://a.example/x", "#3399ff") ===
    '<a style="color:#3399ff" href="https://a.example/x">https://a.example/x</a>',
  "the colour rides in the markup -- TextEdit has no linkColor property",
);
ok(
  lf("plain", "#3399ff") === "plain",
  "and a message without a link is untouched by it",
);

group(
  "(p1b) bodyHtml keeps the sender's spacing and paints links with the accent",
);
const bh = e.bodyHtml({ text: "a  b https://a.example/x" });
ok(
  bh.indexOf('<div style="white-space: pre-wrap">') === 0 &&
    bh.slice(-6) === "</div>",
  "pre-wrap wrapper, because HTML would otherwise eat the sender's runs of spaces",
);
ok(bh.indexOf("a  b") > 0, "and the two spaces are still there");
ok(
  bh.indexOf("color:#3399ff") > 0,
  "the accent is flattened to #rrggbb -- an #aarrggbb string is not CSS: " +
    bh.slice(38, 70),
);
ok(
  e.bodyHtml({ decryptFailed: true }).indexOf("[E2EE 解密失敗]") > 0,
  "bodyHtml still goes through bodyText, so every placeholder is unchanged",
);
ok(
  e.bodyText({ contentType: "STICKER" }) === "[貼圖]",
  "and bodyText itself is untouched -- the list and the tests still use it",
);

group("(p2) openLink opens http(s) only, and closes the overlay first");
e = makeEnv({ placement: "bar", appWindow: false });
e.openLink("https://a.example/x");
ok(
  e.execed.length === 1 && e.execed[0][0] === "xdg-open" &&
    e.execed[0][1] === "https://a.example/x",
  "argv form, no shell: " + JSON.stringify(e.execed[0]),
);
ok(
  e.root.closed === 1,
  "the overlay is closed first, or the browser opens underneath it",
);
e = makeEnv({ placement: "bar" });
e.openLink("www.a.example/x");
ok(
  e.execed.length === 1 && e.execed[0][1] === "https://www.a.example/x",
  "www. is normalised before it leaves: " + JSON.stringify(e.execed[0]),
);
// Pairs with (n3): the App window is not an overlay, so nothing is taken away.
e = makeEnv({ placement: "app", appWindow: true });
e.openLink("https://a.example/x");
ok(
  e.execed.length === 1 && e.root.closed === 0,
  "App window mode opens the link without closing itself (" + e.root.closed +
    ")",
);
e = makeEnv({ placement: "center" });
e.openLink("https://a.example/x");
ok(
  e.root.closed === 1,
  "the centered overlay closes too -- same reason as the bar one",
);
for (
  const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://a.example/x",
    "data:text/html,x",
    "vbscript:x",
    "HTTPX://a.example/",
    "/etc/passwd",
    "//a.example/x",
    "",
  ]
) {
  e = makeEnv({});
  e.openLink(bad);
  ok(
    e.execed.length === 0 && e.root.notice.length > 0,
    "refused and said so: " + JSON.stringify(bad.slice(0, 12)),
  );
}
ok(
  e.root.notice.indexOf("http") < 0 && e.root.notice.indexOf("://") < 0,
  "and the complaint never quotes the url back: " +
    JSON.stringify(e.root.notice),
);
e = makeEnv({});
ok(
  e.linkTarget("HTTPS://A.example/X") === "HTTPS://A.example/X",
  "the scheme test is case-insensitive but the url is passed through as written",
);
ok(
  e.linkTarget("https://a.example/ x") === "" &&
    e.linkTarget("https://a.example/\ttab") === "" &&
    e.linkTarget("https://a.example/\nnl") === "",
  "whitespace inside a url means it is not the one the user saw",
);
ok(
  e.linkTarget("  https://a.example/x  ") === "https://a.example/x",
  "surrounding whitespace is only trimmed",
);
ok(
  e.linkTarget(undefined) === "" && e.linkTarget(null) === "",
  "no url is not a crash",
);

group("(p3) copyText hands the text to wl-copy's stdin and closes it");
e = makeEnv({});
ok(e.copyText("hello") === true, "a copy is accepted");
ok(
  e.clipWriter.writes.length === 1 && e.clipWriter.writes[0] === "hello",
  "exactly the text, once: " + JSON.stringify(e.clipWriter.writes),
);
ok(
  e.clipLog.join(",") === "stdin=true,running=true,write,stdin=false",
  "in that order -- wl-copy only acts on EOF: " + e.clipLog.join(","),
);
ok(
  JSON.stringify(e.clipWriter.command) === JSON.stringify(["wl-copy"]),
  "the command is argv, and the message is not part of it: " +
    JSON.stringify(e.clipWriter.command),
);
// The whole point of stdin: this string would be a command line otherwise.
e = makeEnv({});
const nasty = "$(touch /tmp/x) `id` \"q\" 's' & | ; > < \\ 訊息\nsecond";
e.copyText(nasty);
ok(e.clipWriter.writes[0] === nasty, "shell metacharacters travel verbatim");
e = makeEnv({});
ok(
  e.copyText("") === false && e.copyText(null) === false &&
    e.copyText(undefined) === false,
  "there is nothing to copy, so nothing is started",
);
ok(
  e.clipWriter.writes.length === 0 && e.clipWriter.running === false,
  "and no process was run",
);
// A Process runs one command at a time, so a second press has to queue.
e = makeEnv({});
e.copyText("first");
e.copyText("second");
ok(
  e.clipWriter.writes.length === 1 && e.clipWriter.writes[0] === "first",
  "the second press does not write into a busy process",
);
ok(
  e.root.pendingCopy === "second",
  "it waits: " + JSON.stringify(e.root.pendingCopy),
);
e.clipWriter.running = false; // wl-copy exited
e.flushCopy();
ok(
  e.clipWriter.writes.length === 2 && e.clipWriter.writes[1] === "second",
  "and goes out as soon as the process is free: " +
    JSON.stringify(e.clipWriter.writes),
);
ok(e.root.pendingCopy === "", "with nothing left queued");
e.flushCopy();
ok(e.clipWriter.writes.length === 2, "an empty queue flushes to nothing");

group(
  "(p4) the delegate: a readOnly selectable body, and no shell anywhere near it",
);
const rows = src.slice(
  src.indexOf("            id: msgBody"),
  src.indexOf("            // 貼圖是 stickershop"),
);
ok(
  rows.length > 0 && /^            TextEdit \{$/m.test(
    src.slice(
      src.indexOf("            // 本文要能拖曳選字"),
      src.indexOf("            id: msgBody"),
    ),
  ),
  "the body is a TextEdit, not a Text",
);
ok(
  /readOnly: true/.test(rows) && /selectByMouse: true/.test(rows),
  "read-only and selectable by mouse -- that is the whole feature",
);
ok(
  /textFormat: TextEdit\.RichText/.test(rows) &&
    /text: root\.bodyHtml\(modelData\)/.test(rows),
  "it renders bodyHtml as RichText, which is why escaping is not optional",
);
ok(
  /persistentSelection: false/.test(rows),
  "the selection dies with the focus, or several bubbles stay highlighted at once",
);
ok(
  /onLinkActivated: function\(link\) \{ root\.openLink\(link\) \}/.test(rows),
  "a click on a link goes through the allow-list, never straight to xdg-open",
);
ok(
  /Keys\.onEscapePressed: root\.dropBodyFocus\(\)/.test(rows),
  "Esc hands the focus back instead of bubbling up and closing the conversation",
);
ok(
  /acceptedButtons: Qt\.RightButton/.test(rows) &&
    /root\.openMessageMenu\(msgBody/.test(rows),
  "right-click opens the menu, and only right-click -- the left button still selects",
);
ok(
  /cursorShape: msgBody\.hoveredLink\.length > 0/.test(rows),
  "a link reads as a link under the pointer",
);
ok(
  !/linkColor:/.test(src),
  "TextEdit has no linkColor; the colour is in the markup",
);
// Nothing that carries message text may ever be assembled into a command line.
const shellArgv = src.match(/\["(?:ba)?sh", "-c",[\s\S]*?\n[^\n]*\]/g) || [];
ok(
  shellArgv.length === 2,
  "the only two sh -c calls are the settings writer and the file picker (" +
    shellArgv.length + ")",
);
ok(
  shellArgv.every((c) =>
    !/wl-copy|bodyText|bodyHtml|copyText|pendingCopy|linkTarget|xdg-open/.test(
      c,
    )
  ),
  "and neither of them touches a message, a link or the clipboard",
);
ok(
  /command: \["wl-copy"\]/.test(src),
  "wl-copy is spawned by argv with a constant command",
);
ok(
  !/console\.log/.test(src),
  "nothing in the panel logs -- message text and urls are user data",
);
ok(
  /onStarted: root\.copyStarted = true/.test(src) &&
    /if \(!root\.copyStarted\) root\.notice =/.test(src),
  "a wl-copy that never starts still says so: it emits no exited signal to hang the notice on",
);
ok(
  /MouseArea \{\n            \/\/ contentItem 沒有大小/.test(src) &&
    /root\.dropBodyFocus\(\)\n              \/\/ 不接下這一下/.test(src),
  "clicking the empty area gives the focus back without stealing the flick",
);

group("(p5) the right-click menu only offers what the click actually hit");
e = makeEnv({});
ok(
  JSON.stringify(e.messageMenuItems("").map((i) => i.action)) ===
    JSON.stringify(["body"]),
  "no link under the cursor -> just 複製訊息",
);
ok(
  JSON.stringify(e.messageMenuItems(undefined).map((i) => i.action)) ===
      JSON.stringify(["body"]) &&
    JSON.stringify(e.messageMenuItems(null).map((i) => i.action)) ===
      JSON.stringify(["body"]),
  "and a missing link is the same as no link",
);
ok(
  JSON.stringify(
    e.messageMenuItems("https://a.example/x").map((i) => i.action),
  ) ===
    JSON.stringify(["body", "link", "open"]),
  "on a link -> three rows",
);
ok(
  e.messageMenuItems("https://a.example/x").map((i) => i.label).join("/") ===
    "複製訊息/複製連結/開啟連結",
  "labelled in the panel's language",
);
e = makeEnv({});
e.msgMenu.body = "the whole message";
e.msgMenu.link = "https://a.example/x";
e.runMenuAction("body");
ok(
  e.clipWriter.writes[0] === "the whole message" && e.msgMenu.closed === 1,
  "複製訊息 copies the body and closes the menu",
);
e = makeEnv({});
e.msgMenu.body = "the whole message";
e.msgMenu.link = "https://a.example/x";
e.runMenuAction("link");
ok(
  e.clipWriter.writes[0] === "https://a.example/x",
  "複製連結 copies the link, not the body",
);
e = makeEnv({ placement: "bar" });
e.msgMenu.link = "https://a.example/x";
e.runMenuAction("open");
ok(
  e.execed.length === 1 && e.execed[0][1] === "https://a.example/x" &&
    e.root.closed === 1,
  "開啟連結 goes through openLink, closing the overlay like every other external open",
);
e = makeEnv({});
e.runMenuAction("nonsense");
ok(
  e.clipWriter.writes.length === 0 && e.execed.length === 0 &&
    e.msgMenu.closed === 1,
  "an action nobody handles still closes the menu instead of leaving it stuck open",
);

group("(p6) focus comes back, or the reply box can never be typed into again");
e = makeEnv({ view: "chat" });
e.dropBodyFocus();
ok(
  e.focused.join(",") === "replyField",
  "in a conversation the focus lands on the reply box: " + e.focused.join(","),
);
e = makeEnv({ view: "list" });
e.dropBodyFocus();
ok(
  e.focused.join(",") === "searchField",
  "in the list it lands on the search box",
);

// ------------------------------------------------------------- (q) U45: @成員
const M1 = "u" + "1".repeat(32);
const M2 = "u" + "2".repeat(32);
const M3 = "u" + "3".repeat(32);
const THREE = [{ mid: M1, name: "Alice" }, { mid: M2, name: "Bob" }, {
  mid: M3,
  name: "alicia",
}];
const GROUP = { mid: "cg1", name: "群組" };

group("(q1) where the @ is, and where it is not");
e = makeEnv({ activeChat: GROUP });
ok(
  JSON.stringify(e.mentionQuery("hi @al", 6)) ===
    JSON.stringify({ start: 3, query: "al" }),
  "an @ after a space opens a query: " +
    JSON.stringify(e.mentionQuery("hi @al", 6)),
);
ok(
  JSON.stringify(e.mentionQuery("@al", 3)) ===
    JSON.stringify({ start: 0, query: "al" }),
  "and so does one at the very start",
);
ok(
  JSON.stringify(e.mentionQuery("hi @", 4)) ===
    JSON.stringify({ start: 3, query: "" }),
  "a bare @ is an empty query, not nothing",
);
ok(
  e.mentionQuery("a@b.example", 11) === null,
  "an email address is not a mention",
);
ok(e.mentionQuery("hi @al", 2) === null, "a caret left of the @ sees no query");
ok(
  e.mentionQuery("", 0) === null && e.mentionQuery("@a", 0) === null,
  "a caret at 0 never opens one (lastIndexOf's negative fromIndex would)",
);
ok(
  JSON.stringify(e.mentionQuery("hi @STUB A", 10)) ===
    JSON.stringify({ start: 3, query: "STUB A" }),
  "spaces stay in the query -- display names have them",
);
ok(e.mentionQuery("@a\nb", 4) === null, "a newline ends the query for good");
ok(
  e.mentionQuery("@" + "x".repeat(33), 34) === null,
  "and it gives up long before the whole message is the query",
);
ok(
  e.mentionQuery("hi @a@b", 7) === null,
  "the nearest @ is the one that counts, and one glued to a name is not a " +
    "mention start -- so this whole token is left alone: " +
    JSON.stringify(e.mentionQuery("hi @a@b", 7)),
);

group("(q2) which rows the picker offers");
e = makeEnv({ activeChat: GROUP, members: THREE });
const names = (q) => e.mentionMatches(THREE, q).map((r) => r.name).join(",");
ok(
  names("") === "全部,Alice,Bob,alicia",
  "an empty query lists 全部 and everyone: " + names(""),
);
ok(
  names("al") === "全部,Alice,alicia",
  "a prefix filters, 全部 answers to All: " + names("al"),
);
ok(names("AL") === names("al"), "case-insensitive");
ok(
  names("li") === "Alice,alicia",
  "a substring matches too, and drops 全部: " + names("li"),
);
ok(names("全") === "全部", "全部 answers to its own name as well");
ok(
  names("bo") === "Bob" && names("zzz") === "",
  "no hits is an empty list, not everyone",
);
ok(
  e.mentionMatches(THREE, "al")[0].all === true &&
    e.mentionMatches(THREE, "al")[0].insert === "All",
  "the 全部 row inserts @All while it reads 全部",
);
ok(
  e.mentionMatches(THREE, "al")[1].mid === M1,
  "a person's row carries the mid",
);
ok(
  e.mentionMatches(
    [{ mid: M1, name: "xali" }, { mid: M2, name: "Alice" }],
    "al",
  )
    .map((r) => r.name).join(",") === "全部,Alice,xali",
  "matches at the start come before matches in the middle",
);
const many = [];
for (let i = 0; i < 12; i++) many.push({ mid: M1, name: "Member " + i });
ok(
  e.mentionMatches(many, "").length === 8,
  "at most 8 rows: " + e.mentionMatches(many, "").length,
);
ok(
  e.mentionMatches(null, "a").length === 1 &&
    e.mentionMatches(undefined, "").length === 1,
  "no member list yet still offers 全部",
);

group("(q3) picking rewrites the text and moves the caret");
e = makeEnv({ activeChat: GROUP });
let ins = e.mentionInsert("hi @al", 6, { insert: "Alice" });
ok(
  ins.text === "hi @Alice " && ins.cursor === 10,
  "the query is replaced by @name plus a space: " + JSON.stringify(ins),
);
ins = e.mentionInsert("hi @al there", 6, { insert: "Alice" });
ok(
  ins.text === "hi @Alice  there" && ins.cursor === 10,
  "what is right of the caret is kept, untouched: " + JSON.stringify(ins),
);
ins = e.mentionInsert("@", 1, { insert: "All", all: true });
ok(
  ins.text === "@All " && ins.cursor === 5,
  "the 全部 row types @All: " + JSON.stringify(ins),
);
ok(
  e.mentionInsert("no at sign", 5, { insert: "Alice" }).text === "no at sign",
  "nothing to replace leaves the text alone",
);
ok(
  e.mentionInsert("hi @al", 6, null).text === "hi @al",
  "and so does a missing row",
);
// The caret lands after the trailing space, so the next keystroke cannot glue
// itself to the name -- which is what deriveMentions would then fail to find.
ok(
  e.mentionInsert("hi @al", 6, { insert: "Alice" }).text.charAt(9) === " ",
  "the inserted name always ends in a space",
);

group("(q4) what gets sent is re-derived from the text, never from the picks");
e = makeEnv({ activeChat: GROUP });
const pickA = { name: "Alice", mid: M1, all: false, start: 0 };
const pickAll = { name: "All", mid: "", all: true, start: 0 };
ok(
  JSON.stringify(e.deriveMentions("@Alice hi", [pickA])) ===
    JSON.stringify([{ start: 0, end: 6, mid: M1 }]),
  "a pick still in the text becomes one mention",
);
ok(
  JSON.stringify(e.deriveMentions("hi @Alice", [pickA])) ===
    JSON.stringify([{ start: 3, end: 9, mid: M1 }]),
  "moved: the offsets follow the text, not the recorded start",
);
ok(
  e.deriveMentions("hi there", [pickA]).length === 0,
  "deleted: a name that is gone sends no mention at all",
);
ok(
  e.deriveMentions("@Alicia hi", [pickA]).length === 0,
  "edited into another name: the same, rather than mentioning the wrong person",
);
ok(
  JSON.stringify(e.deriveMentions("@All 開會", [pickAll])) ===
    JSON.stringify([{ start: 0, end: 4, all: true }]),
  "@All carries the flag and no mid: " +
    JSON.stringify(e.deriveMentions("@All 開會", [pickAll])),
);
const twoAnn = [{ name: "Ann", mid: M1, all: false, start: 0 }, {
  name: "Ann",
  mid: M2,
  all: false,
  start: 9,
}];
ok(
  JSON.stringify(e.deriveMentions("@Ann and @Ann", twoAnn)) ===
    JSON.stringify([{ start: 0, end: 4, mid: M1 }, {
      start: 9,
      end: 13,
      mid: M2,
    }]),
  "two people with the same display name get one occurrence each: " +
    JSON.stringify(e.deriveMentions("@Ann and @Ann", twoAnn)),
);
ok(
  JSON.stringify(
    e.deriveMentions("@Ann and @Ann", [{
      name: "Ann",
      mid: M2,
      all: false,
      start: 9,
    }, { name: "Ann", mid: M1, all: false, start: 0 }]),
  ) ===
    JSON.stringify([{ start: 0, end: 4, mid: M1 }, {
      start: 9,
      end: 13,
      mid: M2,
    }]),
  "picked back-to-front, the recorded start still says who is where -- pick " +
    "order alone would have swapped the two mids",
);
ok(
  JSON.stringify(
    e.deriveMentions("@Annie hi @Ann", [{
      name: "Annie",
      mid: M1,
      all: false,
      start: 0,
    }, { name: "Ann", mid: M2, all: false, start: 10 }]),
  ) ===
    JSON.stringify([{ start: 0, end: 6, mid: M1 }, {
      start: 10,
      end: 14,
      mid: M2,
    }]),
  "@Ann does not steal the front of @Annie -- overlapping spans would send the " +
    "same characters twice: " +
    JSON.stringify(
      e.deriveMentions("@Annie hi @Ann", [{
        name: "Annie",
        mid: M1,
        all: false,
        start: 0,
      }, { name: "Ann", mid: M2, all: false, start: 10 }]),
    ),
);
ok(
  JSON.stringify(
    e.deriveMentions("@Bob hi", [pickA, {
      name: "Bob",
      mid: M2,
      all: false,
      start: 5,
    }]),
  ) ===
    JSON.stringify([{ start: 0, end: 4, mid: M2 }]),
  "one pick going missing does not take the others with it",
);
ok(
  e.deriveMentions("@Alice", null).length === 0 &&
    e.deriveMentions("", [pickA]).length === 0,
  "no picks, or no text, is no mentions",
);
// The unit, from this end. README says UTF-16 code units and the daemon
// validates in them; a QML string is a JS string, so indexOf already counts
// that way -- 早安 is 2 units and 🐈 is a surrogate pair worth 2 more.
const emojiText = "早安🐈 @Alice 好";
ok(
  emojiText.length === 13 && [...emojiText].length === 12,
  "the fixture has an astral character in front of the mention",
);
ok(
  JSON.stringify(e.deriveMentions(emojiText, [pickA])) ===
    JSON.stringify([{ start: 5, end: 11, mid: M1 }]),
  "offsets are UTF-16 code units, the same unit the daemon validates against: " +
    JSON.stringify(e.deriveMentions(emojiText, [pickA])),
);
ok(
  emojiText.substring(5, 11) === "@Alice",
  "and they cut the token out exactly, which is what LINE slices with",
);

group("(q5) mention spans are coloured without breaking escaping or links");
e = makeEnv({ activeChat: GROUP });
const withMention = (text, mentions) =>
  e.bodyHtml({ text: text, mentions: mentions });
let html = withMention("@Alice see https://a.example/x", [{
  start: 0,
  end: 6,
  mid: M1,
  name: "Alice",
}]);
ok(
  html.indexOf('pre-wrap"><span style="color:#3399ff">@Alice</span> see ') > 0,
  "the mention is a coloured span, right where the offsets put it: " + html,
);
ok(
  html.indexOf('<a style="color:#3399ff" href="https://a.example/x">') > 0,
  "and the url next to it is still a link: " + html,
);
html = withMention("a&b @Alice <c>", [{
  start: 4,
  end: 10,
  mid: M1,
  name: "Alice",
}]);
ok(
  html.indexOf("a&amp;b ") > 0 && html.indexOf(" &lt;c&gt;") > 0,
  "the pieces around it are still escaped: " + html,
);
ok(
  html.indexOf(">@Alice</span>") > 0,
  "the span holds exactly the characters the offsets named -- escaping happens " +
    "per piece, after the slicing, so an & earlier in the line cannot shift it",
);
html = withMention("<@a&b> hi", [{ start: 0, end: 6, mid: M1, name: "a&b" }]);
ok(
  html.indexOf('<span style="color:#3399ff">&lt;@a&amp;b&gt;</span>') > 0,
  "a mention span is escaped too, never emitted raw: " + html,
);
ok(
  e.bodyHtml({ text: "plain" }) ===
    '<div style="white-space: pre-wrap">plain</div>',
  "a message with no mentions renders exactly as before: " +
    e.bodyHtml({ text: "plain" }),
);
ok(
  e.bodyHtml({
    text: "",
    contentType: "STICKER",
    mentions: [{ start: 0, end: 4, all: true, name: "全部" }],
  }) ===
    '<div style="white-space: pre-wrap">[貼圖]</div>',
  "offsets are not applied to a placeholder body -- they index m.text, not [貼圖]",
);
ok(
  e.bodyHtml({
    text: "@All\nsecond line",
    mentions: [{ start: 0, end: 4, all: true, name: "全部" }],
  })
    .indexOf("</span><br>second") > 0,
  "a newline right after a span is still a <br>",
);
ok(
  JSON.stringify(
    e.mentionRanges([{ start: 2, end: 1 }, { start: 0, end: 99 }, {
      start: 0,
      end: 3,
    }, { start: 1, end: 4 }], 10),
  ) ===
    JSON.stringify([{ start: 0, end: 3 }]),
  "inverted, out of range and overlapping spans never reach the slicer: " +
    JSON.stringify(
      e.mentionRanges([{ start: 2, end: 1 }, { start: 0, end: 99 }, {
        start: 0,
        end: 3,
      }, { start: 1, end: 4 }], 10),
    ),
);
ok(
  e.mentionRanges(undefined, 10).length === 0 &&
    e.mentionRanges("nope", 10).length === 0,
  "a daemon that sends nonsense costs the highlight, not the bubble",
);
// Number() would turn every one of these into a usable offset -- true is 1,
// null and [] are 0, "0" and "6" parse, 6.5 floors to 6 -- and each one would
// colour characters nobody pointed at. Same rule the daemon applies on the way
// in (mentionOffset), now applied on the way out.
const notOffsets = [
  { start: true, end: 6 },
  { start: 0, end: null },
  { start: "0", end: "6" },
  { start: [0], end: 6 },
  { start: 0, end: 6.5 },
  { start: NaN, end: 6 },
  { start: 0, end: Infinity },
  { start: {}, end: 6 },
];
for (const bad of notOffsets) {
  ok(
    e.mentionRanges([bad], 10).length === 0,
    "not an offset, so no span: " + JSON.stringify(bad),
  );
}
ok(
  JSON.stringify(e.mentionRanges([{ start: 0, end: 6 }], 10)) ===
    JSON.stringify([{ start: 0, end: 6 }]),
  "and a pair of real integers still is one",
);

group("(q6) the picker only exists where there is somebody to mention");
e = makeEnv({ activeChat: { mid: "u" + "9".repeat(32) }, members: THREE });
e.replyField.text = "@al";
e.replyField.cursorPosition = 3;
ok(
  e.root.mentionCapable === false && e.root.mentionToken === null &&
    e.root.mentionOpen === false,
  "a 1:1 chat never opens the picker, even with a member list in hand",
);
e = makeEnv({ activeChat: GROUP, members: THREE });
e.replyField.text = "@al";
e.replyField.cursorPosition = 3;
ok(
  e.root.mentionOpen === true && e.root.mentionRows.length === 3,
  "a group does",
);
e.replyField.activeFocus = false;
ok(
  e.root.mentionOpen === false,
  "and only while the reply box has the keyboard",
);
e.replyField.activeFocus = true;
e.dismissMention();
ok(
  e.root.mentionOpen === false,
  "Esc dismisses this @, without clearing the draft",
);
ok(e.replyField.text === "@al", "the text is untouched by dismissing");
e.replyField.text = "@al @bo";
e.replyField.cursorPosition = 7;
ok(e.root.mentionOpen === true, "a different @ opens the picker again");

group("(q7) picking, moving, and what the send frame carries");
e = makeEnv({ activeChat: GROUP, members: THREE });
e.replyField.text = "hi @al";
e.replyField.cursorPosition = 6;
ok(
  e.root.mentionRows.map((r) => r.name).join(",") === "全部,Alice,alicia",
  "three rows",
);
ok(e.root.mentionSelected === 0, "the first row starts selected");
e.moveMention(1);
ok(e.root.mentionSelected === 1, "↓ moves down");
e.moveMention(-1);
e.moveMention(-1);
ok(e.root.mentionSelected === 2, "↑ from the top wraps to the bottom");
e.root.mentionIndex = 1;
ok(e.takeMention() === true, "Enter takes the highlighted row");
ok(
  e.replyField.text === "hi @Alice " && e.replyField.cursorPosition === 10,
  "which types the name and a space: " + JSON.stringify(e.replyField.text),
);
ok(
  e.root.mentionPicks.length === 1 && e.root.mentionPicks[0].mid === M1 &&
    e.root.mentionPicks[0].start === 3,
  "and records who was picked, and where: " +
    JSON.stringify(e.root.mentionPicks),
);
ok(e.root.mentionOpen === false, "the picker closes once the name is complete");
ok(
  JSON.stringify(
    e.deriveMentions(e.replyField.text.trim(), e.root.mentionPicks),
  ) ===
    JSON.stringify([{ start: 3, end: 9, mid: M1 }]),
  "and the frame that follows carries exactly that span",
);
e = makeEnv({ activeChat: GROUP, members: THREE });
e.replyField.text = "@";
e.replyField.cursorPosition = 1;
e.takeMention(0);
ok(
  e.replyField.text === "@All " && e.root.mentionPicks[0].all === true &&
    e.root.mentionPicks[0].mid === "",
  "the 全部 row records an all-pick with no mid: " +
    JSON.stringify(e.root.mentionPicks),
);
e = makeEnv({ activeChat: GROUP, members: THREE });
ok(e.takeMention() === false, "with no @ in the box there is nothing to take");

group("(q8) the member list is per chat, and its failure is not a banner");
e = makeEnv({ view: "list", activeChat: null });
e.openChat({ mid: "cg1" });
ok(
  e.sent.filter((r) => r.cmd === "members").length === 1 &&
    e.sent.filter((r) => r.cmd === "members")[0].chat === "cg1",
  "opening a group asks for its members once: " +
    JSON.stringify(e.sent.map((r) => r.cmd)),
);
e = makeEnv({ view: "list", activeChat: null });
e.openChat({ mid: "u" + "9".repeat(32) });
ok(
  e.sent.filter((r) => r.cmd === "members").length === 0,
  "opening a 1:1 asks for nothing -- the daemon would only refuse",
);
e = makeEnv({ view: "list", activeChat: null });
e.openChat({ mid: "rr1" });
ok(
  e.sent.filter((r) => r.cmd === "members").length === 1,
  "a room is asked as well; the refusal, if any, is shown in the picker",
);
e = makeEnv({ activeChat: GROUP });
e.root.members = THREE;
e.root.membersError = "boom";
e.loadMembers("cg2");
ok(
  e.root.members.length === 0 && e.root.membersError === "",
  "switching chat drops the previous group's list before the new one arrives",
);
e.root.mentionPicks = [pickA];
e.loadMembers("cg3");
ok(
  e.root.mentionPicks.length === 0,
  "and the picks with it -- they belong to the old draft",
);
e = makeEnv({ twoPane: true, activeChat: GROUP });
e.root.mentionPicks = [pickA];
e.root.mentionDismissedAt = 3;
e.open();
ok(
  e.root.mentionPicks.length === 0 && e.root.mentionDismissedAt === -1,
  "reopening the panel wipes the draft, so the picks go with it",
);

e = makeEnv({ activeChat: GROUP });
e.loadMembers("cg1");
e.onReply(JSON.stringify({ id: 1, ok: true, data: THREE }));
ok(
  e.root.members.length === 3 && e.root.membersError === "",
  "the reply lands on members, and clears any earlier failure",
);
e = makeEnv({ activeChat: GROUP });
e.loadMembers("cg1");
e.onReply(
  JSON.stringify({
    id: 1,
    ok: false,
    error: "多人聊天室（room）拿不到成員名單",
  }),
);
ok(
  e.root.membersError === "多人聊天室（room）拿不到成員名單" &&
    e.root.notice === "",
  "a failure is remembered for the picker and never becomes a banner: " +
    JSON.stringify(e.root.notice),
);
e = makeEnv({ activeChat: GROUP });
e.loadMembers("cg1");
e.root.activeChat = { mid: "cg2" };
e.onReply(JSON.stringify({ id: 1, ok: true, data: THREE }));
ok(
  e.root.members.length === 0,
  "a list that comes back after the user moved on is dropped, not shown",
);
e = makeEnv({ activeChat: GROUP });
e.loadMembers("cg1");
e.root.activeChat = { mid: "cg2" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: "boom" }));
ok(e.root.membersError === "" && e.root.notice === "", "and so is its failure");

group("(q9) the picker's keys never reach the key catcher");
// Anchored on the comment: a 14-space "Keys.onPressed" also matches the one
// inside the message bubble, which is a different handler entirely.
const replyKeys = src.slice(
  src.indexOf("              // 選單開著時 ↑↓ 和 Tab 是它的"),
  src.indexOf("              // Enter 和 Esc 不寫在上面"),
);
for (const key of ["Qt.Key_Up", "Qt.Key_Down", "Qt.Key_Tab"]) {
  ok(replyKeys.indexOf(key) > 0, "the reply box handles " + key + " itself");
}
// Code lines only: the comment above the handler quotes the same line.
const accepts = replyKeys.split("\n")
  .filter((l) =>
    l.indexOf("//") < 0 && l.indexOf("event.accepted = true") >= 0
  );
ok(
  accepts.length === 4,
  "and accepts every one of them, U59's Ctrl+V included -- an unaccepted picker key " +
    "bubbles to PanelKeyCatcher, where ↑↓ scroll the message list, and an unaccepted " +
    "Ctrl+V is the TextArea pasting the clipboard's text into the box underneath the " +
    "picture that is on its way out (" + accepts.length + " accepted)",
);
ok(
  replyKeys.indexOf("if (!root.mentionPicking) return") > 0,
  "the three picker keys behind mentionPicking, so with the picker shut they mean what they always did",
);
ok(
  replyKeys.indexOf("Qt.Key_V") > 0 &&
    replyKeys.indexOf("Qt.Key_V") <
      replyKeys.indexOf("if (!root.mentionPicking) return"),
  "and Ctrl+V in front of that gate: V is not one of the picker's keys, so pasting " +
    "a screenshot cannot depend on whether a @ is half-typed",
);
const enterBlock = src.slice(
  src.indexOf("              Keys.onReturnPressed: function(event) {"),
  src.indexOf("              Keys.onEscapePressed: function(event) {"),
);
ok(
  (enterBlock.match(/root\.mentionPicking && root\.takeMention\(\)/g) || [])
    .length === 2,
  "Enter picks on both Return and the numpad's Enter, before it ever submits",
);
const escBlock = src.slice(
  src.indexOf("              Keys.onEscapePressed: function(event) {"),
  src.indexOf("        // @選單"),
);
ok(
  escBlock.indexOf("root.mentionOpen") > 0 &&
    escBlock.indexOf("dismissMention") > 0,
  "Esc closes the picker first and only then leaves the reply box",
);
ok(
  replyKeys.indexOf("Qt.Key_Return") < 0 &&
    replyKeys.indexOf("Qt.Key_Escape") < 0,
  "and Return/Escape are not handled twice -- onReturnPressed/onEscapePressed run " +
    "first (measured on Qt 6.11), so a copy in onPressed would be dead code",
);
const submitBlock = src.slice(
  src.indexOf("              function submit() {"),
  src.indexOf("              // @ 選單開著的時候鍵盤是它的"),
);
ok(
  submitBlock.length > 0 && replyKeys.length > 0 && escBlock.length > 0,
  "the three reply-box blocks were found in Panel.qml",
);
ok(
  submitBlock.indexOf("root.deriveMentions(body, root.mentionPicks)") > 0,
  "send derives the mentions from the trimmed body it actually sends",
);
ok(
  submitBlock.indexOf("root.resetComposerAfterSuccessfulSend()") > 0 &&
    B.resetComposerAfterSuccessfulSend.indexOf("root.mentionPicks = []") > 0,
  "and clears the picks, so the next message cannot inherit them",
);
const pickerBlockSrc = src.slice(
  src.indexOf("        // @選單"),
  src.indexOf(
    "      // ------------------------------------------------------------- 燈箱",
  ),
);
ok(
  pickerBlockSrc.indexOf("Popup {") < 0 &&
    pickerBlockSrc.indexOf("focus: true") < 0 &&
    pickerBlockSrc.indexOf("forceActiveFocus") < 0,
  "the picker takes no focus of its own -- the caret has to stay in the reply box",
);
ok(
  pickerBlockSrc.indexOf("anchors.bottom:") > 0,
  "it is anchored, not positioned by hand",
);
ok(
  pickerBlockSrc.indexOf("root.membersError") > 0,
  "and it is where the member-list failure is finally said out loud",
);
// The reason line cannot hang off the row count: 「全部」 is not a member and is
// in the list whatever the daemon said, so a bare @ always has a row.
e = makeEnv({
  activeChat: GROUP,
  members: [],
  membersError: "多人聊天室（room）拿不到成員名單",
});
e.replyField.text = "@";
e.replyField.cursorPosition = 1;
ok(
  e.root.mentionOpen === true && e.root.mentionRows.length === 1 &&
    e.root.mentionRows[0].all === true,
  "with no members at all the picker still opens on 「全部」 alone",
);
ok(
  pickerBlockSrc.indexOf("visible: root.membersError.length > 0") > 0 &&
    pickerBlockSrc.indexOf("visible: root.mentionRows.length === 0") < 0,
  "so the reason shows whenever there is one -- a row-count test would hide it " +
    "exactly at the moment the user pressed @ and wants to know",
);

// -------------------------------------------------- (r) U48: the conversation
// is a ListView. Where the view stops after the list is replaced, and the two
// separators, are all root functions -- the harness drives them directly and
// pins the declarative half against the source.

// A fixed "now" so the table below reads the same in every timezone and in
// every month: 2026-09-07 14:30 local.
const NOW48 = new Date(2026, 8, 7, 14, 30, 0).getTime();

group("(r1) dayLabel: 今天／昨天／M月D日, and the year only when it differs");
e = makeEnv({});
ok(e.dayLabel(NOW48, NOW48) === "今天", "the message you are reading now");
ok(
  e.dayLabel(new Date(2026, 8, 7, 0, 0, 0).getTime(), NOW48) === "今天",
  "midnight is still today, not yesterday",
);
ok(
  e.dayLabel(new Date(2026, 8, 7, 23, 59, 59, 999).getTime(), NOW48) === "今天",
  "and so is one millisecond before tomorrow",
);
ok(
  e.dayLabel(new Date(2026, 8, 6, 23, 59, 59, 999).getTime(), NOW48) === "昨天",
  "one millisecond earlier is yesterday",
);
ok(
  e.dayLabel(new Date(2026, 8, 6, 0, 0, 0).getTime(), NOW48) === "昨天",
  "all of yesterday is 昨天, not just the evening",
);
ok(
  e.dayLabel(new Date(2026, 8, 5, 23, 59, 59, 999).getTime(), NOW48) ===
    "9月5日",
  "the day before that gets a date: " +
    e.dayLabel(new Date(2026, 8, 5, 23, 59, 59).getTime(), NOW48),
);
ok(
  e.dayLabel(new Date(2026, 0, 3, 10, 0).getTime(), NOW48) === "1月3日",
  "same year, no year prefix",
);
ok(
  e.dayLabel(new Date(2025, 11, 31, 23, 0).getTime(), NOW48) ===
    "2025年12月31日",
  "31 Dec last year is not 12月31日 -- that would read as this year",
);
ok(
  e.dayLabel(new Date(2027, 0, 1, 0, 0).getTime(), NOW48) === "2027年1月1日",
  "a clock that ran ahead is labelled honestly too",
);
// 「今天」 moves on its own at midnight because nowMs is the 30s timer.
const JUSTAFTER = new Date(2026, 8, 8, 0, 0, 1).getTime();
ok(
  e.dayLabel(NOW48, JUSTAFTER) === "昨天",
  "the same message reads 昨天 once the clock rolls over -- nowMs is a parameter, not a capture",
);

group(
  "(r2) dayStart is the grouping key, so a section is exactly one calendar day",
);
ok(
  e.dayStart(new Date(2026, 8, 7, 0, 0, 0).getTime()) ===
    e.dayStart(new Date(2026, 8, 7, 23, 59, 59, 999).getTime()),
  "first and last millisecond of a day share a key",
);
ok(
  e.dayStart(new Date(2026, 8, 7, 23, 59, 59, 999).getTime()) !==
    e.dayStart(new Date(2026, 8, 8, 0, 0, 0).getTime()),
  "one millisecond later is a different day",
);
ok(
  e.dayStart(0) === e.dayStart(1),
  "a missing time does not crash, it just groups together",
);

group("(r3) withDay stamps the key the section reads, as a string");
e = makeEnv({});
const stamped = e.withDay([{ id: "a", time: NOW48 }, {
  id: "b",
  time: NOW48 + 1000,
}]);
ok(
  typeof stamped[0].day === "string",
  "a string, not a number: a big number comes back out of section as 1.75717e+12",
);
ok(
  stamped[0].day === stamped[1].day,
  "two messages a second apart share the section",
);
ok(
  Number(stamped[0].day) === e.dayStart(NOW48),
  "and the string parses back to the day",
);
const kept = [{ id: "a", time: NOW48, day: "already" }];
ok(
  e.withDay(kept)[0].day === "already",
  "an already-stamped message is left alone",
);
ok(
  e.withDay(null).length === 0,
  "a missing list is an empty list, not a crash",
);

group("(r4) firstUnreadIndex counts back over what LINE actually counts");
e = makeEnv({});
const ten = [];
for (let i = 0; i < 10; i++) {
  ten.push({ id: "m" + i, from: "THEM", contentType: "NONE" });
}
ok(e.firstUnreadIndex(ten, 0) === -1, "nothing unread -> no separator");
ok(
  e.firstUnreadIndex(ten, 3) === 7,
  "3 unread -> the separator sits above the last three",
);
ok(
  e.firstUnreadIndex(ten, 10) === 0,
  "the whole page unread -> above the first message",
);
ok(
  e.firstUnreadIndex(ten, 11) === -1,
  "more unread than this page holds -> no separator at all, rather than a wrong one",
);
ok(
  e.firstUnreadIndex([], 3) === -1 && e.firstUnreadIndex(null, 3) === -1,
  "an empty or missing list never places a mark",
);
// The count LINE keeps is of messages from other people.
const mixed = [
  { id: "a", from: "THEM" },
  { id: "b", from: "ME" },
  { id: "c", from: "THEM" },
  { id: "d", from: "ME", pending: true },
  { id: "e", contentType: "CHATEVENT", from: "THEM" },
  { id: "f", from: "THEM" },
];
ok(
  e.firstUnreadIndex(mixed, 2) === 2,
  "own messages, optimistic bubbles and 系統事件 are not unread: " +
    e.firstUnreadIndex(mixed, 2),
);
ok(
  e.firstUnreadIndex(mixed, 3) === 0,
  "and counting further back skips them the same way",
);

group(
  "(r5) the unread mark is taken when the chat opens, not when history lands",
);
e = makeEnv({ view: "list", activeChat: null });
e.root.chats = [{ mid: "C9", unread: 2 }];
e.openChat({ mid: "C9", unread: 2 });
ok(
  e.root.unreadMarkCount === 2 && e.root.unreadMarkId === "",
  "opening records the count and clears any previous mark",
);
ok(
  e.sent.filter((f) => f.cmd === "history")[0].markRead === true,
  "and the same open asks the daemon to mark it read -- which is why the count " +
    "has to be taken here, before state.json comes back with unread: 0",
);
e.onReply(
  JSON.stringify({
    id: e.sent.filter((f) => f.cmd === "history")[0].id,
    ok: true,
    data: [
      { id: "m1", from: "THEM", time: NOW48 },
      { id: "m2", from: "THEM", time: NOW48 },
      { id: "m3", from: "THEM", time: NOW48 },
      { id: "m4", from: "THEM", time: NOW48 },
    ],
  }),
);
ok(
  e.root.unreadMarkId === "m3",
  "the mark lands on the first of the two unread ones",
);
ok(e.root.unreadMarkCount === 0, "and the count is spent");
// A refetch (sync, or a new message arriving) must not walk the line down the page.
e.root.loadHistory("C9");
const again = e.sent.filter((f) => f.cmd === "history").pop();
e.onReply(JSON.stringify({
  id: again.id,
  ok: true,
  data: [
    { id: "m1", from: "THEM", time: NOW48 },
    { id: "m2", from: "THEM", time: NOW48 },
    { id: "m3", from: "THEM", time: NOW48 },
    { id: "m4", from: "THEM", time: NOW48 },
    { id: "m5", from: "THEM", time: NOW48 },
  ],
}));
ok(
  e.root.unreadMarkId === "m3",
  "a refetch leaves the line where the reader last saw it",
);
e.back();
ok(
  e.root.unreadMarkId === "" && e.root.unreadMarkCount === 0,
  "leaving the conversation clears it, so the next open starts over",
);

// U57: in twoPane the chat is still open when the panel comes back, so openChat
// never runs -- and until now nothing else asked how many messages arrived while
// the panel was shut, which is exactly the case the line is for.
// U82: the reload this open fires no longer marks the chat read -- opening the
// panel is not opening the chat. The line still arms from the count snapshot
// below; the receipt waits for a real openChat, which carries markRead.
group(
  "(r5) reopening the panel arms the mark for what arrived while it was shut",
);
e = makeEnv({ twoPane: true, activeChat: { mid: "C9" }, view: "list" });
e.root.messages = [{ id: "m1", from: "THEM", time: NOW48 }];
e.close(); // twoPane keeps activeChat
e.sock.connected = false; // Socket.connected is bound to root.opened
// two arrive while it is shut: the daemon rewrites state.json either way
e.root.chats = [{ mid: "C9", unread: 2, lastTime: 9000 }];
e.sock.connected = true; // the socket comes back with the panel
e.open();
ok(
  e.root.unreadMarkCount === 2 && e.root.unreadMarkId === "",
  "the count is re-read from state on the way in, and any old mark cleared: " +
    e.root.unreadMarkCount,
);
let reopened = e.sent.filter((f) => f.cmd === "history").pop();
ok(
  reopened.markRead !== true,
  "and the reload this open fires does not mark the chat read -- only a real " +
    "openChat does that; the count above arms the line, not the wire",
);
e.onReply(JSON.stringify({
  id: reopened.id,
  ok: true,
  data: [
    { id: "m1", from: "THEM", time: NOW48 },
    { id: "m2", from: "THEM", time: NOW48 },
    { id: "m3", from: "THEM", time: NOW48 },
  ],
}));
ok(
  e.root.unreadMarkId === "m2",
  "the line lands above the first of the two that arrived: " +
    e.root.unreadMarkId,
);

// Nothing new since: no line. Leaving the old one up would point at a message
// that was read an open ago.
e.close();
e.root.chats = [{ mid: "C9", unread: 0, lastTime: 9000 }];
e.open();
ok(
  e.root.unreadMarkId === "" && e.root.unreadMarkCount === 0,
  "reopening on a chat with nothing new draws no line at all",
);

// The socket is usually still down at this moment (it reconnects with the
// panel), so the count is taken here and spent by whichever reload gets there
// first -- the heartbeat's parseState, or onConnectionStateChanged.
e = makeEnv({ twoPane: true, activeChat: { mid: "C9" }, view: "list" });
e.close();
e.sock.connected = false;
e.root.chats = [{ mid: "C9", unread: 1, lastTime: 9000 }];
e.open();
ok(
  e.root.unreadMarkCount === 1 && e.sent.length === 0,
  "armed before the socket is up, with nothing on the wire yet",
);
e.sock.connected = true;
e.parseState(
  JSON.stringify({ chats: [{ mid: "C9", unread: 1, lastTime: 9000 }] }),
);
const deferredLoad = e.sent.filter((f) => f.cmd === "history").pop();
e.onReply(JSON.stringify({
  id: deferredLoad.id,
  ok: true,
  data: [
    { id: "m1", from: "THEM", time: NOW48 },
    { id: "m2", from: "THEM", time: NOW48 },
  ],
}));
ok(
  e.root.unreadMarkId === "m2",
  "and the deferred reload still finds the count waiting for it",
);

// A chat that is no longer in the list (deleted while the panel was shut) is
// zero, not a throw and not a line in the wrong place.
e = makeEnv({ twoPane: true, activeChat: { mid: "C9" }, view: "list" });
e.close();
e.root.chats = [];
e.open();
ok(
  e.root.unreadMarkCount === 0 && e.root.unreadMarkId === "",
  "a chat that fell out of the list arms nothing",
);

group(
  "(r6) setMessages decides where the view stops, before the list is swapped",
);
e = makeEnv({});
e.msgList.contentY = 300;
e.msgList.originY = 0;
e.msgList.contentHeight = 1000;
e.msgList.height = 400;
e.setMessages([{ id: "x" }]);
ok(e.root.atBottom === false, "scrolled up -> the swap is recorded as 'stay'");
ok(
  e.root.keepContentY === 300,
  "and where to come back to is measured before the reset",
);
e = makeEnv({});
e.msgList.contentY = 600;
e.msgList.originY = 0;
e.msgList.contentHeight = 1000;
e.msgList.height = 400;
e.setMessages([{ id: "x" }]);
ok(
  e.root.atBottom === true,
  "parked on the last message -> follow the new one",
);
e = makeEnv({});
e.msgList.contentY = 0;
e.msgList.originY = 0;
e.msgList.contentHeight = 1000;
e.msgList.height = 400;
e.setMessages([{ id: "x" }], true);
ok(
  e.root.atBottom === true,
  "an explicit follow wins over the geometry -- opening a chat always starts at the end",
);
// originY is not 0 while a virtualised ListView is still realising items above.
e = makeEnv({});
e.msgList.contentY = 371;
e.msgList.originY = 71;
e.msgList.contentHeight = 1000;
e.msgList.height = 400;
e.setMessages([{ id: "x" }]);
ok(
  e.root.keepContentY === 300,
  "the saved position is relative to originY, not absolute",
);
ok(
  e.deferred.length === 1,
  "and a backstop is armed for the swap that never happens",
);
e.flushLater();
ok(
  e.root.keepContentY === -1 && e.root.prependAnchorIndex === -1,
  "which clears both flags -- an identical list never emits modelChanged, and a " +
    "flag nobody clears would block scrolling for good",
);

group("(r7) an older page arms the index anchor, not a height");
e = makeEnv({});
e.root.messages = e.withDay([{ id: "b9", time: NOW48 }]); // as a history reply leaves it
e.msgList.contentY = 0;
e.msgList.contentHeight = 900;
e.msgList.height = 400;
e.loadOlder();
// an older page goes out as a history frame carrying `before` (see olderFrame)
e.onReply(
  JSON.stringify({
    id: e.sent.filter(olderFrame).pop().id,
    ok: true,
    data: [{ id: "b7", time: NOW48 }, { id: "b8", time: NOW48 }],
  }),
);
ok(
  e.root.messages.map((m) => m.id).join() === "b7,b8,b9",
  "the page is prepended",
);
ok(
  e.root.prependAnchorIndex === 2,
  "and the anchor is the index the message under the eye moved to: " +
    e.root.prependAnchorIndex,
);
ok(
  e.root.messages.every((m) => typeof m.day === "string"),
  "every prepended message carries the section key too, or its date separator is missing",
);
ok(
  e.root.atBottom === false,
  "paging back never counts as 'follow the bottom', whatever the geometry said",
);

group(
  "(r8) the pane is a ListView over root.messages, with a section separator",
);
ok(
  !/Repeater \{\s*\n\s*model: root\.messages/.test(src),
  "no Repeater rebuilding every bubble on every change",
);
ok(
  /ListView \{\n          id: msgList/.test(src),
  "the conversation is a ListView",
);
const listBlock = src.slice(
  src.indexOf("        ListView {\n          id: msgList"),
  src.indexOf("          id: attachButton"),
);
ok(listBlock.length > 0, "the ListView block was found in Panel.qml");
ok(
  /^          model: root\.messages$/m.test(listBlock),
  "its model is root.messages itself -- one source of truth, no ListModel to keep in sync",
);
ok(
  !/ListModel/.test(src),
  "and there is no ListModel anywhere to drift from it",
);
ok(
  /^          section\.property: "day"$/m.test(listBlock) &&
    /^          section\.delegate: Text \{$/m.test(listBlock),
  "the date separator is a real section header, not a row the delegate hides",
);
ok(
  /root\.dayLabel\(Number\(section\), root\.nowMs\)/.test(listBlock),
  "whose label is recomputed from nowMs, so 今天 moves at midnight on its own",
);
ok(
  /cacheBuffer:/.test(listBlock),
  "with a cache buffer, or scrolling rebuilds as it goes",
);
ok(
  /verticalLayoutDirection: ListView\.TopToBottom/.test(listBlock),
  "oldest at the top, like every other chat window",
);
ok(
  /onModelChanged: \{/.test(listBlock) &&
    /positionViewAtIndex\(Math\.min\(root\.prependAnchorIndex/.test(listBlock),
  "the prepend anchor is applied by index after the swap",
);
ok(
  /root\.keepContentY >= 0 \|\| root\.prependAnchorIndex >= 0\) return/.test(
    listBlock,
  ),
  "and the reset's contentY=0 is not mistaken for 'the reader scrolled to the top'",
);
ok(
  /onContentYChanged: \{/.test(listBlock) &&
    /root\.loadOlder\(\)/.test(listBlock),
  "reaching the top still asks for another page",
);
// Everything the rows did before still has to be wired to the same intents.
ok(
  /required property var modelData/.test(msgRows),
  "the delegate takes modelData explicitly",
);
// U51 gave the index back: which message in a run wears a face is a question
// about the message before this one. The reason index was refused in U48 still
// holds -- the day is a section, not something a row works out for itself.
ok(
  /required property int index/.test(msgRows) &&
    /root\.showAvatarAt\(root\.messages, msgDelegate\.index\)/.test(msgRows) &&
    !/root\.messages\[/.test(msgRows),
  "and an index used for the avatar run only: no row reaches into " +
    "root.messages[index - 1] to find out whether the day changed",
);
ok(
  /root\.bodyHtml\(modelData\)/.test(msgRows) &&
    /root\.mediaUsable\(modelData\)/.test(msgRows) &&
    /modelData\.unsent === true/.test(msgRows),
  "and still asks the same root functions about markup, media and recalls",
);
ok(
  /root\.openMedia\(modelData\.id, "external"\)/.test(msgRows) &&
    /root\.showPicture\(modelData\.id/.test(msgRows),
  "the 📎 and the thumbnail still route through openMedia/showPicture",
);
ok(
  /root\.unreadMarkId/.test(msgRows) && /tr\("chat\.unreadDivider"\)/.test(msgRows),
  "and the unread separator is a row of the delegate -- it appears once, it is not a group",
);
ok(
  /readonly property bool firstUnread: root\.unreadMarkId\.length > 0/.test(
    msgRows,
  ),
  "keyed on the id, so prepending an older page does not move the line",
);

// ------------------------------------------------ (s) U53: list-pane layout
// Style.space() is the shell's DPI scale; the identity here, as in makeEnv, so
// the table below reads in the same units Panel.qml is written in.
const LAYOUT_STYLE = { space: (n) => n };
const listPaneWidth = new Function(
  "Style",
  "PanelKit",
  "parentWidth",
  "fontScale",
  B.listPaneWidth,
)
  .bind(null, LAYOUT_STYLE, PanelKit);
const toolsStacked = new Function(
  "Style",
  "PanelKit",
  "paneWidth",
  "toolsWidth",
  B.toolsStacked,
)
  .bind(null, LAYOUT_STYLE, PanelKit);

group(
  "(s1) the tools row drops below the search box only when both cannot fit",
);
// paneWidth, toolsWidth, stacked?, why
[
  [
    243,
    118,
    true,
    "the 718px tiled pane leaves the search box a slot, not a field",
  ],
  [277, 118, true, "one pixel under the threshold still stacks"],
  [
    278,
    118,
    false,
    "exactly at the threshold fits -- the search box gets its 160",
  ],
  [300, 118, false, "the default pane keeps both on one row"],
  [420, 280, true, "a big font widens the tools, so even a wide pane stacks"],
  [480, 280, false, "…until the pane is wide enough for the wider row too"],
  [0, 118, true, "a pane with no width yet stacks rather than overlapping"],
].forEach(function (row) {
  ok(
    toolsStacked(row[0], row[1]) === row[2],
    "toolsStacked(" + row[0] + ", " + row[1] + ") === " + row[2] + " -- " +
      row[3],
  );
});

group(
  "(s2) the list pane grows with the font but never past 35% of the usable width",
);
// parentWidth, fontScale, width, why
[
  [1400, 1.0, 300, "a wide window stops at the 300-wide cap"],
  [
    1400,
    1.6,
    480,
    "…which the font scale raises, so a big font still fits a chat name",
  ],
  [
    718,
    1.0,
    243,
    "the 718px tiled window hands the conversation the other 65%",
  ],
  [
    718,
    1.6,
    243,
    "and a bigger font cannot claw that back -- this is what f4115da fixed",
  ],
  [940, 1.0, 300, "the panel's own 940 is wide enough for the cap"],
  [200, 1.0, 61, "a pane narrower than the cap just takes its share"],
  [0, 1.0, 0, "and a parent with no width yet is 0, never negative"],
].forEach(function (row) {
  const got = listPaneWidth(row[0], row[1]);
  ok(
    got === row[2],
    "listPaneWidth(" + row[0] + ", " + row[1] + ") === " + row[2] +
      " (got " + got + ") -- " + row[3],
  );
});
ok(
  718 - 25 - listPaneWidth(718, 1.6) >= (718 - 25) * 0.6,
  "even at the largest font the tiled window keeps 60% for the conversation",
);
let widthMono = true, widthPrev = -1;
for (let w = 0; w <= 2000; w += 13) {
  const v = listPaneWidth(w, 1.0);
  if (v < widthPrev) widthMono = false;
  widthPrev = v;
}
ok(
  widthMono,
  "widening the window never narrows the list -- dragging an edge does not jump",
);

group("(s3) Panel.qml wires both rules, and says how to start a dead daemon");
const listPaneBlock = src.slice(
  src.indexOf("      Item {\n        id: listPane"),
  src.indexOf("          id: paneDivider"),
);
ok(listPaneBlock.length > 0, "the listPane block was found in Panel.qml");
ok(
  /width: root\.twoPane \? root\.listPaneWidth\(parent\.width, root\.fontScale\) : parent\.width/
    .test(listPaneBlock),
  "the width binding calls listPaneWidth -- the rule is not copied inline as well",
);
ok(
  /readonly property bool stackedTools: root\.toolsStacked\(width, scaleRow\.implicitWidth\)/
    .test(listPaneBlock),
  "and stackedTools calls toolsStacked",
);
ok(
  !/Style\.space\(300\)/.test(listPaneBlock) &&
    (src.match(/Style\.space\(300\)/g) || []).length === 1,
  "the old inline expression is gone from the binding -- listPaneWidth is the only " +
    "copy of the rule, so the table above cannot pass while the panel does something else",
);
ok(
  /meta: !root\.online \? tr\("daemon\.offline"\)/.test(listPaneBlock),
  "the hero still names the offline state",
);
ok(
  /tr\("daemon\.notRunningHint"\)/.test(listPaneBlock) &&
    /tr\("daemon\.starting"\)/.test(listPaneBlock),
  "and says how to get it back -- the hint points at the start button, plus a starting state after the kick",
);
ok(
  /trailingControl: Component/.test(listPaneBlock) &&
    /tr\("daemon\.startBtn"\)/.test(listPaneBlock) &&
    /visible: !root\.sockConnected/.test(listPaneBlock),
  "and the offline hero carries an actual clickable start button",
);
const toolsRowBlock = listPaneBlock.slice(
  listPaneBlock.indexOf("        Row {\n          id: scaleRow"),
  listPaneBlock.indexOf("          id: searchField"),
);
ok(toolsRowBlock.length > 0, "the scaleRow block was found");
ok(
  /y: listPane\.stackedTools \?/.test(toolsRowBlock),
  "the tools row is placed by y, which the stacking switch can move",
);
ok(
  !/anchors\.verticalCenter: searchField\.verticalCenter/.test(toolsRowBlock),
  "and the old anchor is gone -- an anchor plus a y on the same item is a silent draw",
);
ok(
  /anchors\.right: listPane\.stackedTools \? parent\.right : scaleRow\.left/
    .test(listPaneBlock),
  "the search box takes the whole row back when the tools move under it",
);
ok(
  (src.match(
    /listPane\.stackedTools \? scaleRow\.height \+ Style\.space\(10\) : 0/g,
  ) || []).length === 2,
  "both the panel height and the list's top margin reserve the second row -- " +
    "reserving it in only one of them puts the tools on top of the first chat",
);
ok(
  !src.includes("// Reserve most of the available width for the conversation"),
  "the width comment is in the file's language again",
);
ok(
  !src.includes(
    "// Move the controls below search when the list is too narrow",
  ),
  "and so is the stacking one",
);

// ------------------------------------------------ (t) U49: the panel lives off
// the daemon's event ring. What each kind does to the message list is a pure
// function over that list, so the harness applies them to a fixture; the
// declarative half (quote strip, reaction bar, 已讀 line) is pinned to source.

const EV = (seq, kind, chat, extra) =>
  Object.assign({ seq: seq, at: NOW48, kind: kind, chat: chat }, extra || {});
const MSG = (id, from, text, extra) =>
  Object.assign({
    id: id,
    chat: "C1",
    from: from,
    fromName: from === "ME" ? "我" : "Alice",
    text: text,
    time: NOW48,
    contentType: "NONE",
    decryptFailed: false,
    hasMedia: false,
  }, extra || {});

group("(t1) eventsSince: what is new, and when events alone cannot catch up");
e = makeEnv({});
let ring = [
  EV(1, "message", "C1", { message: MSG("m1", "THEM", "a") }),
  EV(2, "message", "C1", { message: MSG("m2", "THEM", "b") }),
];
let ev = e.eventsSince(ring, "boot-1", "", 0);
ok(ev.live === true, "a state with an events array is a daemon that pushes");
ok(
  ev.list.length === 0,
  "the first state read replays nothing -- the ring is older than the history " +
    "that is about to be fetched, so replaying it is pure make-work",
);
ok(ev.seq === 2, "but the watermark is adopted, so the next write is a delta");
ok(
  ev.reload === false,
  "and the first read is not a gap: nothing was missed, nothing was tracked",
);
ev = e.eventsSince(
  ring.concat([EV(3, "read", "C1", { by: "THEM", upTo: "m2" })]),
  "boot-1",
  "boot-1",
  2,
);
ok(
  ev.list.length === 1 && ev.list[0].seq === 3,
  "afterwards only what is past the watermark",
);
ok(ev.seq === 3 && ev.reload === false, "and the watermark follows it");
ev = e.eventsSince(ring, "boot-1", "boot-1", 2);
ok(
  ev.list.length === 0 && ev.seq === 2,
  "re-reading the same state twice (a heartbeat rewrites the file) changes nothing",
);
// The ring is 200 entries; a panel left alone through a busy hour loses the middle.
ev = e.eventsSince(
  [EV(50, "message", "C1", { message: MSG("m9", "THEM", "z") })],
  "boot-1",
  "boot-1",
  7,
);
ok(
  ev.reload === true,
  "a seq gap is a reload: the events in between are gone and only a history page has them",
);
ok(
  ev.list.length === 1 && ev.seq === 50,
  "the watermark still moves to the end of the ring",
);
ev = e.eventsSince(ring, "boot-2", "boot-1", 9);
ok(
  ev.reload === true,
  "a new bootId is a reload too -- the daemon was down for some of it",
);
ok(
  ev.seq === 2 && ev.list.length === 2,
  "and seq counts from 1 again, so the old watermark must not filter the new round",
);
ev = e.eventsSince(undefined, "", "", 0);
ok(
  ev.live === false && ev.list.length === 0 && ev.reload === false,
  "a daemon with no events key is not broken, it is old -- the panel keeps the old way",
);
ev = e.eventsSince(
  [{ kind: "message", chat: "C1" }, EV(4, "unsend", "C1", { messageId: "m1" })],
  "boot-1",
  "boot-1",
  3,
);
ok(
  ev.list.length === 1 && ev.list[0].seq === 4,
  "an entry with no seq cannot be placed in the round at all, so it is dropped",
);

group("(t2) parseState feeds the open chat from events instead of refetching");
const evState = (extra) =>
  JSON.stringify(Object.assign({
    updatedAt: NOW48,
    bootId: "boot-1",
    me: { mid: "ME" },
    login: { status: "ok" },
    chats: [{ mid: "C1", name: "chat", unread: 0, lastTime: 500 }],
    events: [],
  }, extra));
// 舊語義：同一份內容同時走 state.json 的狀態解析和 events.json 的事件管線。
const feedEvents = (e, str) => {
  e.parseState(str);
  e.parseEventsText(str);
};

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.lastBootId = "boot-1";
e.root.lastSeq = 1;
e.root.loadHistory("C1");
let historyBeforeGap = e.sent.at(-1);
feedEvents(e, evState({
  events: [EV(3, "message", "C1", { message: MSG("gap-3", "THEM", "missed") })],
}));
ok(
  e.sent.filter((r) => r.cmd === "history" && r.count !== 1).length === 1 &&
    e.root.historyReloadAfterGeneration === 2,
  "an event gap during history records a newer-generation reload",
);
e.onReply(JSON.stringify({ id: historyBeforeGap.id, ok: true, data: [] }));
ok(
  e.sent.filter((r) => r.cmd === "history" && r.count !== 1).length === 2 &&
    e.root.historyReloadAfterGeneration === 2,
  "the older in-flight page cannot consume the event-gap reload",
);
e.onReply(
  JSON.stringify({
    id: e.sent.at(-1).id,
    ok: true,
    data: [MSG("gap-3", "THEM", "missed")],
  }),
);
ok(
  e.root.historyReloadAfterGeneration === 0 &&
    e.root.messages[0].id === "gap-3",
  "the post-gap history generation clears the deferred reload",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.lastBootId = "boot-1";
e.root.lastSeq = 1;
e.root.loadHistory("C1");
historyBeforeGap = e.sent.at(-1);
feedEvents(e, evState({
  events: [
    EV(3, "message", "C1", { message: MSG("gap-fail", "THEM", "missed") }),
  ],
}));
e.onReply(
  JSON.stringify({ id: historyBeforeGap.id, ok: false, error: "network" }),
);
ok(
  e.sent.filter((r) => r.cmd === "history" && r.count !== 1).length === 2 &&
    e.root.historyReloadAfterGeneration === 2,
  "failure of the pre-gap history still starts the deferred reload",
);
e.onReply(JSON.stringify({ id: e.sent.at(-1).id, ok: true, data: [] }));

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.chats = [{ mid: "C1", unread: 0, lastTime: 500 }];
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
const ring1 = [EV(1, "message", "C1", { message: MSG("m1", "THEM", "a") })];
feedEvents(e, evState({ events: ring1 }));
ok(
  e.root.messages.length === 1 && e.root.lastSeq === 1 &&
    e.root.lastBootId === "boot-1",
  "the first state read only adopts the watermark -- whatever the ring holds is " +
    "already in the history the panel fetched when it opened the chat",
);
const ring2 = ring1.concat([
  EV(2, "message", "C1", { message: MSG("m2", "THEM", "b") }),
]);
feedEvents(e, evState({ events: ring2 }));
ok(
  e.historyCalls.length === 0,
  "a new message costs no history call at all -- that was the whole point",
);
ok(
  e.root.messages.map((m) => m.id).join() === "m1,m2",
  "it is simply appended",
);
ok(e.root.lastSeq === 2, "and the watermark follows");
// Same file, read again: FileView reloads on every write, heartbeat included.
feedEvents(e, evState({ events: ring2 }));
ok(e.root.messages.length === 2, "the same event is not applied twice");
// Marking read used to be a free ride on the refetch (history carries markRead).
// With no refetch it has to be asked for, or the chat you are reading keeps its
// badge and the other person never gets a 已讀.
let marks = e.sent.filter((r) =>
  r.cmd === "history" && r.markRead === true && r.count === 1
);
ok(
  marks.length === 1 && marks[0].chat === "C1",
  "and one read receipt goes out for it: " + JSON.stringify(marks),
);
ok(
  e.sent.filter((r) => r.cmd === "history" && r.count !== 1).length === 0,
  "which is one message wide, not a page -- the page is what U49 exists to avoid, " +
    "and the page size is a setting now, so no literal here would stay true",
);
// A burst (an album, a long line LINE split up) is still one receipt.
feedEvents(e, evState({
  events: ring2.concat([
    EV(3, "message", "C1", { message: MSG("m3", "THEM", "c") }),
    EV(4, "message", "C1", { message: MSG("m4", "THEM", "d") }),
  ]),
}));
ok(
  e.sent.filter((r) => r.cmd === "history" && r.markRead === true).length === 2,
  "a burst of events is one receipt, not one per message: " +
    e.sent.filter((r) => r.cmd === "history" && r.markRead === true).length,
);
// Our own echo is not something to mark read.
feedEvents(e, evState({
  events: ring2.concat([
    EV(3, "message", "C1", { message: MSG("m3", "THEM", "c") }),
    EV(4, "message", "C1", { message: MSG("m4", "THEM", "d") }),
    EV(5, "message", "C1", { message: MSG("m5", "ME", "e") }),
  ]),
}));
ok(
  e.sent.filter((r) => r.cmd === "history" && r.markRead === true).length === 2,
  "and our own message coming back from LINE is not a receipt at all",
);
ok(
  e.root.messages.map((m) => m.id).join() === "m1,m2,m3,m4,m5",
  "though it is still appended",
);
// A receipt is the panel talking to itself. Nobody pressed anything, so neither
// answer belongs on the notice line -- not the failure as a red banner appearing
// while you read, and not the success quietly wiping the error you are reading.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.notice = "只能收回自己傳的訊息";
e.request("markRead", { chat: "C1", count: 1, markRead: true });
let receipt = e.sent.pop();
e.onReply(
  JSON.stringify({ id: receipt.id, ok: false, error: "沒有這個聊天室的游標" }),
);
ok(
  e.root.notice === "只能收回自己傳的訊息",
  "a failed receipt raises no banner of its own: " +
    JSON.stringify(e.root.notice),
);
ok(
  e.root.loading === false && e.root.loadingOlder === false,
  "and touches none of the spinners either -- on the wire it is a `history` frame, " +
    "but nothing is waiting for that page",
);
e.request("markRead", { chat: "C1", count: 1, markRead: true });
receipt = e.sent.pop();
e.onReply(
  JSON.stringify({ id: receipt.id, ok: true, data: [MSG("m9", "THEM", "z")] }),
);
ok(
  e.root.notice === "只能收回自己傳的訊息",
  "and a successful one does not clear the notice the user is still reading",
);
ok(
  e.root.messages.length === 0,
  "nor does the page it brings back land in the conversation: what was wanted was " +
    "the daemon's sendChatChecked, not those messages",
);
// The ordinary failure banner is untouched by all of that.
e = makeEnv({ activeChat: { mid: "C1" } });
e.request("send", { chat: "C1", text: "x" }, "pending-1");
e.onReply(JSON.stringify({ id: e.sent.pop().id, ok: false, error: "boom" }));
ok(e.root.notice === "boom", "a command the user did press still says so");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
e.parseState(evState({}));
feedEvents(
  e,
  evState({
    events: [EV(1, "message", "C2", { message: MSG("x1", "THEM", "b") })],
  }),
);
ok(
  e.root.messages.length === 1 && e.root.lastSeq === 1,
  "an event for another chat touches nothing here -- that chat's preview comes from `chats`",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
e.parseState(evState({}));
feedEvents(
  e,
  evState({
    bootId: "boot-2",
    events: [EV(1, "message", "C1", { message: MSG("m2", "THEM", "b") })],
  }),
);
ok(
  e.historyCalls.join() === "C1",
  "a restart refetches instead: the events from before it are unrecoverable",
);
// The new daemon writes state.json before its socket listens. parseState is
// then the only place that sees the boot change -- by the time the socket is up
// lastBootId is already the new boot, so neither the ring read nor a push can
// spot the restart. The old round's watermark must not survive into the new one.
e = makeEnv({ activeChat: { mid: "C1" }, connected: false });
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
e.root.lastBootId = "boot-1";
e.root.lastSeq = 900;
e.root.eventsConsumed = true;
e.root.eventsLive = true;
e.parseState(evState({ bootId: "boot-2", events: undefined }));
ok(
  e.root.lastBootId === "boot-2" && e.root.lastSeq === 0,
  "a boot change seen in state.json resets the seq watermark: " +
    e.root.lastSeq,
);
ok(
  e.historyCalls.length === 0 && e.root.historyReloadChat === "C1" &&
    e.root.historyReloadAfterGeneration > 0,
  "with the socket down nothing is fetched, but the catch-up is recorded",
);
e.sock.connected = true;
e.root.reconciliationEpoch++;
e.root.eventsSyncing = true;
ok(
  e.reconcileAfterConnect() === true && e.historyCalls.join() === "C1",
  "and the reconnect refetches the open chat, like a restart seen while connected",
);
e.onReply(JSON.stringify({
  id: e.sent.filter((r) => r.cmd === "history").at(-1).id,
  ok: true,
  data: [MSG("m1", "THEM", "a")],
}));
e.parseEventsText(evState({
  bootId: "boot-2",
  events: [EV(1, "message", "C1", { message: MSG("b2-1", "THEM", "b") })],
}));
e.onPushedEvent({
  boot: "boot-2",
  event: EV(2, "message", "C1", { message: MSG("b2-2", "THEM", "c") }),
});
ok(
  e.root.messages.map((m) => m.id).join() === "m1,b2-1,b2-2" &&
    e.root.lastSeq === 2 && e.root.eventsLive === true,
  "the new boot's seq 1 from the ring and seq 2 from the push both land: " +
    e.root.messages.map((m) => m.id).join(),
);
// The reconnect catch-up follows the reopen rule for read receipts: in a
// two-column placement the right pane's chat only came back with the panel, so
// refetching it must not mark it read. A single-pane chat view is being read.
for (const twoPane of [true, false]) {
  e = makeEnv({ activeChat: { mid: "C1" }, twoPane, view: twoPane ? "list" : "chat" });
  e.root.historyReloadChat = "C1";
  e.root.historyReloadAfterGeneration = 1;
  e.root.reconciliationEpoch++;
  e.reconcileAfterConnect();
  const reconcilePage = e.sent.filter((r) => r.cmd === "history").at(-1);
  ok(
    !!reconcilePage && reconcilePage.markRead === !twoPane,
    (twoPane
      ? "two-column reconnect refetch does not mark the right pane read"
      : "single-pane reconnect refetch still marks the open chat read") +
      ": " + JSON.stringify(reconcilePage),
  );
}
// The panel is closed -> no socket -> nothing is applied, but the watermark still moves.
e = makeEnv({ activeChat: { mid: "C1" }, connected: false });
e.root.lastBootId = "boot-1";
feedEvents(
  e,
  evState({
    events: [EV(7, "message", "C1", { message: MSG("m2", "THEM", "b") })],
  }),
);
ok(
  e.root.lastSeq === 7 && e.root.messages.length === 0,
  "with the socket down nothing is applied, but the watermark still moves -- otherwise " +
    "reopening replays the whole ring in one frame",
);
// An old daemon: no events key at all, so the lastTime rule has to still work.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadedAt = 100;
e.root.chats = [{ mid: "C1", unread: 0, lastTime: 500 }];
e.parseState(
  JSON.stringify({
    updatedAt: NOW48,
    me: { mid: "ME" },
    login: { status: "ok" },
    chats: [{ mid: "C1", unread: 0, lastTime: 500 }],
  }),
);
ok(
  e.historyCalls.join() === "C1",
  "an old daemon still gets a full refetch when the chat's lastTime moves",
);
// Reopening while the socket was down leaves loadedAt at 0; events cannot fill a
// history that was never fetched.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadedAt = 0;
e.root.lastBootId = "boot-1";
e.root.chats = [{ mid: "C1", unread: 0, lastTime: 500 }];
feedEvents(
  e,
  evState({
    events: [EV(1, "message", "C1", { message: MSG("m2", "THEM", "b") })],
  }),
);
ok(
  e.historyCalls.join() === "C1",
  "and so does a panel that has no history yet at all (loadedAt === 0)",
);

group("(t2.5) socket push: live frames, queued sync, file dedupe");

// The connect handler is socket wiring; pin it against source the same way the
// dropInFlight branch above is pinned.
ok(
  /if \(!connected\) \{[^}]*root\.dropInFlight\(\)[^}]*return/.test(sockBlock),
  "losing the connection still drops the in-flight requests first",
);
ok(
  /root\.eventsSyncing = true/.test(sockBlock) &&
    /eventsView\.reload\(\)/.test(sockBlock) &&
    sockBlock.indexOf("root.eventsSyncing = true") <
      sockBlock.indexOf("eventsView.reload()"),
  "and a fresh connection queues pushes behind the events.json catch-up read",
);

// A live event pushed over the socket: applied straight away, watermark moves.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadedAt = 100;
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
e.root.lastBootId = "boot-1";
e.root.lastSeq = 4;
e.onReply(
  JSON.stringify({
    event: EV(5, "message", "C1", { message: MSG("m2", "THEM", "b") }),
    boot: "boot-1",
  }),
);
ok(
  e.root.messages.map((m) => m.id).join() === "m1,m2" && e.root.lastSeq === 5,
  "a pushed event is applied straight off the socket: " +
    JSON.stringify(e.root.messages.map((m) => m.id)),
);
// The file copy of the same seq then lands -- the shared watermark eats it.
e.parseEventsText(evState({
  events: [
    EV(5, "message", "C1", { message: MSG("m2", "THEM", "b") }),
    EV(6, "message", "C1", { message: MSG("m3", "THEM", "c") }),
  ],
}));
ok(
  e.root.messages.map((m) => m.id).join() === "m1,m2,m3" &&
    e.root.lastSeq === 6,
  "the file's copy of a pushed event is deduped by seq, its successor lands",
);
// A stale push (old seq on the same boot) is dropped before applyEvents.
e.onReply(
  JSON.stringify({
    event: EV(5, "message", "C1", { message: MSG("m2x", "THEM", "z") }),
    boot: "boot-1",
  }),
);
ok(
  e.root.messages.filter((m) => m.id === "m2x").length === 0,
  "a re-sent seq from the same boot is dropped, not appended",
);
// And a stray push-shaped line must never crash onReply.
e.onReply(JSON.stringify({ event: EV(9, "message", "C1", {
  message: MSG("z", "THEM", "z"),
}), boot: "boot-1" }));
ok(true, "an unsolicited push line is survivable");

// A boot the file has not shown yet means a new daemon -- the watermark
// resets instead of comparing seqs across processes.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadedAt = 100;
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
e.root.lastBootId = "boot-9";
e.root.lastSeq = 30;
e.onReply(
  JSON.stringify({
    event: EV(2, "message", "C1", { message: MSG("m2", "THEM", "b") }),
    boot: "boot-2",
  }),
);
ok(
  e.root.lastBootId === "boot-2" && e.root.lastSeq === 2 &&
    e.root.messages.map((m) => m.id).join() === "m1,m2",
  "a foreign boot rewrites the watermark and still lands",
);

// Pushes during a catch-up read are queued and drained in order -- they must
// not jump the watermark ahead of the file's older events.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadedAt = 100;
e.root.messages = e.withDay([MSG("m1", "THEM", "a")]);
e.root.lastBootId = "boot-1";
e.root.lastSeq = 2;
e.root.eventsSyncing = true;
e.onReply(
  JSON.stringify({
    event: EV(4, "message", "C1", { message: MSG("m4", "THEM", "d") }),
    boot: "boot-1",
  }),
);
ok(
  e.root.messages.map((m) => m.id).join() === "m1" &&
    e.root.queuedPushes.length === 1,
  "a push mid-sync is held, not applied",
);
e.parseEventsText(evState({
  events: [EV(3, "message", "C1", { message: MSG("m3", "THEM", "c") })],
}));
ok(
  e.root.messages.map((m) => m.id).join() === "m1,m3,m4" &&
    e.root.queuedPushes.length === 0 && e.root.eventsSyncing === false,
  "the file gap lands first, then the queued push drains in order: " +
    JSON.stringify(e.root.messages.map((m) => m.id)),
);

// The same channel repaints a chat row: {chat} frames carry the row and the
// chatsRevision it was published under, no event seq.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.chatSnapshot = [
  { mid: "C1", lastTime: 500, lastText: "old", unread: 0 },
  { mid: "C2", lastTime: 900, lastText: "top", unread: 3 },
];
e.root.chatRevisionSeen = 10;
e.root.chatBootSeen = "boot-1";
e.onReply(
  JSON.stringify({
    chat: { mid: "C1", lastTime: 1200, lastText: "new", unread: 1 },
    chatsRevision: 11,
    boot: "boot-1",
  }),
);
ok(
  e.root.chatSnapshot[0].mid === "C1" &&
    e.root.chatSnapshot[0].lastText === "new" &&
    e.root.chatRevisionSeen === 11,
  "a pushed chat row repaints and re-sorts the list ahead of the file: " +
    JSON.stringify(e.root.chatSnapshot),
);
// A row the list does not have yet (push introduced it) lands as an insert.
e.onReply(
  JSON.stringify({
    chat: { mid: "C9", lastTime: 1300, lastText: "hi", unread: 1 },
    chatsRevision: 12,
    boot: "boot-1",
  }),
);
ok(
  e.root.chatSnapshot[0].mid === "C9" && e.root.chatSnapshot.length === 3,
  "and a provisional row appears without waiting for the file either",
);
// A hidden row pushed by the daemon keeps its stamp through the merge.
e.root.chatSnapshot[0].hidden = true;
e.onReply(
  JSON.stringify({
    chat: { mid: "C9", lastTime: 1400, lastText: "later", unread: 2 },
    chatsRevision: 13,
    boot: "boot-1",
  }),
);
ok(
  e.root.chatSnapshot[0].hidden === true &&
    e.root.chatSnapshot[0].lastText === "later",
  "a stamp-less field on the wire merges instead of erasing",
);
// Stale revision is dropped; so is a frame from a boot the file has not
// shown yet -- the next state.json lands the whole list anyway.
e.onReply(
  JSON.stringify({
    chat: { mid: "C9", lastTime: 9999, lastText: "rewind" },
    chatsRevision: 12,
    boot: "boot-1",
  }),
);
ok(
  e.root.chatSnapshot[0].lastText === "later",
  "an old revision cannot rewind the row",
);
e.onReply(
  JSON.stringify({
    chat: { mid: "C9", lastTime: 9999, lastText: "alien" },
    chatsRevision: 99,
    boot: "boot-7",
  }),
);
ok(
  e.root.chatSnapshot[0].lastText === "later" &&
    e.root.chatRevisionSeen === 13,
  "a patch from a boot the file has not shown yet waits for the file",
);
// So does one that lands before the first snapshot at all.
e = makeEnv({ activeChat: { mid: "C1" } });
e.onReply(
  JSON.stringify({
    chat: { mid: "C9", lastTime: 1, lastText: "early", unread: 1 },
    chatsRevision: 3,
    boot: "boot-1",
  }),
);
ok(
  e.root.chatSnapshot.length === 0,
  "a push before the first file read is dropped -- the file is seconds away",
);
// The file write carrying rev 12 lands after the rev-13 patch: the snapshot
// must not fall back to it, or the just-pushed rows flicker backwards.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.chatSnapshot = [
  { mid: "C9", lastTime: 1400, lastText: "later", unread: 2 },
];
e.root.chatRevisionSeen = 13;
e.root.chatBootSeen = "boot-1";
e.parseState(evState({
  chatsRevision: 12,
  chats: [{ mid: "C1", lastTime: 500, lastText: "old" }],
}));
ok(
  e.root.chatSnapshot.length === 1 &&
    e.root.chatSnapshot[0].lastText === "later",
  "a file revision older than a pushed patch is not allowed to clobber it",
);
e.parseState(evState({
  chatsRevision: 14,
  chats: [{ mid: "C1", lastTime: 500, lastText: "settled" }],
}));
ok(
  e.root.chatSnapshot.length === 1 &&
    e.root.chatSnapshot[0].lastText === "settled",
  "and the next file revision still lands wholesale",
);

group("(t3) message events: dedupe, and the optimistic bubble is replaced");
e = makeEnv({ activeChat: { mid: "C1" } });
let list = [MSG("m1", "THEM", "a")];
ok(
  e.mergeMessage(list, MSG("m2", "THEM", "b")).map((m) => m.id).join() ===
    "m1,m2",
  "a new one appends",
);
ok(
  e.mergeMessage(list, undefined) === list &&
    e.mergeMessage(list, { text: "x" }) === list,
  "an event with no message in it is not a bubble",
);
let merged = e.mergeMessage(list, MSG("m1", "THEM", "edited"));
ok(
  merged !== list && merged.length === 1 && merged[0].text === "edited",
  "the same id updates in place rather than appearing twice",
);
ok(
  merged[0] !== list[0],
  "as a new object -- mutating a plain JS object emits no change signal, and a " +
    "ListView whose elements are the same references does not even rebuild",
);
// The bubble the panel drew the moment Enter was pressed.
e.root.messages = [];
e.root.activeChat = { mid: "C1" };
const pid = e.appendPending("hi", []);
ok(
  e.root.messages[0].pending === true && e.root.messages[0].id === pid,
  "the optimistic bubble is in",
);
e.request("send", { chat: "C1", text: "hi" }, pid);
const sendToken = e.sent.at(-1).requestId;
ok(
  typeof sendToken === "string" && sendToken.length > 0 &&
    e.root.messages[0].requestId === sendToken &&
    e.root.pending[e.sent.at(-1).id].requestId === sendToken,
  "request tags the optimistic bubble and pending record with the wire token",
);
ok(
  e.root.pending[e.sent.at(-1).id].bubble.requestId === sendToken,
  "the pending request retains the complete tagged bubble for a later disconnect",
);
const real = e.mergeMessage(
  e.root.messages,
  Object.assign(MSG("m9", "ME", "hi"), { requestId: sendToken }),
);
ok(
  real.length === 1 && real[0].id === "m9",
  "LINE pushes our own message back, and it takes the pending bubble's place " +
    "instead of standing next to it: " + real.map((m) => m.id).join(),
);
const other = e.mergeMessage(e.root.messages, MSG("m9", "THEM", "hi"));
ok(
  other.length === 2,
  "somebody else saying the same word is a new message, not our echo",
);
const repeated = [
  {
    id: "pending-a",
    from: "ME",
    text: "same",
    pending: true,
    requestId: "request-a",
  },
  {
    id: "pending-b",
    from: "ME",
    text: "same",
    pending: true,
    requestId: "request-b",
  },
];
const exactEcho = Object.assign(MSG("m10", "ME", "same"), {
  requestId: "request-b",
});
merged = e.mergeMessage(repeated, exactEcho);
ok(
  merged[0].id === "pending-a" && merged[1].id === "m10",
  "the exact token replaces the right one of two identical pending bubbles",
);
merged = e.mergeMessage(repeated, MSG("m11", "ME", "same"));
ok(
  merged.length === 3 && merged[0].id === "pending-a" &&
    merged[1].id === "pending-b",
  "a tokenless echo cannot consume a token-protected ambiguous bubble",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = [
  { id: "collision", pending: true, requestId: "older-token" },
  { id: "collision", pending: true },
];
e.request("send", { chat: "C1", text: "new" }, "collision");
ok(
  e.root.messages[0].requestId === "older-token" &&
    e.root.messages[1].requestId === e.sent.at(-1).requestId,
  "request tagging cannot overwrite an already correlated restored bubble",
);
const restoredId = "pending-" + e.root.panelInstanceId + "-" + e.root.nextId;
const freshPendingId = e.appendPending("unique", []);
ok(
  freshPendingId.indexOf(restoredId) === 0 && freshPendingId !== "pending-1",
  "optimistic identities include the panel instance instead of restarting at pending-1",
);
let failedThenRetried = [
  MSG("pending-1", "ME", "same", { pending: true, failed: true }),
  MSG("pending-2", "ME", "same", { pending: true }),
];
failedThenRetried = e.mergeMessage(
  failedThenRetried,
  MSG("m-real", "ME", "same"),
);
ok(
  failedThenRetried.length === 2 &&
    failedThenRetried[0].id === "pending-1" &&
    failedThenRetried[0].failed === true &&
    failedThenRetried[1].id === "m-real",
  "a delivered retry replaces the live pending bubble, never the retained failure",
);

group("(t4) read events move 已讀 on our own messages only");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.members = [{ mid: "A" }, { mid: "B" }];
ok(
  e.root.readerCount === 2,
  "in a group the denominator is the member list (which excludes us)",
);
list = [MSG("m1", "ME", "a"), MSG("m2", "THEM", "b"), MSG("m3", "ME", "c")];
let read = e.applyRead(list, "m3", "A");
ok(
  read !== list && read[0].readBy.count === 1 && read[2].readBy.count === 1,
  "everything of ours up to the read mark counts them",
);
ok(
  read[1].readBy === undefined,
  "their own messages never get a 已讀 -- LINE reports who read what we sent",
);
ok(read[0].readBy.all === false, "one of two members is not everyone");
read = e.applyRead(read, "m3", "A");
ok(
  read[2].readBy.count === 1,
  "the same person reading again does not add a second reader: " +
    read[2].readBy.count,
);
read = e.applyRead(read, "m3", "B");
ok(
  read[2].readBy.count === 2 && read[2].readBy.all === true,
  "the second one does, and completes the room",
);
ok(
  e.applyRead(list, "nope", "A") === list,
  "a mark for a message that is not on this page changes nothing -- older ones are " +
    "not loaded and newer ones have not arrived, so guessing could only over-report",
);
// A 1:1 has exactly one other person, and no member list is ever fetched for it.
e = makeEnv({ activeChat: { mid: "u" + "1".repeat(32) } });
ok(e.root.readerCount === 1, "a 1:1 has one reader without asking anybody");
read = e.applyRead([MSG("m1", "ME", "a")], "m1", "THEM");
ok(
  read[0].readBy.all === true && e.readText(read[0]) === "已讀",
  "so one read receipt is 已讀, with no number",
);
e = makeEnv({ activeChat: { mid: "C1" } });
// The daemon counted somebody at open time without saying who; taking the larger
// of the two can under-report but can never invent a reader.
read = e.applyRead(
  [MSG("m1", "ME", "a", { readBy: { count: 2, all: false } })],
  "m1",
  "A",
);
ok(
  read[0].readBy.count === 2,
  "a reader the daemon already counted is not counted twice: " +
    read[0].readBy.count,
);
// U83: op 40 (we read the chat somewhere else) reaches applyRead with by =
// ourselves. That cursor says "I read theirs", never "someone read mine", so
// it must not touch anything -- the first draft counted it as a reader and a
// 1:1 marked our own bubble 已讀.
const selfList = [
  MSG("m1", "ME", "a"),
  MSG("m2", "THEM", "b"),
  MSG("m3", "ME", "c"),
];
const selfRead = e.applyRead(selfList, "m3", "ME");
ok(
  selfRead === selfList,
  "our own read cursor is not a reader of what we sent: the list comes back as-is",
);
ok(
  selfRead[0].readBy === undefined && selfRead[2].readBy === undefined,
  "so readBy is left exactly as it was",
);
const selfOnCounted = [
  MSG("m1", "ME", "a", { readBy: { count: 1, all: false } }),
];
ok(
  e.applyRead(selfOnCounted, "m1", "ME") === selfOnCounted &&
    selfOnCounted[0].readBy.count === 1,
  "a self read can neither inflate a count nor flip its all flag",
);
const oneToOne = makeEnv({ activeChat: { mid: "u" + "1".repeat(32) } });
const solo = oneToOne.applyRead([MSG("m1", "ME", "a")], "m1", "ME");
ok(
  solo[0].readBy === undefined && oneToOne.readText(solo[0]) === "",
  "the 1:1 that started U83: reading on our phone must not draw 已讀 on our own bubble",
);

group("(t5) 已讀 is drawn only for what is actually known");
e = makeEnv({});
ok(
  e.readText(MSG("m1", "ME", "a", { readBy: { count: 1, all: true } })) ===
    "已讀",
  "1:1 style",
);
ok(
  e.readText(MSG("m1", "ME", "a", { readBy: { count: 3, all: false } })) ===
    "已讀 3",
  "group style",
);
ok(
  e.readText(MSG("m1", "ME", "a")) === "",
  "no readBy at all -> nothing: the field is absent when unknown, and 'unknown' " +
    "must never be drawn as 'nobody'",
);
ok(
  e.readText(MSG("m1", "ME", "a", { readBy: { count: 0, all: true } })) === "",
  "and a zero count is not 已讀 either, whatever `all` says",
);
ok(
  e.readText(MSG("m1", "THEM", "a", { readBy: { count: 1, all: true } })) ===
    "",
  "their messages never carry it, even if a daemon someday sends one",
);
ok(e.readText(null) === "", "and a missing message is not a crash");
const failedReadList = [
  MSG("pending-failed", "ME", "A", { pending: true, failed: true }),
  MSG("m2", "ME", "B"),
];
read = e.applyRead(failedReadList, "m2", "THEM");
ok(
  read[0].readBy === undefined && read[1].readBy.count === 1,
  "read events skip a retained failed message and update the delivered one",
);
ok(
  e.readText(MSG("pending-failed", "ME", "A", {
    failed: true,
    readBy: { count: 1, all: true },
  })) === "",
  "failed messages never render a contradictory read receipt",
);

group("(t6) reaction and unsend events");
e = makeEnv({ activeChat: { mid: "C1" } });
list = [MSG("m1", "THEM", "a"), MSG("m2", "ME", "b")];
let react = e.applyReaction(list, "m2", [{
  type: "NICE",
  count: 2,
  mine: true,
}]);
ok(
  react[1].reactions.length === 1 && react[1].reactions[0].type === "NICE",
  "the bar is replaced whole",
);
ok(
  react[0].reactions === undefined && react[1] !== list[1],
  "and only that message is touched",
);
ok(
  e.applyReaction(react, "m2", []).length === 2 &&
    e.applyReaction(react, "m2", [])[1].reactions === undefined,
  "an empty bar removes the field rather than leaving [] -- absent is the contract's 'none'",
);
ok(
  e.applyReaction(list, "gone", [{ type: "NICE", count: 1, mine: false }]) ===
    list,
  "a reaction on a message this page does not hold changes nothing",
);
let gone = e.applyUnsend([MSG("m1", "THEM", "hi", {
  hasMedia: true,
  mediaPath: "/p/a.jpg",
  mediaState: "ok",
  stickerUrl: "https://s/1.png",
  flexImages: ["https://s/2.png"],
  reactions: [{ type: "NICE", count: 1, mine: false }],
  readBy: { count: 1, all: true },
  mentions: [{ start: 0, end: 2, name: "hi" }],
})], "m1")[0];
ok(
  gone.text === "已收回訊息" && gone.unsent === true &&
    gone.mediaState === "unsent" &&
    gone.hasMedia === false,
  "an unsend rewrites the row the way the daemon rewrites history",
);
ok(
  gone.mediaPath === undefined && gone.stickerUrl === undefined &&
    gone.flexImages === undefined &&
    gone.reactions === undefined && gone.readBy === undefined,
  "and takes the leftovers with it -- a sticker still drawn beside 已收回訊息 is the bug",
);
ok(
  gone.mentions === undefined,
  "the mention offsets go too: they describe the old sentence, and painting them " +
    "over 已收回訊息 colours the wrong characters",
);

list = [MSG("m1", "THEM", "a"), MSG("m2", "ME", "b")];
let edited = e.applyEdit(list, MSG("m1", "THEM", "edited-a", { edited: true }));
ok(edited !== list && edited.length === 2
   && edited[0].text === "edited-a" && edited[0].edited === true && edited[1] === list[1],
   "an edit swaps the row in place: same length, same position, new object");
ok(e.applyEdit(list, MSG("m9", "THEM", "ghost", { edited: true })) === list,
   "an edit for a message this page does not hold changes nothing -- appending it "
   + "would park an old message at the tail in the wrong order");
ok(e.applyEdit(list, {}) === list && e.applyEdit(list, undefined) === list
   && e.applyEdit(list, { id: "" }) === list,
   "and an edit carrying no id to match on is ignored");

list = [MSG("m1", "THEM", "old-a"), MSG("m2", "ME", "b"), MSG("m3", "THEM", "old-c")];
let rebased = e.applyHistory(list, [MSG("m2", "ME", "b"), MSG("m3", "THEM", "new-c")]);
ok(rebased.map(m => m.id).join() === "m1,m2,m3"
   && rebased[2].text === "new-c" && rebased[0] === list[0],
   "a rebase swaps the covered span and keeps what it never saw");
rebased = e.applyHistory(
  [MSG("m1", "THEM", "a"), MSG("pending-1-1", "ME", "draft", { pending: true }),
   MSG("m9", "THEM", "gone")],
  [MSG("m1", "THEM", "a2")]);
ok(rebased.map(m => m.id).join() === "m1,m9,pending-1-1"
   && rebased[2].pending === true,
   "a pending bubble outlives the rebase, and even an unmentioned row stays put");
let drifted = e.applyHistory([MSG("m1", "THEM", "a")], [MSG("m5", "THEM", "x")]);
ok(drifted.map(m => m.id).join() === "m1,m5",
   "a page with no overlap still merges by time instead of dropping the old row");
ok(e.applyHistory(list, []) === list && e.applyHistory(list, null) === list,
   "and an empty rebase changes nothing");

group("(t7) applyEvents routes each kind, and does nothing when nothing changed");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.members = [{ mid: "A" }];
e.root.messages = e.withDay([MSG("m1", "ME", "a")]);
const before49 = e.root.messages;
e.applyEvents([EV(1, "message", "C1", { message: MSG("m2", "THEM", "b") }),
               EV(2, "read", "C1", { by: "A", upTo: "m1" }),
               EV(3, "reaction", "C1", { messageId: "m2",
                                         reactions: [{ type: "OMG", count: 1, mine: true }] }),
               EV(4, "unsend", "C1", { messageId: "m1" }),
               EV(5, "edit", "C1", { message: MSG("m2", "THEM", "b-edited",
                                                  // 真實路徑上 reactions 是 daemon 從 cache
                                                  // 重新掛回來的，所以換回來的這份照樣帶著。
                                                  { edited: true,
                                                    reactions: [{ type: "OMG", count: 1,
                                                                  mine: true }] }) })]);
ok(e.root.messages.length === 2, "the message event appended");
ok(e.root.messages[0].unsent === true, "the unsend landed on the first");
ok(e.root.messages[1].reactions[0].type === "OMG", "the reaction landed on the new one");
ok(e.root.messages[1].text === "b-edited" && e.root.messages[1].edited === true,
   "the edit replaced it in place afterwards");
ok(e.root.messages[0].readBy === undefined,
   "and the read that arrived before the unsend is wiped by it, not left dangling");
ok(e.sent.filter(r => r.markRead === true).length === 1,
   "one receipt for the batch, whatever else was in it");
ok(e.root.messages.every(m => typeof m.day === "string"),
   "every appended message carries the section key, or its date separator goes missing");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "ME", "a")]);
const same = e.root.messages;
e.applyEvents([
  EV(1, "read", "C1", { by: "A", upTo: "nope" }),
  EV(2, "reaction", "C2", { messageId: "m1", reactions: [] }),
]);
ok(
  e.root.messages === same,
  "a round that changes nothing does not swap the model: setMessages would recompute " +
    "the scroll position on every heartbeat",
);
ok(e.sent.length === 0, "and asks the daemon for nothing either");
e.root.activeChat = null;
e.applyEvents([EV(3, "message", "C1", { message: MSG("m2", "THEM", "b") })]);
ok(
  e.root.messages === same,
  "and with no chat open there is nowhere to put them",
);

group("(t8) 回覆: the target, the request, and the way out of it");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "THEM", "早安\n第二行")]);
e.startReply(e.root.messages[0]);
ok(
  !!e.root.replyTarget && e.root.replyTarget.id === "m1",
  "回覆 records which message",
);
ok(
  e.root.replyTarget.text === "早安 第二行",
  "with the body flattened to one line -- the strip is one line high: " +
    JSON.stringify(e.root.replyTarget.text),
);
ok(e.root.replyTarget.fromName === "Alice", "and who said it");
e.submit("好");
let frame = e.sent.pop();
ok(
  frame.cmd === "reply" && frame.replyTo === "m1" && frame.text === "好" &&
    frame.chat === "C1",
  "Enter sends `reply`, not `send`: " + JSON.stringify(frame),
);
ok(
  e.root.replyTarget === null && e.replyField.text === "",
  "the target is spent with the draft -- the next sentence is not a reply too",
);
ok(
  e.root.messages.length === 2 && e.root.messages[1].replyTo.id === "m1" &&
    e.root.messages[1].pending === true,
  "and the optimistic bubble already shows the quote, a second before LINE echoes it back",
);
e = makeEnv({
  activeChat: { mid: "cg1" },
  members: [{ mid: "u" + "1".repeat(32), name: "Bob" }],
});
e.root.messages = e.withDay([MSG("m1", "THEM", "x")]);
e.startReply(e.root.messages[0]);
e.root.mentionPicks = [{ name: "Bob", mid: "u" + "1".repeat(32), start: 0 }];
e.submit("@Bob 好");
frame = e.sent.pop();
ok(
  frame.cmd === "reply" && frame.replyTo === "m1" &&
    frame.mentions.length === 1 &&
    frame.mentions[0].mid === "u" + "1".repeat(32),
  "a reply still carries mentions -- 回覆 and @ are not alternatives: " +
    JSON.stringify(frame),
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.submit("嗨");
frame = e.sent.pop();
ok(
  frame.cmd === "send" && frame.replyTo === undefined,
  "with no target it is the plain send it always was",
);
// Failing halfway is the same story as `send`: the words come back, the bubble goes.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "THEM", "x")]);
e.startReply(e.root.messages[0]);
e.submit("好");
frame = e.sent[e.sent.length - 1];
e.onReply(
  JSON.stringify({
    id: frame.id,
    ok: false,
    error: "沒有指定要回覆哪一則訊息",
  }),
);
ok(e.root.notice === "沒有指定要回覆哪一則訊息", "a refused reply says why");
ok(
  e.root.messages.length === 1 && e.replyField.text === "好",
  "drops the optimistic bubble and gives the sentence back, exactly like send",
);
ok(
  e.isSendCmd("send") && e.isSendCmd("reply") && !e.isSendCmd("sendFile"),
  "which is one rule, asked in one place, for both commands",
);
// Esc unwinds one layer at a time.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "THEM", "x")]);
e.startReply(e.root.messages[0]);
e.back();
ok(
  e.root.replyTarget === null,
  "leaving the conversation drops the target with it",
);
e.startReply(e.root.messages[0]);
e.openChat({ mid: "C2" });
ok(
  e.root.replyTarget === null,
  "and so does switching chat -- it belonged to the other one",
);
ok(
  e.canActOn(MSG("m1", "THEM", "x")) === true,
  "an ordinary message can be replied to",
);
ok(
  e.canActOn(MSG("m1", "ME", "x", { pending: true })) === false,
  "an optimistic bubble cannot: its id is one the panel made up, the daemon never saw it",
);
ok(
  e.canActOn(MSG("m1", "THEM", "x", { unsent: true })) === false,
  "nor a recalled one",
);
ok(
  e.canActOn(MSG("m1", "THEM", "", { contentType: "CHATEVENT" })) === false,
  "nor a system event, which is not a message anybody sent",
);
ok(
  e.quoteText({ id: "m1", fromName: "Alice", text: "早安" }) === "Alice：早安",
  "the quote reads as a quote",
);
ok(
  e.quoteText({ id: "m1" }) === "訊息",
  "and one the daemon could not look up still draws a line, rather than a blank strip",
);
ok(e.quoteText(null) === "", "no target, no strip");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([MSG("m1", "THEM", "a"), MSG("m2", "THEM", "b")]);
ok(
  e.scrollToMessage("m2") === true && e.positioned.join() === "1",
  "clicking a quote centres the original: " + e.positioned.join(),
);
ok(
  e.scrollToMessage("old") === false && e.root.notice.length > 0,
  "and one that is further back than this page says so out loud, instead of doing nothing",
);

group("(t9) 反應: six emoji, one per person, click again to take it back");
e = makeEnv({ activeChat: { mid: "C1" } });
ok(
  e.root.reactionTypes.join() === "NICE,LOVE,FUN,AMAZING,SAD,OMG",
  "the six LINE names, in LINE's own order",
);
ok(
  e.root.reactionTypes.every((t) => e.reactionEmoji(t).length > 0) &&
    new Set(e.root.reactionTypes.map((t) => e.reactionEmoji(t))).size === 6,
  "each maps to a different emoji: " +
    e.root.reactionTypes.map((t) => e.reactionEmoji(t)).join(" "),
);
ok(
  e.reactionEmoji("WHATEVER") === "WHATEVER",
  "and a seventh one LINE adds later prints its name rather than a blank box",
);
ok(
  e.reactionEmoji("") === "？" && e.reactionEmoji(null) === "？",
  "with a visible fallback for nothing",
);
const msgNice = MSG("m1", "THEM", "x", {
  reactions: [{ type: "NICE", count: 2, mine: true }],
});
ok(e.myReaction(msgNice) === "NICE", "the panel knows which one is ours");
ok(
  e.myReaction(MSG("m1", "THEM", "x")) === "",
  "and that we have not chosen on a bare message",
);
e.toggleReaction(msgNice, "LOVE");
frame = e.sent.pop();
ok(
  frame.cmd === "react" && frame.messageId === "m1" && frame.type === "LOVE" &&
    frame.chat === "C1",
  "a different emoji moves our choice: " + JSON.stringify(frame),
);
e.toggleReaction(msgNice, "NICE");
frame = e.sent.pop();
ok(
  frame.cmd === "react" && frame.type === "UNDO",
  "clicking the one we already chose takes it back -- LINE has no second slot, so " +
    "there is nowhere else for 'cancel' to live",
);
e.toggleReaction(MSG("p1", "ME", "x", { pending: true }), "NICE");
ok(
  e.sent.filter((f) => f.cmd === "react").length === 0,
  "and an optimistic bubble is not reactable: the daemon does not know that id",
);

group("(t10) 收回: only ours, and the daemon's refusal is shown");
e = makeEnv({ activeChat: { mid: "C1" } });
const mine49 = MSG("m1", "ME", "oops");
ok(
  JSON.stringify(e.messageMenuItems("", mine49).map((i) => i.action)) ===
    JSON.stringify(["body", "reply", "unsend"]),
  "our own message offers 回覆 and 收回",
);
ok(
  JSON.stringify(
    e.messageMenuItems("", MSG("m1", "THEM", "x")).map((i) => i.action),
  ) ===
    JSON.stringify(["body", "reply"]),
  "somebody else's offers 回覆 alone -- the daemon would refuse the recall anyway, " +
    "and an option that always fails is worse than no option",
);
ok(
  JSON.stringify(
    e.messageMenuItems("https://a.example/x", mine49).map((i) => i.action),
  ) ===
    JSON.stringify(["body", "link", "open", "reply", "unsend"]),
  "the link items keep their place at the top",
);
ok(
  JSON.stringify(
    e.messageMenuItems("", MSG("m1", "ME", "x", { unsent: true })).map((i) =>
      i.action
    ),
  ) ===
    JSON.stringify(["body"]),
  "a message already recalled has nothing left to recall",
);
ok(
  JSON.stringify(e.messageMenuItems("").map((i) => i.action)) ===
    JSON.stringify(["body"]),
  "and a menu opened over nothing at all is exactly what it was before U49",
);
e.unsendMessage(mine49);
frame = e.sent.pop();
ok(
  frame.cmd === "unsend" && frame.messageId === "m1" && frame.chat === "C1",
  "收回 sends the message id and the chat: " + JSON.stringify(frame),
);
e.onReply(
  JSON.stringify({ id: frame.id, ok: false, error: "只能收回自己傳的訊息" }),
);
ok(
  e.root.notice === "只能收回自己傳的訊息",
  "and a refusal (over 24h, someone else's) is shown, not swallowed",
);
e.msgMenu.msg = mine49;
e.runMenuAction("unsend");
ok(
  e.sent.pop().cmd === "unsend" && e.msgMenu.closed > 0,
  "the menu row is wired to it, and closes",
);
e.msgMenu.msg = MSG("m2", "THEM", "x");
e.runMenuAction("reply");
ok(e.root.replyTarget.id === "m2", "and so is 回覆");

group("(t11) the declarative half: quote strip, reaction bar, 已讀 line");
const listBlock49 = src.slice(
  src.indexOf("        ListView {\n          id: msgList"),
  src.indexOf("          id: attachButton"),
);
ok(
  /root\.applyEvents\(evs\.list\)/.test(B.consumeEventsFile) &&
    /root\.eventsSince\(/.test(B.consumeEventsFile),
  "consumeEventsFile is where the ring is consumed, on the events.json read",
);
ok(
  /evs\.live && root\.loadedAt > 0 && !evs\.reload/.test(B.consumeEventsFile),
  "with the three conditions that decide between an append and a refetch in one place",
);
ok(
  /id: quoteBlock/.test(msgRows) &&
    /root\.quoteText\(msgDelegate\.modelData\.replyTo\)/.test(msgRows),
  "a bubble with replyTo draws the quote above its body",
);
ok(
  /root\.scrollToMessage\(msgDelegate\.modelData\.replyTo\.id\)/.test(msgRows),
  "and the quote is clickable, back to the original",
);
ok(
  /maximumLineCount: 1/.test(msgRows),
  "one line only: elide trims the end of a line, it does not fold a newline " +
    "away, and the row that grows a second line climbs onto its neighbours",
);
ok(
  /id: reactionBar/.test(msgRows) &&
    /model: msgDelegate\.modelData\.reactions \?\? \[\]/.test(msgRows),
  "the reaction bar is a Repeater over the contract's own array",
);
ok(
  /root\.reactionEmoji\(reactionPill\.modelData\.type\)/.test(msgRows) &&
    /Number\(reactionPill\.modelData\.count \|\| 0\)/.test(msgRows),
  "each pill is the emoji and the count",
);
ok(
  /borderSpec: Border\.flat\(reactionPill\.mine \? Color\.accent : root\.dim, 1\)/
    .test(msgRows),
  "ours is outlined in the accent",
);
ok(
  /onClicked: root\.toggleReaction\(msgDelegate\.modelData,\n\s*reactionPill\.modelData\.type\)/
    .test(msgRows),
  "and clicking a pill goes through the same toggle as the menu",
);
ok(
  /text: root\.readText\(msgDelegate\.modelData\)/.test(msgRows) &&
    /horizontalAlignment: Text\.AlignRight/.test(msgRows),
  "已讀 is a right-aligned line under the bubble",
);
ok(
  /visible: text\.length > 0/.test(msgRows),
  "which disappears entirely when there is nothing known, rather than reserving a blank row",
);
const stripBlock = src.slice(
  src.indexOf("        Item {\n          id: quoteStrip"),
  src.indexOf("        // @選單"),
);
ok(stripBlock.length > 0, "the quote strip block was found in Panel.qml");
ok(
  /visible: !!root\.replyTarget/.test(stripBlock) &&
    /text: tr\("reply\.quote", root\.quoteText\(root\.replyTarget\)\)/.test(stripBlock),
  "the strip above the box says who is being replied to",
);
ok(
  /onClicked: root\.replyTarget = null/.test(stripBlock),
  "and its ✕ drops the target",
);
ok(
  /anchors\.bottom: quoteStrip\.visible \? quoteStrip\.top/.test(listBlock49),
  "the message list gives up the strip's height instead of hiding behind it",
);
const escBlock49 = src.slice(
  src.indexOf("              Keys.onEscapePressed: function(event) {"),
  src.indexOf("        // 正在回覆哪一則"),
);
ok(
  /if \(root\.replyTarget\) \{ root\.replyTarget = null/.test(escBlock49) &&
    escBlock49.indexOf("root.mentionOpen") <
      escBlock49.indexOf("root.replyTarget"),
  "Esc unwinds one layer at a time: picker, then quote, then the box itself",
);
const menuBlock = src.slice(
  src.indexOf("      Popup {\n        id: msgMenu"),
  src.length,
);
ok(
  /model: root\.reactionTypes/.test(menuBlock) &&
    /root\.toggleReaction\(msgMenu\.msg, emojiCell\.modelData\)/.test(
      menuBlock,
    ),
  "the menu's own emoji row is one click deep, not a submenu",
);
ok(
  /readonly property bool mine: root\.myReaction\(msgMenu\.msg\) === emojiCell\.modelData/
    .test(menuBlock),
  "and it shows which one is already ours",
);
// U66 turned the one Popup into the host for two sets of rows, so the model is
// the dispatcher rather than messageMenuItems() directly; menuItems() is what
// still hands it msgMenu.link and msgMenu.msg for the message case.
ok(
  /model: root\.menuItems\(\)/.test(menuBlock),
  "the rows below it come from the one dispatcher",
);
ok(
  /root\.messageMenuItems\(msgMenu\.link, msgMenu\.msg\)/.test(B.menuItems),
  "which knows which message they are for",
);
ok(
  /property var msg: null/.test(menuBlock),
  "which is what the popup carries now",
);
ok(
  /\+ \(root\.canActOn\(msgMenu\.msg\) \? 1 : 0\)\) \* Style\.spacing\.popupRowHeight/
    .test(src),
  "and the emoji row is counted when the menu is placed, or it hangs off the card",
);
ok(
  /readonly property int readerCount:\n\s*!root\.activeChat \? 0\n\s*: \(\/\^u\/\.test/
    .test(src),
  "the 已讀 denominator is derived from the mid and the member list, not stored",
);

// ------------------------------------------------- (u) U51: faces, and the
// hand-off a clicked notification leaves behind. What colour a face is, what it
// says when there is no picture, and which message in a run wears one are pure
// functions. The hand-off is parseState reading a watermark -- the panel cannot
// be told which chat to open (the shell's IPC is open/close/toggle and carries
// no argument), so getting this wrong means a click that opens the wrong chat.

group("(u1) avatarColor: a mid always gets the same colour");
e = makeEnv({});
ok(
  e.avatarColor("u1234") === e.avatarColor("u1234") &&
    e.avatarColor("u1234") !== undefined,
  "the same mid twice is the same colour: " + e.avatarColor("u1234"),
);
ok(
  /^#[0-9a-f]{6}$/.test(e.avatarColor("u1234")),
  "and it is something QML can take as a colour",
);
const avatarSpread = new Set(
  ["u1", "u2", "u3", "u4", "cg1", "cg2", "r7", "uzzz"].map((m) =>
    e.avatarColor(m)
  ),
);
ok(
  avatarSpread.size >= 4,
  "different mids land on different entries, not all on one: " +
    avatarSpread.size + " of 8",
);
ok(
  e.avatarColor("") === e.avatarColor(undefined) &&
    /^#/.test(e.avatarColor(undefined)),
  "a missing mid still gets a colour instead of throwing -- avatarPath is optional, " +
    "and so is everything around it",
);

group("(u2) avatarInitial: one character, even when that character is two");
ok(e.avatarInitial("frank") === "F", "latin initials are upper-cased");
ok(e.avatarInitial("  王小明 ") === "王", "a leading space is not the initial");
ok(
  e.avatarInitial("🎉 派對") === "🎉",
  "an emoji name keeps both code units -- charAt(0) draws half a surrogate pair, " +
    "which is an empty box",
);
ok(
  e.avatarInitial("") === "" && e.avatarInitial(undefined) === "" &&
    e.avatarInitial(null) === "",
  "nothing to show is empty, never the string 'undefined'",
);

group("(u3) showAvatarAt: the first of a run, in a group, from someone else");
e = makeEnv({ activeChat: { mid: "cg1" } });
const RUN = [
  MSG("m1", "A", "one"),
  MSG("m2", "A", "two"),
  MSG("m3", "B", "three"),
  MSG("m4", "ME", "mine"),
  MSG("m5", "B", "four"),
];
ok(
  e.showAvatarAt(RUN, 0) === true,
  "the first message of a run wears the face",
);
ok(
  e.showAvatarAt(RUN, 1) === false,
  "the rest of the run does not -- a column of " +
    "identical circles says nothing the first one did not",
);
ok(e.showAvatarAt(RUN, 2) === true, "a different sender starts a new run");
ok(e.showAvatarAt(RUN, 3) === false, "our own messages never carry one");
ok(e.showAvatarAt(RUN, 4) === true, "and our message ends the run before it");
const SYS = [
  MSG("m1", "A", "one"),
  MSG("s1", "A", "", { contentType: "CHATEVENT" }),
  MSG("m2", "A", "two"),
];
ok(e.showAvatarAt(SYS, 1) === false, "a system event has no sender to show");
ok(
  e.showAvatarAt(SYS, 2) === false,
  "and does not cut the run it sits in: a join notice is not somebody speaking",
);
const DAY = [
  MSG("m1", "A", "yesterday", { time: NOW48 - 86400000 }),
  MSG("m2", "A", "today"),
];
ok(
  e.showAvatarAt(DAY, 1) === true,
  "a date separator starts a new run -- a faceless first row under the line reads " +
    "as a continuation of the day before",
);
ok(
  e.showAvatarAt([Object.assign(MSG("m9", "A", "x"), { from: "" })], 0) ===
    false,
  "a message with no sender has no face to draw",
);
ok(
  e.showAvatarAt(RUN, -1) === false && e.showAvatarAt(RUN, 99) === false &&
    e.showAvatarAt(null, 0) === false && e.showAvatarAt([], 0) === false,
  "and an index off the end of the list is a false, not an exception",
);
const e11 = makeEnv({ activeChat: { mid: "u9" } });
ok(
  e11.showAvatarAt(RUN, 0) === false && e11.showAvatarAt(RUN, 2) === false,
  "1:1 draws none at all: there are only two people in the room",
);
ok(
  makeEnv({ activeChat: null }).showAvatarAt(RUN, 0) === false,
  "and with no chat open there is nobody to draw",
);

group("(u4) wanted: one jump per hand-off, and only once the panel is up");
const wantState = (extra) =>
  JSON.stringify(Object.assign({
    updatedAt: NOW48,
    bootId: "boot-1",
    me: { mid: "ME" },
    login: { status: "ok" },
    chats: [{ mid: "C1", name: "one", unread: 0, lastTime: 500 }, {
      mid: "C2",
      name: "two",
      unread: 2,
      lastTime: 700,
    }],
    events: [],
  }, extra));
e = makeEnv({ activeChat: null, view: "list" });
e.root.chats = [{ mid: "C1", name: "one" }, { mid: "C2", name: "two" }];
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48, seq: 1 } }));
ok(
  e.root.activeChat && e.root.activeChat.mid === "C2" && e.root.view === "chat",
  "a clicked notification lands in that chat",
);
ok(
  e.root.wantedBootId === "boot-1" && e.root.honouredWanted === 1,
  "and the hand-off is written down",
);
e.root.activeChat = null;
e.root.view = "list";
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48, seq: 1 } }));
ok(
  e.root.activeChat === null && e.root.view === "list",
  "the field never disappears by itself, so the same seq must not jump a second time " +
    "-- every heartbeat rewrites the file",
);
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48 + 9000, seq: 2 } }));
ok(
  e.root.activeChat && e.root.activeChat.mid === "C2" &&
    e.root.honouredWanted === 2,
  "clicking the same chat's notification again is a new hand-off, not a repeat",
);
e.root.activeChat = null;
e.root.view = "list";
e.parseState(
  wantState({ bootId: "boot-2", wanted: { chat: "C1", at: NOW48, seq: 1 } }),
);
ok(
  e.root.activeChat && e.root.activeChat.mid === "C1",
  "a restarted daemon counts from 1 again, and 1 is not older than 2 in a new round",
);
ok(
  e.root.wantedBootId === "boot-2" && e.root.honouredWanted === 1,
  "so the watermark restarts too",
);
e = makeEnv({ opened: false, activeChat: null, view: "list" });
e.root.chats = [{ mid: "C1" }, { mid: "C2" }];
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48, seq: 1 } }));
ok(
  e.root.activeChat === null && e.root.pendingWanted === "C2",
  "the daemon writes the file and then asks the shell to open the panel, so the write " +
    "usually arrives first: opening the chat now would be wiped by the open",
);
e.root.opened = true;
e.open();
ok(
  e.root.activeChat && e.root.activeChat.mid === "C2",
  "it lands the moment the panel is actually up",
);
ok(
  e.root.pendingWanted === "",
  "and is spent, so a later open does not jump again",
);
e = makeEnv({ activeChat: null, view: "list" });
e.root.chats = [{ mid: "C1" }];
e.parseState(wantState({ wanted: { chat: "C9", at: NOW48, seq: 1 } }));
ok(
  e.root.activeChat === null && e.root.pendingWanted === "",
  "a chat the list has never heard of is dropped, not kept: jumping into it on some " +
    "later open has nothing to do with this click",
);
ok(
  e.root.honouredWanted === 1,
  "but the hand-off still counts as done, or it retries forever",
);
e = makeEnv({ opened: false, activeChat: null, view: "list" });
e.root.chats = [{ mid: "C2" }];
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48, seq: 1 } }));
ok(e.root.pendingWanted === "C2", "armed while the panel was closed");
e.clearSession();
ok(
  e.root.pendingWanted === "",
  "and logging out drops it -- that chat cannot be opened any more",
);
e = makeEnv({
  opened: false,
  connected: false,
  activeChat: null,
  view: "list",
});
e.root.chats = [{ mid: "C2" }];
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48, seq: 1 } }));
e.root.opened = true;
e.open();
ok(
  e.root.activeChat === null && e.root.notice === "",
  "the socket comes up with the panel, not before it: opening the chat here would " +
    "ask a closed socket for history and leave a false 'daemon 沒在跑'",
);
ok(e.root.pendingWanted === "C2", "so it is still armed");
e.sock.connected = true;
ok(
  e.takeWanted() === true && e.root.activeChat.mid === "C2",
  "and it lands the moment the line is up -- which is what the socket's own handler calls",
);
e = makeEnv({
  opened: false,
  connected: false,
  twoPane: true,
  activeChat: { mid: "C1" },
  view: "list",
});
e.root.chats = [{ mid: "C1" }, { mid: "C2" }];
e.parseState(wantState({ wanted: { chat: "C2", at: NOW48, seq: 1 } }));
e.root.opened = true;
e.sock.connected = true;
e.open();
ok(
  e.root.activeChat.mid === "C2" &&
    e.historyCalls.filter((c) => c === "C1").length === 0,
  "and in two-pane mode the chat being left is not refetched on the way out: " +
    JSON.stringify(e.historyCalls),
);
e = makeEnv({ activeChat: null, view: "list" });
e.root.chats = [{ mid: "C1" }];
e.parseState(wantState({}));
ok(
  e.root.activeChat === null && e.root.honouredWanted === 0,
  "a daemon that never writes wanted is old, not broken",
);
ok(
  e.root.activeChat === null &&
    (e.parseState(wantState({ wanted: { chat: "C1", seq: 0 } })),
      e.root.honouredWanted === 0),
  "and a seq of 0 is not a hand-off: the daemon's own counter starts at 1",
);

group(
  "(u5) both delegates draw the same badge, and pay for a mask only when there is a picture",
);
const badgeBlock = src.slice(
  src.indexOf("  component AvatarBadge: Item {"),
  src.indexOf("  // 這一則屬於哪一天"),
);
ok(
  badgeBlock.length > 0 && /component AvatarBadge: Item/.test(badgeBlock),
  "the badge is one inline component, so the list and the bubbles cannot drift apart",
);
ok(
  /radius: width \/ 2/.test(badgeBlock) &&
    /maskEnabled: true/.test(badgeBlock) &&
    /maskSource: circleMask/.test(badgeBlock),
  "the picture is masked to the same circle the fallback draws -- clip is square " +
    "however round the Rectangle under it is",
);
ok(
  /layer\.enabled: badge\.hasPicture/.test(badgeBlock) &&
    /layer\.enabled: badgePicture\.visible/.test(badgeBlock),
  "and neither layer exists without a picture: that is an FBO per row, and the busy " +
    "fixture has 200 of them",
);
ok(
  /visible: badge\.hasPicture && badgePicture\.status === Image\.Ready/.test(
    badgeBlock,
  ),
  "a path that no longer resolves falls back to the initial instead of a hole",
);
ok(
  /color: root\.avatarColor\(badge\.seed\)/.test(badgeBlock) &&
    /color: "#ffffff"/.test(badgeBlock),
  "the fallback colour comes from the mid, and the initial is white on it by " +
    "construction, not by theme",
);
ok(
  /sourceSize\.width: Math\.round\(width \* Screen\.devicePixelRatio\)/.test(
    badgeBlock,
  ),
  "decoded at physical pixels: sourceSize is the decode size in real pixels, so a " +
    "logical width decodes at 1/dpr of what gets painted and blurs on HiDPI, same " +
    "as the tray",
);
const listRows = src.slice(
  src.indexOf(
    "            Rectangle {\n              required property var modelData",
  ),
  src.indexOf(
    "      // ----------------------------------------------------- conversation",
  ),
);
ok(
  /AvatarBadge \{\n\s+id: rowAvatar/.test(listRows),
  "every chat row has a face",
);
ok(
  /picture: modelData\.avatarPath \|\| ""/.test(listRows),
  "which is the contract's optional field, absent when there is no picture yet",
);
ok(
  /label: root\.avatarInitial\(modelData\.name \|\| modelData\.mid\)/.test(
    listRows,
  ) &&
    /seed: modelData\.mid \|\| ""/.test(listRows),
  "and falls back to the chat's own initial, coloured by its mid",
);
ok(
  /anchors\.left: rowAvatar\.right/.test(listRows),
  "the name and the preview move over for it instead of sitting underneath it",
);
ok(
  /width: Math\.round\(Style\.space\(32\) \* root\.fontScale\)/.test(listRows),
  "sized in Style units and the text scale, like the row it sits in",
);
ok(
  /picture: modelData\.fromAvatar \|\| ""/.test(msgRows) &&
    /seed: modelData\.from \|\| ""/.test(msgRows),
  "a bubble's face is the sender's own field from the message",
);
ok(
  /visible: msgDelegate\.withAvatar/.test(msgRows),
  "drawn on the first message of a run only",
);
ok(
  /readonly property bool withAvatar:\n\s+root\.showAvatarAt\(root\.messages, msgDelegate\.index\)/
    .test(msgRows),
  "by the rule the tests above drive, not a second copy of it inside the delegate",
);
ok(
  /root\.takeWanted\(\)/.test(B.parseState) &&
    /root\.takeWanted\(\)/.test(B.onOpenedChanged) &&
    /if \(root\.takeWanted\(\)\) return/.test(src),
  "all three moments it can become possible try it: the state write, the panel " +
    "opening, and the socket coming up -- whichever is last is the one that lands it",
);
ok(
  /if \(!root\.takeWanted\(\) && root\.twoPane && root\.activeChat\) \{/.test(
    src,
  ),
  "and a hand-off that landed cancels the refetch of the chat it just left",
);
ok(
  B.parseState.indexOf("root.wantedBootId") >
    B.parseState.indexOf("root.loadedAt === 0"),
  "and last of all, so openChat has the final word on which chat is on screen",
);

// ------------------------------------------------------------ (u6) stickers
// The picker's whole decision surface: which cells a package has, which
// picture each one draws, what a click puts on the wire, what the recently
// used row remembers across restarts, and when the picker is open.
group("(u6) sticker cells, and the still picture an animated pack draws");
const PACKS = [
  {
    id: "1",
    name: "第一包",
    version: 3,
    stickers: [
      {
        id: "4",
        url:
          "https://stickershop.line-scdn.net/stickershop/v1/sticker/4/android/sticker.png",
        animated: false,
      },
      {
        id: "5",
        url:
          "https://stickershop.line-scdn.net/stickershop/v1/sticker/5/android/sticker.png",
        animated: false,
      },
    ],
  },
  // animated: the shop hands back sticker_animation.png (an APNG)
  {
    id: "2",
    name: "",
    version: 0,
    stickers: [
      {
        id: "9",
        url:
          "https://stickershop.line-scdn.net/stickershop/v1/sticker/9/android/sticker_animation.png",
        animated: true,
      },
    ],
  },
  // the contract's "owned but unreadable this time" package: an empty array,
  // not a package missing from the list
  { id: "3", name: "第三包", version: 1, stickers: [] },
];
e = makeEnv({});
let cells = e.stickerCells(PACKS[0]);
ok(
  cells.length === 2,
  "a package becomes one cell per sticker (" + cells.length + ")",
);
ok(
  cells[0].packageId === "1" && cells[0].stickerId === "4" &&
    cells[0].version === 3,
  "each cell carries what sendSticker needs: " + JSON.stringify(cells[0]),
);
ok(
  /\/sticker\/9\/android\/sticker\.png$/.test(e.stickerCells(PACKS[1])[0].url),
  "an animated pack draws the still picture: Qt only paints the first frame of an " +
    "APNG anyway, and one of them is hundreds of KB -- a grid of forty is not",
);
ok(
  e.stickerStill("https://x/sticker/9/android/sticker.png") ===
    "https://x/sticker/9/android/sticker.png",
  "a still url is left alone",
);
ok(
  e.stickerCells(PACKS[2]).length === 0 && e.stickerCells(null).length === 0,
  "a package the daemon could not read, and no package at all, are both zero cells",
);
ok(
  e.stickerCells({
    id: "7",
    version: 1,
    stickers: [{ url: "u" }, { id: "8", url: "u8" }],
  }).length === 1,
  "a sticker with no id is not drawn: pressing it would earn a 「貼圖編號不對」",
);
ok(
  e.stickerCells({ id: "", version: 1, stickers: [{ id: "8" }] }).length === 0,
  "and neither is a package with no id",
);
ok(
  e.stickerPackName(PACKS[1]) === "貼圖包 2",
  "a package the shop named in no language still gets a tab: " +
    e.stickerPackName(PACKS[1]),
);
ok(
  e.stickerPackName(PACKS[0]) === "第一包" && e.stickerPackName(null) === "",
  "named packages keep their name",
);
e.root.stickerPacks = PACKS;
ok(
  e.stickerPack("2") === PACKS[1] && e.stickerPack("99") === null &&
    e.stickerPack("") === null,
  "a package is found by id, and a package that is gone is null, not a throw",
);

group("(u6) the grid is at most four rows, and only as tall as it needs");
e = makeEnv({});
ok(
  e.stickerGridHeight(0, 400, 64, 4) === 0,
  "nothing to draw is no height at all",
);
ok(
  e.stickerGridHeight(3, 400, 64, 4) === 64,
  "three cells in a six-wide row is one row",
);
ok(e.stickerGridHeight(7, 400, 64, 4) === 128, "seven is two rows");
ok(
  e.stickerGridHeight(300, 400, 64, 4) === 256,
  "a package of three hundred stops at four rows and scrolls",
);
ok(
  e.stickerGridHeight(3, 10, 64, 4) === 192,
  "a pane narrower than one cell still lays out one column, not zero",
);

group("(u6) the recently used row: newest first, no repeats, capped");
e = makeEnv({});
const st = (p, s) => ({ packageId: p, stickerId: s, url: "u" + p + "-" + s });
let recent = e.recentPush([], st("1", "4"), 16);
recent = e.recentPush(recent, st("1", "5"), 16);
ok(
  recent.length === 2 && recent[0].stickerId === "5",
  "the one just used is first",
);
recent = e.recentPush(recent, st("1", "4"), 16);
ok(
  recent.length === 2 && recent[0].stickerId === "4",
  "using it again moves it, it does not add a second copy: " +
    JSON.stringify(recent.map((r) => r.stickerId)),
);
ok(
  e.recentPush([st("1", "4")], st("2", "4"), 16).length === 2,
  "the same sticker number in another package is another sticker",
);
let piled = [];
for (let i = 1; i <= 20; i++) {
  piled = e.recentPush(piled, st("1", String(i)), 16);
}
ok(
  piled.length === 16 && piled[0].stickerId === "20" &&
    piled[15].stickerId === "5",
  "capped at sixteen, and it is the oldest that goes",
);
ok(
  e.recentPush([st("1", "4")], st("1", "5"), 0).length === 0,
  "a cap of zero keeps nothing",
);
ok(
  e.recentPush([st("1", "4")], null, 16).length === 1,
  "nothing to remember leaves the row alone",
);

group("(u6) the row is per account, and survives a restart through one file");
e = makeEnv({});
e.root.stickerStore = {
  ME: [{
    packageId: "1",
    stickerId: "4",
    url: "https://x/sticker/4/android/sticker_animation.png",
  }],
  THEM: [{ packageId: "9", stickerId: "9", url: "u" }],
};
ok(
  e.root.recentStickers.length === 1 &&
    e.root.recentStickers[0].stickerId === "4",
  "only this account's row is drawn",
);
ok(
  /sticker\.png$/.test(e.root.recentStickers[0].url),
  "and an animated url stored by an older version is normalised on the way in",
);
e.root.myMid = "THEM";
ok(
  e.root.recentStickers.length === 1 &&
    e.root.recentStickers[0].packageId === "9",
  "logging in as somebody else shows their row, not this one -- their packages " +
    "are a different set and this one's stickers would be refused",
);
e.root.myMid = "NOBODY";
ok(
  e.root.recentStickers.length === 0,
  "an account with no row yet is an empty row",
);
e.root.myMid = "ME";
e.loadStickerStore("not json at all");
ok(
  JSON.stringify(e.root.stickerStore) === "{}" &&
    e.root.recentStickers.length === 0,
  "a store file somebody hand-edited into rubbish is an empty row, not a broken picker",
);
e.loadStickerStore(JSON.stringify({ version: 1, recent: { ME: "nope" } }));
ok(e.root.recentStickers.length === 0, "and so is a row that is not a list");
e.loadStickerStore(
  JSON.stringify({
    version: 1,
    recent: {
      ME: [{ packageId: "1" }, { packageId: "1", stickerId: "4", url: "u" }],
    },
  }),
);
ok(
  e.root.recentStickers.length === 1,
  "an entry with no sticker number is dropped: it cannot be sent and it cannot be drawn",
);
e.loadStickerStore(
  JSON.stringify({
    version: 1,
    recent: {
      ME: [{ packageId: "1", stickerId: "4" }, { stickerId: "5", url: "u" }, {
        packageId: "1",
        stickerId: "6",
        url: "u",
      }],
    },
  }),
);
ok(
  e.root.recentStickers.length === 1 &&
    e.root.recentStickers[0].stickerId === "6",
  "and so is one missing the url or the package: no url draws a cell that is blank -- " +
    "not even the ? an unloadable picture gets -- and no package is a cell the daemon " +
    "refuses on click, which reads as the send being broken: " +
    JSON.stringify(e.root.recentStickers),
);

e = makeEnv({});
e.root.stickerStore = { THEM: [st("9", "9")] };
e.rememberSticker(st("1", "4"));
ok(e.stickerFile.writes.length === 1, "using a sticker writes the file once");
let saved = JSON.parse(e.stickerFile.writes[0]);
ok(
  saved.recent.ME.length === 1 && saved.recent.ME[0].stickerId === "4",
  "this account's row is what changed",
);
ok(
  saved.recent.THEM.length === 1,
  "and the other account's row is still in the file -- the whole store is rewritten, " +
    "so writing only this account's half would wipe theirs",
);
e.root.myMid = "";
e.rememberSticker(st("1", "5"));
ok(
  e.stickerFile.writes.length === 1,
  "before the login lands there is no key to file it under, so nothing is written",
);

group("(u6) opening the picker asks once, and refreshing asks again");
e = makeEnv({});
ok(
  e.toggleSticker() === true && e.root.stickerOpen === true,
  "the 😊 opens it",
);
ok(
  e.sent.length === 1 && e.sent[0].cmd === "stickers" &&
    e.sent[0].refresh === undefined,
  "and asks for the list: " + JSON.stringify(e.sent),
);
e.onReply(JSON.stringify({ id: 1, ok: true, data: { packages: PACKS } }));
ok(
  e.root.stickerPacks.length === 3 && e.root.stickerLoading === false,
  "the reply fills the picker",
);
ok(e.root.stickerTab === "1", "and the first package is the tab you land on");
ok(
  e.root.stickerGridModel.length === 2,
  "whose grid is that package's stickers",
);
ok(
  e.toggleSticker() === false && e.root.stickerOpen === false,
  "pressing it again closes",
);
e.toggleSticker();
ok(
  e.sent.length === 1,
  "and opening it again does not re-ask: 54 packages is 280 KB, and the daemon " +
    "caches for an hour anyway",
);
ok(
  e.loadStickers(true) === true && e.sent.length === 2 &&
    e.sent[1].refresh === true,
  "⟳ is the way to ask again",
);
e.root.stickerLoading = true;
ok(
  e.loadStickers(true) === false && e.sent.length === 2,
  "and a second ⟳ while one is in flight is not a second round trip",
);

group(
  "(u6) the tab survives a refresh, and is replaced when its package is gone",
);
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "2";
e.loadStickers(true);
e.onReply(JSON.stringify({ id: 1, ok: true, data: { packages: PACKS } }));
ok(
  e.root.stickerTab === "2",
  "the package you were looking at is still the one you see",
);
e.loadStickers(true);
e.onReply(JSON.stringify({ id: 2, ok: true, data: { packages: [PACKS[0]] } }));
ok(
  e.root.stickerTab === "1",
  "a package that is gone falls back to the first one",
);
e.loadStickers(true);
e.onReply(JSON.stringify({ id: 3, ok: true, data: {} }));
ok(
  e.root.stickerPacks.length === 0 && e.root.stickerTab === "",
  "and a reply with no packages at all leaves nothing selected, not a stale grid",
);

group("(u6) every way the list can fail says so inside the picker");
e = makeEnv({});
e.toggleSticker();
e.onReply(JSON.stringify({ id: 1, ok: false, error: "貼圖清單讀不到：boom" }));
ok(
  e.root.stickerError === "貼圖清單讀不到：boom" &&
    e.root.stickerLoading === false,
  "the daemon's reason lands in the picker",
);
ok(
  e.root.notice === "",
  "and not on the banner: the picker is drawn over it, so a banner would be a " +
    "message nobody can read",
);
ok(
  e.stickerStatusText() === "貼圖清單讀不到：boom",
  "which is the line the picker draws",
);
e = makeEnv({ connected: false });
ok(e.toggleSticker() === true, "the picker still opens with the daemon down");
ok(
  e.root.stickerError === "daemon 沒在跑" && e.root.notice === "",
  "and says why in the same place: " + JSON.stringify(e.root.stickerError),
);
e = makeEnv({});
e.root.stickerLoading = true;
ok(e.stickerStatusText() === "載入中…", "waiting says it is waiting");
e.root.stickerLoading = false;
ok(
  e.stickerStatusText() === "這個帳號沒有貼圖包",
  "an account that owns none says that, rather than being an empty box",
);
e.root.stickerPacks = PACKS;
e.root.stickerTab = "3";
ok(
  e.stickerStatusText().indexOf("這個貼圖包這次讀不到") === 0,
  "and a package whose sticker list did not come back this time is told apart from " +
    "an empty one -- the contract keeps it in the list on purpose: " +
    e.stickerStatusText(),
);
e.root.stickerTab = "1";
ok(
  e.stickerStatusText() === "",
  "a package with stickers draws no line at all",
);

group("(u6) clicking a sticker sends it, shows it at once, and remembers it");
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
e.root.stickerOpen = true;
const cell = e.root.stickerGridModel[0];
ok(e.sendSticker(cell) === true, "a click sends");
ok(
  e.sent.length === 1 && e.sent[0].cmd === "sendSticker" &&
    e.sent[0].chat === "C1" &&
    e.sent[0].packageId === "1" && e.sent[0].stickerId === "4" &&
    e.sent[0].version === 3,
  "the frame is the contract's: " + JSON.stringify(e.sent[0]),
);
ok(
  e.root.messages.length === 1 && e.root.messages[0].pending === true &&
    e.root.messages[0].contentType === "STICKER" &&
    e.root.messages[0].stickerUrl === cell.url,
  "and the bubble is already on screen with the picture in it: " +
    JSON.stringify(e.root.messages[0].stickerUrl),
);
ok(e.root.stickerOpen === false, "the picker gets out of the way");
ok(
  e.root.recentStickers.length === 1 &&
    e.root.recentStickers[0].stickerId === "4",
  "and the sticker is in the recently used row",
);
saved = JSON.parse(e.stickerFile.writes[0]);
ok(
  saved.recent.ME[0].packageId === "1",
  "which is on disk before the reply comes back",
);
// U49: the echo of my own sticker comes back as a message event
e.root.setMessages(
  e.mergeMessage(e.root.messages, {
    id: "real-1",
    from: "ME",
    text: "",
    contentType: "STICKER",
    stickerUrl: cell.url,
    requestId: e.sent[0].requestId,
    time: 2,
  }),
  true,
);
ok(
  e.root.messages.length === 1 && e.root.messages[0].id === "real-1" &&
    e.root.messages[0].pending === undefined,
  "and LINE pushing it back replaces that bubble instead of drawing a second one",
);

e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "2";
e.sendSticker(e.root.stickerGridModel[0]);
ok(
  /sticker\.png$/.test(e.root.messages[0].stickerUrl),
  "an animated sticker's bubble draws the still picture, like every other cell: " +
    "an APNG only ever shows its first frame here anyway, and it is the download " +
    "that is hundreds of KB",
);
const optimisticUrl = e.root.messages[0].stickerUrl;
// The echo's url is the daemon's to decide (it reads STKOPT off what LINE
// relays), so the bubble must be replaced on identity, not on the picture.
e.root.setMessages(
  e.mergeMessage(e.root.messages, {
    id: "real-9",
    from: "ME",
    text: "",
    contentType: "STICKER",
    time: 3,
    requestId: e.sent[0].requestId,
    stickerUrl:
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/9/android/sticker_animation.png",
  }),
  true,
);
ok(
  e.root.messages.length === 1 && e.root.messages[0].id === "real-9",
  "and an echo carrying the animated url still replaces that bubble rather than " +
    "drawing a second one beside it",
);
ok(
  e.stickerStill(e.root.messages[0].stickerUrl) === optimisticUrl,
  "and it normalises to the very file the optimistic bubble already drew: the " +
    "daemon now sends STKOPT so the other side animates it, so the echo carries " +
    "the animated url -- painted raw that swap is a few hundred KB the bubble is " +
    "invisible for, `visible` being bound to Image.Ready",
);
ok(
  e.sent[0].version === undefined,
  "a package the shop gave no version for sends none, and the daemon fills it in",
);

group("(u6) a sticker that will not send leaves nothing behind");
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
e.replyField.text = "打到一半的字";
e.sendSticker(e.root.stickerGridModel[0]);
e.onReply(
  JSON.stringify({ id: 1, ok: false, error: "這個貼圖包不在你的貼圖清單裡" }),
);
ok(e.root.messages.length === 0, "the optimistic bubble goes");
ok(
  e.root.notice === "這個貼圖包不在你的貼圖清單裡",
  "the refusal is on the banner -- the picker is closed by then, so this is the " +
    "only place left to say it",
);
ok(
  e.replyField.text === "打到一半的字",
  "and a sticker has no text to hand back, so the draft is untouched",
);
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
e.sendSticker(e.root.stickerGridModel[0]);
e.root.activeChat = { mid: "C2" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: "貼圖編號不對" }));
ok(
  e.root.messages.length === 0 && e.root.notice === "",
  "a refusal that arrives after you switched chats still drops its bubble, but " +
    "does not put another chat's error on this one's banner",
);
ok(
  e.hasPendingBubble("sendSticker") && e.hasPendingBubble("send") &&
    e.hasPendingBubble("reply") && !e.hasPendingBubble("sendFile"),
  "which is the same rule the two text sends use",
);
e = makeEnv({ connected: false });
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
ok(
  e.sendSticker(e.root.stickerGridModel[0]) === false &&
    e.root.messages.length === 0,
  "and with the daemon down there is no bubble that will never become real",
);

group("(u6) the picker is closed by Esc, by leaving, and by logging out");
e = makeEnv({});
e.root.stickerOpen = true;
ok(
  e.escapeAction() === "sticker",
  "Esc closes the picker before it leaves the chat -- it is the thing on top",
);
e.root.lightbox = { id: "m1", source: "s", name: "n", index: 0 };
ok(
  e.escapeAction() === "lightbox",
  "except with a picture open, which is above it",
);
e = makeEnv({});
e.root.stickerOpen = false;
ok(
  e.escapeAction() === "back",
  "and with the picker closed Esc means what it always did",
);
e = makeEnv({ twoPane: true });
e.root.stickerOpen = true;
e.back();
ok(e.root.stickerOpen === false, "leaving the conversation closes it");
e = makeEnv({});
e.root.stickerOpen = true;
e.openChat({ mid: "C2" });
ok(
  e.root.stickerOpen === false,
  "and so does switching chats: the next click would have gone to the wrong one",
);
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
e.root.stickerOpen = true;
e.root.stickerError = "boom";
e.root.stickerLoading = true;
e.clearSession();
ok(
  e.root.stickerOpen === false && e.root.stickerPacks.length === 0 &&
    e.root.stickerTab === "" && e.root.stickerError === "",
  "logging out drops the packages too -- another account owns another set, and the " +
    "daemon has already thrown its own cache away",
);
ok(
  e.root.stickerLoading === false,
  "including a list that was still on its way: it would have been the last account's, " +
    "and a flag left set is a picker stuck on 「載入中…」",
);
e.root.activeChat = { mid: "C1" };
ok(
  e.setStickerOpen(true) === true && e.sent.length === 1,
  "so the new account's first look does ask: " + JSON.stringify(e.sent),
);
e = makeEnv({ activeChat: null });
ok(
  e.setStickerOpen(true) === false && e.root.stickerOpen === false,
  "with no chat open there is nowhere to send to, so the button does nothing",
);

group("(u6) the request the contract asks for");
e = makeEnv({});
ok(
  JSON.stringify(
    e.stickerRequest("C1", { packageId: 1, stickerId: 4, version: 3 }),
  ) ===
    JSON.stringify({ chat: "C1", packageId: "1", stickerId: "4", version: 3 }),
  "ids go out as the decimal strings the contract names",
);
ok(
  e.stickerRequest("C1", { packageId: "1", stickerId: "4", version: 0 })
    .version === undefined,
  "no version rather than a zero: the contract says the daemon then uses the one " +
    "from its own list, which is newer than anything the panel is holding",
);
ok(
  e.stickerRequest("C1", { packageId: "1", stickerId: "4" }).version ===
    undefined,
  "and a recently used sticker restored from disk carries none",
);
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
e.sendSticker({ packageId: "1", stickerId: "4", url: "u", version: 99 });
ok(
  e.sent[0].version === 3,
  "a stale version on a remembered sticker is replaced by the package's current one: " +
    JSON.stringify(e.sent[0].version),
);

group(
  "(u6) the picker is drawn the way the @ picker is, and pays for one grid",
);
const stickerPickerBlock = src.slice(
  src.indexOf("        MouseArea {\n          id: stickerScrim"),
  src.indexOf("      Item {\n        id: lightboxLayer"),
);
ok(stickerPickerBlock.length > 0, "the picker block was found in Panel.qml");
ok(
  !/\bPopup\s*\{/.test(stickerPickerBlock),
  "not a Popup: a Popup has no anchors, so its position would have to be computed " +
    "with mapToItem and clamped back into the card by hand",
);
ok(
  stickerPickerBlock.indexOf("forceActiveFocus") < 0 &&
    !/\n\s+focus: true/.test(stickerPickerBlock),
  "and it never takes focus: the half-typed message stays in the reply box, and " +
    "Esc is still the reply box's",
);
const stickerChain = "anchors.bottom: quoteStrip.visible ? quoteStrip.top\n" +
  "            : (noticeLine.visible ? noticeLine.top : replyBox.top)";
ok(
  stickerPickerBlock.indexOf(stickerChain) > 0,
  "it stacks on the same chain as the @ picker: the quote strip, then the banner, " +
    "then the reply box",
);
ok(
  (stickerPickerBlock.match(/GridView \{/g) || []).length === 1 &&
    /model: root\.stickerGridModel/.test(stickerPickerBlock),
  "one grid, whose model is the selected package -- 54 packages are never on the " +
    "scene at once",
);
ok(
  /cacheBuffer: stickerPicker\.cell/.test(stickerPickerBlock),
  "and it caches one row past the edge: every cell is a CDN download",
);
ok(
  src.indexOf("id: stickerScrim") < src.indexOf("id: stickerPicker"),
  "the click-outside catcher is declared first, so the picker sits on top of it",
);
ok(
  /visible: root\.stickerOpen/.test(stickerPickerBlock) &&
    /onClicked: root\.setStickerOpen\(false\)/.test(stickerPickerBlock),
  "clicking anywhere else closes it, through the one function the 😊 and Esc use",
);
const stickerImgBlock = src.slice(
  src.indexOf("              id: stickerImg"),
  src.indexOf(
    "            Row {\n              visible: !msgDelegate.recalled",
  ),
);
ok(
  stickerImgBlock.length > 0 &&
    /remoteSource: msgDelegate\.sticker\n\s+\? root\.stickerStill\(/.test(
      stickerImgBlock,
    ),
  "the bubble's picture is normalised the same way the picker's cells are -- one " +
    "sticker is one url everywhere the panel draws it, whatever STKOPT the message " +
    "carried",
);
const stickerCellAt = src.indexOf("  component StickerCell: Item {");
const stickerCellBlock = src.slice(
  stickerCellAt,
  src.indexOf("  Timer {", stickerCellAt),
);
ok(
  /sourceSize\.width: Math\.round\(width \* Screen\.devicePixelRatio\)/.test(
    stickerCellBlock,
  ) &&
    /sourceSize\.height: Math\.round\(height \* Screen\.devicePixelRatio\)/
      .test(stickerCellBlock),
  "a cell decodes at the size it is drawn: a 64px cell holding a full sticker is " +
    "hundreds of megabytes across a package",
);
ok(
  /asynchronous: true/.test(stickerCellBlock),
  "and loads off the render thread -- these come off the network",
);
ok(
  /status === Image\.Error/.test(stickerCellBlock),
  "a picture that did not load is marked, not left as a gap that looks like a " +
    "missing sticker: the number is still good and it still sends",
);
ok(
  /onClicked: root\.sendSticker\(stickerCell\.modelData\)/.test(
    stickerCellBlock,
  ),
  "and one component draws both the recently used row and the grid, so the two " +
    "cannot disagree about what a click does",
);
const composerBlock = src.slice(
  src.indexOf("          id: attachButton"),
  src.indexOf("              function submit() {"),
);
ok(
  /id: stickerButton/.test(composerBlock) &&
    /anchors\.left: attachButton\.right/.test(composerBlock),
  "the 😊 sits beside the 📎",
);
ok(
  /anchors\.left: stickerButton\.right/.test(composerBlock),
  "and the reply box moves over for it instead of sitting underneath it",
);
ok(
  /enabled: !!root\.activeChat/.test(composerBlock),
  "both buttons are dead until there is a chat to send to",
);

// ------------------------------------------------------------------- (u63)
// The package row is one horizontal Flickable, and a horizontal Flickable takes
// no wheel of its own -- so with a mouse the row could only be dragged, which is
// a gesture a mouse does not have. Through 2.7.0 the reachable packages were the
// ones that happened to fit the width: 「貼圖 pop up 不能換 不同貼圖可能被遮住了」.
// Clicking a tab was never broken; there was just no way to bring one into view.
group("(u63) the package row scrolls to a number the panel computes");
e = makeEnv({});
ok(
  e.stickerTabClamp(-40, 200, 900) === 0,
  "before the first package there is nothing, so the row stops at 0",
);
ok(
  e.stickerTabClamp(9000, 200, 900) === 700,
  "and it stops with the last package against the right edge rather than " +
    "scrolling the whole row out of sight",
);
ok(
  e.stickerTabClamp(50, 900, 200) === 0,
  "a row that already fits cannot be scrolled at all: every package is on screen, " +
    "so any offset would only hide one",
);
ok(
  e.stickerTabClamp(NaN, 200, 900) === 0 &&
    e.stickerTabClamp(10, NaN, NaN) === 0,
  "and a width that is not a number yet (the picker is laid out after it is shown) " +
    "is a row at rest, not a NaN contentX that blanks it",
);

ok(
  e.stickerTabScroll(300, 120, 0, 96, 200, 900) === 204,
  "one wheel notch away from the user walks one step back toward the first " +
    "package -- the same direction a vertical wheel scrolls a vertical list",
);
ok(
  e.stickerTabScroll(300, -120, 0, 96, 200, 900) === 396,
  "and one notch toward the user walks one step on",
);
ok(
  e.stickerTabScroll(300, -60, 0, 96, 200, 900) === 348,
  "a touchpad's half notch moves half a step: the row follows the finger instead " +
    "of jumping",
);
ok(
  e.stickerTabScroll(20, 120, 0, 96, 200, 900) === 0 &&
    e.stickerTabScroll(690, -120, 0, 96, 200, 900) === 700,
  "both ends stop where the clamp says, so spinning the wheel cannot park the row " +
    "past the first or last package",
);
ok(
  e.stickerTabScroll(50, 0, 0, 96, 900, 200) === 0,
  "and a wheel event carrying no vertical delta still leaves a fitting row at 0",
);

// Until U67 both strips read event.angleDelta.y and nothing else, while every
// other scrolling view in the file went through wheelDistance(): a touchpad
// that reports the pixels it actually slid -- and an angleDelta of 0, which is
// what a finger scroll sends -- could not move either strip one pixel.
group("(u67) and a touchpad moves it too, through the same wheelDistance()");
ok(
  e.stickerTabScroll(300, 0, 30, 96, 200, 900) === 252,
  "a finger that slid 30px moves the package row: that is half of wheelDistance's " +
    "60px notch, so half a step, with angleDelta at 0 the whole way",
);
ok(
  e.stickerTabScroll(300, 0, 30, 64, 200, 900) === 268,
  "the recently-used row is the same call with its own step, so the fix cannot " +
    "reach one strip and miss the other",
);
ok(
  e.stickerTabScroll(300, 0, -30, 96, 200, 900) === 348,
  "and the direction follows the finger, like the notch follows the wheel",
);
ok(
  e.stickerTabScroll(300, 6, 30, 96, 200, 900) === 252,
  "a device that sends both is read by its pixels: 6/120 of a notch is the " +
    "rounded-off angle a touchpad puts next to a real 30px slide",
);
ok(
  makeEnv({ scrollPercent: 300 }).stickerTabScroll(
        300,
        120,
        0,
        96,
        200,
        900,
      ) === 12 &&
    makeEnv({ scrollPercent: 50 }).stickerTabScroll(
        300,
        120,
        0,
        96,
        200,
        900,
      ) === 252,
  "and going through wheelDistance puts these two strips under the 捲動速度 " +
    "setting as well, which never reached them before",
);

group("(u63) and it puts the package you picked where you can see it");
ok(
  e.stickerTabInView(100, 120, 60, 200, 900) === 100,
  "a tab already inside the row does not move it: recentring on every change " +
    "would make the row jump under the pointer",
);
ok(
  e.stickerTabInView(100, 40, 60, 200, 900) === 40,
  "a tab off the left edge comes back by its left edge",
);
ok(
  e.stickerTabInView(100, 280, 60, 200, 900) === 140,
  "and one off the right edge by its right edge -- the shortest move that shows it " +
    "whole",
);
ok(
  e.stickerTabInView(100, 80, 400, 200, 900) === 80,
  "a tab wider than the row shows its left edge: the name is read from the left",
);
ok(
  e.stickerTabInView(0, 850, 60, 200, 900) === 700,
  "and the answer is clamped like every other one: the last tab cannot pull the " +
    "row past its end",
);

group("(u63) ←/→ walk the packages, and stop at the ends");
e = makeEnv({});
e.root.stickerPacks = PACKS;
e.root.stickerTab = "1";
ok(
  e.stepStickerTab(1) === true && e.root.stickerTab === "2",
  "→ is the next package",
);
ok(
  e.stepStickerTab(-1) === true && e.root.stickerTab === "1",
  "← is the one before",
);
ok(
  e.stepStickerTab(-1) === false && e.root.stickerTab === "1",
  "the first package is the end of the road: it does not wrap round to the last, " +
    "which reads as having gone the wrong way (the lightbox stops the same way)",
);
e.root.stickerTab = "3";
ok(
  e.stepStickerTab(1) === false && e.root.stickerTab === "3",
  "and so is the last",
);
ok(
  e.stepStickerTab(0) === false && e.root.stickerTab === "3",
  "a key that moved nothing changes nothing",
);
e.root.stickerTab = "gone";
ok(
  e.stepStickerTab(1) === true && e.root.stickerTab === "1",
  "with no package selected -- the list has just come back, or the one that was " +
    "selected is no longer owned -- an arrow starts at the first",
);
e = makeEnv({});
ok(
  e.stepStickerTab(1) === false && e.root.stickerTab === "",
  "and with no list at all the keys do nothing rather than throw",
);
e.root.stickerPacks = PACKS;
ok(e.stickerTabIndex("2") === 1, "a package knows which tab it is");
ok(
  e.stickerTabIndex("nope") === -1 && e.stickerTabIndex("") === -1,
  "and one that is not on the row answers -1, which itemAt() reads as no tab",
);
ok(
  e.stickerPack("2") === PACKS[1] && e.stickerPack("nope") === null,
  "which is the one lookup the picker has: stickerPack() is that index, so the " +
    "grid and the row can never disagree about which package is selected",
);

group(
  "(u63) the row is wheelable, says there is more, and never resizes itself",
);
const tabStripBlock = src.slice(
  src.indexOf("            Item {\n              id: stickerTabStrip"),
  src.indexOf("            // 讀不到、還在讀、這個帳號沒有貼圖包"),
);
ok(tabStripBlock.length > 0, "the package row was found in Panel.qml");
ok(
  /WheelHandler \{\n\s+onWheel: function\(event\) \{\n\s+stickerTabs\.contentX = root\.stickerTabScroll\(\n\s+stickerTabs\.contentX, event\.angleDelta\.y, event\.pixelDelta\.y,/
    .test(tabStripBlock),
  "a vertical wheel over the row scrolls it sideways: a horizontal Flickable eats " +
    "no wheel at all (measured on Qt 6.11, both axes), so without this a mouse " +
    "could only ever reach the packages that happened to fit the width",
);
ok(
  tabStripBlock.indexOf("WheelHandler") < tabStripBlock.indexOf("Flickable {"),
  "and the handler hangs off the strip, not off the Flickable: Flickable's default " +
    "property puts what you declare inside it next to contentItem, where a handler " +
    "is attached to nothing",
);
const recentStripBlock = src.slice(
  src.indexOf("            // 最近用過的排最上面"),
  src.indexOf("            // 分頁列：貼圖包的名字"),
);
ok(
  /WheelHandler \{[\s\S]*recentStickerFlick\.contentX = root\.stickerTabScroll\(\n\s+recentStickerFlick\.contentX, event\.angleDelta\.y, event\.pixelDelta\.y,/
    .test(recentStripBlock),
  "the recently used row is the same kind of strip and gets the same wheel -- " +
    "sixteen stickers do not fit either",
);
ok(
  /visible: stickerTabs\.contentX > 0\.5/.test(tabStripBlock) &&
    /visible: stickerTabs\.contentX < stickerTabs\.maxX - 0\.5/.test(
      tabStripBlock,
    ),
  "‹ and › appear exactly while there is something that way: the row is otherwise " +
    "a plain strip of names with no sign that it moves",
);
ok(
  (tabStripBlock.match(/onClicked: stickerTabStrip\.scrollTabs\(-?1\)/g) || [])
    .length === 2,
  "and clicking one scrolls by the same notch the wheel does, so a machine with no " +
    "wheel is not stuck",
);
ok(
  /function scrollTabs\(notches\) \{\n\s+stickerTabs\.contentX = root\.stickerTabScroll\(\n\s+stickerTabs\.contentX, notches \* 120, 0, stickerTabStrip\.tabStep,/
    .test(tabStripBlock),
  "through the strip's own one-liner rather than four copies of the same call: the " +
    "two arrows are pressed by the mouse and by assistive tech, and a fifth argument " +
    "added to one copy is the bug this file exists to catch",
);
ok(
  /anchors\.left: stickerTabs\.left/.test(tabStripBlock) &&
    /anchors\.right: stickerTabs\.right/.test(tabStripBlock) &&
    /anchors\.right: stickerRefresh\.left/.test(tabStripBlock),
  "the arrows sit on top of the row instead of squeezing it: squeezing changes " +
    "where the row ends, which changes whether the arrow should be there at all -- " +
    "an arrow that flickers between its own two states",
);

// Every other pressable control in this file carries the Accessible lines; the
// two arrows shipped without them, and on a machine with no wheel they are the
// only way to reach a package that is off the edge -- a screen reader had the
// whole control to read out as "‹".
group("(u67) and the two arrows say what they are to assistive tech");
const arrowLeft = tabStripBlock.slice(
  tabStripBlock.indexOf(
    "              Rectangle {\n                id: stickerTabLeft",
  ),
  tabStripBlock.indexOf(
    "              Rectangle {\n                id: stickerTabRight",
  ),
);
const arrowRight = tabStripBlock.slice(
  tabStripBlock.indexOf(
    "              Rectangle {\n                id: stickerTabRight",
  ),
  tabStripBlock.indexOf(
    "              Text {\n                id: stickerRefresh",
  ),
);
for (
  const [glyph, block, label, notches] of [
    ["\u2039", arrowLeft, 'tr("sticker.scrollL")', "1"],
    ["\u203a", arrowRight, 'tr("sticker.scrollR")', "-1"],
  ]
) {
  ok(block.length > 0, glyph + " was found in the package row");
  ok(
    block.includes("Accessible.role: Accessible.Button") &&
      block.includes("Accessible.name: " + label),
    glyph + " is a Button with a name to assistive tech, not an unlabelled " +
      "Rectangle: " + JSON.stringify(label),
  );
  ok(
    block.includes(
      "Accessible.onPressAction: stickerTabStrip.scrollTabs(" + notches + ")",
    ),
    "and pressing it that way scrolls the row exactly as clicking it does -- the " +
      "same call, so the two can never drift",
  );
}
ok(
  /function onStickerTabChanged\(\) \{ Qt\.callLater\(stickerTabs\.showSelected\) \}/
    .test(tabStripBlock) &&
    /function onStickerOpenChanged\(\) \{ Qt\.callLater\(stickerTabs\.showSelected\) \}/
      .test(tabStripBlock),
  "every way of changing package ends at root.stickerTab, so that is the one thing " +
    "the scroll listens to; callLater because the Repeater has not built the tabs " +
    "yet on the frame the list arrives",
);
ok(
  /stickerTabRepeat\.itemAt\(root\.stickerTabIndex\(root\.stickerTab\)\)/.test(
    tabStripBlock,
  ) &&
    /root\.stickerTabInView\(/.test(tabStripBlock),
  "and it asks the tab itself where it is rather than guessing from an index and a " +
    "width -- the names are all different lengths",
);
const moveBlock = src.slice(
  src.indexOf("      onMoveRequested: function(dx, dy) {"),
  src.indexOf("      onActivateRequested:"),
);
ok(
  /if \(root\.stickerOpen && dx !== 0\) \{ root\.stepStickerTab\(dx\); return \}/
    .test(moveBlock),
  "←/→ (h/l) change package while the picker is open",
);
ok(
  moveBlock.indexOf("root.lightbox") < moveBlock.indexOf("root.stickerOpen"),
  "under the lightbox, which is the layer above it",
);
ok(
  moveBlock.indexOf("root.stickerOpen") <
    moveBlock.indexOf("if (dy === 0) return"),
  "and above the message list, which keeps ↑↓ -- those are the keys that reach " +
    "here while the reply box has focus. ←/→ never do (they are moving the caret), " +
    "so this path costs a half-typed message nothing",
);

group("logging out cancels what the last account left in flight");
{
  const pic = "https://stickershop.line-scdn.net/x.png";
  e = makeEnv({ activeChat: { mid: "C1" } });
  e.request("send", { chat: "C1", text: "打到一半的那句" }, "pending-1");
  e.request("image", { url: pic }, pic);
  e.root.imageRequests[pic] = true;
  e.root.openWanted["m1"] = "lightbox";
  e.root.syncing = true;
  e.clearSession();
  ok(
    Object.keys(e.root.pending).length === 0 &&
      Object.keys(e.root.imageRequests).length === 0 &&
      Object.keys(e.root.openWanted).length === 0 && e.root.syncing === false,
    "every record of what is still in flight goes -- unlike a disconnect the line is " +
      "still up here, so those replies really do come back",
  );
  e.onReply(JSON.stringify({ id: 1, ok: false, error: "尚未登入" }));
  ok(
    e.root.notice === "" && e.replyField.text === "",
    "and a reply landing after the switch belongs to nobody: dropped whole rather " +
      "than falling through to the generic error and flashing the account that just " +
      "left at the one that just arrived",
  );
  e.onReply(JSON.stringify({ id: 2, ok: true, data: { path: "/tmp/x.png" } }));
  ok(
    Object.keys(e.root.imagePaths).length === 0,
    "including the picture it was still fetching, which would otherwise be written " +
      "straight back into the cache clearSession() just emptied",
  );
}

// ------------------------------------------- (v) U59: Ctrl+V in the composer
// The clipboard is on the daemon's side of the socket (wl-paste), so the key
// cannot be decided where it is pressed. The panel first stages one immutable
// snapshot, then starts a correlated send only when that probe found a picture.
// Both halves are root functions, so the harness drives the whole round trip.

group("(v) Ctrl+V asks the daemon first, and pastes only when it says text");
e = makeEnv({ activeChat: null });
ok(
  e.pasteClipboard() === false && e.sent.length === 0,
  "with no chat open there is nowhere to send a picture, so the key stays the TextArea's",
);

e = makeEnv({ connected: false });
ok(
  e.pasteClipboard() === false,
  "and a dead daemon cannot answer, so that Ctrl+V has to stay an ordinary paste",
);
ok(
  e.root.notice === "daemon 沒在跑",
  "with the reason request() already put on the banner, said once: " +
    e.root.notice,
);
ok(
  e.replyField.pastes === 0,
  "and pasteClipboard pastes nothing itself -- the unaccepted key is the TextArea's own",
);

e = makeEnv({});
ok(e.pasteClipboard() === true, "with a chat and a daemon the key is taken");
ok(
  e.sent.length === 1 && e.sent[0].cmd === "probeClipboardImage" &&
    e.sent[0].chat === "C1" && !e.sent[0].requestId &&
    Object.keys(e.sent[0]).length === 3,
  "the probe carries no message token because it cannot create a message: " +
    JSON.stringify(e.sent[0]),
);
ok(
  e.root.notice === "傳送中…",
  "the banner says so for the seconds the upload takes, the same sentence 📎 uses",
);
ok(
  e.root.messages.length === 0,
  "and no optimistic bubble: at key-down nobody yet knows whether the clipboard holds " +
    "a picture at all, so a bubble here would be drawn and taken back on every text paste",
);
ok(
  e.replyField.pastes === 0,
  "nothing is pasted while the answer is still out",
);
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { stage: "clipboard-one.png" } }),
);
ok(
  e.sent.length === 2 && e.sent[1].cmd === "sendClipboardImage" &&
    e.sent[1].chat === "C1" && e.sent[1].stage === "clipboard-one.png" &&
    /^1-[0-9]+-2-[0-9a-z]+$/.test(String(e.sent[1].requestId || "")),
  "only the upload carries the stable reconciliation token: " +
    JSON.stringify(e.sent[1]),
);
ok(
  e.root.notice === "傳送中…",
  "the upload phase restores the progress banner after the successful probe clears it",
);
e.onReply(JSON.stringify({ id: 2, ok: true }));
ok(
  e.root.notice === "" && e.replyField.pastes === 0 &&
    e.historyCalls.length === 0,
  "a picture that went clears the banner and asks for nothing more -- the bubble arrives " +
    "as the daemon's own message event, exactly as 📎's does",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.pasteClipboard();
e.root.activeChat = { mid: "C2" };
e.replyField.text = "C2 draft";
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { stage: "clipboard-switch.png" } }),
);
const switchedUploads = e.sent.filter((request) =>
  request.cmd === "sendClipboardImage"
);
ok(
  switchedUploads.length === 1 && switchedUploads[0].chat === "C1" &&
    switchedUploads[0].stage === "clipboard-switch.png",
  "a completed probe keeps the destination captured when Ctrl+V was pressed",
);
ok(
  e.replyField.text === "C2 draft",
  "the completed probe does not alter the newly selected chat's composer",
);

e = makeEnv({});
e.pasteClipboard();
e.onReply(JSON.stringify({ id: 1, ok: false, error: CLIPBOARD_EMPTY }));
ok(
  e.replyField.pastes === 1,
  "the one refusal that means 'that was text' becomes the paste the key would have been",
);
ok(
  e.root.notice === "",
  "and says nothing: a paste is not a failure, and 「" + CLIPBOARD_EMPTY +
    "」 on the banner after pasting would read as one",
);
ok(
  e.root.messages.length === 0,
  "with nothing left behind in the conversation",
);

// Everything else wl-paste can answer is a real refusal. Pasting the clipboard's
// text over any of them would hide the one line that says what to install, what
// to restart, or why this picture cannot go.
for (
  const err of [
    "找不到 wl-paste，請 sudo pacman -S wl-clipboard",
    "連不上 Wayland，請 systemctl --user restart enil",
    "剪貼簿的圖片太大（超過 20 MB）",
    "剪貼簿的圖片格式不支援: image/tiff",
    "剪貼簿的圖片讀不到",
    "讀不到剪貼簿",
    "多人聊天室（room）暫不支援傳檔案",
    "尚未登入",
  ]
) {
  e = makeEnv({});
  e.pasteClipboard();
  e.onReply(JSON.stringify({ id: 1, ok: false, error: err }));
  ok(
    e.root.notice === err && e.replyField.pastes === 0,
    "shown on the banner, never quietly pasted over: " + err,
  );
}

// wl-paste is allowed five seconds, which is long enough to change chats in.
e = makeEnv({});
e.pasteClipboard();
e.root.activeChat = { mid: "C2" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: CLIPBOARD_EMPTY }));
ok(
  e.replyField.pastes === 0,
  "an answer for a chat that is no longer open pastes nothing -- the box on screen " +
    "belongs to the other conversation now",
);
e = makeEnv({});
e.pasteClipboard();
e.root.activeChat = { mid: "C2" };
e.onReply(
  JSON.stringify({ id: 1, ok: false, error: "剪貼簿的圖片太大（超過 20 MB）" }),
);
ok(
  e.root.notice === "傳送中…",
  "and a stale refusal is swallowed like every other one, rather than shouting about " +
    "a chat that is no longer on screen: " + e.root.notice,
);

e = makeEnv({});
e.pasteClipboard();
e.root.activeChat = { mid: "C2" };
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { stage: "clipboard-stale.png" } }),
);
ok(
  e.sent.length === 2 && e.sent[1].cmd === "sendClipboardImage" &&
    e.sent[1].chat === "C1" && e.sent[1].stage === "clipboard-stale.png" &&
    !!e.sent[1].requestId,
  "a successful probe sends to the chat where Ctrl+V was pressed",
);
e.root.notice = "new chat warning";
e.onReply(JSON.stringify({ id: 2, ok: true }));
ok(
  e.root.notice === "new chat warning",
  "the previous chat's delayed upload does not erase the current chat's banner",
);

// Ctrl+V auto-repeats while it is held, and an upload runs for seconds. A second
// request would be a second copy of the same picture; on the text path it would
// be the same words pasted twice, once per reply.
group("(v) one Ctrl+V at a time, and every reply re-arms it");
e = makeEnv({});
ok(e.clipboardBusy() === false, "nothing in flight to begin with");
ok(e.pasteClipboard() === true && e.sent.length === 1, "the first press sends");
ok(
  e.clipboardBusy() === true,
  "and is in flight from the moment the frame goes out",
);
const heldDown = e.pasteClipboard();
ok(
  e.sent.length === 1,
  "a second press while that one is still out sends nothing: " + e.sent.length +
    " frame(s) on the wire",
);
ok(
  heldDown === true,
  "and it is swallowed rather than handed back to the TextArea -- an ordinary paste " +
    "here is exactly the second paste the first reply's fallback is about to do",
);
ok(e.root.notice === "傳送中…", "with the banner left alone: " + e.root.notice);
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { stage: "clipboard-one.png" } }),
);
ok(
  e.clipboardBusy() === true && e.pasteClipboard() === true &&
    e.sent.length === 2,
  "the key stays held while the staged picture is uploading",
);
e.onReply(JSON.stringify({ id: 2, ok: true }));
ok(
  e.clipboardBusy() === false && e.pasteClipboard() === true &&
    e.sent.length === 3,
  "a picture that went re-arms the key",
);

// Every other way the reply can land has to re-arm it too: onReply deletes the
// pending entry above all of them, which is the whole reason the flag is read
// out of `pending` rather than kept as a second copy that five paths must clear.
for (
  const [what, reply] of [
    ["the text fallback", { id: 1, ok: false, error: CLIPBOARD_EMPTY }],
    ["a real refusal", {
      id: 1,
      ok: false,
      error: "剪貼簿的圖片太大（超過 20 MB）",
    }],
    ["an empty error", { id: 1, ok: false }],
  ]
) {
  e = makeEnv({});
  e.pasteClipboard();
  e.onReply(JSON.stringify(reply));
  ok(
    e.clipboardBusy() === false && e.pasteClipboard() === true &&
      e.sent.length === 2,
    "and so does " + what,
  );
}

e = makeEnv({});
e.pasteClipboard();
e.root.activeChat = { mid: "C2" };
e.onReply(JSON.stringify({ id: 1, ok: false, error: CLIPBOARD_EMPTY }));
ok(
  e.clipboardBusy() === false && e.pasteClipboard() === true &&
    e.sent.length === 2,
  "including a stale one, which returns before every branch -- leaving the key dead " +
    "in the chat the user just moved to is the failure this one is easiest to miss",
);

// The line is still up on a logout, so those replies do come back; a disconnect
// is where they never do, and the key must not be left waiting for one.
e = makeEnv({});
e.pasteClipboard();
e.dropInFlight();
ok(
  e.clipboardBusy() === false,
  "a disconnect takes the probe with everything else in flight",
);
ok(
  Object.keys(e.root.ambiguousSendsByChat).length === 0,
  "and disconnect during the probe persists no ambiguous send because the probe had " +
    "no reconciliation token and could not have created a LINE message",
);
ok(
  e.root.notice === "連線中斷，圖片尚未送出",
  "the old uploading banner is replaced with the durable outcome: " +
    e.root.notice,
);
ok(
  e.pasteClipboard() === true,
  "and the key is re-armed instead of waiting for a reply that can no longer come",
);

e = makeEnv({});
e.pasteClipboard();
e.onReply(
  JSON.stringify({ id: 1, ok: true, data: { stage: "clipboard-two.png" } }),
);
const clipboardSendToken = e.sent[1].requestId;
e.dropInFlight();
ok(
  e.root.ambiguousSendsByChat.C1.length === 1 &&
    e.root.ambiguousSendsByChat.C1[0].requestId === clipboardSendToken,
  "disconnect after upload starts remains a real ambiguous send and keeps the exact token",
);

// The sentence itself. It is the daemon's, matched whole, and written once.
group("(v) the sentence the fallback turns on is the daemon's own");
// The sentence lives in the clipboard module since its extraction from
// daemon.ts; the contract is unchanged -- Panel.qml compares against it.
const clipboardSrc = fs.readFileSync(
  path.join(REPO, "daemon", "clipboard.ts"),
  "utf8",
);
const stubSrc = fs.readFileSync(path.join(REPO, "daemon", "stub.py"), "utf8");
ok(
  clipboardSrc.indexOf('error: "' + CLIPBOARD_EMPTY + '"') > 0,
  "the daemon answers exactly 「" + CLIPBOARD_EMPTY +
    "」, which is what Panel.qml compares " +
    "against -- reworded on one side only, every Ctrl+V of text becomes a red banner",
);
ok(
  stubSrc.indexOf('"error": "' + CLIPBOARD_EMPTY + '"') > 0,
  "and so does stub.py, which is the daemon this path is developed against",
);
ok(
  (src.match(new RegExp(CLIPBOARD_EMPTY, "g")) || []).length === 1,
  "Panel.qml spells it once, in the property onReply reads -- a second copy is the " +
    "half that gets missed",
);
const clipBranch = src.slice(
  src.indexOf('      if (cmd === "probeClipboardImage"'),
  src.indexOf('      root.notice = String(res.error || "失敗")'),
);
ok(
  clipBranch.length > 0 && clipBranch.indexOf("=== root.clipboardEmpty") > 0,
  "and the branch matches the whole sentence, not a substring of it: 「剪貼簿的圖片讀不到」 " +
    "shares five characters with it and means the opposite",
);
// Sliced out of onReply itself: "the first `if (stale) {` in the file" would be
// the download branch's, which proves nothing about where this branch sits.
const staleGate = B.onReply.indexOf("      if (stale) {\n");
ok(
  staleGate > 0 &&
    staleGate < B.onReply.indexOf('if (cmd === "probeClipboardImage"'),
  "the branch sits below the stale gate, so a late answer cannot paste into a chat " +
    "the user has already left",
);
ok(
  replyKeys.indexOf("root.pasteClipboard()") > 0 &&
    /if \(root\.pasteClipboard\(\)\) event\.accepted = true/.test(replyKeys),
  "and the key is wired to it, accepting exactly when it says it took the press -- " +
    "with no chat and with no daemon it does not, so the TextArea still gets its " +
    "own paste",
);
ok(
  /if \(root\.clipboardBusy\(\)\) return true/.test(B.pasteClipboard),
  "the debounce answers true rather than false: handing a repeat back to the TextArea " +
    "would paste the clipboard's text right before the first reply's fallback pastes " +
    "it again, which is the same bug seen from the other end",
);
ok(
  !/clipboardBusy: true|clipboardInFlight|property bool clipboard/.test(src) &&
    /for \(var k in root\.pending\)/.test(B.clipboardBusy),
  "and it is derived from pending rather than kept as a flag -- onReply deletes the " +
    "entry above every branch and dropInFlight() empties the lot, so there is no path " +
    "that has to remember to clear it",
);
const composerHint = src.slice(
  src.indexOf("              placeholderText:"),
  src.indexOf("              wrapMode: TextArea.Wrap"),
);
ok(
  /tr\("send\.placeholder"\)/.test(composerHint) &&
    /Ctrl\+V/.test(Strings.STRINGS["send.placeholder2"].zh) &&
    /Ctrl\+V/.test(Strings.STRINGS["send.placeholder2"].en),
  "and the placeholder says the key exists, next to /file -- nothing else on screen " +
    "would ever tell anyone to try it",
);
group("public images use daemon paths and recover after disconnect");
{
  const frames = [];
  const root = {
    imagePaths: {},
    imageRequests: {},
    imageRetryQueue: {},
    imageRetryAttempts: {},
    imageConsumers: { "https://example.com/sticker.png": 1 },
    imageRetries: [],
    previewRequests: {},
    previewRefreshNeeded: false,
    pending: {},
    activeChat: null,
    // the live file reads the socket via root.sockConnected; this standalone
    // root delegates to the sock stub passed alongside.
    get sockConnected() {
      return sock.connected;
    },
    ambiguousSendsByChat: {},
    myMid: "ME",
    notice: "keep this notice",
    persistAmbiguousSends() {},
    isMessageSendCmd() {
      return false;
    },
    draftRecoveryHolds: {},
    scheduleImageRetry(url, invalidate) {
      this.imageRetries.push({ url, invalidate: invalidate === true });
      return true;
    },
    finishImageRetry(url) {
      delete this.imageRetryAttempts[url];
    },
    request(cmd, extra, msgId) {
      frames.push({ cmd, extra, msgId });
      return true;
    },
  };
  const sock = { connected: true };
  const fetchImage = new Function(
    "root",
    "sock",
    "url",
    "invalidate",
    body("  function fetchImage(url, invalidate) {"),
  );
  const url = "https://example.com/sticker.png";
  fetchImage(root, sock, url);
  fetchImage(root, sock, url);
  fetchImage(root, sock, "file:///tmp/image.png");
  ok(
    frames.length === 1 && frames[0].cmd === "image",
    "one daemon request per remote image",
  );
  root.pending[1] = { cmd: "image", msgId: url };
  new Function("root", "line", "tr", "trErr", B.onReply)(
    root,
    JSON.stringify({ id: 1, ok: true, data: { path: "/tmp/image.png" } }),
    Tzh,
    Ezh,
  );
  ok(
    root.imagePaths[url] === "file:///tmp/image.png",
    "successful reply exposes only a local file URL",
  );
  ok(
    root.notice === "keep this notice",
    "background image replies preserve the notice",
  );
  root.pending[2] = { cmd: "image", msgId: url };
  new Function("root", "line", "tr", "trErr", B.onReply)(
    root,
    JSON.stringify({ id: 2, ok: false }),
    Tzh,
    Ezh,
  );
  ok(
    root.imagePaths[url] === "",
    "failed download never falls back to remote TLS",
  );
  delete root.imagePaths[url];
  root.pending[3] = { cmd: "image", msgId: url, invalidate: true };
  new Function("root", "line", "tr", "trErr", B.onReply)(
    root,
    JSON.stringify({
      id: 3,
      ok: false,
      error: "媒體請求過多，請稍後再試",
    }),
    Tzh,
    Ezh,
  );
  ok(
    root.imageRetries.length === 1 &&
      root.imageRetries[0].url === url &&
      root.imageRetries[0].invalidate === true &&
      root.imagePaths[url] === undefined,
    "a busy media lane retries a public image without caching a permanent failure",
  );
  fetchImage(root, sock, url);
  root.pending[4] = { cmd: "image", msgId: url, invalidate: true };
  root.imageRequests[url] = true;
  new Function("root", "tr", B.dropInFlight)(root, Tzh);
  ok(
    root.imageRetryQueue[url].invalidate === true,
    "disconnect retains an in-flight invalidation for the visible image",
  );
  fetchImage(root, sock, url);
  ok(
    frames.length === 3 && frames[2].extra.invalidate === true,
    "disconnect retries an abandoned corrupt-image replacement with invalidation",
  );
  const forgetImage = new Function(
    "root",
    "url",
    body("  function forgetImage(url) {"),
  );
  new Function("root", "tr", B.dropInFlight)(root, Tzh);
  root.imagePaths[url] = "file:///tmp/image.png";
  root.imagePaths["https://example.com/other.png"] = "file:///tmp/other.png";
  fetchImage(root, sock, url);
  ok(frames.length === 3, "a picture already in hand is not asked for twice");
  const before = root.imagePaths;
  forgetImage(root, url);
  ok(
    root.imagePaths[url] === undefined &&
      root.imagePaths["https://example.com/other.png"] ===
        "file:///tmp/other.png",
    "forgetting one url leaves the rest of the cache alone",
  );
  ok(
    root.imagePaths !== before,
    "and hands over a new object -- deleting the key in place changes nothing the " +
      "pictures on screen are bound to",
  );
  fetchImage(root, sock, url, true);
  ok(
    frames.length === 4,
    "so a swept cache file is asked for again: the sweep is the same 14 day / 500 MB " +
      "policy the rest of media/ lives under, and without this the file:// the panel " +
      "is still holding stays broken until the panel is reopened",
  );
  ok(
    frames[3].extra.invalidate === true,
    "a decode failure tells the daemon to discard the corrupt cached bytes",
  );
  new Function("root", "tr", B.dropInFlight)(root, Tzh);
  root.imageRetryQueue[url] = { invalidate: true };
  fetchImage(root, sock, url);
  ok(
    frames[4].extra.invalidate === true &&
      root.imageRetryQueue[url] === undefined,
    "a reconnect consumes the queued invalidation instead of reusing corrupt bytes",
  );
  root.imagePaths = {
    "https://example.com/a.png": "file:///tmp/a.png",
    "https://example.com/b.png": "file:///tmp/b.png",
    "https://example.com/c.png": "file:///tmp/c.png",
  };
  root.imagePathsMax = 2;
  root.pending[5] = { cmd: "image", msgId: "https://example.com/d.png" };
  new Function("root", "line", "tr", "trErr", B.onReply)(
    root,
    JSON.stringify({
      id: 5,
      ok: true,
      data: { path: "/tmp/d.png" },
    }),
    Tzh,
    Ezh,
  );
  ok(
    root.imagePaths["https://example.com/d.png"] === "file:///tmp/d.png" &&
      Object.keys(root.imagePaths).length === 2 &&
      root.imagePaths["https://example.com/c.png"] !== undefined &&
      root.imagePaths["https://example.com/a.png"] === undefined,
    "the path table drops the oldest entry past its cap instead of growing for a whole login",
  );
  root.imagePathsMax = undefined;
  const imageRetryTimerBlock = src.slice(
    src.indexOf("    id: imageRetryTimer"),
    src.indexOf(
      "  function scheduleImageRetry",
      src.indexOf("    id: imageRetryTimer"),
    ),
  );
  ok(
    imageRetryTimerBlock.indexOf("if (!sock.connected) return") <
      imageRetryTimerBlock.indexOf("root.imageRetryQueue = ({})"),
    "an offline retry timer leaves its invalidation queued for reconnect",
  );
  const previewRetryTimerBlock = src.slice(
    src.indexOf("    id: previewRetryTimer"),
    src.indexOf("    id: imageRetryTimer"),
  );
  ok(
    previewRetryTimerBlock.indexOf("if (!sock.connected)") <
      previewRetryTimerBlock.indexOf(
        "Object.assign({}, root.previewRetryQueue)",
      ),
    "an offline preview timer leaves queued invalidation for reconnect",
  );
  const cachedBlock = src.slice(
    src.indexOf("  component CachedImage: Image {"),
    src.indexOf("  moduleName:"),
  );
  ok(
    /cachedImage\.status !== Image\.Error/.test(cachedBlock) &&
      /root\.forgetImage\(cachedImage\.remoteSource\)/.test(cachedBlock) &&
      /root\.fetchImage\(cachedImage\.remoteSource\)/.test(cachedBlock),
    "and it is a picture failing to draw that starts that off, which is the only " +
      "moment the panel learns the file is gone",
  );
  ok(
    /cachedImage\.refetched\) return/.test(cachedBlock) &&
      /refetched = false/.test(cachedBlock),
    "once per url, reset when the url changes: a file that is present but unreadable " +
      "comes back as the very same path (the daemon only stats its size), so a second " +
      "try would spin",
  );
  ok(
    /cachedImage\.remoteSource\.indexOf\("file:\/\/"\) === 0\) return/.test(
      cachedBlock,
    ),
    "and never for a source that was already a local file -- those are downloaded " +
      "originals, which this cache knows nothing about",
  );
}

// ------------------------------------------------ (w) U64: the wheel step is a
// setting. Flickable has no "how far does one notch go", so the three scrolling
// views hand their wheel events to one pair of root functions -- which is what
// everything below drives, against a stub view rather than a scene graph.
group(
  "(w1) the multiplier is the setting over 100, clamped, and 100 is today's feel",
);
e = makeEnv({});
ok(
  SCROLL_STEPS.join(",") === "50,75,100,150,200,300",
  "six steps, 0.5x to 3x: " + SCROLL_STEPS.join(","),
);
ok(
  SCROLL_STEPS.every((v) => e.clampScroll(v) === v),
  "every step survives the clamp untouched",
);
ok(
  e.clampScroll(undefined) === 100 && e.clampScroll(null) === 100 &&
    e.clampScroll("nonsense") === 100 && e.clampScroll(0) === 100 &&
    e.clampScroll(-5) === 100,
  "missing / garbage / zero / negative all read as 100 -- shell.json is hand-editable " +
    "and `omarchy bar set` does not validate what goes into it",
);
ok(
  e.clampScroll(10) === 50 && e.clampScroll(99999) === 300,
  "and out of range clamps to 50..300 rather than leaving the panel unscrollable",
);
ok(
  e.clampScroll("150.4") === 150,
  "numeric strings are rounded, exactly like clampWindowSize",
);
ok(
  /readonly property int scrollPercent: clampScroll\(setting\("scrollSpeed", 100\)\)/
    .test(src),
  "the percentage is the setting run through that clamp and nothing else",
);
ok(
  /readonly property real scrollSpeed: scrollPercent \/ 100/.test(src),
  "and the multiplier is exactly that over 100, so the default 100 means 1x",
);
const scrollSchema =
  manifest.barWidget.schema.filter((s) => s.key === "scrollSpeed")[0];
ok(
  scrollSchema && scrollSchema.type === "integer" && scrollSchema.min === 50 &&
    scrollSchema.max === 300 && scrollSchema.defaultValue === 100,
  "the manifest schema declares the same bounds the clamp enforces",
);
ok(
  manifest.barWidget.defaults.scrollSpeed === 100,
  "and the default matches the fallback Panel.qml reads",
);
ok(
  SCROLL_STEPS[0] === scrollSchema.min &&
    SCROLL_STEPS[SCROLL_STEPS.length - 1] === scrollSchema.max,
  "the button's first and last steps are the schema's own ends, so no press can " +
    "write a value the panel would then clamp away under the label",
);

group(
  "(w2) one notch = the bigger of the two readings, x the multiplier, sign kept",
);
e = makeEnv({});
// U68. Every case below is run at 0.5x / 1x / 3x, because the whole complaint
// was that the multiplier appeared to do nothing: it was multiplying a base
// that had already been cut to a fifth, so 200% of not-much is still not-much.
const atSpeeds = (ad, pd) =>
  [50, 100, 300].map((p) =>
    makeEnv({ scrollPercent: p }).wheelDistance(ad, pd)
  );
ok(
  e.wheelDistance(120, 0) === 60 && e.wheelDistance(-120, 0) === -60,
  "at 1x a plain wheel's notch is 60px and the sign follows the wheel: " +
    e.wheelDistance(120, 0),
);
ok(
  e.wheelDistance(60, 0) === 30 && e.wheelDistance(240, 0) === 120,
  "half a notch and two notches scale with it",
);
ok(
  atSpeeds(-120, 0).join(",") === "-30,-60,-180" &&
    atSpeeds(120, 0).join(",") === "30,60,180",
  "a plain mouse (angleDelta only) is unchanged by U68 at every speed: " +
    atSpeeds(-120, 0).join(","),
);
ok(
  makeEnv({ scrollPercent: 75 }).wheelDistance(120, 0) === 45,
  "and the in-between steps are the same fraction -- 0.75x is three quarters of a notch",
);

// A high-resolution wheel sends BOTH readings for the same detent, and its
// pixelDelta is the small one. Measured on Frank's mouse: angleDelta -160 with
// pixelDelta -14. The old rule ("pixelDelta wins whenever it is non-zero") made
// one detent 14px -- three to six times shorter than the Flickable step it had
// replaced -- which is both "the scroll speed setting does nothing" (200% of
// 14px is 28px) and "scrolling the conversation is janky".
ok(
  e.wheelDistance(-160, -14) === -80 && e.wheelDistance(160, 14) === 80,
  "the notch reading wins for a high-resolution wheel, and down is the mirror of up: " +
    e.wheelDistance(-160, -14),
);
ok(
  Math.abs(e.wheelDistance(-160, -14)) >= 60,
  "so one detent is worth at least a whole plain notch, never its 14px pixelDelta",
);
ok(
  atSpeeds(-160, -14).join(",") === "-40,-80,-240" &&
    atSpeeds(160, 14).join(",") === "40,80,240",
  "and the multiplier now scales something the user can see, in both directions: " +
    atSpeeds(-160, -14).join(","),
);
ok(
  e.wheelDistance(-224, -18) === -112,
  "the second measured sample (angle -224, pixel -18) reads as 1.87 notches: " +
    e.wheelDistance(-224, -18),
);

// A real touchpad has no detents: angleDelta is 0 or a synthetic echo, and the
// pixelDelta is the distance the fingers actually travelled -- which is the
// bigger of the two readings, so it wins on its own.
ok(
  e.wheelDistance(0, -90) === -90 && e.wheelDistance(0, 90) === 90,
  "a touchpad with no angleDelta at all scrolls exactly as far as it slid",
);
ok(
  atSpeeds(0, -90).join(",") === "-45,-90,-270" &&
    atSpeeds(0, 90).join(",") === "45,90,270",
  "with the multiplier applied, so the setting works on a touchpad too: " +
    atSpeeds(0, -90).join(","),
);
ok(
  e.wheelDistance(-120, -150) === -150 && e.wheelDistance(120, 150) === 150,
  "when both readings are there and the pixel one is bigger, the pixels win: " +
    e.wheelDistance(-120, -150),
);
ok(
  atSpeeds(-120, -150).join(",") === "-75,-150,-450",
  "at every speed, and still in the direction the fingers went: " +
    atSpeeds(-120, -150).join(","),
);
ok(
  e.wheelDistance(6, 3) === 3,
  "a 3px slide stays a 3px slide -- the two readings agree here",
);
ok(
  makeEnv({ scrollPercent: 200 }).wheelDistance(6, 3) === 6,
  "with the multiplier still applied",
);
ok(
  e.wheelDistance(0, -3) === -3,
  "and a slide too small to be even a fifth of a notch is not rounded up to one",
);

ok(
  [[-160, -14], [0, -90], [-120, -150], [-120, 0], [-6, -3], [-224, -18]]
    .every(([ad, pd]) => atSpeeds(ad, pd).every((d) => d < 0)) &&
    [[160, 14], [0, 90], [120, 150], [120, 0], [6, 3], [224, 18]]
      .every(([ad, pd]) => atSpeeds(ad, pd).every((d) => d > 0)),
  "no device shape and no speed ever inverts the direction -- both deltas of one " +
    "event carry the same sign, and taking the larger magnitude keeps it",
);
ok(
  e.wheelDistance(0, 0) === 0 && e.wheelDistance(undefined, undefined) === 0 &&
    e.wheelDistance(NaN, NaN) === 0 &&
    makeEnv({ scrollPercent: 300 }).wheelDistance(0, 0) === 0,
  "no vertical component (or no numbers at all) -> no distance, which is how " +
    "wheelScroll knows not to write contentY",
);
ok(
  /Math\.abs\(notch\) > Math\.abs\(px\) \? notch : px/.test(kitSrc),
  "and the source really compares the two readings rather than preferring one",
);

// U68. msgList.onContentHeightChanged re-sticks to the bottom when the view is
// within Style.space(24) of it, so any scroll shorter than that band is undone
// by the next thumbnail that finishes loading. The old 14px notch landed inside
// it; every notch this function can now produce clears it.
ok(
  /contentY >= originY \+ msgList\.seenContentHeight - height - Style\.space\(24\)/
    .test(src),
  "the conversation's stick-to-bottom band is still 24px",
);
ok(
  SCROLL_STEPS.every((p) =>
    Math.abs(makeEnv({ scrollPercent: p }).wheelDistance(-120, 0)) > 24
  ) &&
    SCROLL_STEPS.every((p) =>
      Math.abs(makeEnv({ scrollPercent: p }).wheelDistance(-160, -14)) > 24
    ),
  "and one notch of either wheel, at even the slowest step, moves further than " +
    "that band -- so scrolling up really leaves the bottom instead of being " +
    "snapped back: " +
    SCROLL_STEPS.map((p) =>
      makeEnv({ scrollPercent: p }).wheelDistance(-160, -14)
    ).join(","),
);

group("(w3) the wheel writes contentY itself, clamped to the content");
const stubView = (o) =>
  Object.assign(
    { contentY: 0, originY: 0, height: 100, contentHeight: 1000 },
    o,
  );
e = makeEnv({});
let sv = stubView({ contentY: 500 });
e.wheelScroll(sv, -120, 0);
ok(
  sv.contentY === 560,
  "wheel down moves the content up one step: " + sv.contentY,
);
e.wheelScroll(sv, 120, 0);
ok(sv.contentY === 500, "and wheel up puts it back");
ok(
  makeEnv({ scrollPercent: 300 }).root.scrollSpeed === 3,
  "3x really is 3 as a multiplier",
);
sv = stubView({ contentY: 0 });
makeEnv({ scrollPercent: 300 }).wheelScroll(sv, -120, 0);
ok(
  sv.contentY === 180,
  "so one notch at 3x is three notches' worth: " + sv.contentY,
);
// originY is not 0 on a virtualised ListView -- the top of the content moves
// with whichever items are realised above the viewport.
sv = stubView({ contentY: 30, originY: 20 });
e.wheelScroll(sv, 120, 0);
ok(
  sv.contentY === 20,
  "the top clamps to originY, not to zero -- and landing exactly on it is what " +
    "keeps `contentY <= originY + 4` (load older) working from the wheel",
);
sv = stubView({ contentY: 880, originY: 20 });
e.wheelScroll(sv, -120, 0);
ok(
  sv.contentY === 920,
  "the bottom clamps to originY + contentHeight - height: " + sv.contentY,
);
sv = stubView({ contentHeight: 80 });
e.wheelScroll(sv, -120, 0);
ok(sv.contentY === 0, "content shorter than the viewport does not move at all");
sv = stubView({ contentY: 500 });
e.wheelScroll(sv, 0, 0);
ok(
  sv.contentY === 500,
  "and a wheel with no vertical component writes nothing -- an idle write is still a " +
    "contentYChanged, which is the signal that asks for another page of history",
);

group("(w4) all three scrolling views hand their wheel to that one path");
ok(
  (src.match(/component WheelSpeed: MouseArea \{/g) || []).length === 1,
  "there is exactly one wheel implementation in the file",
);
const wheelBlock = src.slice(
  src.indexOf("  component WheelSpeed: MouseArea {"),
  src.indexOf("  readonly property string stateDir:"),
);
ok(wheelBlock.length > 0, "the WheelSpeed block was found");
ok(
  /acceptedButtons: Qt\.NoButton/.test(wheelBlock),
  "it takes the wheel and nothing else -- press, drag and click still reach the rows below",
);
ok(
  /root\.wheelScroll\(wheelSpeed\.view, wheel\.angleDelta\.y, wheel\.pixelDelta\.y\)/
    .test(wheelBlock),
  "and both deltas go to the shared function instead of being re-derived per view",
);
ok(
  /y: wheelSpeed\.view\.originY/.test(wheelBlock) &&
    /height: Math\.max\(wheelSpeed\.view\.height, wheelSpeed\.view\.contentHeight\)/
      .test(wheelBlock),
  "it covers the whole content in content coordinates, so scrolling never slides it " +
    "out from under the pointer",
);
ok(
  src.includes("WheelSpeed { view: msgList }") &&
    src.includes("WheelSpeed { view: listFlick }") &&
    src.includes("WheelSpeed { view: stickerGrid }"),
  "the conversation, the chat list and the sticker grid all use it",
);
ok(
  (src.match(/WheelSpeed \{ view: /g) || []).length === 3,
  "and nothing else does -- three scrolling views, three instances",
);
const listBlock64 = src.slice(
  src.indexOf("        ListView {\n          id: msgList"),
  src.indexOf("          id: attachButton"),
);
ok(
  /interactive: contentHeight > height/.test(listBlock64),
  "the conversation keeps `interactive`, so touch and drag still belong to Flickable",
);
ok(
  /onModelChanged: \{/.test(listBlock64) &&
    /onContentHeightChanged: \{/.test(listBlock64),
  "U48's two anchoring handlers are untouched -- the wheel writes the very property they read",
);
ok(
  /root\.nearOlderEdge\(contentY, originY, contentHeight, height\)\) root\.loadOlder\(\)/
    .test(listBlock64),
  "and the load-older trigger still hangs off contentY, which is what the wheel now moves",
);
const flickBlock64 = src.slice(
  src.indexOf("      ListView {\n        id: listFlick"),
  src.indexOf(
    "      // ------------------------------" +
      "----------------------- conversation",
  ),
);
ok(
  /model: root\.listModel/.test(flickBlock64) &&
    /cacheBuffer: Style\.space\(600\)/.test(flickBlock64),
  "the chat list is virtualised and keeps a small row buffer",
);
ok(
  /function replaceChatSnapshot\(incoming\)/.test(src) &&
    /while \(oldIndex < 0 && probeY <= probeEnd\)/.test(src) &&
    /listFlick\.indexAt\(1, probeY\)/.test(src) &&
    /listFlick\.positionViewAtIndex\(nextIndex, ListView\.Beginning\)/.test(
      src,
    ) &&
    /root\.replaceChatSnapshot\(incoming\)/.test(B.parseState),
  "chat revisions preserve the visible row and its viewport offset",
);
const replaceChatSnapshot = new Function(
  "root",
  "listFlick",
  "Qt",
  "ListView",
  "incoming",
  B.replaceChatSnapshot,
);
let snapshot = [{ mid: "A" }, { mid: "B" }];
const topRoot = { listModel: snapshot };
Object.defineProperty(topRoot, "chatSnapshot", {
  set(value) {
    snapshot = value;
    topRoot.listModel = value;
  },
});
const topPositions = [];
const topList = {
  contentY: 20,
  originY: 20,
  contentHeight: 160,
  height: 80,
  indexAt() {
    return 0;
  },
  itemAtIndex(i) {
    return { y: 20 + i * 40 };
  },
  positionViewAtIndex(i) {
    topPositions.push("row:" + i);
  },
  positionViewAtBeginning() {
    topPositions.push("top");
    this.contentY = this.originY;
  },
};
replaceChatSnapshot(
  topRoot,
  topList,
  {
    callLater(fn) {
      fn();
    },
  },
  { Beginning: 0 },
  [{ mid: "NEW" }, { mid: "A" }, { mid: "B" }],
);
ok(
  topPositions.join(",") === "top" && topList.contentY === topList.originY,
  "a chat promoted ahead of the first row stays visible while the list is at the top",
);

snapshot = [{ mid: "A" }, { mid: "B" }, { mid: "C" }];
const scrolledRoot = { listModel: snapshot };
Object.defineProperty(scrolledRoot, "chatSnapshot", {
  set(value) {
    snapshot = value;
    scrolledRoot.listModel = value;
  },
});
const scrolledPositions = [];
const scrolledList = {
  contentY: 60,
  originY: 20,
  contentHeight: 200,
  height: 80,
  indexAt() {
    return 1;
  },
  itemAtIndex(i) {
    return { y: 20 + i * 40 };
  },
  positionViewAtIndex(i) {
    scrolledPositions.push(i);
  },
  positionViewAtBeginning() {
    throw new Error("scrolled list jumped to top");
  },
};
replaceChatSnapshot(
  scrolledRoot,
  scrolledList,
  {
    callLater(fn) {
      fn();
    },
  },
  { Beginning: 0 },
  [{ mid: "NEW" }, { mid: "A" }, { mid: "B" }, { mid: "C" }],
);
ok(
  scrolledPositions[0] === 2 && scrolledList.contentY === 100,
  "a scrolled chat list still anchors the row and offset that were visible",
);

group(
  "(w5) the button steps through the six values and says which one it is on",
);
e = makeEnv({});
const scrollWrites = [];
let atPercent = 100;
for (let i = 0; i < SCROLL_STEPS.length; i++) {
  e.root.scrollPercent = atPercent;
  e.stepScrollSpeed();
  const cmd = e.settingWriter.command;
  atPercent = Number(cmd[cmd.length - 1]);
  scrollWrites.push(atPercent);
}
ok(
  scrollWrites.join(" -> ") === "150 -> 200 -> 300 -> 50 -> 75 -> 100",
  "one press moves one step and wraps: " + scrollWrites.join(" -> "),
);
ok(
  e.settingWriter.command.slice(0, 5).join(" ") ===
    "omarchy bar set io.github.frankekn.line scrollSpeed",
  "written through `omarchy bar set`, the same path placement and textScale use: " +
    JSON.stringify(e.settingWriter.command),
);
ok(e.settingWriter.running === true, "and the writer is actually started");
ok(
  scrollWrites.every((v) => SCROLL_STEPS.indexOf(v) >= 0) &&
    new Set(scrollWrites).size === SCROLL_STEPS.length,
  "every value written is one of the panel's own steps, and the cycle visits all six",
);
// shell.json can hold any in-range number; the button still has to have
// somewhere to go from there.
ok(
  e.nextScroll(120) === 150 && e.nextScroll(51) === 75 &&
    e.nextScroll(299) === 300 &&
    e.nextScroll(300) === 50,
  "an in-between value steps to the first one above it, and the top wraps to the bottom",
);
ok(
  e.scrollLabel(50) === "0.5×" && e.scrollLabel(75) === "0.75×" &&
    e.scrollLabel(100) === "1×" &&
    e.scrollLabel(150) === "1.5×" && e.scrollLabel(200) === "2×" &&
    e.scrollLabel(300) === "3×",
  "the label reads as a multiplier, with no trailing zeros on the whole ones",
);
ok(
  e.scrollLabel(120) === "1.2×",
  "including a value nobody could have picked from the list",
);
ok(
  e.scrollLabel(99999) === "3×" && e.scrollLabel("junk") === "1×",
  "and it goes through the same clamp, so the button can never name a speed the panel " +
    "is not actually using",
);
const speedBlock = src.slice(
  src.indexOf("          // 捲動速度：按一下換下一段"),
  src.indexOf("          // 讀取筆數：按一下換下一段"),
);
ok(
  speedBlock.length > 0,
  "the scroll-speed control was found in the tools row",
);
ok(
  /text: tr\("label\.scroll", root\.scrollLabel\(root\.scrollPercent\)\)/.test(speedBlock),
  "it carries the readout -- unlike A-/A+ nothing on screen changes when the speed does, " +
    "so a stepper without a number could not be read back",
);
ok(
  speedBlock.includes("onClicked: root.stepScrollSpeed()") &&
    speedBlock.includes("Accessible.role: Accessible.Button") &&
    speedBlock.includes("Accessible.onPressAction: root.stepScrollSpeed()"),
  "clicking it steps, and it is a Button to assistive tech rather than an unlabelled Text",
);
ok(
  /Accessible\.description: tr\("switch\.to", root\.scrollLabel\(root\.nextScroll\(root\.scrollPercent\)\)\)/
    .test(speedBlock),
  "which is also told where the next press lands",
);
const toolsRow64 = src.slice(
  src.indexOf("        Row {\n          id: scaleRow"),
  src.indexOf("        // 搜尋在標題下方"),
);
ok(
  toolsRow64.indexOf("root.stepScrollSpeed()") > 0 &&
    toolsRow64.indexOf("root.togglePlacement()") > 0 &&
    toolsRow64.indexOf("root.setTextScale(") > 0,
  "and it lives in the existing settings row next to placement and text size, " +
    "not in a second settings surface with a store of its own",
);

// ------------------------------------------- (x) U66: 隱藏聊天 (hide chat)

group("(x1) the list hides a chat until the search box has something in it");
const chatRows = (all, query, up) =>
  new Function("PanelKit", "all", "query", "up", B.chatRows)(
    PanelKit, all, query, up);
const rowSubtitle = (c) =>
  new Function("PanelKit", "c", "tr", "trErr", B.rowSubtitle)(PanelKit, c, Tzh, Ezh);
const chatMenuItems = (c) =>
  new Function("PanelKit", "c", "tr", B.chatMenuItems)(PanelKit, c, Tzh);
const HID = [
  { mid: "cwork", name: "工作", unread: 2, lastFrom: "同事", lastText: "明天" },
  { mid: "umom", name: "媽", unread: 0, lastFrom: "我", lastText: "好" },
  {
    mid: "cnoise",
    name: "吵鬧群",
    unread: 9,
    lastFrom: "路人",
    lastText: "明天見",
    hidden: true,
  },
  {
    mid: "uex",
    name: "前同事",
    unread: 0,
    lastFrom: "他",
    lastText: "嗨",
    hidden: true,
  },
];
const mids = (l) => l.map((c) => c.mid);
ok(
  mids(chatRows(HID, "", true)).join() === "cwork,umom",
  "with an empty search the hidden rows are gone and the rest keep unread-first order",
);
ok(
  chatRows(HID, "", false).length === 0,
  "offline is still an empty list, hidden or not",
);
// (a) of Frank's ruling: typing brings them back rather than an "unhide" screen.
ok(
  mids(chatRows(HID, "明天", true)).join() === "cwork,cnoise",
  "a search that matches both shows both, hidden last",
);
ok(
  mids(chatRows(HID, "嗨", true)).join() === "uex",
  "and a hidden chat is findable on its own",
);
ok(
  mids(chatRows(HID, "沒有這個字", true)).length === 0,
  "a search that matches nothing is empty",
);
// The hidden ones go after *every* visible row, unread or not -- they are the
// rows the user took away, so they never push a live conversation down.
const withRead = HID.concat([{
  mid: "clate",
  name: "明天的會",
  unread: 0,
  lastText: "",
}]);
ok(
  mids(chatRows(withRead, "明天", true)).join() === "cwork,clate,cnoise",
  "a hidden row never outranks a visible one, even a read one",
);
ok(
  mids(chatRows(HID, "  明天  ", true)).join() === "cwork,cnoise" &&
    mids(chatRows(HID, "明天見", true)).join() === "cnoise",
  "the search is still trimmed and still matches the preview line",
);

group("(x2) the row says why it is only showing up in a search");
ok(rowSubtitle(HID[0]) === "同事: 明天", "an ordinary row is unchanged");
ok(rowSubtitle(HID[2]) === "已隱藏 · 路人: 明天見", "a hidden one is marked");
ok(
  rowSubtitle({ mid: "c1", hidden: true }) === "已隱藏",
  "and a hidden chat with no preview text still says so rather than showing a bare name",
);
ok(
  rowSubtitle({ mid: "c1" }) === "",
  "while an ordinary empty one stays empty, so the line keeps hiding itself",
);
const rowBlock66 = src.slice(
  src.indexOf("        model: root.listModel"),
  src.indexOf(
    "      // ------------------------------" +
      "----------------------- conversation",
  ),
);
ok(rowBlock66.length > 0, "the chat-list row was found in Panel.qml");
ok(
  /text: root\.oneLine\(root\.rowSubtitle\(modelData\)\)/.test(rowBlock66),
  "the row draws it through the one function, in the existing dim second line",
);

group(
  "(x3) the bar icon never lights up for a chat that was taken off the list",
);
// One-liner bindings, so they are lifted out of the source and evaluated
// rather than slice()d: a copy of the rule here would pass while the panel
// counted something else.
function rhs(decl) {
  const line = lines.find((l) => l.trimStart().startsWith(decl));
  if (!line) throw new Error("not found in " + PANEL + ": " + decl);
  return line.slice(line.indexOf(decl) + decl.length);
}
const unreadChatsOf = new Function(
  "chats",
  "return " + rhs("readonly property var unreadChats:"),
);
const totalUnreadOf = new Function(
  "unreadChats",
  "return " + rhs("readonly property int totalUnread:"),
);
ok(
  mids(unreadChatsOf(HID)).join() === "cwork",
  "the hidden chat with 9 unread is not one of the unread chats",
);
ok(
  totalUnreadOf(unreadChatsOf(HID)) === 2,
  "so the badge counts 2, not 11 -- hiding a noisy group actually makes it quiet",
);
ok(
  totalUnreadOf(unreadChatsOf(HID.filter((c) => !c.hidden))) === 2,
  "and taking the hidden rows out by hand gives the same number, so nothing is double-counted",
);

group("(x4) right-click offers the one action the row is not already in");
ok(
  chatMenuItems(HID[0]).length === 1 &&
    chatMenuItems(HID[0])[0].label === "隱藏聊天",
  "a visible row offers 隱藏聊天",
);
ok(
  chatMenuItems(HID[2])[0].label === "取消隱藏" &&
    chatMenuItems(HID[2])[0].action === "unhide",
  "a hidden one offers 取消隱藏 instead -- never both, so the label is also the state",
);
ok(
  chatMenuItems(null)[0].action === "hide",
  "and nothing selected falls back to the hide side rather than throwing",
);
ok(
  /if \(mouse\.button === Qt\.RightButton\)\n\s*root\.openChatMenu\(rowHover, mouse\.x, mouse\.y, modelData\)/
    .test(rowBlock66) &&
    /acceptedButtons: Qt\.LeftButton \| Qt\.RightButton/.test(rowBlock66) &&
    /else\n\s*root\.openChat\(modelData\)/.test(rowBlock66),
  "the row takes the right button for the menu and leaves the left one opening the chat",
);
ok(
  /msgMenu\.chat = c \|\| null/.test(B.openChatMenu) &&
    /msgMenu\.open\(\)/.test(B.openChatMenu),
  "which opens the one existing Popup rather than a second menu implementation",
);
ok(
  /msgMenu\.chat = null/.test(B.openMessageMenu),
  "and a right-click on a message clears the chat again, so the two never mix",
);
ok(
  /visible: !msgMenu\.chat && root\.canActOn\(msgMenu\.msg\)/.test(menuBlock),
  "the six emoji stay out of the chat menu -- there is no message there to react to",
);

group("(x5) hiding goes through the daemon, and its refusal is visible");
const hideCalls = [];
const hideRoot = {
  request(cmd, extra) {
    hideCalls.push({ cmd: cmd, chat: extra.chat });
    return true;
  },
};
const setChatHidden = new Function("root", "c", "hide", B.setChatHidden);
setChatHidden(hideRoot, HID[0], true);
setChatHidden(hideRoot, HID[2], false);
ok(
  JSON.stringify(hideCalls) ===
    JSON.stringify([{ cmd: "hide", chat: "cwork" }, {
      cmd: "unhide",
      chat: "cnoise",
    }]),
  "the panel asks the daemon and keeps no state of its own -- state.json is the answer",
);
setChatHidden(hideRoot, null, true);
setChatHidden(hideRoot, { mid: "" }, true);
ok(
  hideCalls.length === 2,
  'a row with no mid sends nothing rather than hiding ""',
);
// hide/unhide carry a `chat`, so without a branch of their own they would be
// swallowed as stale the moment the panel is on the list (activeChat is null).
let he = makeEnv({ view: "list" });
he.root.activeChat = null;
he.root.pending[7] = { cmd: "hide", msgId: "", text: "", chat: "cwork" };
he.onReply(
  JSON.stringify({ id: 7, ok: false, error: "沒有指定是哪一間聊天室" }),
);
ok(
  he.root.notice === "沒有指定是哪一間聊天室",
  "a refused hide says so on the banner instead of vanishing",
);
he.root.pending[8] = { cmd: "unhide", msgId: "", text: "", chat: "cwork" };
he.onReply(JSON.stringify({ id: 8, ok: false }));
ok(
  he.root.notice === "取消隱藏失敗",
  "and an error with no words still gets a sentence",
);

group("(x6) the selection cannot point at a row that is no longer there");
const clampRoot = { listModel: [], selectedIndex: 3 };
const clampSelection = new Function("root", B.clampSelection);
clampSelection(clampRoot);
ok(
  clampRoot.selectedIndex === 0,
  "an empty list parks the selection at 0, not -1",
);
clampRoot.listModel = [1, 2];
clampRoot.selectedIndex = 5;
clampSelection(clampRoot);
ok(clampRoot.selectedIndex === 1, "a shorter list clamps to the last row");
clampRoot.selectedIndex = 0;
clampSelection(clampRoot);
ok(
  clampRoot.selectedIndex === 0,
  "and a selection already inside it is left alone",
);
ok(
  /readonly property int listCount: root\.listModel\.length/.test(src) &&
    /onListCountChanged: root\.clampSelection\(\)/.test(src),
  "the clamp hangs off the row count, so hiding a row re-clamps but a rewritten " +
    "state.json of the same length does not move the selection under the mouse",
);

group("(x7) hiding the chat you are looking at walks back the way Esc does");
const chatHidden = new Function("root", "mid", B.chatHidden);
const hiddenState = {
  chatById(mid) {
    return HID.find((c) => c.mid === mid) || null;
  },
};
ok(
  chatHidden(hiddenState, "cnoise") === true &&
    chatHidden(hiddenState, "cwork") === false,
  "the answer comes from the current state.chats, not from the activeChat snapshot",
);
ok(
  chatHidden(hiddenState, "cgone") === false &&
    chatHidden(hiddenState, "") === false,
  "a chat that has dropped out of the list is not 'hidden', so nothing fires for it",
);
ok(
  /onActiveHiddenChanged: if \(root\.activeHidden\) root\.backToList\(\)/.test(
    src,
  ),
  "and the way back is backToList() itself -- twoPane keeps its right half, " +
    "which is that function's own rule",
);

group(
  "(x8) but a hidden chat opened from a search hit is not 'hidden since opened'",
);
// Search is the only door into a hidden chat. A rule that only looked at the
// hidden flag would fire the moment activeChat became that row and bounce
// straight back to the list, so the row would be findable and un-openable.
const hiddenSinceOpened = new Function(
  "root",
  "chat",
  "openedHidden",
  B.hiddenSinceOpened,
);
const sinceRoot = {
  chatHidden(mid) {
    return chatHidden(hiddenState, mid);
  },
};
const opened = (c, mark) => hiddenSinceOpened(sinceRoot, c, mark);
ok(
  opened(HID[2], "cnoise") === false,
  "opening the hidden row the search turned up leaves it open",
);
ok(
  opened(HID[2], "") === true,
  "while the same row hidden out from under you walks back to the list",
);
ok(
  opened(HID[0], "") === false && opened(HID[0], "cnoise") === false,
  "an ordinary chat is never bounced, whatever was opened last",
);
ok(
  opened(null, "") === false && opened({ mid: "" }, "") === false &&
    opened({ mid: "cgone" }, "") === false,
  "and no chat, no mid, or one that has dropped out of the list fires nothing",
);
// The mark has to be set before activeChat, because activeHidden is bound to
// activeChat: the binding re-runs inside that assignment, so a mark written
// after it arrives too late to stop the bounce.
const marked = B.openChat.indexOf("root.hiddenOnOpen =");
const assigned = B.openChat.indexOf("root.activeChat = chat");
ok(
  marked >= 0 && assigned > marked,
  "openChat() marks an already-hidden chat before it assigns activeChat",
);
ok(
  /root\.hiddenOnOpen = chat && root\.chatHidden\(chat\.mid\) \? String\(chat\.mid \|\| ""\) : ""/
    .test(B.openChat),
  "and it asks the current state.chats rather than trusting the row it was handed",
);
ok(
  /readonly property bool activeHidden:\n\s*root\.hiddenSinceOpened\(root\.activeChat, root\.hiddenOnOpen\)/
    .test(src),
  "the binding is the one function, so this is the rule the panel really runs",
);

// -------------------------------------- (y) U69: page size and the prefetch

group(
  "(y1) how many messages a page is, and what a hand-edited shell.json does",
);
e = makeEnv({});
ok(
  HISTORY_STEPS.every((v) => e.clampHistory(v) === v),
  "every step the button can reach survives the clamp untouched",
);
ok(
  e.clampHistory(undefined) === 60 && e.clampHistory(null) === 60 &&
    e.clampHistory("nonsense") === 60 && e.clampHistory(0) === 60 &&
    e.clampHistory(-5) === 60,
  "a missing, non-numeric or nonsensical setting is the default, not a page of 0 " +
    "-- `omarchy bar set` does not validate, so shell.json really can hold any of these",
);
ok(
  e.clampHistory(1) === 20 && e.clampHistory(99999) === 200,
  "and anything out of range is clamped to the ends rather than thrown away",
);
ok(
  e.clampHistory(37) === 37 && e.clampHistory("37") === 37,
  "an in-range value nobody could have picked from the list is still honoured",
);
ok(
  e.clampHistory("60.5") === 61 && e.clampHistory(59.4) === 59,
  "and it is rounded, exactly like clampScroll and clampWindowSize",
);
ok(
  /readonly property int historyPage: clampHistory\(setting\("historyPage", 60\)\)/
    .test(src),
  "the panel really reads the setting through that clamp",
);
const pageSchema =
  manifest.barWidget.schema.filter((s) => s.key === "historyPage")[0];
ok(
  !!pageSchema && pageSchema.type === "integer" && pageSchema.min === 20 &&
    pageSchema.max === 200 && pageSchema.defaultValue === 60,
  "and the manifest schema names the same bounds and default: " +
    JSON.stringify(pageSchema),
);
ok(
  manifest.barWidget.defaults.historyPage === 60,
  "with the default also in defaults, like every other setting the panel writes",
);

group("(y2) one page size feeds the first page and every page back");
e = makeEnv({ historyPage: 100, activeChat: { mid: "C1" } });
e.openChat({ mid: "C1", unread: 0 });
let firstPage = e.sent.filter((r) =>
  r.cmd === "history" && r.before === undefined
).pop();
ok(
  firstPage.count === 100,
  "opening a chat asks for the setting's number: " +
    JSON.stringify(firstPage.count),
);
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.root.loading = false;
e.loadOlder();
let backPage = e.sent.filter(olderFrame).pop();
ok(
  backPage.count === 100 && backPage.before === "m9",
  "and paging back asks for the same number, not a literal of its own: " +
    JSON.stringify(backPage.count),
);
ok(
  !/count: 30/.test(B.loadHistory) && !/count: 30/.test(B.loadOlder),
  "neither of the two has a page size written into it any more",
);

group(
  "(y3) the button steps through the four sizes and says which one it is on",
);
e = makeEnv({});
const pageWrites = [];
let atPage = HISTORY_STEPS[0];
for (let i = 0; i < HISTORY_STEPS.length; i++) {
  e.root.historyPage = atPage;
  e.stepHistoryPage();
  const cmd = e.settingWriter.command;
  atPage = Number(cmd[cmd.length - 1]);
  pageWrites.push(atPage);
}
ok(
  pageWrites.join(" -> ") === "60 -> 100 -> 150 -> 30",
  "one press moves one step and wraps: " + pageWrites.join(" -> "),
);
ok(
  e.settingWriter.command.slice(0, 5).join(" ") ===
    "omarchy bar set io.github.frankekn.line historyPage",
  "written through `omarchy bar set`, the same path scrollSpeed and placement use: " +
    JSON.stringify(e.settingWriter.command),
);
ok(e.settingWriter.running === true, "and the writer is actually started");
ok(
  pageWrites.every((v) => HISTORY_STEPS.indexOf(v) >= 0) &&
    new Set(pageWrites).size === HISTORY_STEPS.length,
  "every value written is one of the panel's own steps, and the cycle visits all four",
);
ok(
  e.nextHistory(37) === 60 && e.nextHistory(31) === 60 &&
    e.nextHistory(149) === 150 &&
    e.nextHistory(150) === 30 && e.nextHistory(1000) === 30,
  "a hand-edited value steps to the first one above it, and the top wraps to the bottom",
);
ok(
  e.historyLabel(60) === "60" && e.historyLabel(150) === "150",
  "the label is the number itself -- 則數 has no unit to read it back by",
);
ok(
  e.historyLabel(99999) === "200" && e.historyLabel("junk") === "60",
  "and it goes through the same clamp, so the button can never name a page size " +
    "the panel is not actually asking for",
);
const pageBlock = src.slice(
  src.indexOf("          // 讀取筆數：按一下換下一段"),
  src.indexOf("          // 手動同步。"),
);
ok(pageBlock.length > 0, "the page-size control was found in the tools row");
ok(
  /text: tr\("label\.history", root\.historyLabel\(root\.historyPage\)\)/.test(pageBlock),
  "it carries the readout -- nothing on screen changes until the next chat opens, " +
    "so a stepper without a number could not be read back",
);
ok(
  pageBlock.includes("onClicked: root.stepHistoryPage()") &&
    pageBlock.includes("Accessible.role: Accessible.Button") &&
    pageBlock.includes("Accessible.onPressAction: root.stepHistoryPage()"),
  "clicking it steps, and it is a Button to assistive tech rather than an unlabelled Text",
);
ok(
  /Accessible\.description: tr\("switch\.to", root\.historyLabel\(root\.nextHistory\(root\.historyPage\)\)\)/
    .test(pageBlock),
  "which is also told where the next press lands",
);
const toolsRow69 = src.slice(
  src.indexOf("        Row {\n          id: scaleRow"),
  src.indexOf("        // 搜尋在標題下方"),
);
ok(
  toolsRow69.indexOf("root.stepHistoryPage()") > 0 &&
    toolsRow69.indexOf("root.stepScrollSpeed()") > 0,
  "and it lives in the existing settings row beside scroll speed, not in a second " +
    "settings surface with a store of its own",
);

group("(y4) the next page is asked for a screen early, not at the very top");
e = makeEnv({});
ok(
  e.nearOlderEdge(400, 0, 2000, 400) === true,
  "exactly one viewport from the top is inside the threshold",
);
ok(
  e.nearOlderEdge(399, 0, 2000, 400) === true,
  "and anything nearer than that is too",
);
ok(
  e.nearOlderEdge(401, 0, 2000, 400) === false,
  "one pixel further away is not -- the band is a screen wide, not the whole list",
);
ok(
  e.nearOlderEdge(1600, 0, 2000, 400) === false,
  "sitting at the bottom asks for nothing at all",
);
ok(
  e.nearOlderEdge(471, 71, 2000, 400) === true &&
    e.nearOlderEdge(472, 71, 2000, 400) === false,
  "the distance is measured from originY, which is not 0 while a virtualised " +
    "ListView is still realising the items above the viewport",
);
ok(
  e.nearOlderEdge(0, 0, 300, 400) === false &&
    e.nearOlderEdge(0, 0, 400, 400) === false,
  "and a conversation shorter than the viewport asks for nothing, or every chat " +
    "that fits on screen would fetch a page the moment it opened",
);
// The whole point of the earlier trigger is that the round trip happens while
// there is still something to read; the old one waited until there was not.
ok(
  !/contentY <= originY \+ Style\.space\(4\)/.test(src),
  "the old 'only when it is actually pinned to the top' trigger is gone",
);

group(
  "(y5) the model swap's contentY = 0 is still not 'the reader scrolled up'",
);
// U21/U48's guards: a ListView zeroes contentY on a model reset (measured on
// Qt 6.11: 1034 -> 0), and with a threshold a whole screen wide that lands
// deep inside the band -- so every one of them has to survive.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.msgList.contentY = 0;
e.msgList.originY = 0;
e.msgList.contentHeight = 2000;
e.msgList.height = 400;
e.root.keepContentY = 300;
e.contentYChanged();
ok(
  e.sent.filter(olderFrame).length === 0,
  "a swap in progress (keepContentY >= 0) fetches nothing, even at contentY 0",
);
e.root.keepContentY = -1;
e.root.prependAnchorIndex = 2;
e.contentYChanged();
ok(
  e.sent.filter(olderFrame).length === 0,
  "and neither does the prepend that is still being anchored",
);
e.root.prependAnchorIndex = -1;
e.contentYChanged();
ok(
  e.sent.filter(olderFrame).length === 1,
  "once both flags are clear, the same position does ask for a page",
);
ok(e.root.loadingOlder === true, "and that page is marked as in flight");
e.contentYChanged();
e.contentYChanged();
ok(
  e.sent.filter(olderFrame).length === 1,
  "which is what keeps the wider band to one request in flight: " +
    e.sent.filter(olderFrame).length + " went out",
);
e.root.loading = true;
e.root.loadingOlder = false;
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 1,
  "a first page still on its way blocks it too -- 'before' would name a message " +
    "about to be replaced wholesale",
);

group(
  "(y5b) the prepend anchor keeps the reader where they were, not at the top",
);
// U48 anchors the swap on the index the reader's message moved to, and then
// left it at the top of the viewport -- correct while the only way to trigger
// a page was to be pinned to the top, where that distance is 0. Asking a
// screen early breaks that assumption: the page can land while the reader is
// still on their way up, and dropping the distance would yank the view up by
// as much as a whole screen of unread conversation.
e = makeEnv({});
ok(
  e.anchoredContentY(900, 0, 0, 5000, 400) === 900,
  "pinned to the top (keep 0) lands exactly where the anchor put it, as before",
);
ok(
  e.anchoredContentY(900, 0, 250, 5000, 400) === 1150,
  "and a reader 250px below it stays 250px below it: " +
    e.anchoredContentY(900, 0, 250, 5000, 400),
);
ok(
  e.anchoredContentY(900, 71, 250, 5000, 400) === 1150,
  "originY only matters to the clamp -- the offset is a distance, not a position",
);
ok(
  e.anchoredContentY(4700, 0, 250, 5000, 400) === 4600,
  "and it is clamped to the bottom of the content, never past it",
);
ok(
  e.anchoredContentY(100, 0, 250, 300, 400) === 0,
  "content shorter than the viewport clamps to the top rather than a negative contentY",
);
ok(
  e.anchoredContentY(900, 0, -1, 5000, 400) === 900,
  "no saved position (-1, the swap that was never a scroll) changes nothing",
);
// The runaway this also closes: without the offset every page put the reader
// back one page-height from the top, so a page shorter than the viewport left
// the threshold true and fetched again -- with nobody touching the mouse.
let atTop = 0;
for (const page of [120, 120, 120, 120]) { // four short pages in a tall window
  atTop = e.anchoredContentY(page, 0, atTop, 100000, 400);
}
ok(
  atTop === 480 && e.nearOlderEdge(atTop, 0, 100000, 400) === false,
  "four short pages add up past one screen and the prefetch stops on its own: " +
    atTop,
);
ok(
  /contentY = root\.anchoredContentY\(contentY, originY, keep, contentHeight, height\)/
    .test(listBlock),
  "and the ListView really applies it right after the anchor",
);
ok(
  /positionViewAtIndex\(Math\.min\(root\.prependAnchorIndex, count - 1\), ListView\.Beginning\)/
    .test(listBlock),
  "which is still an index anchor -- contentHeight is an estimate, U48's reason stands",
);

group("(y6) a conversation with nothing older left stops asking");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.msgList.contentY = 0;
e.msgList.contentHeight = 2000;
e.msgList.height = 400;
e.loadOlder();
e.onReply(
  JSON.stringify({
    id: e.sent.filter(olderFrame).pop().id,
    ok: true,
    data: [],
  }),
);
ok(
  e.root.noMoreOlder === true && e.root.loadingOlder === false,
  "an empty page is the daemon saying there is nothing older",
);
e.contentYChanged();
e.contentYChanged();
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 1,
  "and every later scroll inside the band asks for nothing: " +
    e.sent.filter(olderFrame).length + " older frames in total",
);
// The daemon always sends the anchor back, so "one message, already have it"
// is the same answer as an empty page.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.loadOlder();
e.onReply(
  JSON.stringify({
    id: e.sent.filter(olderFrame).pop().id,
    ok: true,
    data: [{ id: "m9", time: NOW48 }],
  }),
);
ok(
  e.root.noMoreOlder === true,
  "a page that is nothing but the anchor coming back is the top of the conversation",
);
ok(e.root.messages.length === 1, "and nothing is prepended twice");
// A page that did land must leave the door open, or one page back would be all
// anyone ever got.
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.loadOlder();
e.onReply(
  JSON.stringify({
    id: e.sent.filter(olderFrame).pop().id,
    ok: true,
    data: [{ id: "m8", time: NOW48 }, { id: "m9", time: NOW48 }],
  }),
);
ok(
  e.root.noMoreOlder === false && e.root.messages.length === 2,
  "a page that brought something new leaves paging switched on",
);

group("(y7) reopening or refetching a chat arms the paging again");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.loadOlder();
e.onReply(
  JSON.stringify({
    id: e.sent.filter(olderFrame).pop().id,
    ok: true,
    data: [],
  }),
);
ok(e.root.noMoreOlder === true, "C1 has been read to the top");
e.root.chats = [{ mid: "C2", name: "b", unread: 0 }];
e.openChat({ mid: "C2", unread: 0 });
ok(
  e.root.noMoreOlder === false,
  "opening another chat clears it -- the flag was about C1's oldest message",
);
// 同步 and the event path both refetch in place; messages[0] changes, so the
// answer to "is there anything older" is about a different message now.
e.root.noMoreOlder = true;
e.loadHistory("C2");
ok(
  e.root.noMoreOlder === false,
  "and so does any refetch, or a synced conversation could never be paged back again",
);
ok(
  /root\.noMoreOlder = false/.test(B.loadHistory),
  "which is loadHistory's own doing, so every caller gets it: " +
    "openChat, 同步, and the event-driven reload",
);

// ------------------------------------------- (y8) U71: a frame that never went
// out must not leave a spinner behind. Both flags are lit before the write, and
// request() answers false without putting anything in `pending` when the socket
// is down -- so nothing was ever going to come back and turn them off again.
// The two call sites this reached ask for nothing themselves: a scroll near the
// top and a click on a row both walk straight in.
group("(y8) a request the socket refused leaves no spinner behind");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.msgList.contentY = 0;
e.msgList.originY = 0;
e.msgList.contentHeight = 2000;
e.msgList.height = 400;
e.sock.connected = false; // the few seconds a restart takes
e.contentYChanged(); // one scroll near the top
ok(
  e.sent.length === 0,
  "no older frame went out (" + e.sent.length + " frames)",
);
ok(
  e.root.loadingOlder === false,
  "and loadingOlder is not left lit by a page nobody was asked for",
);
ok(
  e.root.notice === "daemon 沒在跑",
  "the banner is the only thing that happened",
);
e.sock.connected = true; // the daemon comes back
e.contentYChanged();
ok(
  e.sent.filter(olderFrame).length === 1,
  "the same conversation pages back at once, without being left and reopened: " +
    e.sent.filter(olderFrame).length + " older frames",
);
ok(
  e.root.loadingOlder === true,
  "and that page is in flight in the ordinary way",
);

// The other flag, down the other route: a click on a chat row goes through
// openChat into loadHistory, which checked nothing either.
e = makeEnv({
  twoPane: true,
  activeChat: null,
  view: "list",
  connected: false,
});
e.root.chats = [{ mid: "C2", name: "b", unread: 0 }];
e.openChat({ mid: "C2", unread: 0 });
ok(e.sent.length === 0, "no history frame went out either");
ok(
  e.root.loading === false,
  "so the conversation is not left on 「載入中…」 with nothing on its way",
);
e.sock.connected = true;
e.loadHistory("C2");
ok(
  e.sent.filter((r) => r.cmd === "history").length === 1 &&
    e.root.loading === true,
  "and the reconnected panel loads it the ordinary way",
);

// Neither of them asks the socket itself. A copy of the condition at each caller
// is what this bug was: two call sites already did not have one.
// Code lines only -- both functions name sock.connected in a comment, saying
// exactly why they do not read it.
const codeOnly = (b) =>
  b.split("\n").filter((l) => l.indexOf("//") < 0).join("\n");
ok(
  !/sock\.connected/.test(codeOnly(B.loadHistory)) &&
    !/sock\.connected/.test(codeOnly(B.loadOlder)),
  "the condition stays inside request(), which is the only thing that knows " +
    "whether the frame was written",
);

group("(y8b) a disconnect turns both flags off, because it emptied the wait");
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = e.withDay([{ id: "m9", time: NOW48 }]);
e.root.loadHistory("C1");
ok(e.root.loading === true, "a page of history is on its way");
e.root.loadingOlder = true; // an older page with it
e.dropInFlight();
ok(
  Object.keys(e.root.pending).length === 0,
  "the disconnect drops what was in flight",
);
ok(
  e.root.loading === false && e.root.loadingOlder === false,
  "and the two flags with it -- they are records of that same wait, and no reply " +
    "is coming to turn them off",
);
e.loadOlder();
ok(
  e.sent.filter(olderFrame).length === 1,
  "so the chat is pageable the moment the line is back, rather than after a " +
    "round trip through the list",
);

group("(y8c) a sentence that could not be sent stays in the box");
// The reply box lights the same kind of state before it sends: an optimistic
// bubble and an emptied draft, neither of which anything but a reply undoes.
e = makeEnv({ activeChat: { mid: "C1" }, connected: false });
e.root.messages = e.withDay([MSG("m1", "THEM", "x")]);
e.startReply(e.root.messages[0]);
e.submit("還沒送出去的那句");
ok(e.sent.length === 0, "nothing went out");
ok(
  e.replyField.text === "還沒送出去的那句",
  "the draft is still in the box -- it is the only copy of it there is: " +
    JSON.stringify(e.replyField.text),
);
ok(
  e.root.messages.filter((m) => m.pending === true).length === 0,
  "and no bubble is left standing for a message that was never sent",
);
ok(
  e.root.replyTarget !== null && e.root.replyTarget.id === "m1",
  "the quote is still attached to the draft it belongs to",
);
e.sock.connected = true;
e.submit(e.replyField.text);
ok(
  e.sent.length === 1 && e.sent[0].cmd === "reply" &&
    e.sent[0].replyTo === "m1",
  "so pressing Enter again once the daemon is back sends it, quote and all: " +
    JSON.stringify(e.sent),
);
ok(
  e.replyField.text === "" && e.root.replyTarget === null,
  "and only then is the draft spent",
);

group("(z1) persisted drafts carry the whole composer state");
const draftBlock = src.slice(
  src.indexOf(
    "  // --------------------------------------------------------------- drafts",
  ),
  src.indexOf("  function chatById(mid)"),
);
ok(
  /id: draftFile/.test(draftBlock) && /atomicWrites: true/.test(draftBlock) &&
    /panel-drafts\.json/.test(draftBlock),
  "drafts use the state directory's atomic FileView",
);
ok(
  /function scheduleDraftSave\(\)[\s\S]*?draftSaveTimer\.restart\(\)/.test(
    draftBlock,
  ) &&
    /id: draftSaveTimer[\s\S]*?interval: 500[\s\S]*?onTriggered: root\.saveActiveDraft\(false\)/
      .test(draftBlock) &&
    /Component\.onDestruction:[\s\S]*?draftSaveTimer\.stop\(\)[\s\S]*?root\.saveActiveDraft\(false\)/
      .test(draftBlock),
  "typing is persisted by the 500ms debounce timer — never a synchronous full-store write per keystroke — and teardown flushes the latest composer",
);
{
  let restarted = 0, saved = 0;
  new Function("root", "draftSaveTimer", B.scheduleDraftSave)(
    {
      draftStoreLoaded: true,
      restoringDraft: false,
      activeChat: { mid: "C1" },
      myMid: "M1",
      saveActiveDraft: () => {
        saved++;
      },
    },
    {
      restart: () => {
        restarted++;
      },
    },
  );
  ok(
    restarted === 1 && saved === 0,
    "scheduleDraftSave arms the debounce instead of writing through it",
  );
  new Function("root", "draftSaveTimer", B.scheduleDraftSave)(
    {
      draftStoreLoaded: false,
      restoringDraft: false,
      activeChat: { mid: "C1" },
      myMid: "M1",
      saveActiveDraft: () => {
        saved++;
      },
    },
    {
      restart: () => {
        restarted++;
      },
    },
  );
  ok(
    restarted === 1 && saved === 0,
    "and stays silent while the draft file has not loaded (the staging path owns that)",
  );
}
{
  let written = null;
  const prune = (accounts) => {
    const root = {
      draftStoreLoaded: true,
      draftStore: {},
      draftLastAccount: "M0",
      pendingDraftComposers: { M1: { C: 1 }, M0: { C: 1 } },
      pendingAmbiguousByAccount: { M1: {}, M0: {} },
      pendingDraftAccountClears: { M1: {}, M0: {} },
      writeDraftStore: (next) => {
        written = next;
        return true;
      },
    };
    new Function(
      "root",
      "DraftStore",
      "keepAccount",
      B.pruneDraftAccountsExcept,
    )(
      root,
      { snapshot: () => ({ revision: 9, accounts, lastAccount: "M0" }) },
      "M1",
    );
    return root;
  };
  written = null;
  const r1 = prune({ M1: { C1: { version: 3 } }, M0: { C9: { version: 1 } } });
  ok(
    written && Object.keys(written).join() === "M1" &&
      Object.keys(r1.pendingDraftComposers).join() === "M1" &&
      Object.keys(r1.pendingAmbiguousByAccount).join() === "M1" &&
      Object.keys(r1.pendingDraftAccountClears).join() === "M1",
    "a settled session clears the orphan drafts of the account nobody will log into again",
  );
  written = null;
  prune({ M1: { C1: { version: 3 } } });
  ok(written === null, "no foreign account means no write at all");
}
ok(
  /mentions: Array\.isArray\(root\.mentionPicks\)/.test(draftBlock) &&
    /replyTo: target \?/.test(draftBlock) &&
    /cursor: Number\(replyField\.cursorPosition/.test(draftBlock) &&
    /var allocated = DraftStore\.allocateRevision\(\)/.test(draftBlock) &&
    /version: allocated/.test(draftBlock),
  "text, mentions, quote, cursor and a conflict version are one persisted draft",
);
ok(
  /Number\(saved\.version \|\| 0\) !== Number\(expectedVersion\)/.test(
    draftBlock,
  ) &&
    /root\.saveActiveDraft\(false\)/.test(draftBlock) &&
    B.saveActiveDraft.indexOf("var latest = DraftStore.snapshot()") <
      B.saveActiveDraft.indexOf(
        "var allocated = DraftStore.allocateRevision()",
      ),
  "a late send acknowledgement cannot delete a newer draft",
);
ok(
  /function scheduleDraftSave\(\)[\s\S]*!root\.draftStoreLoaded/.test(
    draftBlock,
  ) &&
    /function restoreDraft\(chat\)[\s\S]*!root\.draftStoreLoaded/.test(
      draftBlock,
    ) &&
    /pendingDraftComposers/.test(draftBlock),
  "composer work is staged until the draft file has loaded",
);
ok(
  /onLoadFailed: function\(error\)/.test(draftBlock) &&
    /error === FileViewError\.FileNotFound/.test(draftBlock) &&
    /draftLoadRetryTimer\.restart\(\)/.test(draftBlock),
  "only a confirmed missing draft file initializes an empty store",
);
const clearDraftBody = new Function(
  "DraftStore",
  "root",
  "replyField",
  "chat",
  "expectedVersion",
  "expectedGeneration",
  "expectedGenerationOwner",
  B.clearDraft,
);
const clearDraft = (
  root,
  replyField,
  chat,
  expectedVersion,
  expectedGeneration,
  expectedGenerationOwner,
) =>
  clearDraftBody(
    {
      snapshot: () => ({
        accounts: root.sharedDraftStore || root.draftStore,
        lastAccount: root.draftLastAccount || "",
      }),
    },
    root,
    replyField,
    chat,
    expectedVersion,
    expectedGeneration,
    expectedGenerationOwner === undefined
      ? root.panelInstanceId
      : expectedGenerationOwner,
  );
const saveDraftBody = new Function(
  "DraftStore",
  "root",
  "replyField",
  "removeEmpty",
  B.saveActiveDraft,
);
function saveDraft(root, replyField, removeEmpty) {
  return saveDraftBody(
    {
      allocateRevision: () => ++root.draftRevision,
      snapshot: () => ({
        revision: root.draftRevision || 0,
        accounts: root.draftStore,
        lastAccount: "ME",
      }),
    },
    root,
    replyField,
    removeEmpty,
  );
}
const emptyDraftRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  restoringDraft: false,
  draftStoreLoaded: true,
  draftStore: {
    ME: { C1: { text: "awaiting acknowledgement", version: 3 } },
  },
  draftRevision: 3,
  replyTarget: null,
  pending: {},
  mentionPicks: [],
  written: 0,
  composerDirtyByChat: { C1: false },
  composerDraftVersionByChat: { C1: 3 },
  pendingDraftSend() {
    return false;
  },
  draftVersionInFlight() {
    return false;
  },
  writeDraftStore(next) {
    this.written++;
    this.draftRevision++;
    this.draftStore = next;
  },
};
saveDraft(emptyDraftRoot, { text: "", cursorPosition: 0 }, false);
ok(
  emptyDraftRoot.written === 0 && emptyDraftRoot.draftStore.ME.C1,
  "an internal empty-composer debounce keeps the persisted sent revision",
);
emptyDraftRoot.composerDirtyByChat.C1 = true;
saveDraft(emptyDraftRoot, { text: "", cursorPosition: 0 }, false);
ok(
  emptyDraftRoot.written === 1 && !emptyDraftRoot.draftStore.ME,
  "a manually emptied composer is removed by the debounce",
);
const exhaustedEraseRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  restoringDraft: false,
  draftStoreLoaded: true,
  draftStoreUnavailable: true,
  draftStore: { ME: { C1: { text: "old", version: 7 } } },
  pendingDraftComposers: {
    ME: {
      C1: { text: "new staged text", generation: 8, baseVersion: 7 },
    },
  },
  draftRevision: 9007199254740991,
  replyTarget: null,
  mentionPicks: [],
  composerDirtyByChat: { C1: true },
  composerDraftVersionByChat: { C1: 0 },
  composerGenerationFor() {
    return 8;
  },
  draftRecoveryHolds: {},
  draftDurabilityPendingByChat: {},
  pending: {},
  pendingDraftSend() {
    return false;
  },
  draftRecoveryHeld() {
    return false;
  },
  writeDraftStore(next) {
    this.draftStore = next;
    return true;
  },
};
saveDraft(exhaustedEraseRoot, { text: "", cursorPosition: 0 }, false);
ok(
  !exhaustedEraseRoot.draftStore.ME &&
    !exhaustedEraseRoot.pendingDraftComposers.ME,
  "erasing an exhausted composer removes its stale recovery copy",
);
const disconnectedDraftRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  restoringDraft: false,
  draftStoreLoaded: true,
  draftStore: { ME: { C1: { text: "sent but unconfirmed", version: 3 } } },
  draftRevision: 3,
  replyTarget: null,
  mentionPicks: [],
  composerDirtyByChat: { C1: true },
  composerDraftVersionByChat: { C1: 3 },
  composerGenerationByChat: { C1: 2 },
  pending: {
    1: { chat: "C1", spendsDraft: true, draftVersion: 3, draftGeneration: 2 },
  },
  draftRecoveryHolds: {},
  imageRequests: {},
  previewRequests: {},
  openWanted: {},
  pendingDraftSend() {
    return Object.keys(this.pending).length > 0;
  },
  composerGenerationFor(chat) {
    return this.composerGenerationByChat[chat];
  },
  draftRecoveryHeld(chat, version, generation, composerGeneration) {
    const hold = this.draftRecoveryHolds[chat];
    if (!hold) return false;
    const sameDraft = Number(version || 0) > 0
      ? hold.version === Number(version)
      : generation === undefined || hold.generation === Number(generation);
    return sameDraft && (composerGeneration === undefined ||
      hold.emptyGeneration === Number(composerGeneration));
  },
  writeDraftStore(next) {
    this.draftStore = next;
  },
};
new Function("root", "tr", B.dropInFlight)(disconnectedDraftRoot, Tzh);
saveDraft(disconnectedDraftRoot, { text: "", cursorPosition: 0 }, false);
ok(
  Object.keys(disconnectedDraftRoot.pending).length === 0 &&
    disconnectedDraftRoot.draftRecoveryHolds.C1.version === 3 &&
    disconnectedDraftRoot.draftStore.ME.C1.text === "sent but unconfirmed",
  "a socket disconnect preserves the recovery copy of an unacknowledged draft",
);
disconnectedDraftRoot.composerGenerationByChat.C1 = 3;
disconnectedDraftRoot.composerDirtyByChat.C1 = true;
saveDraft(disconnectedDraftRoot, { text: "", cursorPosition: 0 }, false);
ok(
  !disconnectedDraftRoot.draftStore.ME,
  "a user edit after disconnect can explicitly delete the restored draft",
);
emptyDraftRoot.composerDirtyByChat.C1 = true;
saveDraft(emptyDraftRoot, { text: "replacement", cursorPosition: 0 }, false);
ok(
  emptyDraftRoot.draftStore.ME.C1.version === 5,
  "deleting and recreating a chat draft cannot reuse its old identity",
);
const draftRoot = {
  myMid: "ME",
  activeChat: { mid: "C1" },
  replyTarget: null,
  mentionPicks: [],
  panelInstanceId: "panel-draft-test",
  composerGeneration: 7,
  composerGenerationByChat: { C1: 7 },
  composerDirtyByChat: { C1: true },
  composerDraftVersionByChat: { C1: 7 },
  draftStore: { ME: { C1: { text: "sent", version: 7 } } },
  saved: 0,
  reset: 0,
  written: null,
  saveActiveDraft() {
    this.saved++;
  },
  pendingDraftSend() {
    return false;
  },
  draftVersionInFlight() {
    return false;
  },
  composerGenerationFor(chat) {
    return Number(this.composerGenerationByChat[String(chat)] || 0);
  },
  resetComposerAfterSuccessfulSend() {
    this.reset++;
  },
  writeDraftStore(next) {
    this.written = next;
    this.draftStore = next;
  },
};
clearDraft(draftRoot, { text: "next" }, "C1", 7);
ok(
  draftRoot.saved === 1 && draftRoot.draftStore.ME.C1.version === 7,
  "typing the next sentence makes a late acknowledgement save it instead of clearing",
);
draftRoot.saved = 0;
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      cursor: 0,
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "sent", cursorPosition: 0 }, "C1", 7, 6);
ok(
  draftRoot.saved === 1 && draftRoot.draftStore.ME.C1.version === 7,
  "an identical next sentence is protected by its newer composer generation",
);
draftRoot.saved = 0;
draftRoot.composerDirtyByChat = { C1: true };
draftRoot.composerGenerationByChat = { C1: 7 };
clearDraft(
  draftRoot,
  { text: "sent", cursorPosition: 0 },
  "C1",
  7,
  7,
  "another-panel",
);
ok(
  draftRoot.saved === 1 && draftRoot.draftStore.ME.C1.version === 7,
  "a matching numeric generation from another panel cannot spend local edits",
);
draftRoot.composerDirtyByChat = {};
draftRoot.saved = 0;
draftRoot.written = null;
draftRoot.composerDirtyByChat.C1 = false;
draftRoot.composerGenerationByChat.C1 = 9;
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      cursor: 0,
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "sent", cursorPosition: 0 }, "C1", 7, 6);
ok(
  draftRoot.written && !draftRoot.written.ME && draftRoot.reset === 1,
  "an unchanged restored revision is spent despite an advanced composer generation",
);
draftRoot.composerDirtyByChat.C1 = true;
draftRoot.composerGenerationByChat.C1 = 7;
draftRoot.reset = 0;
draftRoot.saved = 0;
draftRoot.written = null;
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      cursor: 0,
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "", cursorPosition: 0 }, "C1", 7, 6);
ok(
  draftRoot.written && !draftRoot.written.ME && draftRoot.saved === 0,
  "a newer edit deleted back to empty lets the acknowledgement spend the sent draft",
);
draftRoot.written = null;
draftRoot.activeChat = { mid: "C2" };
draftRoot.draftStore = { ME: { C1: { text: "newer", version: 8 } } };
clearDraft(draftRoot, { text: "" }, "C1", 7);
ok(
  draftRoot.written === null && draftRoot.draftStore.ME.C1.version === 8,
  "a newer version saved after switching chats is preserved",
);
draftRoot.draftStore = { ME: { C1: { text: "sent", version: 7 } } };
clearDraft(draftRoot, { text: "" }, "C1", 7);
ok(
  draftRoot.written && !draftRoot.written.ME,
  "the matching sent revision is cleared after success",
);
draftRoot.written = null;
draftRoot.activeChat = { mid: "C1" };
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "sent" }, "C1", 7);
ok(
  draftRoot.written && !draftRoot.written.ME && draftRoot.reset === 1,
  "an unchanged restored revision leaves both storage and composer after success",
);
draftRoot.written = null;
draftRoot.reset = 0;
draftRoot.composerGeneration = 8;
draftRoot.composerGenerationByChat = { C1: 7, C2: 8 };
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      cursor: 0,
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "sent", cursorPosition: 0 }, "C1", 7, 7);
ok(
  draftRoot.written && !draftRoot.written.ME && draftRoot.reset === 1,
  "typing in another chat does not preserve an acknowledged sent draft",
);
draftRoot.written = null;
draftRoot.reset = 0;
draftRoot.restoringDraft = true;
draftRoot.draftRestoreEpoch = 4;
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      cursor: 4,
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "sent", cursorPosition: 0 }, "C1", 7, 7);
ok(
  draftRoot.written && !draftRoot.written.ME && draftRoot.reset === 1 &&
    draftRoot.restoringDraft === false && draftRoot.draftRestoreEpoch === 5,
  "an acknowledgement can spend a draft before deferred cursor restore runs",
);
draftRoot.written = null;
draftRoot.saved = 0;
draftRoot.draftStore = {
  ME: {
    C1: {
      text: "sent",
      cursor: 1,
      mentions: [],
      replyTo: null,
      version: 7,
    },
  },
};
clearDraft(draftRoot, { text: "sent", cursorPosition: 2 }, "C1", 7);
ok(
  draftRoot.saved === 1 && draftRoot.draftStore.ME.C1.version === 7,
  "moving only the caret preserves the newer composer state",
);
draftRoot.written = null;
draftRoot.activeChat = { mid: "C2" };
draftRoot.draftStore = { ME: { C1: { text: "sent", version: 7 } } };
draftRoot.sharedDraftStore = {
  ME: { C1: { text: "other screen", version: 8 } },
};
clearDraft(draftRoot, { text: "" }, "C1", 7);
ok(
  draftRoot.written === null && draftRoot.draftStore.ME.C1.version === 8,
  "a send acknowledgement cannot erase another screen's newer draft",
);
ok(
  /delete next\[account\]/.test(B.clearSession || src) ||
    /root\.clearDraftAccount\(root\.sessionMid\)/.test(src),
  "logout removes the account's drafts",
);

group("(z1b) pending sends retain the complete draft until success");
e = makeEnv({ activeChat: { mid: "C1" } });
const amyMid = "u" + "1".repeat(32);
e.root.members = [{ mid: amyMid, name: "Amy" }];
e.root.mentionPicks = [{ name: "Amy", mid: amyMid, start: 0 }];
e.root.replyTarget = { id: "m1", fromName: "Amy", text: "old" };
e.submit("@Amy 尚未確認");
const pendingSend = e.sent[0];
ok(
  e.root.draftStore.ME.C1.text === "@Amy 尚未確認" &&
    e.root.draftStore.ME.C1.mentions.length === 1 &&
    e.root.draftStore.ME.C1.replyTo.id === "m1",
  "submit persists text, mention and quote before clearing the composer",
);
e.openChat({ mid: "C2" });
ok(
  e.root.draftStore.ME.C1.text === "@Amy 尚未確認",
  "switching chats does not delete a draft whose send is pending",
);
e.onReply(JSON.stringify({ id: pendingSend.id, ok: false, error: "no" }));
ok(
  e.root.draftStore.ME.C1.text === "@Amy 尚未確認",
  "a stale failure leaves the original chat's persisted draft intact",
);
e.openChat({ mid: "C1" });
ok(
  e.replyField.text === "@Amy 尚未確認" &&
    e.root.mentionPicks.length === 1 &&
    e.root.replyTarget && e.root.replyTarget.id === "m1",
  "returning to the chat restores every composer field for retry",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "@Amy old",
        cursor: 4,
        mentions: [{ name: "Amy", mid: amyMid, start: 0 }],
        replyTo: { id: "m1", fromName: "Amy", text: "quoted" },
        version: 1,
      },
    },
  },
});
e.restoreDraft("C1");
e.flushLater();
e.root.draftStore = { ME: { C1: { text: "another panel", version: 2 } } };
e.submitDisplayed();
let cleanSend = e.sent[0];
ok(
  cleanSend.text === "@Amy old" &&
    e.root.pending[cleanSend.id].draftVersion === 1,
  "an unchanged send spends the revision displayed in this panel",
);
e.onReply(JSON.stringify({ id: cleanSend.id, ok: false, error: "no" }));
e.flushLater();
ok(
  e.replyField.text === "@Amy old" && e.replyField.cursorPosition === 4 &&
    e.root.mentionPicks.length === 1 &&
    e.root.replyTarget && e.root.replyTarget.id === "m1" &&
    e.root.draftStore.ME.C1.text === "another panel",
  "a failed send restores this panel's complete composer without overwriting the shared draft",
);
e.submitDisplayed();
cleanSend = e.sent[1];
e.onReply(JSON.stringify({ id: cleanSend.id, ok: true }));
ok(
  e.root.draftStore.ME.C1.text === "another panel" &&
    e.root.draftStore.ME.C1.version === 2,
  "its acknowledgement preserves a newer draft saved by another panel",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: { ME: { C1: { text: "/file /tmp/a", version: 1 } } },
});
e.restoreDraft("C1");
e.flushLater();
e.root.draftStore = { ME: { C1: { text: "another panel", version: 2 } } };
e.submitDisplayed();
const fileSend = e.sent[0];
e.onReply(JSON.stringify({ id: fileSend.id, ok: false, error: "no" }));
e.flushLater();
ok(
  fileSend.cmd === "sendFile" && e.replyField.text === "/file /tmp/a" &&
    e.root.draftStore.ME.C1.text === "another panel",
  "a failed file send restores this panel's command without overwriting the shared draft",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: { C1: { text: "old", version: 2 } },
    OTHER: { C9: { text: "keep", version: 1 } },
  },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "idle", settled: true },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "old" &&
    e.root.draftStore.OTHER.C9.text === "keep",
  "an idle startup snapshot does not erase drafts before resume is known",
);

e = makeEnv({
  draftStore: {
    ME: { C1: { text: "remove after no-token resume", version: 2 } },
    OTHER: { C9: { text: "keep", version: 1 } },
  },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "current-boot",
  login: { status: "starting", attempt: "resume" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "current-boot",
  login: { status: "idle", settled: true },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME && e.root.draftStore.OTHER.C9.text === "keep" &&
    e.root.sessionMid === "",
  "a current-boot no-token resume clears only the last active account",
);

e = makeEnv({
  draftStore: {
    ME: { C1: { text: "remove after late start", version: 2 } },
    OTHER: { C9: { text: "keep", version: 1 } },
  },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "completed-resume",
  login: { status: "idle", attempt: "resume", settled: true },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME && e.root.draftStore.OTHER.C9.text === "keep" &&
    e.root.sessionMid === "",
  "a fresh panel recognizes a completed no-token resume snapshot",
);

e = makeEnv({
  draftStore: {
    ME: {
      C1: {
        text: "remove after offline logout",
        version: 2,
        ambiguousSends: [{ requestId: "logged-out" }],
      },
    },
    OTHER: { C9: { text: "keep", version: 1 } },
  },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "completed-logout",
  login: { status: "idle", attempt: "logout", settled: true },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME && e.root.draftStore.OTHER.C9.text === "keep",
  "a fresh panel recognizes an explicit logout completed while it was stopped",
);
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "completed-logout",
  login: { status: "ok" },
  me: { mid: "ME" },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME,
  "logging in again cannot restore drafts or markers cleared by offline logout",
);

e = makeEnv({
  draftStore: {
    OTHER: { C9: { text: "keep after manual failure", version: 1 } },
  },
  draftLastAccount: "OTHER",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "manual-boot",
  login: { status: "starting", attempt: "manual" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "manual-boot",
  login: { status: "idle", settled: true },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.OTHER.C9.text === "keep after manual failure",
  "a failed manual login cannot clear the last account's retained drafts",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "keep stale transition", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "old-boot",
  login: { status: "starting", attempt: "resume" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "new-boot",
  login: { status: "idle" },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "keep stale transition",
  "a transient state from another boot cannot authorize draft cleanup",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "keep through resume",
        version: 2,
        ambiguousSends: [{ requestId: "resume-2", spendsDraft: true }],
      },
    },
  },
});
e.root.sessionMid = "ME";
e.root.ambiguousSendsByChat = {
  C1: [{ requestId: "resume-2", spendsDraft: true }],
};
e.root.historyRefreshNeeded = true;
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "starting" },
  chats: [],
  events: [],
}));
ok(
  e.root.sessionMid === "ME" && e.root.activeChat.mid === "C1" &&
    e.root.draftStore.ME.C1.text === "keep through resume" &&
    e.root.ambiguousSendsByChat.C1[0].requestId === "resume-2",
  "a transient daemon restart preserves the session recovery state",
);
ok(
  e.sent.filter((r) => r.cmd === "history").length === 0,
  "socket recovery waits while daemon resume has not published a ready session",
);
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "ok" },
  me: { mid: "ME" },
  chats: [],
  events: [],
}));
ok(
  e.sent.filter((r) => r.cmd === "history").length === 1,
  "the first ready state retries unresolved-send reconciliation",
);

e.onReply(JSON.stringify({ id: e.sent.at(-1).id, ok: true, data: [] }));
const heartbeatHistoryCount = e.sent.filter((r) => r.cmd === "history").length;
const readyHeartbeat = JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "ok" },
  me: { mid: "ME" },
  chats: [],
  events: [],
});
e.parseState(readyHeartbeat);
e.parseState(readyHeartbeat);
ok(
  e.sent.filter((r) => r.cmd === "history").length === heartbeatHistoryCount,
  "unchanged ready heartbeats do not retry unresolved history indefinitely",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: {
    ME: {
      C1: {
        text: "keep through network retry",
        version: 5,
        ambiguousSends: [{ requestId: "network-5", spendsDraft: true }],
      },
    },
  },
  draftLastAccount: "ME",
});
e.root.sessionMid = "ME";
e.root.ambiguousSendsByChat = {
  C1: [{ requestId: "network-5", spendsDraft: true }],
};
e.root.historyRefreshNeeded = true;
e.root.messages = [{
  id: "pending-network",
  text: "keep through network retry",
  pending: true,
  requestId: "network-5",
}];
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "retry-boot",
  login: { status: "starting", attempt: "resume" },
  chats: [],
  events: [],
}));
// logoutClaimed(false, false) may publish cleared account data while its
// teardown is in progress, but its login state remains transient.
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "retry-boot",
  login: { status: "starting", attempt: "resume" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "retry-boot",
  login: {
    status: "error",
    reason: "network",
    attempt: "resume",
    settled: true,
  },
  chats: [],
  events: [],
}));
ok(
  e.root.sessionMid === "ME" && e.root.activeChat.mid === "C1" &&
    e.root.draftStore.ME.C1.text === "keep through network retry" &&
    e.root.ambiguousSendsByChat.C1[0].requestId === "network-5" &&
    e.root.messages[0].requestId === "network-5",
  "the retryable resume teardown sequence preserves drafts, tokens, and bubbles",
);
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "retry-boot",
  login: { status: "ok" },
  me: { mid: "ME" },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "keep through network retry" &&
    e.root.messages[0].requestId === "network-5",
  "a successful retry retains recovery state until reconciliation completes",
);

e = makeEnv({
  activeChat: { mid: "C1" },
  draftStore: { ME: { C1: { text: "departed manual session", version: 7 } } },
  draftLastAccount: "ME",
});
e.root.sessionMid = "ME";
e.root.sessionEstablished = true;
e.root.messages = [{ id: "old-session", text: "clear me" }];
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "manual-terminal",
  login: {
    status: "error",
    reason: "network",
    attempt: "manual",
    settled: true,
  },
  chats: [],
  events: [],
}));
ok(
  e.root.sessionMid === "" && e.root.activeChat === null &&
    e.root.messages.length === 0 && !e.root.draftStore.ME,
  "a settled manual-login network failure clears the departed session",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "resume me", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  bootId: "legacy",
  updatedAt: Date.now(),
  login: { status: "ok" },
  me: { mid: "ME" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  bootId: "legacy",
  updatedAt: Date.now(),
  login: { status: "idle" },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME && e.root.sessionMid === "",
  "a legacy daemon idle remains a final logout state",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "resume me", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "idle", settled: false },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "resume me" &&
    e.root.initialIdleDraftHandled === false,
  "a modern retryable boot idle keeps drafts until resume has settled",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "remove expired", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "error", reason: "token_expired", settled: true },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME && e.root.initialIdleDraftHandled === true,
  "a fresh panel clears drafts after terminal resume teardown",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "legacy expired", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "error", reason: "token_expired" },
  chats: [],
  events: [],
}));
ok(
  !e.root.draftStore.ME && e.root.initialIdleDraftHandled === true,
  "a legacy terminal token error clears the expired account's drafts",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "legacy retry", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "error", reason: "network" },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "legacy retry",
  "a legacy retryable network error still preserves drafts",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "keep retryable", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "error", reason: "network", settled: false },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "keep retryable" &&
    e.root.initialIdleDraftHandled === false,
  "a fresh panel preserves drafts after retryable resume failure",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "keep unreadable", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "error", reason: "unknown", settled: false },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "keep unreadable" &&
    e.root.initialIdleDraftHandled === false,
  "an unreadable auth store preserves drafts for recovery",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "retry after QR failure", version: 2 } } },
  draftLastAccount: "ME",
});
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  login: { status: "error", reason: "network", settled: false },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "retry after QR failure" &&
    e.root.initialIdleDraftHandled === false,
  "a pre-authentication QR failure keeps the resumable account draft",
);

e = makeEnv({
  draftStore: { ME: { C1: { text: "survive restart", version: 2 } } },
  draftLastAccount: "ME",
});
e.root.sessionMid = "ME";
e.root.sessionEstablished = true;
e.root.sessionBootId = "old-boot";
e.root.chatBootSeen = "old-boot";
const restartEpoch = e.root.sessionEpoch;
e.parseState(JSON.stringify({
  bootId: "new-boot",
  updatedAt: Date.now(),
  login: { status: "idle" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  bootId: "new-boot",
  updatedAt: Date.now(),
  login: { status: "idle" },
  chats: [],
  events: [],
}));
e.parseState(JSON.stringify({
  bootId: "new-boot",
  updatedAt: Date.now(),
  login: { status: "ok" },
  me: { mid: "ME" },
  chats: [],
  events: [],
}));
ok(
  e.root.draftStore.ME.C1.text === "survive restart" &&
    e.root.sessionEpoch === restartEpoch && e.root.sessionBootId === "new-boot",
  "repeated legacy boot idle cannot erase a session that later resumes",
);

e = makeEnv({
  draftStore: {
    ME: { C1: { text: "remove", version: 2 } },
    OTHER: { C9: { text: "keep", version: 1 } },
  },
  draftLastAccount: "OTHER",
});
e.root.sessionMid = "ME";
const repeatedLogout = JSON.stringify({
  updatedAt: Date.now(),
  bootId: "same-logout",
  login: { status: "idle", attempt: "logout", settled: true },
  chats: [],
  events: [],
});
e.parseState(repeatedLogout);
e.parseState(repeatedLogout);
ok(
  !e.root.draftStore.ME && e.root.draftStore.OTHER.C9.text === "keep",
  "repeated logout heartbeats do not clear another account named by the old hint",
);

const lateDraftRoot = {
  loginStatus: "idle",
  pendingDraftAccountClears: { ME: true, OLD: true },
  pendingDraftComposers: {
    NEW: {
      C3: {
        text: "typed before load",
        cursor: 4,
        mentions: [],
        replyTo: null,
        generation: 7,
      },
    },
  },
  pendingAmbiguousByAccount: {
    ME: {
      byChat: { C1: [{ requestId: "new-session" }] },
      changedChats: { C1: true },
    },
  },
  accountsWithAmbiguous(accounts, account, byChat) {
    const next = Object.assign({}, accounts);
    const chats = Object.assign({}, next[account] || {});
    for (const chat in byChat) chats[chat] = { ambiguousSends: byChat[chat] };
    next[account] = chats;
    return next;
  },
  pending: {
    1: { spendsDraft: true, chat: "C3", draftVersion: 0, draftGeneration: 7 },
  },
  composerEditedBeforeDraftLoad: false,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
};
let lateDraftWrite = "";
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  lateDraftRoot,
  {
    allocateRevision: () => 1,
    load: () => ({
      accounts: {
        ME: { C1: { text: "logged out" } },
        OLD: { C2: { text: "also logged out" } },
        OTHER: { C9: { text: "keep" } },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  {
    save: (_path, text) => {
      lateDraftWrite = text;
    },
  },
  { path: "/tmp/panel-drafts.json" },
  "ignored",
);
ok(
  lateDraftRoot.draftStore.ME.C1.text === undefined &&
    lateDraftRoot.draftStore.ME.C1.ambiguousSends[0].requestId ===
      "new-session" &&
    !lateDraftRoot.draftStore.OLD &&
    lateDraftRoot.draftStore.OTHER.C9.text === "keep" &&
    lateDraftRoot.draftStore.NEW.C3.text === "typed before load" &&
    lateDraftRoot.draftStore.NEW.C3.version === 1 &&
    lateDraftRoot.draftStore.NEW.C3.generation === undefined &&
    lateDraftRoot.pending[1].draftVersion === 1 &&
    Object.keys(lateDraftRoot.pendingDraftAccountClears).length === 0 &&
    lateDraftWrite === "cleaned",
  "delayed logout removes old drafts but keeps markers from a later same-account login",
);

e = makeEnv();
e.root.draftStoreLoaded = false;
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "completed-before-drafts",
  login: { status: "idle", attempt: "resume", settled: true },
  chats: [],
  events: [],
}));
const noTokenBeforeDraftLoad = e.root;
ok(
  noTokenBeforeDraftLoad.clearLastDraftOnLoad === true,
  "a completed resume snapshot defers cleanup until the draft file loads",
);
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  noTokenBeforeDraftLoad,
  {
    load: () => ({
      accounts: {
        ME: { C1: { text: "remove after delayed load" } },
        OTHER: { C9: { text: "keep" } },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({ version: 1, revision: 1, lastAccount: "ME", accounts: {} }),
);
ok(
  !noTokenBeforeDraftLoad.draftStore.ME &&
    noTokenBeforeDraftLoad.draftStore.OTHER.C9.text === "keep" &&
    noTokenBeforeDraftLoad.clearLastDraftOnLoad === false,
  "no-token cleanup waits for a delayed draft file and removes its last account",
);

e = makeEnv();
e.root.draftStoreLoaded = false;
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "failed-draft-read-before-cleanup",
  login: { status: "idle", attempt: "resume", settled: true },
  chats: [],
  events: [],
}));
const failedDraftLoadRoot = e.root;
const failedDraftLoadStore = {
  load: () => ({
    accounts: { OLD: { C1: { text: "remove after retry" } } },
    lastAccount: "OLD",
  }),
  merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
  serialize: () => "cleaned",
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  failedDraftLoadRoot,
  failedDraftLoadStore,
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  "",
);
ok(
  failedDraftLoadRoot.clearLastDraftOnLoad === true &&
    failedDraftLoadRoot.draftStore.OLD.C1.text === "remove after retry",
  "a failed draft read retains the deferred account cleanup obligation",
);
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  failedDraftLoadRoot,
  failedDraftLoadStore,
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({
    version: 1,
    revision: 2,
    lastAccount: "OLD",
    accounts: { OLD: { C1: { text: "remove after retry" } } },
  }),
);
ok(
  !failedDraftLoadRoot.draftStore.OLD &&
    failedDraftLoadRoot.clearLastDraftOnLoad === false,
  "the next valid draft snapshot completes cleanup after a read failure",
);

e = makeEnv();
e.root.draftStoreLoaded = false;
e.root.clearLastDraftOnLoad = true;
const endedFile = JSON.stringify({
  version: 1,
  revision: 1,
  lastAccount: "OLD",
  accounts: { OLD: { C1: { text: "ended" } } },
});
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  e.root,
  {
    load: () => ({
      accounts: {
        OLD: { C1: { text: "ended" } },
        NEW: {
          C2: { text: "new login", ambiguousSends: [{ requestId: "new" }] },
        },
      },
      lastAccount: "NEW",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  endedFile,
);
ok(
  !e.root.draftStore.OLD &&
    e.root.draftStore.NEW.C2.text === "new login" &&
    e.root.draftStore.NEW.C2.ambiguousSends[0].requestId === "new",
  "delayed cleanup uses the ended file account instead of a newer shared lastAccount",
);

e = makeEnv();
e.root.draftStoreLoaded = false;
e.parseState(JSON.stringify({
  updatedAt: Date.now(),
  bootId: "logout-before-drafts",
  login: { status: "idle", attempt: "logout", settled: true },
  chats: [],
  events: [],
}));
const logoutBeforeDraftLoad = e.root;
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  logoutBeforeDraftLoad,
  {
    load: () => ({
      accounts: {
        ME: {
          C1: {
            text: "remove after offline logout",
            ambiguousSends: [{ requestId: "logged-out" }],
          },
        },
        OTHER: { C9: { text: "keep" } },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({ version: 1, revision: 1, lastAccount: "ME", accounts: {} }),
);
ok(
  !logoutBeforeDraftLoad.draftStore.ME &&
    logoutBeforeDraftLoad.draftStore.OTHER.C9.text === "keep",
  "offline logout cleanup waits for the draft file and clears only its last account",
);

const stagedRemovalRoot = {
  loginStatus: "ok",
  pendingDraftAccountClears: {},
  pendingDraftComposers: { ME: { C1: { remove: true } } },
  pendingAmbiguousByAccount: {},
  composerEditedBeforeDraftLoad: false,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
  myMid: "",
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  stagedRemovalRoot,
  {
    load: () => ({
      accounts: {
        ME: {
          C1: {
            text: "already submitted",
            version: 2,
            ambiguousSends: [{ requestId: "await-history" }],
          },
        },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({ version: 1, lastAccount: "ME", accounts: {} }),
);
ok(
  stagedRemovalRoot.draftStore.ME.C1.text === undefined &&
    stagedRemovalRoot.draftStore.ME.C1.ambiguousSends[0].requestId ===
      "await-history",
  "a staged empty composer preserves unresolved-send correlation from the loaded file",
);

const stagedComposerRoot = {
  loginStatus: "ok",
  pendingDraftAccountClears: {},
  pendingDraftComposers: {
    ME: {
      C1: {
        text: "new sentence",
        cursor: 12,
        mentions: [],
        replyTo: null,
        generation: 4,
      },
    },
  },
  pendingAmbiguousByAccount: {},
  pending: {},
  deferredDraftRequests: [],
  composerEditedBeforeDraftLoad: false,
  activeChat: null,
  settledIdleBeforeDraftLoad: false,
  initialIdleDraftHandled: false,
  settledIdleDraftAccount: "",
  settledIdleDraftRevision: 0,
  settledIdleDraftAt: 0,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
  myMid: "ME",
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  stagedComposerRoot,
  {
    allocateRevision: () => 3,
    load: () => ({
      accounts: {
        ME: {
          C1: {
            text: "submitted",
            version: 2,
            ambiguousSends: [{ requestId: "await-history" }],
          },
        },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "merged",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  "ignored",
);
ok(
  stagedComposerRoot.draftStore.ME.C1.text === "new sentence" &&
    stagedComposerRoot.draftStore.ME.C1.version === 3 &&
    stagedComposerRoot.draftStore.ME.C1.ambiguousSends[0].requestId ===
      "await-history",
  "a staged composer preserves unresolved-send correlation from the loaded file",
);

const observedIdleRoot = {
  loginStatus: "starting",
  sessionEstablished: false,
  initialIdleDraftHandled: false,
  settledIdleBeforeDraftLoad: true,
  settledIdleDraftAccount: "",
  pendingDraftAccountClears: {},
  pendingDraftComposers: {},
  pendingAmbiguousByAccount: {},
  composerEditedBeforeDraftLoad: false,
  activeChat: null,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  observedIdleRoot,
  {
    load: () => ({
      accounts: {
        ME: { C1: { text: "logged out" } },
        NEW: { C2: { text: "new panel" } },
      },
      lastAccount: "NEW",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({ version: 1, lastAccount: "ME", accounts: {} }),
);
ok(
  !observedIdleRoot.draftStore.ME &&
    observedIdleRoot.draftStore.NEW.C2.text === "new panel" &&
    observedIdleRoot.initialIdleDraftHandled &&
    observedIdleRoot.settledIdleBeforeDraftLoad === false,
  "pre-load logout removes the disk account without deleting a newer panel's account",
);

const stagedLogoutRoot = {
  draftStoreLoaded: false,
  pendingDraftAccountClears: {},
  pendingDraftComposers: {
    ME: { C1: { text: "must disappear" } },
    OTHER: { C2: { text: "keep" } },
  },
  pendingAmbiguousByAccount: {
    ME: { byChat: { C1: [{ requestId: "must disappear" }] } },
    OTHER: { byChat: { C2: [{ requestId: "keep" }] } },
  },
};
new Function("root", "DraftStore", "account", B.clearDraftAccount)(
  stagedLogoutRoot,
  { snapshot: () => ({ revision: 4 }) },
  "ME",
);
ok(
  !stagedLogoutRoot.pendingDraftComposers.ME &&
    stagedLogoutRoot.pendingDraftComposers.OTHER.C2.text === "keep" &&
    !stagedLogoutRoot.pendingAmbiguousByAccount.ME &&
    stagedLogoutRoot.pendingAmbiguousByAccount.OTHER.byChat.C2[0].requestId ===
      "keep" &&
    stagedLogoutRoot.pendingDraftAccountClears.ME.revision === 4 &&
    stagedLogoutRoot.pendingDraftAccountClears.ME.at > 0,
  "logout removes the account's staged pre-load edits as well as its loaded snapshot",
);

const legacyLogoutRoot = {
  loginStatus: "idle",
  sessionEstablished: true,
  initialIdleDraftHandled: false,
  settledIdleBeforeDraftLoad: false,
  pendingDraftAccountClears: { ME: { revision: 0, at: 1000 } },
  pendingDraftComposers: {},
  composerEditedBeforeDraftLoad: false,
  activeChat: null,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  legacyLogoutRoot,
  {
    load: () => ({
      accounts: { ME: { OLD: { text: "legacy", version: 7 } } },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({
    version: 1,
    accounts: {
      ME: { OLD: { text: "legacy", version: 7 } },
    },
  }),
);
ok(
  !legacyLogoutRoot.draftStore.ME,
  "an unknown logout boundary normalizes legacy draft versions before cleanup",
);

const unknownBoundaryRoot = {
  loginStatus: "starting",
  sessionEstablished: false,
  initialIdleDraftHandled: false,
  settledIdleBeforeDraftLoad: false,
  pendingDraftAccountClears: { ME: { revision: 0, at: 1000 } },
  pendingDraftComposers: {},
  composerEditedBeforeDraftLoad: false,
  activeChat: null,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  unknownBoundaryRoot,
  {
    load: () => ({
      accounts: {
        ME: {
          OLD: { text: "legacy", version: 7 },
          NEW: { text: "new session", version: 8, updatedAt: 2000 },
        },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({
    version: 1,
    revision: 8,
    accounts: {
      ME: {
        OLD: { text: "legacy", version: 7 },
        NEW: { text: "new session", version: 8, updatedAt: 2000 },
      },
    },
  }),
);
ok(
  !unknownBoundaryRoot.draftStore.ME.OLD &&
    unknownBoundaryRoot.draftStore.ME.NEW.text === "new session",
  "an unknown boundary uses draft timestamps to retain post-logout edits",
);

const sameAccountDraftRoot = {
  loginStatus: "starting",
  sessionEstablished: false,
  initialIdleDraftHandled: false,
  settledIdleBeforeDraftLoad: false,
  pendingDraftAccountClears: { ME: 5 },
  pendingDraftComposers: {},
  composerEditedBeforeDraftLoad: false,
  activeChat: null,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  sameAccountDraftRoot,
  {
    load: () => ({
      accounts: {
        ME: {
          OLD: { text: "logged out", version: 5 },
          NEW: { text: "new panel", version: 7 },
        },
      },
      lastAccount: "ME",
    }),
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "cleaned",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  JSON.stringify({ version: 1, revision: 8, lastAccount: "ME", accounts: {} }),
);
ok(
  !sameAccountDraftRoot.draftStore.ME.OLD &&
    sameAccountDraftRoot.draftStore.ME.NEW.text === "new panel",
  "a deferred logout keeps newer same-account drafts from another panel",
);

const deferredCases = [
  { cmd: "send", extra: { chat: "C1", text: "plain" }, msgId: "pending-1" },
  {
    cmd: "reply",
    extra: { chat: "C1", text: "quoted", replyTo: "m1" },
    msgId: "pending-1",
  },
  {
    cmd: "sendFile",
    extra: { chat: "C1", path: "/tmp/a", _spendsDraft: true },
    msgId: "",
  },
];
for (const deferredCase of deferredCases) {
  e = makeEnv({ activeChat: { mid: "C1" } });
  e.root.draftStoreLoaded = false;
  e.root.composerGenerationByChat.C1 = 4;
  const accepted = e.request(
    deferredCase.cmd,
    deferredCase.extra,
    deferredCase.msgId,
  );
  const queuedItem = e.root.deferredDraftRequests[0];
  ok(
    accepted === true && e.sent.length === 0 &&
      e.root.deferredDraftRequests.length === 1 && e.root.nextId === 2,
    deferredCase.cmd + " queues once and reserves its request/message id",
  );
  e.root.draftStore = { ME: { C1: { text: "plain", version: 7 } } };
  e.root.composerDraftVersionByChat.C1 = 7;
  queuedItem.extra._draftVersion = 7;
  e.root.draftStoreLoaded = true;
  e.flushDeferredDraftActions();
  e.flushDeferredDraftActions();
  ok(
    e.sent.length === 1 && e.sent[0].cmd === deferredCase.cmd &&
      e.root.pending[1].draftVersion === 7,
    deferredCase.cmd +
      " dispatches exactly once with the merged draft revision",
  );
}
e.root.deferredDraftPickers = [{
  session: e.root.sessionEpoch,
  account: e.root.myMid,
  chat: "C1",
  generation: 4,
}];
e.flushDeferredDraftActions();
ok(
  e.root.picked === 1 && e.root.pickedRequests[0].chat === "C1" &&
    e.root.deferredDraftPickers.length === 0,
  "a picker-backed /file action opens exactly once after draft loading",
);

const emptyDraftFile = JSON.stringify({
  version: 1,
  revision: 0,
  lastAccount: "",
  accounts: {},
});
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.submit("A");
e.submit("B");
ok(
  e.root.deferredDraftRequests.length === 1 && e.replyField.text === "B" &&
    e.root.messages.length === 1 && e.root.messages[0].text === "A" &&
    e.root.pendingDraftComposers.ME.C1.text === "A",
  "a guarded second submission cannot replace the first deferred recovery draft",
);
const queuedComposer = JSON.stringify(
  e.root.deferredDraftRequests[0].extra._displayedComposer,
);
const nextReplyTarget = {
  id: "m-next",
  from: "THEM",
  fromName: "Alice",
  text: "next target",
};
e.startReply(nextReplyTarget);
ok(
  e.replyField.text === "B" && e.root.replyTarget.id === "m-next" &&
    JSON.stringify(e.root.deferredDraftRequests[0].extra._displayedComposer) ===
      queuedComposer,
  "an earlier deferred send does not lock the next composer or mutate its snapshot",
);
const replyEditorBlock = src.slice(
  src.indexOf("            TextArea.flickable: TextArea {"),
  src.indexOf(
    "              placeholderText:",
    src.indexOf("            TextArea.flickable: TextArea {"),
  ),
);
ok(
  !/readOnly:/.test(replyEditorBlock) &&
    !/deferredDraftSend/.test(B.startReply) &&
    /function submit\(\)[\s\S]*root\.deferredDraftSend\(root\.activeChat\.mid\)/
      .test(src),
  "only another submission is serialized while the earlier composer waits for loading",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.submit("A");
const deferredTextId = e.root.messages[0].id;
const followingStickerId = e.root.appendPendingSticker(
  "https://stickers.example/1.png",
);
e.request(
  "sendSticker",
  { chat: "C1", packageId: "1", stickerId: "1" },
  followingStickerId,
);
e.onReply(JSON.stringify({ id: 2, ok: false, error: "sticker failed" }));
ok(
  deferredTextId !== followingStickerId &&
    deferredTextId.indexOf("pending-") === 0 &&
    followingStickerId.indexOf("pending-") === 0 &&
    e.root.messages.length === 1 && e.root.messages[0].id === deferredTextId,
  "a sticker following deferred text gets a distinct id and its failure drops only itself",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.submit("A");
ok(
  e.replyField.text === "" && e.sent.length === 0 &&
    e.root.pendingDraftComposers.ME &&
    e.root.pendingDraftComposers.ME.C1.text === "A",
  "submitting before FileView answers clears A while retaining its deferred action",
);
e.loadDraftStore(emptyDraftFile);
ok(
  e.sent.length === 1 && e.replyField.text === "" &&
    e.root.draftStore.ME && e.root.draftStore.ME.C1 &&
    e.root.draftStore.ME.C1.text === "A",
  "loading sends A once without restoring submitted text into the composer",
);
e.onReply(JSON.stringify({ id: 1, ok: false, error: "rejected" }));
ok(
  e.replyField.text === "A" && e.root.draftStore.ME.C1.text === "A",
  "a daemon rejection restores the deferred composer's complete recovery draft",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.submit("A");
e.replyField.text = "B";
e.root.noteComposerEdit();
e.replyField.text = "";
e.root.noteComposerEdit();
e.sock.connected = false;
e.loadDraftStore(emptyDraftFile);
ok(
  e.sent.length === 0 && e.replyField.text === "" &&
    e.root.draftStore.ME.C1.text === "A" &&
    e.root.deferredDraftRequests.length === 1,
  "typing and erasing B cannot delete A when deferred dispatch finds the socket down",
);
e.root.saveActiveDraft(true);
ok(
  e.root.draftStore.ME.C1.text === "A",
  "the failed deferred dispatch protects A from the next chat-switch save",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.root.composerGenerationByChat.C1 = 1;
e.replyField.text = "A";
e.request("send", { chat: "C1", text: "A" }, "pending-A");
e.replyField.text = "B";
e.root.composerGenerationByChat.C1 = 2;
e.root.draftStore = { ME: { C1: { text: "B", cursor: 1, version: 8 } } };
e.root.composerDraftVersionByChat.C1 = 8;
e.root.draftStoreLoaded = true;
e.flushDeferredDraftActions();
let deferredEntry = e.root.pending[1];
clearDraft(
  e.root,
  e.replyField,
  "C1",
  deferredEntry.draftVersion,
  deferredEntry.draftGeneration,
);
ok(
  deferredEntry.draftVersion === 0 && deferredEntry.draftGeneration === 1 &&
    deferredEntry.displayedComposer.text === "A" &&
    e.replyField.text === "B" && e.root.draftStore.ME.C1.text === "B",
  "a queued send keeps A's ownership and cannot spend B typed before draft loading finishes",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.root.composerGenerationByChat.C1 = 1;
e.replyField.text = "A";
e.request("send", { chat: "C1", text: "A" }, "pending-A");
e.replyField.text = "B";
e.root.composerGenerationByChat.C1 = 2;
e.root.pendingDraftComposers = { ME: { C1: { text: "B", generation: 2 } } };
e.root.draftStoreUnavailable = true;
e.flushDeferredDraftActions();
deferredEntry = e.root.pending[1];
clearDraft(
  e.root,
  e.replyField,
  "C1",
  deferredEntry.draftVersion,
  deferredEntry.draftGeneration,
);
ok(
  e.root.pendingDraftComposers.ME.C1.text === "B" && e.replyField.text === "B",
  "terminal draft-load failure also keeps newer text outside the queued send's ownership",
);

e = makeEnv({ activeChat: { mid: "C1" } });
e.root.draftStoreLoaded = false;
e.root.draftStoreUnavailable = true;
ok(
  e.request(
        "send",
        { chat: "C1", text: "recover without overwrite" },
        "pending",
      ) === true &&
    e.sent.length === 1,
  "terminal draft read failure allows sending without overwriting the file",
);
const unavailablePendingRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  restoringDraft: false,
  draftStoreLoaded: false,
  draftStoreUnavailable: true,
  pendingDraftComposers: {
    ME: {
      C1: {
        text: "sent text",
        cursor: 4,
        mentions: [{ start: 0, end: 1 }],
        replyTo: { id: "m1" },
        generation: 3,
      },
    },
  },
  composerEditedBeforeDraftLoad: true,
  composerGeneration: 4,
  composerGenerationFor() {
    return 4;
  },
  pendingDraftSend() {
    return true;
  },
  replyTarget: null,
  mentionPicks: [],
};
saveDraft(unavailablePendingRoot, { text: "", cursorPosition: 0 }, false);
ok(
  unavailablePendingRoot.pendingDraftComposers.ME.C1.text === "sent text" &&
    unavailablePendingRoot.pendingDraftComposers.ME.C1.mentions.length === 1 &&
    unavailablePendingRoot.pendingDraftComposers.ME.C1.replyTo.id === "m1" &&
    unavailablePendingRoot.pendingDraftComposers.ME.C1
        .emptyComposerGeneration === 4,
  "an in-flight staged draft survives an empty composer and chat switch",
);
const recoveredEmptyRoot = {
  myMid: "ME",
  activeChat: { mid: "C1" },
  draftStoreLoaded: false,
  draftStoreUnavailable: true,
  draftLoadRetryAttempt: 5,
  pendingDraftAccountClears: {},
  settledIdleBeforeDraftLoad: false,
  initialIdleDraftHandled: false,
  composerEditedBeforeDraftLoad: false,
  pendingDraftComposers: {
    ME: {
      C1: {
        text: "sent text",
        cursor: 4,
        mentions: [{ start: 0, end: 1 }],
        replyTo: { id: "m1" },
        generation: 3,
        emptyComposerGeneration: 4,
      },
    },
  },
  pending: {
    1: { chat: "C1", spendsDraft: true, draftVersion: 0, draftGeneration: 3 },
  },
  composerGenerationByChat: { C1: 4 },
  composerGenerationFor(chat) {
    return this.composerGenerationByChat[chat];
  },
  composerDraftVersionByChat: { C1: 0 },
  composerDirtyByChat: { C1: true },
  mentionPicks: [],
  replyTarget: null,
  restored: 0,
  saved: 0,
  restoreDraft() {
    this.restored++;
  },
  saveActiveDraft() {
    this.saved++;
  },
  draftStore: {},
  draftLastAccount: "",
};
const recoveredEmptyReply = { text: "", cursorPosition: 0 };
let recoveredRevision = 0;
new Function(
  "root",
  "replyField",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  recoveredEmptyRoot,
  recoveredEmptyReply,
  {
    load: () => ({ accounts: {}, lastAccount: "" }),
    allocateRevision: () => ++recoveredRevision,
    merge: (_before, next, last) => ({ accounts: next, lastAccount: last }),
    serialize: () => "saved",
  },
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  "ignored",
);
ok(
  recoveredEmptyReply.text === "" && recoveredEmptyRoot.restored === 0 &&
    recoveredEmptyRoot.saved === 0 &&
    recoveredEmptyRoot.draftStore.ME.C1.text === "sent text" &&
    recoveredEmptyRoot.draftStore.ME.C1.emptyComposerGeneration === undefined &&
    recoveredEmptyRoot.pending[1].draftVersion === 1 &&
    recoveredEmptyRoot.composerDraftVersionByChat.C1 === 1 &&
    recoveredEmptyRoot.composerDirtyByChat.C1 === false,
  "storage recovery keeps the current empty composer while versioning its in-flight draft",
);
ok(
  /draftStoreUnavailable = true/.test(draftBlock) &&
    /tr\("draft\.(unreadable|verCap)"\)/.test(draftBlock) &&
    /!root\.draftStoreUnavailable/.test(B.request),
  "exhausted draft retries become an explicit recoverable state",
);
const unavailableDraftRoot = {
  myMid: "ME",
  draftStoreLoaded: false,
  pendingDraftComposers: {
    ME: { C1: { text: "newer edit", generation: 2 } },
  },
};
clearDraft(unavailableDraftRoot, { text: "", cursorPosition: 0 }, "C1", 0, 1);
ok(
  unavailableDraftRoot.pendingDraftComposers.ME.C1.text === "newer edit",
  "an old acknowledgement cannot spend a newer staged draft",
);
const stagedRestoreRoot = {
  myMid: "ME",
  draftStoreLoaded: false,
  draftStoreUnavailable: true,
  activeChat: { mid: "C1" },
  pendingDraftComposers: {
    ME: {
      C1: {
        text: "retry me",
        cursor: 3,
        mentions: [{ start: 0, end: 1 }],
        replyTo: { id: "m1", fromName: "A", text: "quoted" },
        generation: 4,
      },
    },
  },
  draftRestoreEpoch: 0,
  restoringDraft: false,
  mentionPicks: [],
  replyTarget: null,
  composerDirtyByChat: {},
  composerDraftVersionByChat: {},
  composerGenerationByChat: {},
  composerGeneration: 1,
  composerGenerationFor(chat) {
    return Number(this.composerGenerationByChat[String(chat)] || 0);
  },
  resetComposerAfterSuccessfulSend() {
    stagedReplyField.text = "";
    this.mentionPicks = [];
    this.replyTarget = null;
  },
};
const stagedReplyField = { text: "", cursorPosition: 0, length: 8 };
new Function("root", "replyField", "chat", "Qt", B.restoreDraft)(
  stagedRestoreRoot,
  stagedReplyField,
  "C1",
  {
    callLater(fn) {
      fn();
    },
  },
);
ok(
  stagedReplyField.text === "retry me" &&
    stagedReplyField.cursorPosition === 3 &&
    stagedRestoreRoot.mentionPicks.length === 1 &&
    stagedRestoreRoot.replyTarget.id === "m1" &&
    stagedRestoreRoot.composerGenerationByChat.C1 === 4,
  "unavailable storage still restores the complete staged composer",
);
const exhaustedRestoreRoot = {
  myMid: "ME",
  draftStoreLoaded: true,
  draftStoreUnavailable: true,
  activeChat: { mid: "C1" },
  draftStore: { ME: { C1: { text: "old disk text", version: 7 } } },
  pendingDraftComposers: {
    ME: {
      C1: {
        text: "new existing",
        cursor: 4,
        mentions: [{ start: 0, end: 3 }],
        replyTo: { id: "m7", fromName: "B", text: "quote" },
        generation: 8,
      },
      C2: {
        text: "brand new",
        cursor: 9,
        mentions: [],
        replyTo: null,
        generation: 9,
      },
    },
  },
  draftRestoreEpoch: 0,
  restoringDraft: false,
  mentionPicks: [],
  replyTarget: null,
  composerDirtyByChat: {},
  composerDraftVersionByChat: {},
  composerGenerationByChat: {},
  composerGeneration: 1,
};
const exhaustedReplyField = { text: "", cursorPosition: 0, length: 20 };
const runRestoreDraft = new Function(
  "root",
  "replyField",
  "chat",
  "Qt",
  B.restoreDraft,
);
runRestoreDraft(exhaustedRestoreRoot, exhaustedReplyField, "C1", {
  callLater(fn) {
    fn();
  },
});
const restoredExisting = exhaustedReplyField.text === "new existing" &&
  exhaustedReplyField.cursorPosition === 4 &&
  exhaustedRestoreRoot.mentionPicks.length === 1 &&
  exhaustedRestoreRoot.replyTarget.id === "m7";
runRestoreDraft(exhaustedRestoreRoot, exhaustedReplyField, "C2", {
  callLater(fn) {
    fn();
  },
});
ok(
  restoredExisting && exhaustedReplyField.text === "brand new" &&
    exhaustedReplyField.cursorPosition === 9 &&
    exhaustedRestoreRoot.composerDraftVersionByChat.C1 === 0 &&
    exhaustedRestoreRoot.composerDraftVersionByChat.C2 === 0,
  "revision exhaustion restores staged edits for existing and new chats",
);
clearDraft(stagedRestoreRoot, stagedReplyField, "C1", 0, 4);
ok(
  stagedReplyField.text === "" &&
    stagedRestoreRoot.pendingDraftComposers.ME.C1.remove === true &&
    stagedRestoreRoot.pendingDraftComposers.ME.C1.acknowledged === true &&
    stagedRestoreRoot.pendingDraftComposers.ME.C1.generation === 4,
  "acknowledging a staged draft clears its composer and retains a removal marker",
);
const exhaustedAckRoot = {
  myMid: "ME",
  draftStoreLoaded: true,
  draftStoreUnavailable: true,
  draftStore: { ME: { C1: { text: "old disk text", version: 7 } } },
  pendingDraftComposers: {
    ME: {
      C1: { text: "sent staged", generation: 8, baseVersion: 7 },
    },
  },
  draftLastAccount: "ME",
  draftRecoveryHolds: {},
  activeChat: { mid: "C1" },
  composerGenerationFor() {
    return 8;
  },
  composerDirtyByChat: { C1: true },
  composerDraftVersionByChat: { C1: 0 },
  draftRestoreEpoch: 0,
  restoringDraft: false,
  mentionPicks: [],
  replyTarget: null,
  draftRecoveryHeld() {
    return false;
  },
  resetComposerAfterSuccessfulSend() {
    exhaustedAckReply.text = "";
  },
  writeDraftStore(next) {
    this.draftStore = next;
    return true;
  },
};
const exhaustedAckReply = { text: "sent staged", cursorPosition: 11 };
clearDraft(exhaustedAckRoot, exhaustedAckReply, "C1", 0, 8);
ok(
  !exhaustedAckRoot.pendingDraftComposers.ME &&
    !exhaustedAckRoot.draftStore.ME &&
    exhaustedAckReply.text === "" &&
    exhaustedAckRoot.composerDraftVersionByChat.C1 === 0,
  "an exhausted staged acknowledgement spends both recovery and old disk draft",
);
const foreignAckRoot = {
  myMid: "ME",
  draftStoreLoaded: true,
  draftStoreUnavailable: true,
  draftStore: { ME: { C1: { text: "other panel", version: 9 } } },
  pendingDraftComposers: {
    ME: { C1: { text: "local staged", generation: 8 } },
  },
  draftLastAccount: "ME",
  draftRecoveryHolds: {},
  activeChat: null,
  composerDirtyByChat: {},
  composerDraftVersionByChat: {},
  draftRecoveryHeld() {
    return false;
  },
  writes: 0,
  writeDraftStore() {
    this.writes++;
    return true;
  },
};
clearDraft(foreignAckRoot, { text: "", cursorPosition: 0 }, "C1", 0, 8);
ok(
  !foreignAckRoot.pendingDraftComposers.ME &&
    foreignAckRoot.draftStore.ME.C1.text === "other panel" &&
    foreignAckRoot.writes === 0,
  "an exhausted version-zero acknowledgement preserves another panel's draft",
);
ok(
  /if \(!edit\.acknowledged && accountChats\[stagedChat\] !== undefined\)/.test(
    B.loadDraftStore || src,
  ),
  "a staged acknowledgement cannot delete another panel's recovered draft",
);

ok(
  /onCursorPositionChanged:\s*\{[\s\S]*?root\.noteComposerEdit\(\)[\s\S]*?root\.scheduleDraftSave\(\)/
    .test(src),
  "cursor-only edits advance the composer generation and schedule persistence",
);
ok(
  /visible: modelData\.hasMedia[\s\S]*?thumb\.status === Image\.Error/.test(
    src,
  ),
  "a second thumbnail decode failure leaves a visible fallback label",
);
ok(
  /onModelDataChanged: root\.fetchPreview\(modelData\)/.test(src),
  "a recycled message delegate requests its new row's preview",
);
ok(
  /root\.request\("sendFile", \{[\s\S]*?_spendsDraft: picker\.originSpendsDraft/
    .test(src),
  "file-picker sends and spends its saved composer revision only after success",
);
const pickFileBody = body(
  "  function pickFile(submitComposer, expectedGeneration, expectedChat, expectedVersion) {",
);
ok(
  /if \(spendsComposer && ownsComposer\) \{[\s\S]*root\.saveActiveDraft\(false\)/
    .test(pickFileBody),
  "/file submission saves its originating draft before opening",
);
ok(
  /property double originDraftVersion/.test(pickerBlock) &&
    /property double settledIdleDraftRevision/.test(src) &&
    /_draftVersion: picker\.originDraftVersion/.test(pickerBlock) &&
    /picker\.originDraftVersion = deferredOrigin[\s\S]*composerDraftVersionByChat/
      .test(
        pickFileBody,
      ),
  "file-picker captures the saved revision at launch instead of spending a newer edit",
);
ok(
  /property bool originSpendsDraft/.test(pickerBlock) &&
    /!root\.draftVersionInFlight\([\s\S]*picker\.originDraftVersion/.test(
      pickFileBody,
    ),
  "file-picker does not spend a draft revision owned by another send",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.pending = {
  1: { chat: "C1", spendsDraft: true, draftVersion: 7 },
  2: { chat: "C2", spendsDraft: true, draftVersion: 7 },
};
ok(
  e.draftVersionInFlight("C1", 7) === true &&
    e.draftVersionInFlight("C1", 8) === false,
  "draft revision ownership is scoped to both chat and version",
);
e.root.pending = {
  1: { chat: "C1", spendsDraft: true, draftVersion: 0, draftGeneration: 1 },
};
ok(
  e.draftVersionInFlight("C1", 0, 1) === true &&
    e.draftVersionInFlight("C1", 0, 2) === false,
  "staged draft ownership uses composer generation while revision is zero",
);
ok(
  /property int originDraftGeneration/.test(pickerBlock) &&
    /_draftGeneration: picker\.originDraftGeneration/.test(pickerBlock) &&
    /root\.pickerComposerStillOwned\(/.test(pickerBlock) &&
    /composerGenerationFor\(chat\) !== Number\(generation\)/.test(
      B.pickerComposerStillOwned,
    ),
  "file-picker preserves edits made while the native picker is open",
);
const pickerOwnershipRoot = {
  composerDraftVersionByChat: { C1: 7 },
  composerGenerationFor: () => 4,
};
const pickerStillOwned = new Function(
  "root",
  "chat",
  "version",
  "generation",
  B.pickerComposerStillOwned,
);
ok(
  pickerStillOwned(pickerOwnershipRoot, "C1", 7, 4) === true &&
    pickerStillOwned(pickerOwnershipRoot, "C1", 6, 4) === false &&
    pickerStillOwned(pickerOwnershipRoot, "C1", 0, 4) === true &&
    pickerStillOwned(pickerOwnershipRoot, "C1", 7, 3) === false,
  "file-picker composer ownership checks revision and generation",
);
ok(
  /root\.pickerComposerStillOwned\([\s\S]*picker\.originDraftVersion/.test(
    pickerBlock,
  ),
  "file-picker completion checks the displayed revision before clearing the composer",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.composerGeneration = 9;
e.request("sendFile", {
  chat: "C1",
  path: "/tmp/a",
  _spendsDraft: true,
  _draftVersion: 2,
  _draftGeneration: 4,
});
ok(
  e.root.pending[1].draftGeneration === 4,
  "a file send acknowledgement is bound to the composer generation captured at picker launch",
);
ok(
  /&& spendsComposer && hasComposerDraft\)/.test(pickFileBody),
  "/file waits for a real draft version but the paperclip never does",
);
ok(
  /deferredPickers\.push\(\{[\s\S]*session: root\.sessionEpoch[\s\S]*chat: pickerChat[\s\S]*generation: requestedGeneration/
    .test(
      pickFileBody,
    ),
  "picker-backed /file records its account, session, chat and generation while drafts load",
);
const queuedPickerRoot = {
  draftStoreLoaded: true,
  draftStoreUnavailable: false,
  sessionEpoch: 7,
  myMid: "ME",
  busy: false,
  opened: [],
  deferredDraftPickers: [
    { session: 7, account: "ME", chat: "C1", generation: 2, version: 11 },
    { session: 7, account: "ME", chat: "C2", generation: 5, version: 12 },
  ],
  pickerBusy() {
    return this.busy;
  },
  pickFile(submit, generation, chat, version) {
    this.opened.push({ submit, generation, chat, version });
    this.busy = true;
  },
};
const flushQueuedPickers = new Function("root", B.flushDeferredDraftPickers);
flushQueuedPickers(queuedPickerRoot);
flushQueuedPickers(queuedPickerRoot);
queuedPickerRoot.busy = false;
flushQueuedPickers(queuedPickerRoot);
ok(
  queuedPickerRoot.opened.length === 2 &&
    queuedPickerRoot.opened[0].submit === true &&
    queuedPickerRoot.opened[0].chat === "C1" &&
    queuedPickerRoot.opened[0].generation === 2 &&
    queuedPickerRoot.opened[0].version === 11 &&
    queuedPickerRoot.opened[1].chat === "C2" &&
    queuedPickerRoot.opened[1].generation === 5 &&
    queuedPickerRoot.opened[1].version === 12 &&
    queuedPickerRoot.deferredDraftPickers.length === 0,
  "two deferred picker actions open once in order with their original ownership",
);
const queuedBindingRoot = {
  deferredDraftPickers: [
    { session: 7, account: "ME", chat: "C1", generation: 2, version: 0 },
    { session: 7, account: "ME", chat: "C2", generation: 5, version: 0 },
  ],
};
const queuedBindingPicker = { running: false };
new Function(
  "root",
  "picker",
  "account",
  "chat",
  "generation",
  "revision",
  B.rebindPickerDraft,
)(queuedBindingRoot, queuedBindingPicker, "ME", "C1", 2, 17);
ok(
  queuedBindingRoot.deferredDraftPickers[0].version === 17 &&
    queuedBindingRoot.deferredDraftPickers[1].version === 0,
  "draft loading binds only the queued picker whose composer received the revision",
);
ok(
  /Qt\.callLater\(root\.flushDeferredDraftPickers\)/.test(pickerBlock),
  "picker completion or cancellation advances the deferred picker queue",
);
const runPickFile = new Function(
  "root",
  "replyField",
  "picker",
  "submitComposer",
  "expectedGeneration",
  "expectedChat",
  "expectedVersion",
  pickFileBody,
);
const ownershipPicker = { running: false };
const ownershipRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  sessionEpoch: 3,
  draftStoreLoaded: true,
  draftStoreUnavailable: false,
  composerGenerationFor() {
    return 2;
  },
  draftStore: { ME: { C1: { text: "B", version: 8 } } },
  composerDraftVersionByChat: { C1: 8 },
  pendingDraftComposers: {},
  saveCalls: 0,
  saveActiveDraft() {
    this.saveCalls++;
  },
  draftVersionInFlight() {
    return false;
  },
  replyTarget: null,
  mentionPicks: [],
};
runPickFile(ownershipRoot, { text: "B" }, ownershipPicker, true, 1);
ok(
  ownershipPicker.running === true &&
    ownershipPicker.originDraftGeneration === 1 &&
    ownershipPicker.originSpendsDraft === false &&
    ownershipRoot.saveCalls === 0,
  "a deferred picker opens without taking ownership of text edited after /file was submitted",
);
const sharedNewerPicker = { running: false };
const sharedNewerRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  sessionEpoch: 3,
  draftStoreLoaded: true,
  draftStoreUnavailable: false,
  composerGenerationFor() {
    return 2;
  },
  draftStore: { ME: { C1: { text: "other panel", version: 9 } } },
  composerDraftVersionByChat: { C1: 8 },
  pendingDraftComposers: {},
  saveActiveDraft() {},
  draftVersionInFlight() {
    return false;
  },
  replyTarget: null,
  mentionPicks: [],
};
runPickFile(sharedNewerRoot, { text: "/file" }, sharedNewerPicker, true, 2);
ok(
  sharedNewerPicker.originDraftVersion === 8 &&
    sharedNewerPicker.originSpendsDraft === true,
  "an ordinary picker retains its displayed revision when another panel saved a newer one",
);
const inactivePicker = { running: false };
const inactivePickerRoot = {
  activeChat: { mid: "C2" },
  myMid: "ME",
  sessionEpoch: 3,
  draftStoreLoaded: true,
  draftStoreUnavailable: false,
  composerGenerationFor(chat) {
    return chat === "C1" ? 4 : 8;
  },
  draftStore: {
    ME: {
      C1: { text: "/file", version: 12, generation: 4 },
      C2: { text: "new", version: 13, generation: 8 },
    },
  },
  composerDraftVersionByChat: { C2: 13 },
  pendingDraftComposers: {},
  saveCalls: 0,
  saveActiveDraft() {
    this.saveCalls++;
  },
  draftVersionInFlight() {
    return false;
  },
  replyTarget: null,
  mentionPicks: [],
};
runPickFile(
  inactivePickerRoot,
  { text: "new" },
  inactivePicker,
  true,
  4,
  "C1",
  12,
);
ok(
  inactivePicker.running === true && inactivePicker.originChat === "C1" &&
    inactivePicker.originDraftVersion === 12 &&
    inactivePicker.originDraftGeneration === 4 &&
    inactivePicker.originSpendsDraft === true &&
    inactivePickerRoot.saveCalls === 0,
  "an inactive queued picker owns the persisted revision of its original chat",
);
const exhaustedPicker = { running: false };
const exhaustedPickerRoot = {
  activeChat: { mid: "C1" },
  myMid: "ME",
  sessionEpoch: 4,
  draftStoreLoaded: true,
  draftStoreUnavailable: true,
  composerGenerationFor() {
    return 6;
  },
  draftStore: { ME: { C1: { text: "old", version: 5 } } },
  pendingDraftComposers: { ME: { C1: { text: "new", generation: 6 } } },
  composerDraftVersionByChat: { C1: 5 },
  saveActiveDraft() {},
  draftVersionInFlight() {
    return false;
  },
  replyTarget: null,
  mentionPicks: [],
};
runPickFile(exhaustedPickerRoot, { text: "new" }, exhaustedPicker, true, 6);
ok(
  exhaustedPicker.running === true &&
    exhaustedPicker.originSpendsDraft === true &&
    exhaustedPicker.originDraftVersion === 0 &&
    exhaustedPicker.originDraftGeneration === 6,
  "the picker owns a staged composer after revision exhaustion",
);
e = makeEnv({
  activeChat: { mid: "C2" },
  draftStore: {
    ME: {
      C1: { text: "/file", version: 12, generation: 4 },
      C2: { text: "keep", version: 13, generation: 8 },
    },
  },
});
e.root.composerGenerationByChat = { C1: 4, C2: 8 };
e.request("sendFile", {
  chat: "C1",
  path: "/tmp/a",
  _spendsDraft: true,
  _draftVersion: 12,
  _draftGeneration: 4,
});
e.onReply(JSON.stringify({ id: 1, ok: true }));
ok(
  !e.root.draftStore.ME.C1 && e.root.draftStore.ME.C2.text === "keep",
  "a successful inactive queued picker spends its original persisted draft: " +
    JSON.stringify(e.root.draftStore),
);
e.request("sendFile", {
  chat: "C1",
  path: "/missing",
  _spendsDraft: true,
  _draftVersion: 12,
  _draftGeneration: 4,
});
e.replyField.text = "current chat stays intact";
e.onReply(JSON.stringify({ id: 2, ok: false, error: "file rejected" }));
ok(
  e.root.notice === "file rejected" &&
    e.replyField.text === "current chat stays intact",
  "a failed inactive queued picker stays visible without touching the current composer",
);
ok(
  /originSpendsDraft = false[\s\S]*if \(spendsComposer && ownsComposer\)/.test(
    pickFileBody,
  ) &&
    /onClicked: root\.pickFile\(false\)/.test(src) &&
    /body === "\/file"\) \{ root\.pickFile\(true\)/.test(src),
  "paperclip attachments preserve ordinary text while /file submits its draft",
);
ok(
  /pendingDraftComposers[\s\S]*stagedMode/.test(pickFileBody) &&
    /saved\.generation/.test(pickFileBody) &&
    /function rebindPickerDraft\(/.test(src) &&
    /picker\.originDraftVersion = Number\(revision/.test(src),
  "the picker binds unavailable staged drafts through storage recovery",
);
ok(
  pickerBlock.indexOf("picker.originAccount !== root.myMid") <
    pickerBlock.indexOf('path === "__NO_ZENITY__"'),
  "a stale picker cannot publish the missing-zenity notice into a new session",
);
ok(
  pickerBlock.indexOf("picker.originSession !== root.sessionEpoch") <
      pickerBlock.indexOf('path === "__NO_ZENITY__"') &&
    /picker\.originSession = root\.sessionEpoch/.test(src),
  "logging back into the same account still invalidates an old file picker",
);
ok(
  B.clearSession.indexOf("root.resettingComposerAfterSend = true") <
      B.clearSession.indexOf('replyField.text = ""') &&
    B.clearSession.indexOf('replyField.text = ""') <
      B.clearSession.indexOf("root.resettingComposerAfterSend = false") &&
    /root\.composerEditedBeforeDraftLoad = false/.test(B.clearSession),
  "session cleanup cannot stage its programmatic empty composer as a user edit",
);
ok(
  B.backToList.includes("root.stopDraftSaveTimer()"),
  "leaving a chat cancels the stale draft debounce after saving",
);
ok(
  /root\.fetchPreview\(target, true\)/.test(src) &&
    /invalidate: invalidate === true/.test(src),
  "a failed thumbnail asks the daemon to replace its cached file",
);
e = makeEnv({ activeChat: { mid: "C1" } });
const invalidatedPreview = MSG("preview-invalidated", "THEM", "");
invalidatedPreview.chat = "C1";
invalidatedPreview.contentType = "IMAGE";
invalidatedPreview.hasMedia = true;
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  e.root,
  e.sock,
  invalidatedPreview,
  true,
);
ok(
  e.root.pending[1].invalidate === true,
  "a preview request retains invalidation through a busy reply",
);
const retryBlock = body("  function retryPreview(id, automatic) {");
ok(
  retryBlock.indexOf("root.fetchPreview(target, true)") <
      retryBlock.indexOf("root.setMessages(changed, false)") &&
    !retryBlock.includes("Qt.callLater"),
  "the invalidating retry claims the request before a recycled delegate can race it",
);
ok(
  /property var previewDecodeRetries/.test(src) &&
    /retryPreview\(messageId, true\)/.test(src) &&
    /if \(decodeRetries\[retryId\]\) return/.test(retryBlock),
  "automatic decode retry ownership survives delegate recreation",
);
const decodeLoopRoot = {
  previewDecodeRetries: {},
  messages: [
    { id: "m1", chat: "C1", mediaPath: "/tmp/corrupt" },
  ],
  activeChat: { mid: "C1" },
  fetches: 0,
  withFields(message, fields) {
    return { ...message, ...fields };
  },
  fetchPreview() {
    this.fetches++;
  },
  setMessages(messages) {
    this.messages = messages;
  },
  rememberHistory() {},
};
const runRetryPreview = new Function(
  "root",
  "id",
  "automatic",
  B.retryPreview,
);
runRetryPreview(decodeLoopRoot, "m1", true);
new Function("root", "id", B.finishPreviewRetry)(decodeLoopRoot, "m1");
runRetryPreview(decodeLoopRoot, "m1", true);
const automaticFetches = decodeLoopRoot.fetches;
runRetryPreview(decodeLoopRoot, "m1", false);
ok(
  automaticFetches === 1 && decodeLoopRoot.fetches === 2,
  "a second decode failure stays bounded while manual retry remains available",
);
ok(
  /mediaLoading:[\s\S]*previewRequests/.test(src) &&
    /mediaLoading \? tr\("loading"\)/.test(src),
  "an in-flight thumbnail is labelled as loading rather than failed",
);
ok(
  /previewRefreshNeeded = true/.test(B.dropInFlight) &&
    /root\.previewRefreshNeeded[\s\S]*root\.loadHistory/.test(src),
  "reconnect reloads a chat whose thumbnail request was interrupted",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.previewRequests = { m1: true };
e.root.previewDecodeRetries = { m1: true };
e.root.pending = {
  1: { cmd: "preview", msgId: "m1", chat: "C1", invalidate: true },
};
e.dropInFlight();
ok(
  e.root.previewRetryQueue.m1.invalidate === true &&
    e.root.previewDecodeRetries.m1 === true,
  "disconnect preserves an unfinished preview invalidation for reconnect",
);
ok(
  /Object\.keys\(root\.previewRetryQueue\)\.length > 0[\s\S]*previewRetryTimer\.restart/
    .test(
      sockBlock,
    ),
  "reconnect resumes queued preview invalidations while connected",
);
ok(
  B.fetchPreview.indexOf("root.previewRefreshNeeded = true") <
    B.fetchPreview.indexOf("delete busy[m.id]"),
  "a preview refused before socket write still schedules reconnect recovery",
);
ok(
  B.fetchPreview.indexOf("!root.sockConnected") >
      B.fetchPreview.indexOf("String(m.chat") &&
    B.fetchPreview.indexOf("!root.sockConnected") <
      B.fetchPreview.indexOf("var busy"),
  "a dropped socket defers thumbnails instead of replacing the banner with the offline notice",
);
e = makeEnv({ activeChat: { mid: "C1" }, connected: false });
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  e.root,
  e.sock,
  MSG("preview-offline", "THEM", "", { contentType: "IMAGE", hasMedia: true }),
  true,
);
ok(
  e.sent.length === 0 &&
    e.root.previewRetryQueue["preview-offline"].invalidate === true &&
    e.root.previewRefreshNeeded === true,
  "an offline invalidating preview keeps its cache marker for reconnect",
);
e.sock.connected = true;
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  e.root,
  e.sock,
  MSG("preview-offline", "THEM", "", { contentType: "IMAGE", hasMedia: true }),
);
ok(
  e.sent.at(-1).cmd === "preview" && e.sent.at(-1).invalidate === true,
  "the reconnected delegate request inherits the queued invalidation",
);
e = makeEnv({ activeChat: { mid: "C1" }, connected: false });
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  e.root,
  e.sock,
  MSG("preview-plain", "THEM", "", { contentType: "IMAGE", hasMedia: true }),
);
ok(
  e.sent.length === 0 &&
    e.root.previewRetryQueue["preview-plain"].invalidate === false &&
    e.root.previewRefreshNeeded === true,
  "an ordinary offline preview is queued for the reconnect replay",
);
e.sock.connected = true;
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  e.root,
  e.sock,
  MSG("preview-plain", "THEM", "", { contentType: "IMAGE", hasMedia: true }),
);
ok(
  e.sent.at(-1).cmd === "preview" && e.sent.at(-1).invalidate === false &&
    !e.root.previewRetryQueue["preview-plain"],
  "the reconnected replay fetches the plain thumbnail and spends the entry",
);
const previewReplayBlock = src.slice(
  src.indexOf("id: previewRetryTimer"),
  src.indexOf("id: imageRetryTimer"),
);
const replayPreviews = new Function(
  "root",
  "sock",
  previewReplayBlock.slice(
    previewReplayBlock.indexOf("onTriggered: {") + "onTriggered: {".length,
    previewReplayBlock.indexOf(
      "\n    }",
      previewReplayBlock.indexOf("onTriggered: {"),
    ),
  ),
);
e = makeEnv({ activeChat: { mid: "C2" } });
e.root.messages = [
  MSG("preview-b", "THEM", "", { contentType: "IMAGE", hasMedia: true }),
];
// Chat A's invalidation was queued while A was open; the panel now shows B.
e.root.previewRetryQueue = {
  "preview-a": { invalidate: true, chat: "C1" },
  "preview-b": { invalidate: false, chat: "C2" },
};
const replayed = [];
e.root.fetchPreview = (m, inv) => replayed.push([String(m.id), inv]);
replayPreviews(e.root, e.sock);
ok(
  replayed.length === 1 && replayed[0][0] === "preview-b" &&
    replayed[0][1] !== true &&
    e.root.previewRetryQueue["preview-a"].invalidate === true,
  "the reconnect replay keeps another chat's queued invalidation",
);
const reconnectPreview = src.slice(
  src.indexOf("if (root.previewRefreshNeeded && root.activeChat)"),
  src.indexOf(
    "// 面板重開時",
    src.indexOf("if (root.previewRefreshNeeded && root.activeChat)"),
  ),
);
ok(
  !/previewRefreshNeeded = false/.test(reconnectPreview) &&
    B.onReply.indexOf("root.previewRefreshNeeded = false") >
      B.onReply.indexOf('} else if (cmd === "history")'),
  "thumbnail recovery stays armed until a current history reply succeeds",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.loadHistory("C1");
e.root.previewRefreshNeeded = true;
e.onReply(JSON.stringify({ id: 1, ok: false, error: "offline" }));
ok(
  e.root.previewRefreshNeeded === true,
  "a failed recovery history keeps the next reconnect armed",
);
e.root.loadHistory("C1");
e.onReply(JSON.stringify({ id: 2, ok: true, data: [] }));
ok(
  e.root.previewRefreshNeeded === false,
  "a successful recovery history finally clears the reconnect flag",
);

const draftLibrary = fs.readFileSync(path.join(REPO, "DraftStore.js"), "utf8")
  .replace(/^\.pragma library\s*/, "");
const makeDraftStore = new Function(
  draftLibrary +
    "; return { load: load, merge: merge, serialize: serialize, " +
    "allocateRevision: allocateRevision, snapshot: snapshot }; ",
);

const loadedExhaustedDrafts = makeDraftStore();
loadedExhaustedDrafts.load(JSON.stringify({
  version: 1,
  revision: 9007199254740991,
  lastAccount: "ME",
  accounts: {
    ME: { C1: { text: "disk copy", version: 9007199254740991 } },
    OTHER: { C2: { text: "keep", version: 2 } },
  },
}));
let loadedExhaustedWrite = null;
const loadedExhaustedLogoutRoot = {
  draftStoreLoaded: true,
  draftStore: loadedExhaustedDrafts.snapshot().accounts,
  draftLastAccount: "ME",
  pendingDraftAccountClears: {},
  pendingDraftComposers: {
    ME: { C1: { text: "staged at limit", generation: 9 } },
    OTHER: { C2: { text: "other staged", generation: 3 } },
  },
  writeDraftStore(next) {
    loadedExhaustedWrite = next;
  },
};
new Function("root", "DraftStore", "account", B.clearDraftAccount)(
  loadedExhaustedLogoutRoot,
  loadedExhaustedDrafts,
  "ME",
);
ok(
  !loadedExhaustedLogoutRoot.pendingDraftComposers.ME &&
    loadedExhaustedLogoutRoot.pendingDraftComposers.OTHER.C2.text ===
      "other staged" &&
    loadedExhaustedWrite && !loadedExhaustedWrite.ME &&
    loadedExhaustedWrite.OTHER.C2.text === "keep",
  "logout removes a loaded account's staged revision-exhaustion recovery",
);

const racedDrafts = makeDraftStore();
const delayedDraftFile = JSON.stringify({
  version: 1,
  revision: 5,
  accounts: { ME: { OLD: { text: "logged out", version: 5 } } },
  lastAccount: "ME",
});
const beforeLogout = racedDrafts.load(delayedDraftFile);
const logoutBoundary = racedDrafts.snapshot().revision;
racedDrafts.merge(beforeLogout.accounts, {}, "");
const newDraftVersion = racedDrafts.allocateRevision();
const beforeNewDraft = racedDrafts.snapshot();
racedDrafts.merge(beforeNewDraft.accounts, {
  ME: { NEW: { text: "new session", version: newDraftVersion } },
}, "ME");
const delayedPanelRoot = {
  loginStatus: "starting",
  sessionEstablished: false,
  initialIdleDraftHandled: false,
  settledIdleBeforeDraftLoad: false,
  pendingDraftAccountClears: { ME: logoutBoundary },
  pendingDraftComposers: {},
  composerEditedBeforeDraftLoad: false,
  activeChat: null,
  draftLastAccount: "",
  draftStore: {},
  draftStoreLoaded: false,
};
new Function(
  "root",
  "DraftStore",
  "DraftWriter",
  "draftFile",
  "content",
  B.loadDraftStore,
)(
  delayedPanelRoot,
  racedDrafts,
  { save() {} },
  { path: "/tmp/panel-drafts.json" },
  delayedDraftFile,
);
const racedSnapshot = racedDrafts.snapshot();
ok(
  racedSnapshot.accounts.ME.NEW.text === "new session" &&
    JSON.parse(racedDrafts.serialize()).accounts.ME.NEW.text === "new session",
  "a real shared draft store preserves a same-account draft across a delayed logout load",
);

const sharedDrafts = makeDraftStore();
const firstDraftView = sharedDrafts.load(JSON.stringify({
  version: 1,
  revision: 1,
  accounts: { ME: { A: { text: "a" } } },
  lastAccount: "ME",
}));
sharedDrafts.merge(firstDraftView.accounts, {
  ME: { A: { text: "a" }, B: { text: "b" } },
}, "ME");
sharedDrafts.merge(firstDraftView.accounts, {
  ME: { A: { text: "a" }, C: { text: "c" } },
}, "ME");
const mergedDrafts = JSON.parse(sharedDrafts.serialize());
ok(
  mergedDrafts.accounts.ME.B.text === "b" &&
    mergedDrafts.accounts.ME.C.text === "c",
  "stale screen snapshots merge different chat drafts through the shared store",
);
sharedDrafts.load(JSON.stringify({
  version: 1,
  revision: 1,
  accounts: { ME: { A: { text: "old" } } },
}));
ok(
  JSON.parse(sharedDrafts.serialize()).accounts.ME.C.text === "c",
  "an older file notification cannot roll the shared draft store back",
);
const allocatedAfterMerges = sharedDrafts.allocateRevision();
const allocatedAgain = sharedDrafts.allocateRevision();
ok(
  allocatedAgain === allocatedAfterMerges + 1,
  "draft identities use the shared revision clock and are never reused",
);
const legacyDrafts = makeDraftStore();
legacyDrafts.load(JSON.stringify({
  version: 1,
  accounts: { ME: { A: { text: "legacy", version: 7 } } },
}));
ok(
  legacyDrafts.allocateRevision() === 8,
  "a legacy file seeds the revision clock above its stored draft identities",
);
const malformedDrafts = makeDraftStore();
ok(
  malformedDrafts.load(JSON.stringify({
        version: 1,
        revision: "bad",
        accounts: {},
      })) === null &&
    malformedDrafts.load(JSON.stringify({
        version: 1,
        revision: 1,
        accounts: { ME: { A: { text: "bad", version: "bad" } } },
      })) === null &&
    Object.keys(malformedDrafts.snapshot().accounts).length === 0,
  "malformed revisions are rejected without poisoning the shared clock",
);
const exhaustedDrafts = makeDraftStore();
const exhaustedLoad = exhaustedDrafts.load(JSON.stringify({
  version: 1,
  revision: 9007199254740991,
  accounts: {},
}));
ok(
  exhaustedLoad !== null && exhaustedDrafts.allocateRevision() === 0,
  "a persisted revision with no safe increment loads but refuses allocation",
);
const boundaryDrafts = makeDraftStore();
boundaryDrafts.load(JSON.stringify({
  version: 1,
  revision: 9007199254740990,
  accounts: { ME: { A: { text: "kept", version: 9007199254740990 } } },
}));
const boundaryOne = boundaryDrafts.allocateRevision();
const boundaryTwo = boundaryDrafts.allocateRevision();
const boundaryBeforeMerge = boundaryDrafts.snapshot();
const boundaryMerge = boundaryDrafts.merge(
  boundaryBeforeMerge.accounts,
  {
    ME: {
      A: { text: "kept", version: 9007199254740990 },
      B: { text: "blocked", version: boundaryOne },
    },
  },
  "ME",
);
const boundaryDelete = boundaryDrafts.merge(
  boundaryBeforeMerge.accounts,
  {},
  "",
);
const boundarySerialized = boundaryDrafts.serialize();
const boundaryReload = makeDraftStore().load(boundarySerialized);
ok(
  boundaryOne === 9007199254740991 && boundaryTwo === 0 &&
    boundaryMerge === null && boundaryDelete !== null &&
    boundaryReload !== null &&
    boundaryReload.revision === boundaryOne &&
    !boundaryReload.accounts.ME,
  "revision exhaustion refuses new identities but still persists deletion",
);
const nestedDeleteDrafts = makeDraftStore();
const nestedBefore = nestedDeleteDrafts.load(JSON.stringify({
  version: 1,
  revision: 9007199254740991,
  accounts: {
    ME: {
      A: {
        text: "sent",
        cursor: 4,
        version: 9,
        ambiguousSends: [{ requestId: "pending" }],
      },
    },
  },
  lastAccount: "ME",
}));
const nestedDelete = nestedDeleteDrafts.merge(nestedBefore.accounts, {
  ME: { A: { ambiguousSends: [{ requestId: "pending" }] } },
}, "ME");
ok(
  nestedDelete !== null &&
    nestedDelete.accounts.ME.A.text === undefined &&
    nestedDelete.accounts.ME.A.ambiguousSends[0].requestId === "pending",
  "revision exhaustion permits nested composer-field deletion",
);
const arrayDeleteDrafts = makeDraftStore();
const arrayBefore = arrayDeleteDrafts.load(JSON.stringify({
  version: 1,
  revision: 9007199254740991,
  accounts: {
    ME: {
      A: {
        ambiguousSends: [{ requestId: "confirmed" }, { requestId: "pending" }],
      },
    },
  },
}));
const arrayDelete = arrayDeleteDrafts.merge(arrayBefore.accounts, {
  ME: { A: { ambiguousSends: [{ requestId: "pending" }] } },
});
ok(
  arrayDelete !== null &&
    arrayDelete.accounts.ME.A.ambiguousSends.length === 1 &&
    arrayDelete.accounts.ME.A.ambiguousSends[0].requestId === "pending",
  "revision exhaustion permits deleting a non-final ambiguity token",
);
function reconcileAtRevisionLimit(limit) {
  const store = makeDraftStore();
  const content = JSON.stringify({
    version: 1,
    revision: limit,
    lastAccount: "OLD",
    accounts: { OLD: { C0: { text: "remove", version: limit } } },
  });
  const writes = [];
  const root = {
    myMid: "ME",
    activeChat: null,
    draftStoreLoaded: false,
    draftStoreUnavailable: false,
    draftRevisionExhausted: false,
    draftLoadRetryAttempt: 0,
    draftStore: {},
    draftLastAccount: "",
    pendingDraftAccountClears: { OLD: { revision: limit, at: Date.now() } },
    pendingDraftComposers: {
      ME: {
        C1: {
          text: "retain staged",
          cursor: 4,
          mentions: [],
          replyTo: null,
          generation: 3,
        },
      },
    },
    pending: {},
    deferredDraftRequests: [],
    composerEditedBeforeDraftLoad: false,
    settledIdleBeforeDraftLoad: false,
    initialIdleDraftHandled: false,
    settledIdleDraftAccount: "",
    settledIdleDraftRevision: 0,
    settledIdleDraftAt: 0,
    flushed: 0,
    flushDeferredDraftActions() {
      this.flushed++;
    },
    markDraftStoreUnavailable() {
      this.draftRevisionExhausted = true;
      this.draftStoreUnavailable = true;
      this.flushDeferredDraftActions();
    },
  };
  new Function(
    "root",
    "DraftStore",
    "DraftWriter",
    "draftFile",
    "content",
    B.loadDraftStore,
  )(
    root,
    store,
    {
      save(_path, value) {
        writes.push(value);
      },
    },
    { path: "/tmp/panel-drafts.json" },
    content,
  );
  return { root, writes, serialized: JSON.parse(store.serialize()) };
}
const exhaustedReconcile = reconcileAtRevisionLimit(9007199254740991);
const lastSafeReconcile = reconcileAtRevisionLimit(9007199254740990);
const ordinaryReconcile = reconcileAtRevisionLimit(10);
ok(
  !exhaustedReconcile.serialized.accounts.OLD &&
    !lastSafeReconcile.serialized.accounts.OLD &&
    exhaustedReconcile.writes.length === 1 &&
    lastSafeReconcile.writes.length === 1 &&
    exhaustedReconcile.root.pendingDraftComposers.ME.C1.text ===
      "retain staged" &&
    lastSafeReconcile.root.pendingDraftComposers.ME.C1.text ===
      "retain staged" &&
    exhaustedReconcile.root.draftStoreUnavailable &&
    lastSafeReconcile.root.draftStoreUnavailable,
  "logout deletion commits before staged additions at both revision limits",
);
ok(
  !ordinaryReconcile.serialized.accounts.OLD &&
    ordinaryReconcile.serialized.accounts.ME.C1.text === "retain staged" &&
    ordinaryReconcile.writes.length === 2 &&
    Object.keys(ordinaryReconcile.root.pendingDraftComposers).length === 0,
  "post-deletion reconciliation persists ordinary staged additions",
);
ok(
  /allocatedRevision <= 0[\s\S]*?markDraftStoreUnavailable/.test(
    B.loadDraftStore,
  ) &&
    /if \(!cleaned\)[\s\S]*?markDraftStoreUnavailable/.test(B.loadDraftStore) &&
    /if \(!merged\)[\s\S]*?return false/.test(B.writeDraftStore),
  "panel persistence boundaries route revision exhaustion into recovery",
);
const exhaustedPanelRoot = {
  draftStoreLoaded: true,
  draftStoreUnavailable: false,
  draftRevisionExhausted: false,
  notice: "",
  flushed: 0,
  flushDeferredDraftActions() {
    this.flushed++;
  },
};
new Function("root", "tr", B.markDraftStoreUnavailable)(exhaustedPanelRoot, Tzh);
ok(
  exhaustedPanelRoot.draftStoreLoaded === true &&
    exhaustedPanelRoot.draftStoreUnavailable === true &&
    exhaustedPanelRoot.draftRevisionExhausted === true &&
    exhaustedPanelRoot.flushed === 1,
  "revision exhaustion keeps the loaded snapshot available for safe deletions",
);
const draftLoadErrors = { FileNotFound: 1, Unknown: 2 };
const draftRetryTimer = {
  interval: 0,
  restarts: 0,
  restart() {
    this.restarts++;
  },
};
const malformedLoadRoot = {
  draftStoreLoaded: false,
  draftStoreUnavailable: false,
  draftLoadRetryAttempt: 0,
  flushed: 0,
  notice: "",
  flushDeferredDraftActions() {
    this.flushed++;
  },
};
const handleDraftFailure = new Function(
  "root",
  "FileViewError",
  "draftLoadRetryTimer",
  "error",
  "tr",
  B.handleDraftLoadFailure,
);
malformedLoadRoot.handleDraftLoadFailure = (error) =>
  handleDraftFailure(
    malformedLoadRoot,
    draftLoadErrors,
    draftRetryTimer,
    error,
    Tzh,
  );
malformedLoadRoot.loadDraftStore = () =>
  malformedLoadRoot.handleDraftLoadFailure(draftLoadErrors.Unknown);
const handleDraftLoaded = new Function(
  "root",
  "FileViewError",
  "content",
  B.handleDraftLoaded,
);
for (let i = 0; i < 6; i++) {
  handleDraftLoaded(
    malformedLoadRoot,
    draftLoadErrors,
    JSON.stringify({ version: 1, revision: "bad", accounts: {} }),
  );
}
ok(
  malformedLoadRoot.draftLoadRetryAttempt === 6 &&
    malformedLoadRoot.draftStoreUnavailable === true &&
    malformedLoadRoot.flushed === 1 && draftRetryTimer.restarts === 5,
  "deep draft validation failures reach the terminal recovery path",
);
const draftWriterSource = fs.readFileSync(
  path.join(REPO, "DraftWriter.qml"),
  "utf8",
);
const draftWriterLines = draftWriterSource.split("\n");
function draftWriterBody(header) {
  const start = draftWriterLines.findIndex((line) => line.trimEnd() === header);
  if (start < 0) throw new Error("not found in DraftWriter.qml: " + header);
  for (let i = start + 1; i < draftWriterLines.length; i++) {
    if (draftWriterLines[i] === "  }") {
      return draftWriterLines.slice(start + 1, i).join("\n");
    }
  }
  throw new Error("unterminated in DraftWriter.qml: " + header);
}
ok(
  /^pragma Singleton/m.test(draftWriterSource) &&
    /property FileView writer: FileView/.test(draftWriterSource) &&
    /if \(root\.saving\) return/.test(draftWriterSource) &&
    /if \(!root\.current && root\.queued\.length === 0\) return/.test(
      draftWriterSource,
    ) &&
    /onSaved: root\.finishSave\(true\)/.test(draftWriterSource) &&
    /property string current: ""/.test(draftWriterSource) &&
    /onSaveFailed:[\s\S]*?retryTimer\.restart\(\)/.test(draftWriterSource) &&
    /root\.writeFailed\(root\.lastError\)/.test(draftWriterSource) &&
    /root\.writeSucceeded\(saved\)/.test(draftWriterSource) &&
    /onTriggered: root\.pumpSave\(\)/.test(draftWriterSource) &&
    /root\.queued = \[String\(content\)\]/.test(draftWriterSource),
  "one engine-lifetime FileView serializes retries and coalesces pending draft revisions",
);
const writerWrites = [];
const writerRoot = {
  saving: false,
  current: "",
  queued: ["first", "second"],
  lastError: "failed",
  retryAttempt: 1,
  writeSucceeded() {},
  writer: {
    setText(value) {
      writerWrites.push(value);
    },
  },
};
const pumpDraftWriter = new Function(
  "root",
  draftWriterBody("  function pumpSave() {"),
);
const finishDraftWriter = new Function(
  "root",
  "succeeded",
  draftWriterBody("  function finishSave(succeeded) {"),
);
writerRoot.pumpSave = () => pumpDraftWriter(writerRoot);
writerRoot.pumpSave();
writerRoot.saving = false; // onSaveFailed leaves `current` owned by the retry.
writerRoot.pumpSave();
finishDraftWriter(writerRoot, true);
ok(
  writerWrites.join() === "first,first,second" &&
    writerRoot.current === "second" && writerRoot.saving === true,
  "a failed atomic write retries the same revision before advancing the queue",
);
const saveDraftWriter = new Function(
  "root",
  "path",
  "content",
  draftWriterBody("  function save(path, content) {"),
);
const coalescedRoot = {
  filePath: "/drafts",
  queued: ["older"],
  saving: true,
  pumpSave() {},
};
saveDraftWriter(coalescedRoot, "/drafts", "newer");
saveDraftWriter(coalescedRoot, "/drafts", "latest");
ok(
  coalescedRoot.queued.join() === "latest",
  "rapid edits retain only the latest snapshot behind the in-flight atomic write",
);
const rejectedWriterErrors = [];
const rejectedWriterRoot = {
  filePath: "/drafts-a",
  queued: [],
  saving: false,
  lastError: "",
  writeFailed(error) {
    rejectedWriterErrors.push(error);
  },
  pumpSave() {},
};
const rejectedWriter = saveDraftWriter(
  rejectedWriterRoot,
  "/drafts-b",
  "must not queue",
);
ok(
  rejectedWriter === false &&
    rejectedWriterErrors.join() === "draft path changed" &&
    rejectedWriterRoot.lastError === "draft path changed" &&
    rejectedWriterRoot.queued.length === 0,
  "a different draft path is rejected with an observable failure",
);
const confirmedDraftRoot = {
  myMid: "ME",
  draftDurabilityPendingByChat: { A: 4, B: 5 },
};
new Function("root", "content", B.confirmDraftSaved)(
  confirmedDraftRoot,
  JSON.stringify({
    accounts: {
      ME: {
        A: { text: "saved", version: 4 },
        B: { text: "older", version: 3 },
      },
    },
  }),
);
ok(
  confirmedDraftRoot.draftDurabilityPendingByChat.A === undefined &&
    confirmedDraftRoot.draftDurabilityPendingByChat.B === 5,
  "only the composer revision confirmed by FileView is marked durable",
);
ok(
  /property string draftWriteError: ""/.test(src) &&
    /function onWriteFailed\(error\)[\s\S]*?draft\.notSaved/.test(src) &&
    /function onWriteSucceeded\(content\)[\s\S]*?confirmDraftSaved\(content\)/
      .test(src) &&
    /function listNoticeText\(\)[\s\S]*?draftWriteError/.test(src),
  "permanent draft write failures stay visible until a successful retry",
);
const sharedPanelDrafts = makeDraftStore();
sharedPanelDrafts.load(
  JSON.stringify({ version: 1, revision: 0, accounts: {} }),
);
const saveSharedDraft = new Function(
  "DraftStore",
  "root",
  "replyField",
  "removeEmpty",
  B.saveActiveDraft,
);
function makeSharedPanel(text) {
  const root = {
    activeChat: { mid: "C" },
    myMid: "ME",
    restoringDraft: false,
    draftStoreLoaded: true,
    composerDirtyByChat: { C: true },
    composerDraftVersionByChat: {},
    draftDurabilityPendingByChat: {},
    draftRecoveryHolds: {},
    mentionPicks: [],
    replyTarget: null,
    pendingDraftSend: () => false,
    draftRecoveryHeld: () => false,
    composerGenerationFor: () => 1,
  };
  const snapshot = sharedPanelDrafts.snapshot();
  root.draftStore = snapshot.accounts;
  root.draftLastAccount = snapshot.lastAccount;
  root.writeDraftStore = (next) => {
    const merged = sharedPanelDrafts.merge(root.draftStore, next, "ME");
    root.draftStore = merged.accounts;
    root.draftLastAccount = merged.lastAccount;
  };
  return { root, reply: { text, cursorPosition: text.length } };
}
const olderPanel = makeSharedPanel("older");
saveSharedDraft(sharedPanelDrafts, olderPanel.root, olderPanel.reply, false);
const newerPanel = makeSharedPanel("newer");
saveSharedDraft(sharedPanelDrafts, newerPanel.root, newerPanel.reply, false);
saveSharedDraft(sharedPanelDrafts, olderPanel.root, olderPanel.reply, true);
ok(
  sharedPanelDrafts.snapshot().accounts.ME.C.text === "newer" &&
    olderPanel.root.composerDirtyByChat.C === false &&
    olderPanel.root.draftDurabilityPendingByChat.C > 0,
  "an unchanged older panel cannot overwrite a newer shared draft while disk acknowledgement is pending",
);

group("(z2) a late preview patches only its message");
const retryRoot = {
  previewRetryAttempts: {},
  previewRetryQueue: {},
  previewDecodeRetries: {},
  previewRefreshNeeded: false,
};
const retryIntervals = [];
const retryTimer = {
  interval: 0,
  restart() {
    retryIntervals.push(this.interval);
  },
};
const scheduleRetry = new Function(
  "root",
  "previewRetryTimer",
  "id",
  "invalidate",
  "chat",
  B.schedulePreviewRetry,
);
for (let i = 0; i < 10; i++) {
  scheduleRetry(retryRoot, retryTimer, "m1", true, "C1");
}
ok(
  retryIntervals.join() === "250,500,1000,2000,4000,4000,4000,4000,4000,4000" &&
    retryRoot.previewRefreshNeeded === false &&
    retryRoot.previewRetryQueue.m1.invalidate === true,
  "busy preview retries remain queued through long-running media work",
);
retryRoot.previewDecodeRetries.m1 = true;
new Function("root", "id", B.finishPreviewRetry)(retryRoot, "m1");
ok(
  !retryRoot.previewRetryAttempts.m1 &&
    retryRoot.previewDecodeRetries.m1,
  "transport completion retains decode-retry ownership",
);
new Function("root", "id", B.finishPreviewDecode)(retryRoot, "m1");
ok(
  !retryRoot.previewDecodeRetries.m1 &&
    /status === Image\.Ready[\s\S]*finishPreviewDecode\(messageId\)/.test(src),
  "successful Qt decoding releases automatic retry ownership",
);
const queuedPreviewRequests = [];
const queuedPreviewRoot = {
  activeChat: { mid: "C1" },
  sockConnected: true,
  previewRequests: {},
  previewRetryQueue: { m1: { invalidate: true } },
  previewRefreshNeeded: false,
  mediaUsable: () => true,
  request(cmd, args) {
    queuedPreviewRequests.push({ cmd, args });
    return true;
  },
};
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  queuedPreviewRoot,
  { connected: true },
  { id: "m1", chat: "C1", contentType: "IMAGE", hasMedia: true },
  false,
);
ok(
  queuedPreviewRequests.length === 1 &&
    queuedPreviewRequests[0].args.invalidate === true &&
    !queuedPreviewRoot.previewRetryQueue.m1,
  "an ordinary delegate request preserves and claims queued invalidation",
);
const refusedPreviewRoot = {
  activeChat: { mid: "C1" },
  sockConnected: true,
  previewRequests: {},
  previewRetryQueue: { m1: { invalidate: true } },
  previewRefreshNeeded: false,
  mediaUsable: () => true,
  request: () => false,
};
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  refusedPreviewRoot,
  { connected: true },
  { id: "m1", chat: "C1", contentType: "IMAGE", hasMedia: true },
  false,
);
ok(
  refusedPreviewRoot.previewRetryQueue.m1.invalidate === true,
  "a refused delegate request keeps queued invalidation for retry",
);
const offlineInvalidationRoot = {
  activeChat: { mid: "C1" },
  previewRequests: {},
  previewRetryQueue: {},
  previewRefreshNeeded: false,
  mediaUsable: () => true,
  request: () => false,
};
new Function("root", "sock", "m", "invalidate", B.fetchPreview)(
  offlineInvalidationRoot,
  { connected: true },
  { id: "m1", chat: "C1", contentType: "IMAGE", hasMedia: true },
  true,
);
ok(
  offlineInvalidationRoot.previewRetryQueue.m1.invalidate === true &&
    offlineInvalidationRoot.previewRefreshNeeded === true,
  "an offline automatic retry retains cache invalidation for reconnect",
);
const imageRetryRoot = {
  imageRetryAttempts: {},
  imageRetryQueue: {},
  imageConsumers: { u: 1 },
};
const imageRetryIntervals = [];
const imageRetryTimer = {
  interval: 0,
  restart() {
    imageRetryIntervals.push(this.interval);
  },
};
const scheduleImageRetry = new Function(
  "root",
  "imageRetryTimer",
  "url",
  "invalidate",
  B.scheduleImageRetry,
);
const imageRetryResults = [];
for (let i = 0; i < 30; i++) {
  imageRetryResults.push(
    scheduleImageRetry(imageRetryRoot, imageRetryTimer, "u", true),
  );
}
ok(
  imageRetryIntervals.slice(0, 5).join() === "250,500,1000,2000,4000" &&
    imageRetryIntervals.slice(5).every((value) => value === 4000) &&
    imageRetryResults.every(Boolean),
  "a visible public image keeps retrying through arbitrarily long congestion",
);
imageRetryRoot.imageConsumers = {};
ok(
  scheduleImageRetry(imageRetryRoot, imageRetryTimer, "u", true) === false,
  "an image with no remaining delegate does not start another retry",
);
imageRetryRoot.imageConsumers = { u: 1, v: 1 };
imageRetryRoot.imageRetryQueue.v = { invalidate: false };
imageRetryRoot.imageRetryAttempts.v = 2;
const releaseImage = new Function("root", "url", B.releaseImage);
imageRetryRoot.finishImageRetry = (url) => {
  delete imageRetryRoot.imageRetryAttempts[url];
};
releaseImage(imageRetryRoot, "u");
ok(
  !imageRetryRoot.imageConsumers.u && !imageRetryRoot.imageRetryQueue.u &&
    !imageRetryRoot.imageRetryAttempts.u &&
    imageRetryRoot.imageConsumers.v === 1 &&
    imageRetryRoot.imageRetryQueue.v.invalidate === false,
  "destroying the last delegate stops only that image's background retry",
);
imageRetryRoot.mediaRetryMax = 4;
for (let i = 0; i < 20; i++) imageRetryRoot.imageConsumers["img" + i] = 1;
for (let i = 0; i < 20; i++) {
  scheduleImageRetry(imageRetryRoot, imageRetryTimer, "img" + i, false);
}
ok(
  Object.keys(imageRetryRoot.imageRetryQueue).length === 4 &&
    imageRetryRoot.imageRetryQueue.img19 !== undefined &&
    imageRetryRoot.imageRetryQueue.img0 === undefined &&
    Object.keys(imageRetryRoot.imageRetryAttempts).length === 4,
  "image-retry bookkeeping is capped: the oldest URLs fall off, the newest keep their backoff",
);
imageRetryRoot.mediaRetryMax = undefined;
const cappedPreviewRoot = {
  previewRetryAttempts: {},
  previewRetryQueue: {},
  mediaRetryMax: 3,
};
const cappedPreviewTimer = { interval: 0, restart() {} };
for (let i = 0; i < 10; i++) {
  scheduleRetry(cappedPreviewRoot, cappedPreviewTimer, "p" + i, false, "C");
}
ok(
  Object.keys(cappedPreviewRoot.previewRetryQueue).length === 3 &&
    cappedPreviewRoot.previewRetryQueue.p9 !== undefined &&
    cappedPreviewRoot.previewRetryQueue.p0 === undefined &&
    Object.keys(cappedPreviewRoot.previewRetryAttempts).length === 3,
  "the preview replay queue and its attempt counters cap together",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.scheduleImageRetry = () => false;
e.root.pending = { 6: { cmd: "image", msgId: "https://example.com/a.png" } };
e.onReply(
  JSON.stringify({ id: 6, ok: false, error: "媒體請求過多，請稍後再試" }),
);
ok(
  e.root.imagePaths["https://example.com/a.png"] === "",
  "an exhausted public-image retry publishes the visible failure sentinel",
);
e = makeEnv({ activeChat: { mid: "C1" } });
e.root.messages = [{
  id: "m1",
  chat: "C1",
  contentType: "IMAGE",
  hasMedia: true,
}, { id: "m2", chat: "C1", text: "keep" }];
e.root.previewRequests = { m1: true };
e.root.atBottom = true;
e.root.pending = {
  7: { cmd: "preview", msgId: "m1", chat: "C1", gen: e.root.historyGen },
};
e.onReply(
  JSON.stringify({ id: 7, ok: false, error: "媒體請求過多，請稍後再試" }),
);
ok(
  e.root.previewRetries.join() === "m1",
  "a media-lane refusal schedules the visible thumbnail for retry",
);
e.root.previewRequests = { m1: true };
e.root.pending = {
  8: { cmd: "preview", msgId: "m1", chat: "C1", gen: e.root.historyGen },
};
e.onReply(
  JSON.stringify({ id: 8, ok: true, data: { path: "/tmp/m1-preview" } }),
);
ok(
  e.root.messages[0].mediaPath === "/tmp/m1-preview" &&
    e.root.messages[1].text === "keep",
  "the thumbnail is merged without replacing the page",
);
ok(
  e.root.atBottom === true,
  "a thumbnail-only patch preserves follow mode for the next incoming message",
);
ok(!e.root.previewRequests.m1, "the in-flight preview flag is released");

// ------------------------------------------------- (y) Strings.js i18n
// The translation table is the same file the panel imports; these pin the
// contract the panel relies on: zh is the wire language (daemon strings and
// stored data stay zh), en is display-only.

group("(y1) Strings.t / Strings.fmt cover both languages and every key");
{
  const keys = Object.keys(Strings.STRINGS);
  ok(keys.length > 60, "the table is not a stub: " + keys.length + " keys");
  let missing = [];
  for (const k of keys) {
    const row = Strings.STRINGS[k];
    if (typeof row.zh !== "string" || typeof row.en !== "string")
      missing.push(k);
  }
  ok(
    missing.length === 0,
    "every key has both zh and en" +
      (missing.length ? " — missing: " + missing.join(",") : ""),
  );
  ok(
    Strings.t("read.all", "zh") === "已讀" &&
      Strings.t("read.all", "en") === "Read",
    "t() returns each language's own string",
  );
  ok(Strings.t("no.such.key", "en") === "no.such.key",
    "an unknown key falls back to the key itself, never a crash");
  ok(
    Strings.fmt("read.n", "zh", 3) === "已讀 3" &&
      Strings.fmt("read.n", "en", 3) === "Read 3",
    "fmt() interpolates %1 positionally in both languages",
  );
  ok(
    Strings.fmt("day.ymd", "en", 2024, 1, 3) === "1/3/2024" &&
      Strings.fmt("day.ymd", "zh", 2024, 1, 3) === "2024年1月3日",
    "fmt() can reorder arguments across languages",
  );
}

group("(y2) normalizeLang maps the setting enum to zh/en");
{
  ok(
    Strings.normalizeLang("繁體中文", "en_US.UTF-8") === "zh" &&
      Strings.normalizeLang("English", "zh_TW.UTF-8") === "en",
    "an explicit pick beats the system locale, in both directions",
  );
  ok(
    Strings.normalizeLang("System", "zh_TW.UTF-8") === "zh" &&
      Strings.normalizeLang("System", "en_US.UTF-8") === "en" &&
      Strings.normalizeLang("System", "") === "en",
    "System follows the locale, defaulting to English",
  );
}

group("(y3) err() translates daemon wire strings for display only");
{
  ok(
    Strings.err("尚未登入", "zh") === "尚未登入" &&
      Strings.err("尚未登入", "en") === "Not logged in",
    "zh display is untouched; en display translates the wire string",
  );
  ok(
    Strings.err("同步失敗：timeout", "en") === "Sync failed: timeout",
    "a prefixed wire error keeps its tail",
  );
  ok(
    Strings.err("已隱藏 · 我: [貼圖]", "en") === "Hidden · me: [Sticker]",
    "wire tokens embedded in a composed row are translated in place",
  );
  ok(
    Strings.err("我們家的群組", "en") === "我們家的群組",
    "a bare 我 inside user text is never touched",
  );
  ok(
    Strings.err("some English error", "en") === "some English error",
    "an unknown string passes through unchanged",
  );
  ok(
    Strings.err(undefined, "en") === "" && Strings.err(null, "en") === "",
    "missing errors stay empty, not 'undefined'",
  );
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
