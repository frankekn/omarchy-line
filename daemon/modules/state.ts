/**
 * The daemon's persisted state and the session-shape bindings the state file
 * publishes: the atomic state.json writer with its epoch invalidation and
 * write throttle (statepersist/statewrite), the event ring (eventring), the
 * notification hand-off (wanted), the hidden-conversations preference
 * (hidden), the talk-side refresh health tracker, and `login`/`me`/`link`/
 * `chats`/`chatsRevision`/`chatListHealth` -- the fields writeState() copies
 * into every snapshot.
 *
 * Dependency direction: imports env (paths, trackers, boot id) and text
 * (errorLine); nothing above it reads daemon state. Every other module reads
 * these bindings and calls these functions. The reassignment accessors
 * (setMe, setLink, setChats, bumpChatsRevision, setChatListHealth, clearEvents,
 * clearWanted, setLoginState) exist because an imported ESM binding cannot be
 * assigned from outside its module; each wraps exactly the assignment it
 * replaced, in the caller's order, so values and timing are unchanged.
 */
import { RefreshHealthState } from "../refreshcontrol.ts";
import { createChatSummaryStore } from "../chatsummary.ts";
import { CHAT_LIMIT } from "./env.ts";
import {
  BOOT_ID,
  EVENTS_PATH,
  HIDDEN_PATH,
  STATE_PATH,
  stateWriteBytes,
  timings,
} from "./env.ts";
import { errorLine } from "./text.ts";
import type { Json, PluginChat, PluginEvent } from "./types.ts";

// ------------------------------------------------------------------ events

// The block between the enil:eventring markers is sliced out verbatim by
// daemon/events_test.ts on top of a stub scheduleStateWrite; the ring and the
// counter are declared inside it for the same reason.
// enil:eventring-begin
/**
 * How much of the recent past a panel that was closed can catch up on without
 * re-fetching history, and how far a resubscribing socket can replay. Every
 * entry carries a whole PluginMessage, so this is also the cap on how large
 * the persisted `events` array can grow.
 */
const EVENTS_MAX = 200;
let events: PluginEvent[] = [];
/** Strictly increasing within one process; `bootId` is what survives a restart. */
let eventSeq = 0;
/**
 * Optional live delivery: socket.ts wires its panel broadcast here so an
 * open panel hears the event in under a millisecond instead of waiting for
 * the events.json flush, the inotify hop and a half-megabyte re-parse. The
 * file ring stays the catch-up layer for panels that were closed; pushed
 * seqs simply advance its watermark, so the two paths never double-apply.
 */
let eventSink: ((e: PluginEvent) => void) | null = null;

function setEventSink(sink: typeof eventSink): void {
  eventSink = sink;
}

/** Appends one event, drops what falls off the ring, and publishes it. */
function pushEvent(e: Omit<PluginEvent, "seq" | "at">): PluginEvent {
  const full: PluginEvent = { seq: ++eventSeq, at: Date.now(), ...e };
  // A history event carries a whole page; only the newest one per chat has
  // any meaning, so its predecessors leave the ring instead of piling up
  // sixty-message payloads in it.
  if (full.kind === "history") {
    events = events.filter((ev) =>
      !(ev.kind === "history" && ev.chat === full.chat)
    );
  }
  events.push(full);
  // Slice rather than shift-in-a-loop: the array is replaced wholesale on
  // every write anyway, and this keeps the trim O(1) in statements.
  if (events.length > EVENTS_MAX) events = events.slice(-EVENTS_MAX);
  scheduleEventsWrite();
  // Live delivery is best-effort: a stalled or disconnected panel is caught
  // by the file ring + seq gap detection, so a broadcast failure must never
  // reach the op pipeline.
  try {
    eventSink?.(full);
  } catch {
    // ignored -- the ring is the durable copy
  }
  return full;
}
// enil:eventring-end

/**
 * The ring's own file. Kept apart from state.json because every entry can
 * carry a whole PluginMessage -- 200 of them dwarf the rest of the state --
 * and the panel re-parses whatever file changed. Splitting it means the hot
 * event stream never forces a re-parse of the chat list and friends.
 *
 * Same 250ms coalescing as state.json: an album burst is still one write.
 */
let eventsWriting: Promise<void> = Promise.resolve();
let lastEventsWriteAt = 0;
let eventsWriteTimer: ReturnType<typeof setTimeout> | null = null;

