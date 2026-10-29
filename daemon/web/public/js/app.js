// Assemble the shared model, protocol services and views. Views receive actions
// through ctx.
import { makeRegistry } from "./registry.js";
import { createModel } from "./model.js";
import { createTranslator, isEnglish } from "./i18n.js";
import { createDraftStore } from "./drafts.js";
import { createConnection } from "./connection.js";
import { createStateController } from "./controller-state.js";
import { createChatController } from "./controller-chat.js";
import { createSendController } from "./controller-send.js";
import { createComposerController } from "./controller-composer.js";
import { createStickersController } from "./controller-stickers.js";
import { createUploadController } from "./controller-upload.js";
import { createLoginView } from "./view-login.js";
import { createChatsView } from "./view-chats.js";
import { createMessagesView } from "./view-messages.js";
import { createMediaView } from "./view-media.js";
import { createComposerView } from "./view-composer.js";
import { createMentionsView } from "./view-mentions.js";
import { createStickersView } from "./view-stickers.js";
import { createUploadView } from "./view-upload.js";

const language = navigator.language || "";
const english = isEnglish(language),
  t = createTranslator(language),
  model = createModel();
const { assembling, provide, finish } = makeRegistry();
let ctx = assembling;
provide("app", { model, t, english });
document.documentElement.lang = english ? "en" : "zh-Hant";
for (const node of document.querySelectorAll("[data-i18n]")) {
  node.textContent = t(node.dataset.i18n);
}
for (const node of document.querySelectorAll("[data-placeholder]")) {
  node.placeholder = t(node.dataset.placeholder);
}
for (const node of document.querySelectorAll("[data-i18n-title]")) {
  node.title = t(node.dataset.i18nTitle);
  node.setAttribute("aria-label", t(node.dataset.i18nTitle));
}
provide("view-login", createLoginView(ctx));
provide(
  "drafts",
  createDraftStore(model, undefined, () => ctx.toast(t("storageFailed"))),
);
provide("view-chats", createChatsView(ctx));
provide("view-messages", createMessagesView(ctx));
provide("view-media", createMediaView(ctx));
provide("view-composer", createComposerView(ctx));
provide("view-mentions", createMentionsView(ctx));
provide("view-stickers", createStickersView(ctx));
provide("view-upload", createUploadView(ctx));
provide("controller-state", createStateController(ctx));
provide("controller-chat", createChatController(ctx));
provide("controller-send", createSendController(ctx));
provide("controller-composer", createComposerController(ctx));
provide("controller-stickers", createStickersController(ctx));
provide("controller-upload", createUploadController(ctx));
const scheme = location.protocol === "https:" ? "wss:" : "ws:";
provide(
  "connection",
  createConnection({
    model,
    url: `${scheme}//${location.host}/api/ws`,
    offlineMessage: () => t("offlineAction"),
    errorMessage: () => t("genericError"),
    onFrame: (frame) => ctx.onFrame(frame),
    onStatus: (status) => ctx.connectionStatus(status),
    onReady: () => {
      if (model.active) ctx.loadHistory(model.active, ctx.isViewingChat());
    },
  }),
);
ctx = finish();
setInterval(() => ctx.renderNotices(), 30000);
ctx.beginSession();
