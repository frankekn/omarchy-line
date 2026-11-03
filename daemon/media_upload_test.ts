import { assert, assertEquals, assertRejects } from "@std/assert";
import { Buffer } from "node:buffer";
// @ts-types="thrift-types"
import * as thrift from "thrift";
import { Thrift } from "@evex/linejs/thrift";
import { BaseClient, InternalError } from "@evex/linejs/base";
import type { Client } from "@evex/linejs";
import { uploadMedia } from "./modules/media-upload.ts";

type Args = Parameters<typeof uploadMedia>[1];
const plainRefusal = () =>
  Object.assign(new Error("member settings off"), {
    type: "RequestError",
    data: { code: "E2EE_RETRY_PLAIN", reason: "member settings off" },
  });
const args = (oType: Args["oType"] = "file"): Args => ({
  data: new Blob(["test media"]),
  oType,
  to: "ctest",
  filename: "測試 file.pdf",
  contentMetadata: { ENIL_REQUEST_ID: "web-file-1" },
});

function harness(options: {
  negotiate?: () => Promise<unknown>;
  encrypted?: () => Promise<unknown>;
  seq?: () => Promise<number>;
  respond?: (index: number) => Response;
} = {}) {
  const requests: { url: string; init: RequestInit; headers: Headers }[] = [];
  const encrypted: Args[] = [];
  let sequences = 0;
  const owner = {
    base: {
      e2ee: {
        getE2EELocalPublicKey: options.negotiate ?? (() => Promise.resolve()),
      },
      getReqseq: () => {
        sequences++;
        return options.seq?.() ?? Promise.resolve(42);
      },
      request: { getHeader: () => ({ "X-Line-Access": "synthetic-token" }) },
      obs: {
        prefix: "https://obs.line-apps.com/",
        uploadMediaByE2EE: (input: Args) => {
          encrypted.push(input);
          return options.encrypted?.() ?? Promise.resolve();
        },
      },
      fetch: (url: RequestInfo | URL, init: RequestInit) => {
        requests.push({
          url: String(url),
          init,
          headers: new Headers(init.headers),
        });
        return Promise.resolve(
          options.respond?.(requests.length) ??
            new Response(null, {
              status: 201,
              headers: { "x-obs-oid": "123456789" },
            }),
        );
      },
    },
  } as unknown as Client;
  return { owner, requests, encrypted, sequences: () => sequences };
}

function obsParams(headers: Headers): Record<string, string> {
  return JSON.parse(
    Buffer.from(headers.get("X-Obs-Params")!, "base64").toString(),
  );
}
function messageMetadata(headers: Headers): unknown {
  const { message } = JSON.parse(
    Buffer.from(headers.get("X-Talk-Meta")!, "base64").toString(),
  );
  return new Thrift().readThriftStruct(
    Buffer.from(message, "base64"),
    thrift.TBinaryProtocol,
  )[18];
}

Deno.test("media negotiation keeps capable chats encrypted, with all upload arguments", async () => {
  const h = harness();
  const input = {
    ...args("video"),
    preview: new Blob(["jpeg"]),
    durationMs: 1234,
  };
  assertEquals(await uploadMedia(h.owner, input, () => true), { sent: true });
  assert(h.encrypted[0] === input);
  assertEquals(h.requests.length, 0);
  assertEquals(h.sequences(), 0);
});

Deno.test("member settings off selects one plain OBS send with filename, bytes and request id", async () => {
  const h = harness({ negotiate: () => Promise.reject(plainRefusal()) });
  const input = args();
  assert(input.filename);
  assertEquals(await uploadMedia(h.owner, input, () => true), { sent: true });
  assertEquals(h.encrypted, []);
  assertEquals(h.requests.length, 1);
  const { url, init, headers } = h.requests[0];
  assertEquals(url, "https://obs.line-apps.com/r/talk/m/reqseq");
  assertEquals(init.method, "POST");
  assertEquals(init.redirect, "error");
  assert(init.body === input.data);
  assertEquals(headers.get("X-Line-Access"), "synthetic-token");
  assertEquals(obsParams(headers), {
    ver: "2.0",
    oid: "reqseq",
    reqseq: "42",
    tomid: "ctest",
    type: "file",
    name: input.filename,
  });
  assertEquals(messageMetadata(headers), {
    ENIL_REQUEST_ID: "web-file-1",
    FILE_NAME: input.filename,
    FILE_SIZE: String(input.data.size),
  });
});