function writeEventsFile(): void {
  if (stateWritesBlocked) return;
  lastEventsWriteAt = Date.now();
  const epoch = stateEpoch;
  const snapshot = JSON.stringify(
    { bootId: BOOT_ID, events, updatedAt: Date.now() },
  );
  eventsWriting = eventsWriting.then(async () => {
    // A queued write must not resurrect a ring clearEvents already emptied.
    if (epoch !== stateEpoch || epoch < stateInvalidationTarget) return;
    const tmp = `${EVENTS_PATH}.tmp`;
    await Deno.writeTextFile(tmp, snapshot);
    await Deno.rename(tmp, EVENTS_PATH);
  }).catch((e) => console.error("[state] events write failed:", e));
}

function scheduleEventsWrite(now: number = Date.now()): void {
  if (eventsWriteTimer !== null) return; // one is already owed
  const due = lastEventsWriteAt + STATE_WRITE_MIN_MS;
  if (now >= due) {
    writeEventsFile();
    return;
  }
  eventsWriteTimer = setTimeout(() => {
    eventsWriteTimer = null;
    writeEventsFile();
  }, due - now);
}

// The block between the enil:wanted markers is sliced out verbatim by
// daemon/notify_test.ts, so it keeps its own counter and reaches for nothing
// else.
// enil:wanted-begin
/**
 * Which conversation a clicked notification was about.
 *
 * The shell can only be told to *open* the panel -- its IpcHandler exposes
 * open/close/toggle and nothing more (omarchy shell/Ui/Panel.qml:48) -- so the
 * chat has to travel the other way, through the file the panel already
 * watches. The panel honours a hand-off it has not seen before and remembers
 * the `seq`; `seq` is strictly increasing inside one process, so a second
 * click on the same chat is still a new hand-off, and `bootId` next to it says
 * when the counter started over.
 */
interface PluginWanted {
  chat: string;
  at: number;
  seq: number;
}

let wanted: PluginWanted | null = null;
let wantedSeq = 0;

function setWanted(chat: string, at: number = Date.now()): PluginWanted {
  wanted = { chat, at, seq: ++wantedSeq };
  return wanted;
}
// enil:wanted-end

// The block between the enil:hidden markers is sliced out verbatim by
// daemon/hidden_test.ts, so it must stay self-contained: HIDDEN_PATH and
// errorLine() are the only two names it reaches for, and the test supplies
// both.
// enil:hidden-begin
/**
 * The conversations the user has taken off the list, on this machine only.
 *
 * LINE has no such flag: `updateChat`'s ChatAttribute enumerates the name, the
 * picture, the notification setting and the favourite mark, and nothing else,
 * so there is no field to set and nothing to sync. (`deleteSelfFromChat` is
 * not it either -- that leaves the group for real, on every device.) So this
 * is a local preference, kept next to the other daemon-owned files.
 *
 * Frank chose the quiet reading of it (2026-09-09): a hidden chat stays hidden
 * when a message arrives, does not raise a toast, and does not count towards
 * the bar's unread number. Nothing here ever removes a mid on its own -- only
 * `unhide` does.
 */
const HIDDEN_MAX = 1000;
const hiddenMids = new Set<string>();
let hiddenWriting = Promise.resolve();

/** Insertion order is age order in a Set too, so the first is the oldest. */
function capHidden(): void {
  while (hiddenMids.size > HIDDEN_MAX) {
    const oldest = hiddenMids.values().next().value;
    if (oldest === undefined) return;
    hiddenMids.delete(oldest);
  }
}

function isHidden(mid: string): boolean {
  return hiddenMids.has(mid);
}

/** Returns whether anything moved, so a repeated hide costs no disk write. */
function setHidden(mid: string, on: boolean): boolean {
  if (on === hiddenMids.has(mid)) return false;
  if (on) {
    hiddenMids.add(mid);
    capHidden();
  } else {
    hiddenMids.delete(mid);
  }
  return true;
}

/**
 * The only place `hidden` is put on a chat row, and only on the hidden ones:
 * an older panel build must not have to know what `hidden: false` means.
 *
 * Stamped at write time rather than stored on the PluginChat objects because
 * summaryCache hands the same object back on the next refresh -- a flag
 * written during a refresh would go stale the moment hide/unhide moved it.
 */
function hiddenStamped<T extends { mid: string }>(list: T[]): T[] {
  if (hiddenMids.size === 0) return list;
  return list.map((c) => hiddenMids.has(c.mid) ? { ...c, hidden: true } : c);
}

