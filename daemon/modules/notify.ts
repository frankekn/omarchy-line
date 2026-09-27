/**
 * Desktop notifications: the notify-send argv builder (enil:notifyargs
 * block), the per-chat burst dedup, the bounded icon wait on the avatar
 * fetcher, and the toast action that hands the clicked chat to the panel via
 * state.json (openChat) before raising the shell panel.
 *
 * Dependency direction: imports from below -- avatars (avatarSoon), names
 * (resolveName), state (isHidden, setWanted, writeState), caches (isMe),
 * session. socket.ts reports panel opens/closes through the accessors here.
 */
import { avatarNow, avatarTokens, resolveAvatar } from "./avatars.ts";
import { isMe } from "./caches.ts";
import { resolveName } from "./names.ts";
import { isHidden, setWanted, writeState } from "./state.ts";
import { sessionIsCurrent } from "./session.ts";
import { errorLine } from "./text.ts";
import type { Client } from "@evex/linejs";
import type { TalkMsg } from "./types.ts";

// The block between the enil:notifyargs markers is sliced out verbatim by
// daemon/notify_test.ts, so it must stay self-contained: the two constants
// belong to it.
// enil:notifyargs-begin
/**
 * The libnotify action identifier omarchy's notification shell invokes when a
 * toast is clicked (shell/plugins/notifications/Service.qml:376). It has to be
 * exactly this string -- anything else and the shell falls through to focusing
 * the sending app by window class, which finds nothing -- the panel is a layer
 * surface, not a window.
 */
const NOTIFY_ACTION = "default";
const NOTIFY_ACTION_LABEL = "開啟";

/**
 * argv for one toast.
 *
 * `--` before the text because notify-send parses with GOption, which permutes
 * argv: a name or a message starting with "-" would be read as a flag (exit 1,
 * or a usage dump). `--action` implies `--wait`, so passing it is also what
 * decides that the child outlives this call -- an action is only invokable
 * while the sender is alive.
 */
function notifyArgs(summary: string, body: string, icon?: string): string[] {
  const args = ["--app-name=LINE"];
  if (icon) args.push(`--icon=${icon}`);
  args.push(`--action=${NOTIFY_ACTION}=${NOTIFY_ACTION_LABEL}`);
  args.push("--", summary, body);
  return args;
}
// enil:notifyargs-end

// The panel is "open" exactly when a client holds the socket (Panel.qml binds
// its Socket.connected to the popup), so anything we would notify about is
// already on screen.
let panelConnections = 0;

// Bursts (a photo album, a split-up sentence) arrive as separate events; one
// popup per chat per window is enough to know something came in.
const NOTIFY_WINDOW_MS = 2_000;
const lastNotified = new Map<string, number>();
let notifySendMissing = false;

// notify-send only exits once the toast is gone, and a server configured to
// keep one forever would otherwise leave a child per message for the life of
// the daemon.
const NOTIFY_WAIT_MS = 10 * 60_000;
// How long a toast is willing to wait for a picture it does not have yet. A
// notification that arrives two minutes late because a CDN was slow is worse
// than one with no icon.
const NOTIFY_ICON_WAIT_MS = 3_000;

// Panel.qml's `ipcTarget`; `open` is on the base Panel's IpcHandler.
const PANEL_IPC_TARGET = "io.github.frankekn.line";

const NOTIFY_PLACEHOLDER: Record<string, string> = {
  STICKER: "[貼圖]",
  IMAGE: "[圖片]",
  VIDEO: "[影片]",
  AUDIO: "[語音]",
  FILE: "[檔案]",
};

