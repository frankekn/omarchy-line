/** Select media encryption before uploading; never retry an upload/send. */
import { Buffer } from "node:buffer";
// @ts-types="thrift-types"
import * as thrift from "thrift";
import type { Client } from "@evex/linejs";
import { restrictionCode } from "./text.ts";

type UploadArgs = Parameters<Client["base"]["obs"]["uploadMediaByE2EE"]>[0];

/** OBS accepts a binary Message struct inside its base64 JSON X-Talk-Meta. */
function talkMetadata(metadata: Record<string, string>): string {
  const chunks: Buffer[] = [];
  const transport = new thrift.TBufferedTransport(Buffer.from([]), (chunk) => {
    if (chunk) chunks.push(chunk);
  });
  const protocol = new thrift.TBinaryProtocol(transport);
  const { MAP, STRING } = thrift.Thrift.Type;
  protocol.writeStructBegin("Message");
  protocol.writeFieldBegin("contentMetadata", MAP, 18);
  protocol.writeMapBegin(STRING, STRING, Object.keys(metadata).length);
  for (const [key, value] of Object.entries(metadata)) {
    protocol.writeString(key);
    protocol.writeString(value);
  }
  protocol.writeMapEnd();
  protocol.writeFieldEnd();
  protocol.writeFieldStop();
  protocol.writeStructEnd();
  protocol.flush();
  transport.flush();
  return Buffer.from(JSON.stringify({
    message: Buffer.concat(chunks).toString("base64"),
  })).toString("base64");
}

function allowsPlainMedia(error: unknown, target: string): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    type?: unknown;
    message?: unknown;
    data?: { code?: unknown };
  };
  // These are linejs's explicit negotiation refusals. Network, key, auth and
  // account-restriction errors must not turn into an unencrypted send.
  // A group key lookup can also negotiate its creator's key, so this refusal
  // only applies to the upload when its MID matches the requested target.
  return (failure.type === "Not support E2EE" && failure.message === target) ||
    (failure.type === "RequestError" &&
      failure.data?.code === "E2EE_RETRY_PLAIN");
}

/**
 * The normal OBS reqseq endpoint uploads AND sends. Unlike uploadObjTalk,
 * this carries our request id in X-Talk-Meta and checks the HTTP response.
 */
async function uploadPlainObject(
  owner: Client,
  path: string,
  data: Blob,
  params: Record<string, string>,
  metadata?: Record<string, string>,
): Promise<string> {
  const headers = new Headers(owner.base.request.getHeader("POST"));
  headers.set("Content-Type", "application/octet-stream");
  headers.set(
    "X-Obs-Params",
    Buffer.from(JSON.stringify({ ver: "2.0", ...params })).toString("base64"),
  );
  if (metadata) headers.set("X-Talk-Meta", talkMetadata(metadata));
  const response = await owner.base.fetch(
    new URL(`r/talk/m/${path}`, owner.base.obs.prefix),
    { method: "POST", headers, body: data, redirect: "error" },
  );
  if (response.status !== 200 && response.status !== 201) {
    // Keep restrictions visible to the daemon without exposing response
    // headers, tokens or arbitrary server response bodies in logs/replies.
    const code = restrictionCode(new Error(await response.text()));
    throw new Error(
      `LINE 媒體上傳失敗（HTTP ${response.status}${code ? ` / ${code}` : ""}）`,
    );
  }
  const oid = response.headers.get("x-obs-oid");
  await response.body?.cancel();
  if (!oid) throw new Error("LINE 未回傳媒體識別碼");
  return oid;
}

export async function uploadMedia(
  owner: Client,
  args: UploadArgs,
  isCurrent: () => boolean,
): Promise<{ sent: boolean; previewError?: unknown }> {
  let encrypted = true;
  try {
    // Preflight repeats key negotiation on encrypted sends so LINE's plain
    // refusal is known before uploading a potentially large encrypted object.
    await owner.base.e2ee.getE2EELocalPublicKey(args.to);
  } catch (error) {
    if (!allowsPlainMedia(error, args.to)) throw error;
    encrypted = false;
  }
  if (!isCurrent()) return { sent: false };
  if (encrypted) {
    // Errors from this point onward are never a reason to send again.
    await owner.base.obs.uploadMediaByE2EE(args);
    return { sent: true };
  }

  const reqseq = await owner.base.getReqseq("talk");
  if (!isCurrent()) return { sent: false };
  const filename = args.filename ?? "file";
  const metadata: Record<string, string> = {
    ...args.contentMetadata,
    FILE_NAME: filename,
    FILE_SIZE: String(args.data.size),
  };
  delete metadata.DURATION;
  const duration = Math.round(args.durationMs ?? 0);
  if (
    args.oType === "video" && Number.isSafeInteger(duration) && duration > 0
  ) {
    metadata.DURATION = String(duration);
  }
  const oid = await uploadPlainObject(owner, "reqseq", args.data, {
    oid: "reqseq",
    reqseq: String(reqseq),
    tomid: args.to,
    type: args.oType === "gif" ? "image" : args.oType,
    name: filename,
    ...(args.oType === "gif" || args.oType === "image"
      ? { cat: "original" }
      : {}),
    ...(metadata.DURATION ? { duration: metadata.DURATION } : {}),
  }, metadata);
  if (args.preview && args.oType === "video" && isCurrent()) {
    // The main request has already sent the message. A thumbnail failure
    // cannot turn it into a failed send and invite a duplicate on retry.
    try {
      // __ud-preview is OBS's upload directive; /preview is for downloads.
      await uploadPlainObject(owner, `${oid}__ud-preview`, args.preview, {
        type: "image",
        name: "preview.jpg",
      });
    } catch (previewError) {
      return { sent: true, previewError };
    }
  }
  return { sent: true };
}