Deno.test("direct-contact E2EE unsupported also uses the plain upload path", async () => {
  const h = harness({
    negotiate: () =>
      Promise.reject(Object.assign(new Error("utest"), {
        type: "Not support E2EE",
      })),
  });
  await uploadMedia(h.owner, { ...args("image"), to: "utest" }, () => true);
  assertEquals(h.requests.length, 1);
  assertEquals(obsParams(h.requests[0].headers).tomid, "utest");
  assertEquals(obsParams(h.requests[0].headers).cat, "original");
});

Deno.test("a group creator's unsupported E2EE does not downgrade the group", async () => {
  let uploads = 0;
  const negotiated: string[] = [];
  const base = new BaseClient({
    device: "IOSIPAD",
    fetch: () => {
      uploads++;
      return Promise.resolve(
        new Response(null, { status: 201, headers: { "x-obs-oid": "123" } }),
      );
    },
  });
  Object.assign(base, { getReqseq: () => Promise.resolve(42) });
  Object.assign(base.talk, {
    getLastE2EEGroupSharedKey: () =>
      Promise.resolve({
        groupKeyId: 1,
        creator: "ucreator",
        creatorKeyId: 1,
        receiverKeyId: 1,
        encryptedSharedKey: Buffer.alloc(32),
      }),
    negotiateE2EEPublicKey: ({ mid }: { mid: string }) => {
      negotiated.push(mid);
      return Promise.resolve({ specVersion: -1 });
    },
  });
  Object.assign(base.e2ee, {
    getE2EESelfKeyDataByKeyId: () =>
      Promise.resolve({ privKey: Buffer.alloc(32).toString("base64") }),
  });

  const error = await assertRejects(
    () =>
      uploadMedia(
        { base } as unknown as Client,
        { ...args(), to: "cgroup" },
        () => true,
      ),
    InternalError,
    "ucreator",
  );
  assertEquals(error.type, "Not support E2EE");
  assertEquals(negotiated, ["ucreator"]);
  assertEquals(uploads, 0);
});

for (
  const error of [
    new Error("E2EE_RETRY_PLAIN in unstructured text"),
    new DOMException("timeout", "TimeoutError"),
    Object.assign(new Error("missing key"), { type: "No E2EEKey" }),
    ...["ABUSE_BLOCK", "BANNED", "EXCESSIVE_ACCESS", "NOT_AUTHORIZED_DEVICE"]
      .map(
        (code) =>
          Object.assign(new Error(code), {
            type: "RequestError",
            data: { code },
          }),
      ),
  ]
) {
  Deno.test(`negotiation failure never downgrades or sends: ${error.message}`, async () => {
    const h = harness({ negotiate: () => Promise.reject(error) });
    const caught = await assertRejects(() =>
      uploadMedia(h.owner, args(), () => true)
    );
    assert(caught === error);
    assertEquals([h.requests.length, h.encrypted.length, h.sequences()], [
      0,
      0,
      0,
    ]);
  });
}

Deno.test("an encrypted upload failure is never retried as plain, even with the fallback code", async () => {
  const error = plainRefusal();
  const h = harness({ encrypted: () => Promise.reject(error) });
  assert(
    await assertRejects(() => uploadMedia(h.owner, args(), () => true)) ===
      error,
  );
  assertEquals([h.encrypted.length, h.requests.length], [1, 0]);
});

