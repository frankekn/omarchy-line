// Run every web suite, or the suites named on the command line.
import { runSuite } from "./harness.js";
import { main } from "./main.js";
import { edge } from "./edge.js";
import { media } from "./media.js";
import { mentions } from "./mentions.js";
import { account } from "./account.js";
import { read } from "./read.js";
import { reconcile } from "./reconcile.js";
import { parity } from "./parity.js";
import { review } from "./review.js";
import { a11y } from "./a11y.js";
import { parityFixes } from "./parity-fixes.js";
import { stateWire } from "./state-wire.js";
import { stateWireResync } from "./state-wire-resync.js";
import { previewCache } from "./preview-cache.js";
import { drafts } from "./drafts.js";

const suites = {
  main,
  edge,
  media,
  mentions,
  account,
  read,
  reconcile,
  parity,
  review,
  a11y,
  "parity-fixes": parityFixes,
  "state-wire": stateWire,
  "state-wire-resync": stateWireResync,
  "preview-cache": previewCache,
  drafts,
};
const selected = Deno.args.length ? Deno.args : Object.keys(suites);
for (const name of selected) {
  if (!Object.hasOwn(suites, name)) throw new Error(`Unknown suite: ${name}`);
}
let failed = 0;
for (const name of selected) {
  try {
    await runSuite(name, suites[name]);
  } catch {
    failed++;
  }
}
if (failed) Deno.exit(1);
