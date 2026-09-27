/** Baseline benchmark: thrift decode micro-benchmark on a pinned fixture.
 *
 * The fixture is a Message-shaped wire struct (fid-typed after the LINE talk
 * Message: i64 id/createdTime/deliveredTime, mid strings, i32 contentType,
 * nested location struct, string->string contentMetadata map, string chunks
 * list), compact-protocol encoded with the vendored fork's own writeStruct
 * and pinned below as hex. Pinning guarantees every run of this bench
 * decodes byte-identical input, so numbers stay comparable across runs and
 * machines — and a vendor wire change trips the drift guard instead of
 * silently moving the baseline.
 *
 * The decode paths exercised are the ones every live message goes through:
 * readThrift (framed, push + talk responses) and readThriftStruct
 * (struct-only) from the vendored fork's thrift readwrite reader.
 *
 * Run:
 *
 *   cd daemon && deno task bench:thrift
 *
 * Output: the fixture line (byte length + hex), per-round decode
 * throughput and a median for each path.
 */
import {
  readThrift,
  readThriftStruct,
} from "../vendor/linejs/packages/linejs/base/thrift/readwrite/read.ts";
import {
  type NestedArray,
  Protocols,
} from "../vendor/linejs/packages/linejs/base/thrift/readwrite/declares.ts";
import {
  writeStruct,
  writeThrift,
} from "../vendor/linejs/packages/linejs/base/thrift/readwrite/write.ts";

const ROUNDS = 5;
const WARMUP_OPS = 500;
const OPS_PER_ROUND = 2_000;

/** Message-shaped fixture, written with the same NestedArray convention the
 * fork's own round-trip tests use (see readwrite/write.test.ts). */
const MESSAGE_FIXTURE: NestedArray = [
  [10, 1, 918436273642123n], // id (I64, beyond safe-integer range/10)
  [11, 2, "u9a3c1f02e5d84b70a1c2d3e4f5061728"], // from mid
  [11, 3, "u4d5e6f70819a2b3c4d5e6f70819a2b3c"], // to mid
  [11, 4, "明天午後排一下時間，menu decided — see you then 👍"], // text
  [8, 5, 1], // contentType (I32, NONE)
  [10, 6, 1760000000000n], // createdTime
  [10, 7, 1760000000123n], // deliveredTime
  [2, 8, 1], // hasContent (BOOL)
  [12, 9, [ // location (STRUCT)
    [11, 1, "台北市信義區市府路45號"],
    [8, 2, 25],
    [6, 3, 121],
    [11, 4, "Taipei 101"],
    [6, 10, 0],
  ]],
  [13, 10, [11, 11, { // contentMetadata (MAP<STRING,STRING>)
    contentType: "USER",
    e2eeVersion: "2",
    chunkCount: "3",
  }]],
  [15, 11, [11, [ // chunks (LIST<STRING>)
    "first chunk of an e2ee payload",
    "second chunk of an e2ee payload",
    "third chunk of an e2ee payload",
  ]]],
  [11, 12, "918436273642100"], // relatedMessageId (STRING on this wire)
  [8, 13, 3], // readCount (I32)
  [2, 14, 0], // appExtensionType (BOOL-typed wire field)
  [10, 15, 1760000010000n], // updatedTime
];

/** Pinned compact-protocol encoding of MESSAGE_FIXTURE. A mismatch means the
 * vendor wire encoder changed and this baseline is no longer comparable:
 * re-pin the hex and re-baseline before trusting any new number. */
const PINNED_STRUCT_HEX =
  "1696eab6bd83d4a103182175396133633166303265356438346237306131633264336534" +
  "663530363137323818217534643565366637303831396132623363346435653666373038" +
  "313961326233631840e6988ee5a4a9e58d88e5be8ce68e92e4b880e4b88be69982e99693" +
  "efbc8c6d656e75206465636964656420e280942073656520796f75207468656e20f09f91" +
  "8d1502168080e682b96616f681e682b966111c1820e58fb0e58c97e5b882e4bfa1e7bea9" +
  "e58d80e5b882e5ba9ce8b7af3435e8999f153214f201180a546169706569203130316400" +
  "001b03880b636f6e74656e745479706504555345520b6532656556657273696f6e01320a" +
  "6368756e6b436f756e74013319381e6669727374206368756e6b206f6620616e20653265" +
  "65207061796c6f61641f7365636f6e64206368756e6b206f6620616e2065326565207061" +
  "796c6f61641e7468697264206368756e6b206f6620616e2065326565207061796c6f6164" +
  "180f39313834333632373336343231303015061216a09ce782b96600";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bench(label: string, decode: () => unknown): number {
  for (let i = 0; i < WARMUP_OPS; i++) decode();
  const perOpUs: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now();
    for (let i = 0; i < OPS_PER_ROUND; i++) decode();
    const wallMs = performance.now() - started;
    perOpUs.push(wallMs * 1000 / OPS_PER_ROUND);
    console.log(
      `${label} round ${round + 1}: ${
        wallMs.toFixed(1)
      } ms / ${OPS_PER_ROUND} ops = ${perOpUs[round].toFixed(2)} µs/op (${
        (OPS_PER_ROUND / (wallMs / 1000)).toFixed(0)
      } ops/sec)`,
    );
  }
  const med = median(perOpUs);
  console.log(
    `${label} median: ${med.toFixed(2)} µs/op (${
      (1000 / med).toFixed(0)
    }K ops/sec) over ${ROUNDS} rounds`,
  );
  return med;
}

const structWire = writeStruct(MESSAGE_FIXTURE, Protocols[4]);
{
  const actual = hex(structWire);
  if (PINNED_STRUCT_HEX === "") {
    throw new Error(
      `PINNED_STRUCT_HEX is empty — first run must be pinned: ${actual}`,
    );
  }
  if (actual !== PINNED_STRUCT_HEX) {
    throw new Error(
      `fixture drift: compact encoding of MESSAGE_FIXTURE changed — got ${actual} — re-pin PINNED_STRUCT_HEX and re-baseline first`,
    );
  }
}
const framedWire = writeThrift(MESSAGE_FIXTURE, "recvMessage", Protocols[4]);
{
  const sanity = readThriftStruct(structWire);
  if (typeof sanity[2] !== "string" || typeof sanity[5] !== "number") {
    throw new Error("fixture sanity check failed: decode shape unexpected");
  }
}

console.log(
  `fixture: Message-shaped wire struct, ${structWire.length} bytes struct / ${framedWire.length} bytes framed, compact protocol, hex ${
    hex(structWire)
  }`,
);
bench("readThriftStruct", () => readThriftStruct(structWire));
bench("readThrift", () => readThrift(framedWire));