Deno.test("plain video preserves duration and uploads its preview against the sent object", async () => {
  const h = harness({ negotiate: () => Promise.reject(plainRefusal()) });
  const input = {
    ...args("video"),
    preview: new Blob(["jpeg"]),
    durationMs: 1234.6,
  };
  assertEquals(await uploadMedia(h.owner, input, () => true), { sent: true });
  assertEquals(h.requests.length, 2);
  assertEquals(messageMetadata(h.requests[0].headers), {
    ENIL_REQUEST_ID: "web-file-1",
    FILE_NAME: input.filename,
    FILE_SIZE: String(input.data.size),
    DURATION: "1235",
  });
  assertEquals(obsParams(h.requests[0].headers).duration, "1235");
  assertEquals(
    h.requests[1].url,
    "https://obs.line-apps.com/r/talk/m/123456789__ud-preview",
  );
  assert(h.requests[1].init.body === input.preview);
  assertEquals(obsParams(h.requests[1].headers), {
    ver: "2.0",
    type: "image",
    name: "preview.jpg",
  });
  assertEquals(h.sequences(), 1);
});

Deno.test("plain GIF remains animated and ignores inapplicable duration metadata", async () => {
  const h = harness({ negotiate: () => Promise.reject(plainRefusal()) });
  await uploadMedia(h.owner, {
    ...args("gif"),
    durationMs: 500,
    contentMetadata: { DURATION: "invalid", ENIL_REQUEST_ID: "gif-1" },
  }, () => true);
  assertEquals(obsParams(h.requests[0].headers).cat, "original");
  assertEquals(obsParams(h.requests[0].headers).type, "image");
  assertEquals(messageMetadata(h.requests[0].headers), {
    ENIL_REQUEST_ID: "gif-1",
    FILE_NAME: "測試 file.pdf",
    FILE_SIZE: "10",
  });
});

Deno.test("failed main plain upload reports restrictions without leaking response content or retrying", async () => {
  const h = harness({
    negotiate: () => Promise.reject(plainRefusal()),
    respond: () =>
      new Response("EXCESSIVE_ACCESS synthetic-secret", { status: 429 }),
  });
  const error = await assertRejects(
    () => uploadMedia(h.owner, args(), () => true),
    Error,
    "HTTP 429 / EXCESSIVE_ACCESS",
  );
  assert(!String(error).includes("synthetic-secret"));
  assertEquals(h.requests.length, 1);
});

Deno.test("preview failure preserves sent success and the restriction error; no second send", async () => {
  const h = harness({
    negotiate: () => Promise.reject(plainRefusal()),
    respond: (n) =>
      n === 1
        ? new Response(null, { status: 201, headers: { "x-obs-oid": "123" } })
        : new Response("ABUSE_BLOCK", { status: 403 }),
  });
  const result = await uploadMedia(h.owner, {
    ...args("video"),
    preview: new Blob(["jpeg"]),
  }, () => true);
  assert(result.sent);
  assert(String(result.previewError).includes("ABUSE_BLOCK"));
  assertEquals([h.requests.length, h.sequences(), h.encrypted.length], [
    2,
    1,
    0,
  ]);
});

for (const plain of [false, true]) {
  Deno.test(`session change during negotiation prevents upload (plain=${plain})`, async () => {
    let current = true;
    const h = harness({
      negotiate: () => {
        current = false;
        return plain ? Promise.reject(plainRefusal()) : Promise.resolve();
      },
    });
    assertEquals(await uploadMedia(h.owner, args(), () => current), {
      sent: false,
    });
    assertEquals([h.requests.length, h.encrypted.length, h.sequences()], [
      0,
      0,
      0,
    ]);
  });
}

Deno.test("session change while reserving plain sequence prevents sending", async () => {
  let current = true;
  const h = harness({
    negotiate: () => Promise.reject(plainRefusal()),
    seq: () => {
      current = false;
      return Promise.resolve(42);
    },
  });
  assertEquals(await uploadMedia(h.owner, args(), () => current), {
    sent: false,
  });
  assertEquals(h.requests.length, 0);
});

Deno.test("logout after a successful plain send skips preview and still reports success", async () => {
  let current = true;
  const h = harness({
    negotiate: () => Promise.reject(plainRefusal()),
    respond: () => {
      current = false;
      return new Response(null, {
        status: 201,
        headers: { "x-obs-oid": "123" },
      });
    },
  });
  assertEquals(
    await uploadMedia(h.owner, {
      ...args("video"),
      preview: new Blob(["jpeg"]),
    }, () => current),
    { sent: true },
  );
  assertEquals(h.requests.length, 1);
});
