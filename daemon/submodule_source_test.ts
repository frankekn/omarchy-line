import { assertEquals } from "@std/assert";

const EXPECTED_SOURCE = "url = https://github.com/frankekn/linejs.git";

Deno.test("linejs submodule stays on the public project fork", async () => {
  const config = await Deno.readTextFile(
    new URL("../.gitmodules", import.meta.url),
  );
  const urls = config.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("url = "));
  assertEquals(urls, [EXPECTED_SOURCE]);
});
