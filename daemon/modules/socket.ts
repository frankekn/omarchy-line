/**
 * The panel socket: handle() dispatches every command the panel sends (with
 * the per-command guards and refusals the Panel.qml contract dictates), wrap
 * converts raw thrift messages for the download/preview paths, serve/
 * servePanel accept unix-socket connections through panelserver.ts, and the
 * media lane's retirement signal keeps a retired session's queued work from
 * touching the new one.
 *
 * Dependency direction: socket.ts sits on top -- it imports everything below
 * it (login for startLogin/logout/syncNow, refresh, messages, media-send,
 * stickers, push, names, caches, state, session, notify, env, text, protocol,
 * panelserver) and nothing imports from it, so the dependency graph closes
 * one-way into main().
 */
import { pooledMap } from "../pool.ts";
import {
  PANEL_BACKGROUND_COMMANDS,
  PANEL_MESSAGE_COMMANDS,
  PANEL_MUTATION_COMMANDS,
  PANEL_SESSION_INDEPENDENT_COMMANDS,
  servePanelConnection,
} from "../panelserver.ts";
import {
  classifyLoginError,
  downloadErrorText,
  ENCODE_ERROR,
  errorLine,
  errorText,
  EXPIRED_ERROR,
  mediaStateFrom,
  NET_DOWN_TEXT,
  TOKEN_EXPIRED_TEXT,
  UNSENT_ERROR,
} from "./text.ts";
import {
  claimClipboardStageBinding,
  CLIPBOARD_STAGE_TTL_MS,
  clipboardStage,
  clipboardStageSessions,
  DECRYPT_WIDTH,
  discardBoundClipboardStage,
  discardClipboardStage,
  expireClipboardStage,
  imageCache,
  MEDIA_DIR,
  panelMediaLane,
  panelMediaRetirementSignal,
  sendClipboardImageRequest,
  timings,
  wlPaste,
} from "./env.ts";
import {
  cursors,
  isMe,
  memberCache,
  MEMBERS_TTL_MS,
  midKind,
  readRanges,
  rememberPaginationCursor,
  unsentBeforePublication,
} from "./caches.ts";
import { cacheMedia, toPluginMessage } from "./messages.ts";
import {
  bumpChatsRevision,
  login,
  saveHidden,
  setHidden,
  writeState,
} from "./state.ts";
import { loadReadRange } from "./push.ts";
import { refreshChats, setForceFullRefresh } from "./refresh.ts";
import { notePanelClosed, notePanelOpened } from "./notify.ts";
import type { Client } from "@evex/linejs";
import { TalkMessage } from "@evex/linejs";
import type { Json, PluginMember, PluginMessage, TalkMsg } from "./types.ts";
import { resolveName, warmNames } from "./names.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import {
  asMessageId,
  buildMentionMeta,
  panelRequestId,
  previewableMessage,
  REACTION_PICKABLE,
} from "./protocol.ts";
import { fileTargetRefusal, sendArgs, sendFilePath } from "./media-send.ts";
import {
  sendSticker,
  stickerListRefusal,
  stickerPackages,
} from "./stickers.ts";
import { loginOperation, logout, startLogin, syncNow } from "./login.ts";
// enil:histcount-begin
/** What `count` means when the caller did not say. */
const HISTORY_COUNT = 30;
/**
 * The most messages one `history` call will ask LINE for. The panel's own
 * setting stops at 200 too; this is the other half of that pair, because the
 * panel is not the only thing that can open the socket and `messagesCount`
 * went straight into the LINE request with no bound at all -- a hand-typed
 * `{"cmd":"history","count":100000}` was a request for a hundred thousand
 * messages, and a negative or fractional one was a malformed request LINE has
 * no reason to answer politely.
 */
const HISTORY_COUNT_MAX = 200;

/**
 * A page size the request can carry. A choice is a JSON number, or a string
 * that parses as one; anything else -- a boolean, an array, an object, a
 * blank string -- means "the caller did not choose", so the default stands
 * (that is the same rule envInt uses, which throws `""` away too). A number
 * that is merely out of range IS a choice, just one we cannot honour, so it
 * is clamped rather than thrown away. Rounded because messagesCount is a
 * count -- 60.5 is not one.
 *
 * The type test is the whole point: `Number()` answers 0 for `""`, `" "`,
 * `[]` and `false`, and 60 for `[60]`, so coercing first sent a blank count
 * to the clamp's floor and asked LINE for one message where README and
 * stub.py both say 30.
 */