/** Serialised like writeState(): two clicks must not share one temp file. */
function saveHidden(path: string = HIDDEN_PATH): Promise<void> {
  hiddenWriting = hiddenWriting.then(async () => {
    // Read inside the queue, not snapshotted before it. Unlike state.json --
    // which publishes the moment it was asked for, updatedAt and all -- this
    // file is only ever "the set as it is now", so a queued write has no
    // reason to carry an older one: two back-to-back clicks would otherwise
    // put the first click's set on disk first, and a kill landing between the
    // two writes would leave the file a click behind the panel.
    const blob = JSON.stringify({ mids: [...hiddenMids] });
    const tmp = `${path}.${Deno.pid}.tmp`;
    const handle = await Deno.open(tmp, {
      write: true,
      create: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      const bytes = new TextEncoder().encode(blob);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await handle.write(bytes.subarray(offset));
        if (written <= 0) throw new Error("hidden file accepted no bytes");
        offset += written;
      }
      await handle.sync();
    } finally {
      handle.close();
    }
    await Deno.rename(tmp, path); // atomic, like every other file we own
  }).catch((e) => {
    // Losing the file costs the user hiding a row again, never a message, so
    // it is a log line and not a refusal.
    console.error("[hidden] write failed:", errorLine(e));
  });
  return hiddenWriting;
}

async function loadHidden(path: string = HIDDEN_PATH): Promise<void> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // No file yet, or one we cannot read. Starting with nothing hidden is the
    // recoverable answer -- a daemon that refused to boot over a preferences
    // file would take the whole chat list down with it.
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Same recoverable answer, but say so: silently forgetting the hidden
    // rows looked exactly like the user unhiding everything.
    console.error("[hidden] unreadable file:", errorLine(e));
    return;
  }
  const mids = (parsed as { mids?: unknown } | null)?.mids;
  if (!Array.isArray(mids)) return;
  for (const mid of mids) {
    if (typeof mid === "string" && mid) hiddenMids.add(mid);
  }
  capHidden();
}
// enil:hidden-end

// enil:statepersist-begin
let writing = Promise.resolve();
// Invalidates snapshots queued by an ended session before they reach disk.
// Logout advances it synchronously, before its first await.
let stateEpoch = 0;
let stateInvalidationTarget = 0;
let stateWritesBlocked = false;
// Byte length, not code units: chat text is mostly CJK, so `.length` would
// understate what the panel re-parses on every file-watch hit. One encoder,
// reused across writes.
const textEncoder = new TextEncoder();

function blockStateWrites(): void {
  stateWritesBlocked = true;
}

function releaseStateWrites(): void {
  stateWritesBlocked = false;
}

async function invalidateStateWrites(): Promise<void> {
  const target = Math.max(stateEpoch, stateInvalidationTarget) + 1;
  // Queued snapshots see this synchronously and stop before writing. A rename
  // already in progress is covered by `writing`; invalidation does not finish
  // until that atomic commit has finished, so it cannot land afterward.
  stateInvalidationTarget = target;
  await writing;
  stateEpoch = Math.max(stateEpoch, target);
}