/** The cached picture, or a bounded wait for one that is being fetched. */
async function avatarSoon(
  mid: string,
  ms: number,
  owner: Client,
  generation: number,
): Promise<string | undefined> {
  const cached = avatarNow(mid, owner, generation);
  if (cached) return cached;
  const token = avatarTokens.get(mid);
  if (!token) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveAvatar(mid, token, owner, generation).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What a clicked toast does: raise the panel, and say which conversation the
 * click was about. Two steps because the shell's IPC can only open the panel;
 * the chat travels through state.json, which the panel is already watching.
 * The write goes first so the hand-off is on disk before the panel is up.
 */
function openChat(chatMid: string): void {
  setWanted(chatMid);
  void writeState();
  try {
    const child = new Deno.Command("omarchy-shell", {
      args: [PANEL_IPC_TARGET, "open"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    // Awaited only to close the child out; a shell that is not running is a
    // nonzero exit, and the hand-off is already written either way.
    void child.status.catch(() => {});
  } catch (e) {
    console.error("[notify] open:", errorLine(e));
  }
}

async function notify(
  msg: TalkMsg,
  owner: Client,
  generation: number,
): Promise<void> {
  try {
    // logout() nulls `client` before the pusher is fully torn down, so the old
    // pusher can still emit a message here; resolveName() assumes a client.
    if (!sessionIsCurrent(owner, generation)) return;
    if (panelConnections > 0 || notifySendMissing) return;
    const raw = msg?.raw ?? {};
    const from = String(raw.from ?? "");
    // isMyMessage reads client.base.profile.mid -- a second source for the
    // same question, in case getMyProfile() failed and me.mid is empty.
    if (!from || isMe(from) || msg.isMyMessage) return;

    // toType is USER only for 1:1, where `to` is *us*; the chat the panel
    // knows is keyed by the other party instead.
    const toType = String(raw.toType ?? "");
    const oneToOne = toType === "USER" || toType === "0";
    const chatMid = oneToOne ? from : String(raw.to ?? "");
    if (!chatMid) return;
    // A hidden conversation is silent on purpose: it is off the list, its
    // unread is out of the bar's number, and a toast would be the one thing
    // still saying "look at me" about a row the user took away. It also stays
    // hidden -- nothing in this path calls setHidden().
    if (isHidden(chatMid)) return;

    const now = Date.now();
    const prev = lastNotified.get(chatMid) ?? 0;
    if (now - prev < NOTIFY_WINDOW_MS) return;
    if (!sessionIsCurrent(owner, generation)) return;
    lastNotified.set(chatMid, now);

    const contentType = String(raw.contentType ?? "NONE");
    // An undecrypted E2EE payload is just an empty text, so the placeholder
    // below covers it as well as the non-text content types.
    let body = String(msg.text ?? "") ||
      NOTIFY_PLACEHOLDER[contentType] || "[新訊息]";

    const summary = await resolveName(chatMid, owner, generation);
    if (!sessionIsCurrent(owner, generation)) return;
    // In a group the summary is the room, so the body has to say who spoke;
    // for 1:1 the summary is already the sender and a prefix would repeat it.
    if (!oneToOne) {
      body = `${await resolveName(from, owner, generation)}: ${body}`;
      if (!sessionIsCurrent(owner, generation)) return;
    }
    // resolveName() above is what put the picture token in reach, so this is
    // the first moment the icon can be asked for at all.
    const icon = await avatarSoon(
      chatMid,
      NOTIFY_ICON_WAIT_MS,
      owner,
      generation,
    );
    if (!sessionIsCurrent(owner, generation)) return;
    const child = new Deno.Command("notify-send", {
      args: notifyArgs(summary, body, icon),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    // The child lives as long as the toast does, which is the point -- but a
    // toast nobody dismisses must not become a permanent process.
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
    }, NOTIFY_WAIT_MS);
    let out;
    try {
      out = await child.output();
    } finally {
      clearTimeout(killer);
    }
    // notify-send prints the chosen action's name and nothing else.
    if (new TextDecoder().decode(out.stdout).trim() === NOTIFY_ACTION) {
      if (!sessionIsCurrent(owner, generation)) return;
      openChat(chatMid);
    }
  } catch (e) {
    // A missing notify-send would otherwise log once per incoming message.
    if (e instanceof Deno.errors.NotFound) {
      notifySendMissing = true;
      console.error("[notify] notify-send not found; notifications disabled");
    } else {
      console.error("[notify]", (e as Error).message);
    }
  }
}

/** serve() counts panel connections; notifications stay quiet while one is
 * open. The reassignments live here because the counter is declared here. */
export function notePanelOpened(): void {
  panelConnections++;
}

export function notePanelClosed(): void {
  panelConnections--;
}

export {
  avatarSoon,
  lastNotified,
  notify,
  notifyArgs,
  openChat,
  panelConnections,
  setWanted,
};
