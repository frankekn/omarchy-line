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

const suites = {
  main,
  edge,
  media,
  mentions,
  account,
  read,
  reconcile,
  parity,
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