function writeState(): Promise<void> {
  // Logout keeps this barrier raised across remote token revocation and every
  // local cache reset. Background heartbeats may still run during those
  // awaits, but they must not publish a half-retired session.
  if (stateWritesBlocked) return writing;
  const epoch = stateEpoch;
  // Capture session-owned state at the call site. Timing samples are added at
  // the actual write point below, after older queued writes have completed.
  const stateSnapshot = {
    bootId: BOOT_ID,
    me,
    login,
    chats: chats.map((chat) => ({ ...chat })),
    chatsRevision,
    ...(chatListHealth ? { chatList: chatListHealth } : {}),
    ...(link ? { link } : {}),
    ...(refreshHealthValue() ? { refresh: refreshHealthValue() } : {}),
    ...(wanted ? { wanted } : {}),
  };
  // Every path to disk goes through here, so this is where the rate limiter
  // below learns that a write just happened -- including the ones it did not
  // schedule (heartbeat, login edges, refreshChats).
  noteStateWritten();
  // Serialised so two rapid updates cannot interleave their temp files.
  writing = writing.then(async () => {
    if (epoch !== stateEpoch || epoch < stateInvalidationTarget) return;
    const timingSnapshot = timings.snapshot();
    // stateBytes lags one write, exactly like timings: this write's own size
    // is not knowable until the text below exists, so the block carries the
    // window as of the previous write and the new sample rides the next one.
    const sizeSnapshot = stateWriteBytes.snapshot();
    const snapshot = JSON.stringify(
      {
        ...stateSnapshot,
        // Hidden chats are a local preference and may change while this
        // snapshot waits behind an older disk write. Stamp the current set at
        // the serialization point so a queued write cannot restore an old
        // preference for one state-file cycle.
        chats: hiddenStamped(stateSnapshot.chats),
        updatedAt: Date.now(),
        ...(Object.keys(timingSnapshot).length
          ? { timings: timingSnapshot }
          : {}),
        ...(sizeSnapshot
          ? {
            // `chats` is this file's own row count at the serialization
            // point, not a windowed stat -- it describes the array above.
            stateBytes: {
              ...sizeSnapshot,
              chats: stateSnapshot.chats.length,
            },
          }
          : {}),
      },
      null,
      2,
    );
    const started = performance.now();
    // Pid-suffixed tmp: belt and braces behind the single-instance gate
    // (modules/instance.ts) -- two writers must never rename a half-written
    // file onto each other's state.
    const tmp = `${STATE_PATH}.${Deno.pid}.tmp`;
    const bytes = textEncoder.encode(snapshot);
    let committed = false;
    try {
      const handle = await Deno.open(tmp, {
        write: true,
        create: true,
        truncate: true,
        mode: 0o600,
      });
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = await handle.write(bytes.subarray(offset));
          if (written <= 0) throw new Error("state file accepted no bytes");
          offset += written;
        }
        // Durable before the name exists. Rename is atomic for the watcher,
        // but without this a power loss can leave a fresh state.json whose
        // bytes never made it to the platter.
        await handle.sync();
      } finally {
        handle.close();
      }
      if (epoch !== stateEpoch || epoch < stateInvalidationTarget) {
        await Deno.remove(tmp).catch(() => {});
        return;
      }
      await Deno.rename(tmp, STATE_PATH); // atomic: the plugin watches this
      committed = true;
    } finally {
      if (committed) {
        timings.record("state.write", performance.now() - started);
        // Sampled where the text exists, committed writes only: the window
        // describes files that actually reached disk.
        stateWriteBytes.record(bytes.byteLength);
      }
    }
  }).catch((e) => console.error("[state] write failed:", e));
  return writing;
}
// enil:statepersist-end

function setLogin(status: string, extra: Json = {}) {
  login = { status, ...extra };
  console.log(`[login] ${status}`, extra.error ?? "");
  return writeState();
}

// The block between the enil:statewrite markers is sliced out verbatim by
// daemon/events_test.ts on top of a stub writeState, so it must keep its own
// timer state and reach for nothing else.
// enil:statewrite-begin
/**
 * Four writes a second. A photo album lands as a burst of push events and each
 * one wants the file on disk, but the panel re-reads and re-parses the whole
 * state.json on every change -- one write per event would make it do that
 * twenty times for one album.
 */
const STATE_WRITE_MIN_MS = 250;
let lastStateWriteAt = 0;
let stateWriteTimer: ReturnType<typeof setTimeout> | null = null;

/** Called by writeState() itself; a queued write is redundant after one. */
function noteStateWritten(now: number = Date.now()): void {
  lastStateWriteAt = now;
  cancelStateWrite();
}

/** Cancels the trailing write when its session has just been retired. */
function cancelStateWrite(): void {
  if (stateWriteTimer !== null) {
    clearTimeout(stateWriteTimer);
    stateWriteTimer = null;
  }
}

/** Writes now if the quota allows, otherwise leaves one write queued. */
function scheduleStateWrite(now: number = Date.now()): void {
  if (stateWriteTimer !== null) return; // one is already owed
  const due = lastStateWriteAt + STATE_WRITE_MIN_MS;
  if (now >= due) {
    writeState();
    return;
  }
  stateWriteTimer = setTimeout(() => {
    stateWriteTimer = null;
    writeState();
  }, due - now);
}
// enil:statewrite-end

let login: Json = { status: "idle", settled: false };

/**
 * Push-link health, mirrored into state.json so the panel can tell "daemon up
 * but LINE unreachable" from "all fine". null while there is no session, which
 * is why it is optional in the contract. Written on edges only -- a ping every
 * 30s must not rewrite the file.
 */
let link: Json | null = null;

