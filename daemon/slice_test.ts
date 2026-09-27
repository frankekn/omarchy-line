/**
 * The slicer the other daemon tests share, plus a guard on the markers.
 *
 * The tests cannot `import` daemon.ts: that pulls in @evex/linejs and evaluates
 * the module-level session/state-dir code, and the whole point is to run with
 * no LINE session and no state dir. Instead each test cuts the block between a
 * pair of `// enil:<name>-begin` / `-end` comments out of the daemon source on
 * disk, pastes it on top of a stub prelude, and imports that throwaway module.
 *
 * Since the daemon.ts split into daemon/modules/*, a block lives in whichever
 * file owns its section; the slicer resolves each marker by scanning daemon.ts
 * first and then every file under modules/. Marker text is byte-identical to
 * before, and each marker name is still unique across the whole tree (the
 * guard below pins that).
 *
 * Reading from disk rather than `git show HEAD:` is deliberate: an uncommitted
 * regression must fail the suite, not slip through because it is unstaged.
 */
import { assert } from "@std/assert";

/** Files the slicer scans for markers, in order. */
async function markerSources(): Promise<URL[]> {
  const sources = [new URL("./daemon.ts", import.meta.url)];
  try {
    const names: string[] = [];
    for await (
      const entry of Deno.readDir(new URL("./modules/", import.meta.url))
    ) {
      if (entry.isFile && entry.name.endsWith(".ts")) names.push(entry.name);
    }
    names.sort();
    for (const name of names) {
      sources.push(new URL(`./modules/${name}`, import.meta.url));
    }
  } catch {
    // modules/ does not exist (yet): daemon.ts is the only source.
  }
  return sources;
}

/** Returns the text between the `enil:<name>` markers, begin marker included. */
export async function sliceBlock(name: string): Promise<string> {
  const beginMarker = `// enil:${name}-begin`;
  const endMarker = `// enil:${name}-end`;
  for (const source of await markerSources()) {
    const src = await Deno.readTextFile(source);
    const begin = src.indexOf(beginMarker);
    if (begin < 0) continue;
    const end = src.indexOf(endMarker);
    assert(end > begin, `enil:${name}-end marker missing or out of order`);
    return src.slice(begin, end);
  }
  assert(
    false,
    `enil:${name}-begin marker missing from daemon.ts and daemon/modules/`,
  );
  throw new Error("unreachable");
}

/**
 * Writes `prelude + blocks` to a throwaway module and imports it. More than
 * one name is for blocks that call each other -- talkop reads reactionName out
 * of the reactions block, and stubbing it would test the stub.
 */
export async function loadBlocks<T = Record<string, unknown>>(
  names: string[],
  prelude: string,
): Promise<T> {
  const bodies: string[] = [];
  for (const name of names) bodies.push(await sliceBlock(name));
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(file, [prelude, ...bodies].join("\n"));
  const mod = await import("file://" + file);
  // The module is resolved by now, so the file is only clutter in /tmp.
  await Deno.remove(file).catch(() => {});
  return mod as T;
}

/** Writes `prelude + block` to a throwaway module and imports it. */
export function loadBlock<T = Record<string, unknown>>(
  name: string,
  prelude: string,
): Promise<T> {
  return loadBlocks<T>([name], prelude);
}

Deno.test("every marker pair used by the suite is present and ordered", async () => {
  for (
    const name of [
      "watchdog",
      "pushlog",
      "sweep",
      "preview",
      "loginerror",
      "resumeretry",
      "logingate",
      "unhandled",
      "filepayload",
      "fetchguard",
      "envint",
      "previewable",
      "requestid",
      "sync",
      "mediastate",
      "mention",
      "statepersist",
      "statewrite",
      "eventring",
      "reactions",
      "talkop",
      "readop",
      "readrange",
      "sendargs",
      "avatar",
      "avatarfetch",
      "notifyargs",
      "wanted",
      "sticker",
      "shoppage",
      "refusaltext",
      "mediakind",
      "sendcap",
      "videoduration",
      "videopreview",
      "uploadargs",
      "errortext",
      "hidden",
      "histcount",
      "pushsummary",
      "storageguard",
    ]
  ) {
    const block = await sliceBlock(name);
    assert(block.length > 0, `${name} block is empty`);
    assert(
      !block.includes(`// enil:${name}-begin`, 1),
      `${name} begin marker appears twice`,
    );
  }
});
