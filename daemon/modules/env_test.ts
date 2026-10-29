/** State paths must agree with the shell permission flags even for empty XDG. */
import { assertEquals } from "@std/assert";

Deno.test("an empty XDG_STATE_HOME falls back to the home state directory", async () => {
  const moduleUrl = new URL("./env.ts", import.meta.url).href;
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--frozen",
      `import { STATE_DIR } from ${
        JSON.stringify(moduleUrl)
      }; console.log(STATE_DIR);`,
    ],
    env: { XDG_STATE_HOME: "" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  assertEquals(
    new TextDecoder().decode(out.stdout).trim(),
    `${Deno.env.get("HOME")}/.local/state/enil`,
  );
});
