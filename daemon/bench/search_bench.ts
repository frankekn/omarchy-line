/** Message search benchmark: a synthetic store of 121 chats and 100,000
 * messages, then a few `search` scans timed end to end.
 *
 * Half of the lines are shaped like Letter-Sealed history lines (chunks as
 * tagged Buffer JSON, no text), half like plain or pushed text lines; one
 * chat holds 20,000 messages so the largest-file cost shows up too. The
 * event-loop column is the longest gap a 1 ms interval timer saw while the
 * scan ran -- how long other daemon work would have waited.
 *
 * Run:
 *
 *   cd daemon && deno task bench:search
 */
import { searchMessages } from "../modules/search.ts";

const ME = "u" + "0".repeat(31) + "1";
const CHATS = 121;
const TOTAL = 100_000;
const BIG = 20_000;
const WORDS = [
  "晚上",
  "吃飯",
  "會議",
  "deploy",
  "release",
  "明天",
  "記得",
  "帶傘",
  "hello",
  "thanks",
  "週末",
  "報告",
];

function chatMid(i: number): string {
  return "c" + i.toString(16).padStart(32, "0");
}

function text(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) parts.push(WORDS[(n * 7 + i * 13) % 12]);
  return parts.join(" ") + ` #${n}`;
}

function line(chat: string, n: number): string {
  const base = {
    chatMid: chat,
    from: "u" + (n % 50).toString(16).padStart(32, "0"),
    to: chat,
    toType: "GROUP",
    id: String(18_000_000_000_000 + n),
    createdTime: 1_700_000_000_000 + n * 1000,
    deliveredTime: 1_700_000_000_000 + n * 1000,
    contentType: "NONE",
    hasContent: false,
    sessionId: 0,
  };
  if (n % 2) {
    const data = Array.from({ length: 64 }, (_, i) => (n + i) % 256);
    return JSON.stringify({
      ...base,
      contentMetadata: { e2eeVersion: "2", seq: String(n) },
      chunks: [0, 1, 2, 3, 4].map(() => ({ type: "Buffer", data })),
    });
  }
  return JSON.stringify({ ...base, contentMetadata: {}, text: text(n) });
}

const dir = await Deno.makeTempDir({ prefix: "enil-search-bench-" });
try {
  const root = `${dir}/messages`;
  await Deno.mkdir(`${root}/${ME}`, { recursive: true });
  let n = 0, bytes = 0;
  const order: string[] = [];
  for (let c = 0; c < CHATS; c++) {
    const chat = chatMid(c);
    order.push(chat);
    const count = c === 0 ? BIG : Math.floor((TOTAL - BIG) / (CHATS - 1)) +
      (c <= (TOTAL - BIG) % (CHATS - 1) ? 1 : 0);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(line(chat, n++));
    const body = lines.join("\n") + "\n";
    bytes += body.length;
    await Deno.writeTextFile(`${root}/${ME}/${chat}.jsonl`, body);
  }
  console.log(
    `store: ${CHATS} chats, ${n} messages, ${(bytes / 1e6).toFixed(1)} MB`,
  );
  const deps = { root, myMid: ME, order, isHidden: () => false };
  for (
    const [label, q] of [
      ["common CJK", "吃飯"],
      ["common ASCII, mixed case", "DePlOy"],
      ["rare", "#99998"],
      ["absent", "zzzz不存在"],
    ]
  ) {
    for (let run = 0; run < 3; run++) {
      let last = performance.now(), worst = 0;
      const timer = setInterval(() => {
        const at = performance.now();
        worst = Math.max(worst, at - last);
        last = at;
      }, 1);
      const start = performance.now();
      const r = await searchMessages(deps, {
        q,
        chat: "",
        limit: 30,
        before: 0,
      });
      const took = performance.now() - start;
      clearInterval(timer);
      console.log(
        `${label.padEnd(26)} run ${run + 1}: ${
          took.toFixed(0).padStart(5)
        } ms` +
          `  hits ${r.hits.length}  partial ${r.partial}` +
          `  scanned ${r.scanned}  longest loop gap ${worst.toFixed(0)} ms`,
      );
    }
  }
} finally {
  await Deno.remove(dir, { recursive: true });
}
