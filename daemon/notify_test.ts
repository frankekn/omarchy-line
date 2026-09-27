/**
 * The two halves of click-to-open: the argv a toast is spawned with, and the
 * hand-off it leaves in state.json when the user clicks it.
 *
 * Nothing here spawns anything. What is worth pinning is the shape: the
 * action has to be named exactly `default` or omarchy's notification shell
 * will not invoke it, and every piece of user text has to be its own argv
 * entry behind a `--` or notify-send's GOption parser will read it as a flag.
 *
 *   deno test -A notify_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const ARGS_PRELUDE = `
export { NOTIFY_ACTION, NOTIFY_ACTION_LABEL, notifyArgs };
`;
const WANTED_PRELUDE = `
export { setWanted, wanted, wantedSeq };
`;

interface NotifyArgsModule {
  NOTIFY_ACTION: string;
  NOTIFY_ACTION_LABEL: string;
  notifyArgs(name: string, body: string, icon?: string): string[];
}
interface Wanted {
  chat: string;
  at: number;
  seq: number;
}
interface WantedModule {
  wanted: Wanted | null;
  setWanted(chat: string, at?: number): Wanted;
}
let A: NotifyArgsModule | undefined;
async function args(): Promise<NotifyArgsModule> {
  if (!A) A = await loadBlock<NotifyArgsModule>("notifyargs", ARGS_PRELUDE);
  return A;
}

Deno.test("the action is named exactly what the shell invokes", async () => {
  const m = await args();
  // Service.qml:376 compares action.identifier against this literal; any
  // other name and a click falls through to focusing a window that does not
  // exist, so the toast silently does nothing.
  assertEquals(m.NOTIFY_ACTION, "default");
  const argv = m.notifyArgs("媽", "記得帶傘");
  assert(
    argv.includes(`--action=default=${m.NOTIFY_ACTION_LABEL}`),
    argv.join(" "),
  );
});

Deno.test("the text always comes after --, as its own two entries", async () => {
  const m = await args();
  const argv = m.notifyArgs("媽", "記得帶傘");
  const sep = argv.indexOf("--");
  assert(sep >= 0, "no -- separator");
  assertEquals(argv.slice(sep + 1), ["媽", "記得帶傘"]);
  // Every flag is before it, so nothing the user typed can be read as one.
  assert(
    argv.slice(0, sep).every((a: string) => a.startsWith("--")),
    argv.join(" "),
  );
});

Deno.test("a name or a message that looks like a flag is still text", async () => {
  const m = await args();
  const argv = m.notifyArgs("--urgency=critical", "-h boolean:x:true");
  const sep = argv.indexOf("--");
  assertEquals(argv.slice(sep + 1), [
    "--urgency=critical",
    "-h boolean:x:true",
  ]);
});

Deno.test("nothing is quoted, joined or escaped: there is no shell", async () => {
  const m = await args();
  const body = 'rm -rf $HOME; echo "oops" && `whoami` | tee /tmp/x';
  const argv = m.notifyArgs("a b; c", body);
  // One entry in, one entry out -- the proof that this argv goes to
  // Deno.Command and not through /bin/sh.
  assertEquals(argv[argv.length - 1], body);
  assertEquals(argv[argv.length - 2], "a b; c");
  assertEquals(argv.filter((a: string) => a === body).length, 1);
});

Deno.test("the icon flag is there only when there is a picture", async () => {
  const m = await args();
  const path = "/home/x/.local/state/enil/media/avatars/deadbeef.jpg";
  const withIcon = m.notifyArgs("媽", "嗨", path);
  assertEquals(withIcon[1], `--icon=${path}`);
  assert(withIcon.indexOf(`--icon=${path}`) < withIcon.indexOf("--"));
  // A picture that has not been fetched yet is not an empty --icon=: notify-send
  // takes that as a stock icon name and warns about it once per message.
  for (const none of [undefined, ""]) {
    const argv = m.notifyArgs("媽", "嗨", none);
    assert(
      argv.every((a: string) => !a.startsWith("--icon")),
      argv.join(" "),
    );
  }
  // The app name is first either way, so the shell groups LINE's toasts.
  assertEquals(withIcon[0], "--app-name=LINE");
});

Deno.test("the click hand-off names the chat and never repeats a seq", async () => {
  const m = await loadBlock<WantedModule>("wanted", WANTED_PRELUDE);
  assertEquals(m.wanted, null, "nothing is wanted before a click");
  const first = m.setWanted("cabc", 1_700_000_000_000);
  assertEquals(first, { chat: "cabc", at: 1_700_000_000_000, seq: 1 });
  // Clicking the same chat's second toast is a second hand-off: the panel
  // tells them apart by seq, so reusing one would be ignored as already done.
  const second = m.setWanted("cabc", 1_700_000_000_001);
  assertEquals(second.seq, 2);
  assertEquals(m.setWanted("udef").seq, 3);
  // `at` defaults to now rather than staying unset, because the panel shows
  // its own "opened from a notification" only for a recent one.
  assert(Math.abs(m.setWanted("udef").at - Date.now()) < 5_000);
});