function historyCount(value: unknown): number {
  if (typeof value === "string") {
    if (value.trim() === "") return HISTORY_COUNT;
  } else if (typeof value !== "number") {
    return HISTORY_COUNT;
  }
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return HISTORY_COUNT;
  return Math.max(1, Math.min(HISTORY_COUNT_MAX, n));
}
// enil:histcount-end

async function handle(req: Json, signal?: AbortSignal): Promise<Json> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const cmd = String(req.cmd ?? "");
  const requestId = panelRequestId(req);

  if (cmd === "login") {
    if (client) return { ok: true };
    // startLogin() must not be awaited: on the happy path it runs for as long
    // as the QR stays on screen. But its gate is claimed in the first
    // statement, before any await, so a refusal -- and only a refusal -- is
    // already settled on the promise by the time it is handed back here.
    // Racing it against a plain value reads that without waiting for a login
    // that did start. Silence was the bug: a click landing while the resume
    // retry held the gate got {ok:true} and then nothing ever happened.
    const outcome = await Promise.race([startLogin(), "running"]);
    // Same wording as the logout branch below: to the panel it is the same
    // situation, a login already under way that it has to wait out.
    if (outcome === false) return { ok: false, error: "登入中，請稍候" };
    return { ok: true };
  }

  // Before the guard: logging out while logged out is a no-op, not an error.
  if (cmd === "logout") {
    // A QR/PIN login is a long-running loginWithQR we cannot cancel. Dropping
    // to "idle" underneath it would show the login button again, and a click
    // would start a second login against the same storage file.
    if (
      loginOperation !== "resume" && loginOperation !== "logout" &&
      ["starting", "qr", "pin"].includes(String(login.status))
    ) {
      return { ok: false, error: "登入中，請稍候" };
    }
    return await logout();
  }

  // Before the guard, so there is exactly one gate for sync rather than a live
  // one here and a dead copy inside syncNow(): the copy is what sync_test.ts
  // drives, and a gate no production path can reach is a gate nobody trusts.
  if (cmd === "sync") return await syncNow();

  // Before the guard: hiding is a preference in a file of ours, not a call to
  // LINE, so a session that is still coming up (or gone) is no reason to
  // refuse it. Idempotent both ways -- the panel sends whichever of the two
  // the row is not already in, and a second click must not become an error.
  if (cmd === "hide" || cmd === "unhide") {
    const mid = String(req.chat ?? "");
    if (!mid) return { ok: false, error: "沒有指定是哪一間聊天室" };
    // Nothing moved: the file on disk already says this, and state.json is
    // already stamped from the same set.
    if (!setHidden(mid, cmd === "hide")) return { ok: true };
    bumpChatsRevision();
    await saveHidden();
    await writeState();
    return { ok: true };
  }

  // A probe result can arrive after the panel moved to another chat. Let that
  // panel release the staged clipboard file without requiring a live LINE
  // session; clipboardStagePath confines deletion to daemon-created stages.
  if (cmd === "discardClipboardImage") {
    await discardClipboardStage(MEDIA_DIR, String(req.stage ?? ""));
    return { ok: true };
  }

  if (!client) return { ok: false, error: "尚未登入" };
  const owner = client;
  const generation = sessionGeneration;

  if (cmd === "image") {
    try {
      const url = String(req.url ?? "");
      const path = await imageCache.get(url, req.invalidate === true, signal);
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "尚未登入" };
      }
      return {
        ok: true,
        data: { path },
      };
    } catch {
      return { ok: false, error: "圖片下載失敗" };
    }
  }

  if (cmd === "history") {
    const chatMid = String(req.chat ?? "");
    const count = historyCount(req.count);
    const before = req.before ? String(req.before) : "";
    const end = before ? cursors.get(before) : cursors.get(`box:${chatMid}`);
    if (!end || end.chat !== chatMid) {
      return { ok: false, error: "沒有這個聊天室的游標" };
    }

    // Once per open, not once per page: this is the only moment 已讀 can be
    // put on a bubble, and after it the read ops keep it current -- paging
    // back through a year of history must not pay a round trip per page.
    if (!before || !readRanges.has(chatMid)) {
      await loadReadRange(chatMid, owner, generation);
    }
    if (!sessionIsCurrent(owner, generation)) {
      return { ok: false, error: "尚未登入" };
    }

    const raws = await owner.base.talk.getPreviousMessagesV2WithRequest({
      request: {
        messageBoxId: chatMid,
        endMessageId: {
          messageId: end.messageId,
          deliveredTime: end.deliveredTime,
        },
        messagesCount: count,
      },
    });
    if (!sessionIsCurrent(owner, generation)) {
      return { ok: false, error: "尚未登入" };
    }

    const out: PluginMessage[] = [];
    // LINE returns newest-first; the panel renders oldest at the top. Reversed
    // here rather than after the loop so the loop itself runs oldest-first: a
    // reply is always newer than what it quotes, and replySources is filled as
    // it goes, so the other order would leave every same-page reply with an id
    // and no quoted line.
    raws.reverse();
    if (raws.length) {
      rememberPaginationCursor(chatMid, String(raws[0].id ?? ""));
    }
    // The decrypt-heavy wraps run through a bounded pool: fromRawTalk does
    // the E2EE work itself (no manual decryptE2EEMessage -- decrypting twice
    // just redoes the same work off the still-present chunks), and the items
    // are independent. The conversion below stays sequential on purpose:
    // toPluginMessage reads replySources that earlier same-page messages
    // write, so a reply's quoted line only exists once its target has been
    // converted. A dead session stops admitting wraps via the guard, and
    // the loop's check turns that into the same 尚未登入 refusal.
    const wrapped = await pooledMap(
      raws,
      DECRYPT_WIDTH,
      (raw) => wrap(raw, owner),
      () => sessionIsCurrent(owner, generation),
    );
    if (wrapped === null) {
      return { ok: false, error: "尚未登入" };
    }
    for (const tm of wrapped) {
      // Return text and metadata before any media transfer. Visible image
      // delegates request their thumbnail separately.
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "尚未登入" };
      }
      out.push(
        await toPluginMessage(tm, chatMid, false, owner, generation),
      );
    }

    if (req.markRead && out.length) {
      const newest = out[out.length - 1];
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "尚未登入" };
      }
      const seq = await owner.base.getReqseq();
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "尚未登入" };
      }
      await owner.base.talk.sendChatChecked({
        chatMid,
        lastMessageId: newest.id,
        seq,
      }).catch((e: Error) => console.error("[read]", e.message));
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "尚未登入" };
      }
      // Reading the chat moved the server's unread count, and no per-box
      // source can tell the incremental round by how much -- the full round's
      // box.unreadCount is the only authority there is.
      setForceFullRefresh(true);
      refreshChats();
    }

    return { ok: true, data: out };
  }

  if (cmd === "members") {
    const chatMid = String(req.chat ?? "");
    // A 1:1 box has no member list, and the panel never opens the picker in
    // one; answering with an empty array instead would look like a group
    // whose members could not be read.
    if (!chatMid || midKind(chatMid) === "user") {
      return { ok: false, error: "這不是群組，沒有成員名單" };
    }
    const hit = memberCache.get(chatMid);
    if (hit && Date.now() - hit.at < MEMBERS_TTL_MS) {
      return { ok: true, data: hit.list };
    }
    // getChat asks withMembers (client/client.ts:374-381), and the mids are
    // the keys of extra.groupExtra.memberMids (mid -> join time). Chat itself
    // exposes no accessor for them, so this reaches into raw. A room (r...)
    // comes back through the same call as a ROOM-typed Chat, but nothing
    // promises the server fills groupExtra for one -- hence a refusal rather
    // than an empty picker that reads as "this group has nobody in it".
    const chat = await owner.getChat(chatMid);
    if (!sessionIsCurrent(owner, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    const group = chat?.raw?.extra?.groupExtra;
    const mids: string[] = group?.memberMids
      ? Object.keys(group.memberMids)
      : [];
    if (!mids.length) {
      return {
        ok: false,
        error: chatMid.startsWith("r")
          ? "多人聊天室（room）拿不到成員名單"
          : "這個聊天室沒有成員名單",
      };
    }
    await warmNames(mids);
    const list: PluginMember[] = [];
    for (const mid of mids) {
      // Yourself is never in the picker: LINE does not notify you of your own
      // mention, so the row would be a way to type a name and nothing else.
      if (isMe(mid)) continue;
      list.push({ mid, name: await resolveName(mid, owner, generation) });
      if (!sessionIsCurrent(owner, generation)) {
        return { ok: false, error: "尚未登入" };
      }
    }
    // Sorted by name so the picker's order is the same on every open, and so
    // the panel never has to sort a list it is filtering as the user types.
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    if (!sessionIsCurrent(owner, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    memberCache.set(chatMid, { at: Date.now(), list });
    return { ok: true, data: list };
  }

  // One branch, because a reply is a send with a quote: same mentions, same
  // encryption, same refusals. Splitting them left two copies of the mention
  // handling to keep in step.
  if (cmd === "send" || cmd === "reply") {
    const to = String(req.chat ?? "");
    const text = String(req.text ?? "");
    const replyTo = cmd === "reply" ? String(req.replyTo ?? "") : "";
    // Without it the message would still send, as a plain one -- silently
    // losing the quote the user chose is worse than refusing.
    if (cmd === "reply" && !replyTo) {
      return { ok: false, error: "沒有指定要回覆哪一則訊息" };
    }
    // The offsets have to be measured against the same string that is
    // encrypted, so build the metadata from `text` and not from req.text.
    const meta = buildMentionMeta(req.mentions, text);
    await owner.base.talk.sendMessage(sendArgs(
      to,
      text,
      meta,
      replyTo,
      requestId,
    ));
    if (sessionIsCurrent(owner, generation)) refreshChats();
    return { ok: true };
  }

  if (cmd === "stickers") {
    try {
      // `refresh` is the panel's button, not a cache-buster it may pass on
      // every open: a cold load is one shop call per page plus one CDN fetch
      // per owned package.
      const packages = await stickerPackages(req.refresh === true);
      return { ok: true, data: { packages } };
    } catch (e) {
      // Same shape as sync's refusal: the panel prints it, so it has to say
      // what happened in words rather than hand over a Thrift class name.
      return stickerListRefusal(e);
    }
  }

  if (cmd === "sendSticker") {
    const res = await sendSticker(req, stickerPackages, (args) => {
      // Read at send time rather than captured above: the owned list may have
      // to be loaded first, and a logout inside that window must not go out
      // on the session it just dropped. Same words as the gate above,
      // because to the panel it is the same situation.
      if (!sessionIsCurrent(owner, generation)) throw new Error("尚未登入");
      return owner.base.talk.sendMessage(args);
    }, requestId);
    // No local event, same as `send`: LINE pushes our own sticker back down.
    if (res.ok && sessionIsCurrent(owner, generation)) refreshChats();
    return res;
  }

  if (cmd === "react") {
    const messageId = String(req.messageId ?? "");
    const type = String(req.type ?? "").toUpperCase();
    // ALL is a query filter in LINE's enum, not something a person can pick.
    if (!REACTION_PICKABLE.includes(type)) {
      return { ok: false, error: "不支援的表情" };
    }
    const id = asMessageId(messageId);
    if (id === null) return { ok: false, error: "訊息 id 不對" };
    // base.talk.react builds the ReactRequest itself and the enum writer maps
    // the name to its number (base/thrift/readwrite/struct.ts:1200). It also
    // hardcodes reqSeq 0, which is what every linejs caller sends today.
    type Reaction = Parameters<typeof owner.base.talk.react>[0]["reaction"];
    await owner.base.talk.react({ id, reaction: type as Reaction });
    if (sessionIsCurrent(owner, generation)) refreshChats();
    return { ok: true };
  }

  if (cmd === "unsend") {
    const messageId = String(req.messageId ?? "");
    const cursor = cursors.get(messageId);
    if (!cursor) return { ok: false, error: "訊息不在快取裡" };
    // TalkMessage.unsend refuses this as well (client/features/message/talk.ts
    // :154), but only once it holds a TalkMessage -- which costs the fetch
    // that builds one. The sender is already on the cursor.
    if (!isMe(String(cursor.from ?? ""))) {
      return { ok: false, error: "只能收回自己傳的訊息" };
    }
    const seq = await owner.base.getReqseq();
    if (!sessionIsCurrent(owner, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    await owner.base.talk.unsendMessage({
      seq,
      messageId,
    });
    // No local event: LINE echoes the recall back as DESTROY_MESSAGE, and
    // pushing one here would draw the bubble away twice.
    if (sessionIsCurrent(owner, generation)) refreshChats();
    return { ok: true };
  }

  if (cmd === "sendFile") {
    return await sendFilePath(
      String(req.chat ?? ""),
      String(req.path ?? ""),
      owner,
      generation,
      requestId,
    );
  }

  if (cmd === "probeClipboardImage") {
    const to = String(req.chat ?? "");
    // Checked before wl-paste runs: a chat we cannot send to is no reason to
    // go and read the user's clipboard.
    const bad = fileTargetRefusal(to);
    if (bad) return bad;
    const result = await clipboardStage(
      MEDIA_DIR,
      crypto.randomUUID(),
      wlPaste,
    );
    const stage = String((result.data as Json | undefined)?.stage ?? "");
    if (result.ok === true && stage) {
      if (!sessionIsCurrent(owner, generation)) {
        await discardClipboardStage(MEDIA_DIR, stage);
        return { ok: false, error: "尚未登入" };
      }
      clipboardStageSessions.set(stage, { owner, generation, chat: to });
      expireClipboardStage(
        MEDIA_DIR,
        stage,
        CLIPBOARD_STAGE_TTL_MS,
        setTimeout,
        async (_dir, expiredStage) =>
          await discardBoundClipboardStage(expiredStage),
      );
    }
    return result;
  }

  if (cmd === "sendClipboardImage") {
    const to = String(req.chat ?? "");
    const stage = String(req.stage ?? "");
    if (!stage) {
      const bad = fileTargetRefusal(to);
      if (bad) return bad;
    } else {
      const claim = claimClipboardStageBinding(
        clipboardStageSessions,
        stage,
        owner,
        generation,
        to,
      );
      if (claim !== "claimed") {
        if (claim === "mismatch") {
          await discardClipboardStage(MEDIA_DIR, stage);
        }
        return { ok: false, error: "剪貼簿暫存已失效" };
      }
    }
    try {
      return await sendClipboardImageRequest(
        MEDIA_DIR,
        stage,
        crypto.randomUUID(),
        wlPaste,
        (path, filename) =>
          sendFilePath(
            to,
            path,
            owner,
            generation,
            requestId,
            filename,
          ),
      );
    } finally {
      if (stage) clipboardStageSessions.delete(stage);
    }
  }

  if (cmd === "download") {
    const c = client;
    const generation = sessionGeneration;
    if (!c) return { ok: false, error: "尚未登入" };
    const id = String(req.messageId ?? "");
    const cursor = cursors.get(id);
    if (!cursor) return { ok: false, error: "訊息不在快取裡" };
    if (cursor.chat !== String(req.chat ?? "")) {
      return { ok: false, error: "訊息不在這個聊天室" };
    }
    // Both refusals are answered from what the message already said. Asking
    // LINE first buys a round trip, a request timeout and an error text from
    // three layers down that says nothing the user can act on.
    const state = mediaStateFrom(
      !!cursor.unsent || unsentBeforePublication.has(id),
      cursor.expiresAt,
      Date.now(),
    );
    if (state === "unsent") return { ok: false, error: UNSENT_ERROR };
    if (state === "expired") return { ok: false, error: EXPIRED_ERROR };
    const raws = await c.base.talk.getPreviousMessagesV2WithRequest({
      request: {
        messageBoxId: String(req.chat ?? ""),
        endMessageId: {
          messageId: cursor.messageId,
          deliveredTime: cursor.deliveredTime,
        },
        messagesCount: 1,
      },
    });
    if (!sessionIsCurrent(c, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    if (!raws.length) return { ok: false, error: "找不到訊息" };
    const wrapped = await wrap(raws[0], c);
    const cached = await cacheMedia(wrapped, id, false, false, signal);
    if (!sessionIsCurrent(c, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    const current = cursors.get(id) ?? cursor;
    const currentState = mediaStateFrom(
      !!current.unsent || unsentBeforePublication.has(id),
      current.expiresAt,
      Date.now(),
    );
    if (currentState === "unsent") return { ok: false, error: UNSENT_ERROR };
    if (currentState === "expired") return { ok: false, error: EXPIRED_ERROR };
    return "path" in cached
      ? { ok: true, data: { path: cached.path } }
      : { ok: false, error: downloadErrorText(cached.error) };
  }

  if (cmd === "preview") {
    const c = client;
    const generation = sessionGeneration;
    if (!c) return { ok: false, error: "尚未登入" };
    const id = String(req.messageId ?? "");
    const cursor = cursors.get(id);
    if (!cursor) return { ok: false, error: "訊息不在快取裡" };
    if (cursor.chat !== String(req.chat ?? "")) {
      return { ok: false, error: "訊息不在這個聊天室" };
    }
    const state = mediaStateFrom(
      !!cursor.unsent || unsentBeforePublication.has(id),
      cursor.expiresAt,
      Date.now(),
    );
    if (state !== "ok") return { ok: false, error: "縮圖不可用" };
    const raws = await c.base.talk.getPreviousMessagesV2WithRequest({
      request: {
        messageBoxId: String(req.chat ?? ""),
        endMessageId: {
          messageId: cursor.messageId,
          deliveredTime: cursor.deliveredTime,
        },
        messagesCount: 1,
      },
    });
    if (!sessionIsCurrent(c, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    if (!raws.length) return { ok: false, error: "找不到訊息" };
    const wrapped = await wrap(raws[0], c);
    const raw = wrapped.raw;
    // An E2EE video has no cheap preview: asking for one downloads the whole
    // clip. The panel keeps its attachment placeholder for those.
    if (!previewableMessage(raw)) {
      return { ok: false, error: "縮圖不可用" };
    }
    const cached = await cacheMedia(
      wrapped,
      id,
      true,
      req.invalidate === true,
      signal,
    );
    if (!sessionIsCurrent(c, generation)) {
      return { ok: false, error: "尚未登入" };
    }
    const current = cursors.get(id) ?? cursor;
    if (
      mediaStateFrom(
        !!current.unsent || unsentBeforePublication.has(id),
        current.expiresAt,
        Date.now(),
      ) !== "ok"
    ) return { ok: false, error: "縮圖不可用" };
    return "path" in cached
      ? { ok: true, data: { path: cached.path } }
      : { ok: false, error: "縮圖下載失敗" };
  }

  return { ok: false, error: `unknown cmd: ${cmd}` };
}

/**
 * TalkMessage gives us text/getFlex/getData; the raw Thrift struct does not.
 * fromRawTalk decrypts E2EE payloads itself, so callers hand it the raw
 * message -- but it *throws* when decryption fails, which would drop a whole
 * page of history, so fall back to the plain constructor the library also
 * exposes (`new TalkMessage({ client, raw })`) and let toPluginMessage flag it.
 */
async function wrap(
  raw: TalkMessage["raw"],
  owner: Client,
): Promise<TalkMsg> {
  try {
    return await TalkMessage.fromRawTalk(raw, owner);
  } catch {
    return new TalkMessage({ client: owner, raw });
  }
}

async function serve(conn: Deno.Conn): Promise<void> {
  notePanelOpened();
  let live = true;
  const closePanel = () => {
    if (!live) return;
    live = false;
    notePanelClosed();
  };
  try {
    await servePanel(conn, closePanel);
  } finally {
    closePanel();
  }
}

// The block between the enil:refusaltext markers is sliced out verbatim by
// errortext_test.ts on top of errorText() and classifyLoginError().
// enil:refusaltext-begin
/** The words a thrown command failure reaches the panel with. */
function refusalText(e: unknown): string {
  const kind = classifyLoginError(e);
  if (kind === "network") return NET_DOWN_TEXT;
  if (kind === "token_expired") return TOKEN_EXPIRED_TEXT;
  return errorText(e);
}
// enil:refusaltext-end

async function servePanel(
  conn: Deno.Conn,
  onClosed: () => void = () => {},
): Promise<void> {
  await servePanelConnection(conn, {
    handle,
    lane: panelMediaLane,
    backgroundCommands: PANEL_BACKGROUND_COMMANDS,
    backgroundPriority: (cmd) => cmd === "image",
    messageCommands: PANEL_MESSAGE_COMMANDS,
    mustAdmitRequest(req) {
      const cmd = String(req.cmd ?? "");
      return PANEL_MUTATION_COMMANDS.has(cmd) ||
        (cmd === "history" && req.markRead === true);
    },
    sessionIndependentCommands: PANEL_SESSION_INDEPENDENT_COMMANDS,
    backgroundSignal: panelMediaRetirementSignal,
    onClosed,
    encodeError: ENCODE_ERROR,
    refusalText,
    captureValidity() {
      const acceptedClient = client;
      const acceptedGeneration = sessionGeneration;
      return () =>
        acceptedClient === client && acceptedGeneration === sessionGeneration;
    },
    staleRequestError: "尚未登入",
    allowStaleCommand(cmd) {
      return cmd === "logout" && client === null;
    },
    reportFailure(cmd, error, background) {
      console.error(
        `[cmd] ${cmd}${background ? " background" : ""} failed: ${
          errorLine(error)
        }`,
      );
    },
    reportEncodingFailure(cmd, error) {
      console.error(
        `[cmd] ${cmd} reply unserializable: ${(error as Error).name}`,
      );
    },
    recordTiming(key, elapsedMs) {
      timings.record(key, elapsedMs);
    },
  });
}

export { handle, serve };
