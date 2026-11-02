// Temporary CI proof: verify the regression fails without tail-size retention.
import { assert, runSuite } from "./harness.js";
import { readingNavigation } from "./reading-navigation.js";

const root = new URL("../../daemon/web/public/js/", import.meta.url);
let app = await Deno.readTextFile(new URL("app.js", root));
app = app.replace(
  "  model = createModel();",
  "  model = createModel();\nglobalThis.__followModel = model;",
).replace("ctx = finish();", "ctx = finish();\nglobalThis.__followCtx = ctx;");
const view = await Deno.readTextFile(new URL("view-messages.js", root));
const marker = "    if (order.at(-1) !== keys.at(-1)) {";
assert.equal(view.split(marker).length, 2);
// Keep navigation setup intact; disable retention for the tail experiment.
const withoutFix = view.replace(
  marker,
  "    if (model.messages.length < 199 && order.at(-1) !== keys.at(-1)) {",
);
await runSuite("tail-negative-control", async (h) => {
  let control, reproduced = false;
  try {
    await readingNavigation(h, async (context) => {
      control = context;
      await context.route(
        "**/js/app.js",
        (route) => route.fulfill({ contentType: "text/javascript", body: app }),
      );
      await context.route(
        "**/js/view-messages.js",
        (route) =>
          route.fulfill({ contentType: "text/javascript", body: withoutFix }),
      );
    });
  } catch (error) {
    let result;
    try {
      result = JSON.parse(error.message);
    } catch {
      throw error;
    }
    assert.ok(result.before.height > 150);
    assert.equal(result.after.height, 100);
    assert.ok(result.after.scrollHeight < result.before.scrollHeight);
    reproduced = true;
    console.log("  expected native size loss", JSON.stringify(result));
  } finally {
    await control?.close();
  }
  assert.equal(
    reproduced,
    true,
    "the negative control must reproduce size loss",
  );
});