let me: Json = {};
let chats: PluginChat[] = [];
let chatsRevision = 0;
let chatListHealth: { complete: boolean; loaded: number } | null = null;

const refreshHealthState = new RefreshHealthState({
  writeState: () => void writeState(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
});

function refreshHealthValue() {
  return refreshHealthState.value;
}

function noteRefreshOk(now: number = Date.now()): void {
  refreshHealthState.succeed(now);
}

function noteRefreshFailed(
  reason: "token_expired" | "network" | "unknown",
  now: number = Date.now(),
): void {
  refreshHealthState.fail(reason, now);
}

function clearRefreshHealth(): void {
  refreshHealthState.clear();
}

// The chat summary cache (moved verbatim beside the state it caps) and the
// incremental-round bookkeeping: the dirty set and the full-round switch.
const chatSummaryStore = createChatSummaryStore({ chatLimit: CHAT_LIMIT });
// The versions map is the one piece of the state that never rebinds, so a
// local name for it is stable for the process lifetime.
const { chatSummaryVersions } = chatSummaryStore;

/**
 * One dirty-set entry: the local path that already rendered the change, plus
 * the unread debt the push path booked for this chat (see onIncomingMessage).
 * An unsend never books debt -- a recall does not change unread -- but it
 * leaves debt a push booked earlier standing.
 */
interface DirtyMid {
  reason: "message" | "unsend";
  /** Messages shown by a push but not yet counted; the round pays them. */
  pending: number;
}

// Chats a push or a recall touched since the last round finished, with the
// local path that already rendered the change: "message" published a summary
// in onIncomingMessage, "unsend" drew the tombstone in onTalkOp. The
// incremental round re-reads only these. Last write wins on the reason, so a
// chat that saw both goes the API way -- its fresh fetch renders whichever
// content is current, tombstone included.
const dirtyMids = new Map<string, DirtyMid>();

/** setLogin's raw sibling: assigns the login snapshot without logging or
 * writing, for main()'s pre-resume transient mark. */
export function setLoginState(next: Json): void {
  login = next;
}

/** Login owns the me edges; see the module doc above. */
export function setMe(next: Json): void {
  me = next;
}

/** Edge writer for the push-link health field. */
export function setLink(next: Json | null): void {
  link = next;
}

/** Publishes a rebuilt chat list. */
export function setChats(next: PluginChat[]): void {
  chats = next;
}

/**
 * Subscribed panels get a changed chat row the moment the revision moves, so
 * the list repaint does not wait on the file throttle. Callers that rebuilt
 * the whole list (refresh rounds, logout) pass nothing -- that scale of
 * change still arrives through state.json.
 */
let chatSink: ((row: PluginChat, revision: number) => void) | null = null;

function setChatSink(
  sink: ((row: PluginChat, revision: number) => void) | null,
): void {
  chatSink = sink;
}

/** The panel invalidates its list rendering off this counter. */
export function bumpChatsRevision(changed?: PluginChat): void {
  chatsRevision++;
  // `hidden` lives on the serialized copy, not the stored row; stamp it before
  // the row leaves the process or a hidden chat would resurface for a beat.
  if (changed) chatSink?.(hiddenStamped([changed])[0], chatsRevision);
}

/** Published together with chats. */
export function setChatListHealth(
  next: { complete: boolean; loaded: number } | null,
): void {
  chatListHealth = next;
}

/** Logout empties the ring; eventSeq deliberately keeps counting. */
export function clearEvents(): void {
  events = [];
  scheduleEventsWrite();
}

/** A hand-off into a retired session must not survive logout. */
export function clearWanted(): void {
  wanted = null;
}

export {
  blockStateWrites,
  cancelStateWrite,
  chatListHealth,
  chats,
  chatsRevision,
  chatSummaryStore,
  chatSummaryVersions,
  clearRefreshHealth,
  dirtyMids,
  events,
  eventSeq,
  hiddenStamped,
  invalidateStateWrites,
  isHidden,
  link,
  loadHidden,
  login,
  me,
  noteRefreshFailed,
  noteRefreshOk,
  noteStateWritten,
  pushEvent,
  refreshHealthState,
  refreshHealthValue,
  releaseStateWrites,
  saveHidden,
  scheduleStateWrite,
  setChatSink,
  setEventSink,
  setHidden,
  setLogin,
  setWanted,
  writeState,
};
export type { DirtyMid };

export type { PluginEvent };
