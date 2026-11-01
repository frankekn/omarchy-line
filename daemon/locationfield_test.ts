import { assertEquals } from "@std/assert";
import { audioLengthOf, locationOf } from "./modules/messages.ts";

Deno.test("locationOf keeps the title, address and position", () => {
  assertEquals(
    locationOf({
      title: " Taipei 101 ",
      address: "No. 7, Section 5, Xinyi Road",
      latitude: 25.033964,
      longitude: 121.564468,
      phone: "",
      categoryId: "",
    }),
    {
      title: "Taipei 101",
      address: "No. 7, Section 5, Xinyi Road",
      latitude: 25.033964,
      longitude: 121.564468,
    },
  );
});

Deno.test("locationOf allows a place without a title or address", () => {
  assertEquals(locationOf({ latitude: 0, longitude: 0 }), {
    title: "",
    address: "",
    latitude: 0,
    longitude: 0,
  });
});

Deno.test("locationOf refuses a missing or impossible position", () => {
  assertEquals(locationOf(undefined), null);
  assertEquals(locationOf("25,121"), null);
  assertEquals(locationOf({ title: "No position" }), null);
  assertEquals(locationOf({ latitude: null, longitude: 121 }), null);
  assertEquals(locationOf({ latitude: "x", longitude: 121 }), null);
  assertEquals(locationOf({ latitude: 91, longitude: 121 }), null);
  assertEquals(locationOf({ latitude: 25, longitude: -181 }), null);
  assertEquals(locationOf({ latitude: 25, longitude: Infinity }), null);
});

Deno.test("locationOf drops non-string text fields", () => {
  assertEquals(
    locationOf({ title: 5, address: { x: 1 }, latitude: "1.5", longitude: 2 }),
    { title: "", address: "", latitude: 1.5, longitude: 2 },
  );
});

Deno.test("audioLengthOf reads AUDLEN, then DURATION", () => {
  assertEquals(audioLengthOf({ AUDLEN: "3456" }), 3456);
  assertEquals(audioLengthOf({ DURATION: "1200.4" }), 1200);
  assertEquals(audioLengthOf({ AUDLEN: "0", DURATION: "900" }), 900);
  assertEquals(audioLengthOf({ AUDLEN: "abc" }), undefined);
  assertEquals(audioLengthOf({}), undefined);
});
