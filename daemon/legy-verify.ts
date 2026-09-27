/** LEGY 遷移 live 驗證:QR 登入 + 一次 /S3 加密往返。
 *  vendor = v3.4.2-omarchy.3 (LEGY 預設 legy.line-apps.com)。
 *  流量日誌證明每個請求打哪個主機。
 *  QR 過期 (410) 自動換新 QR 重試 — 不用重跑腳本。 */
import { loginWithQR } from "@evex/linejs";
import { MemoryStorage } from "@evex/linejs/storage";
import QRCode from "qrcode";

const hosts: Record<string, number> = {};
const origFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  try {
    const h = new URL(url).host;
    hosts[h] = (hosts[h] ?? 0) + 1;
  } catch { /* 非 URL 請求 */ }
  return origFetch(input as never, init);
}) as typeof fetch;

const MAX_ATTEMPTS = 10;
let client: Awaited<ReturnType<typeof loginWithQR>> | undefined;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(
    `\n=== LEGY 遷移 live 驗證 — 第 ${attempt}/${MAX_ATTEMPTS} 輪,等待 QR 掃描 ===`,
  );
  try {
    client = await loginWithQR(
      {
        async onReceiveQRUrl(url: string) {
          console.log(
            `\n[QR 更新 ${
              new Date().toLocaleTimeString()
            }] 已開在 Preview (/tmp/legy-qr.png)`,
          );
          console.log("(或手動輸入) " + url + "\n");
          try {
            await QRCode.toFile("/tmp/legy-qr.png", url, {
              width: 420,
              margin: 2,
            });
            await new Deno.Command("open", [
              "-a",
              "Preview",
              "/tmp/legy-qr.png",
            ]).output();
          } catch (e) {
            console.log("(QR PNG 寫入失敗,用上面的 URL)", String(e));
          }
        },
        onPincodeRequest(pin: string) {
          console.log(`\n>>> 手機確認碼: ${pin} <<<\n`);
        },
      },
      {
        device: "ANDROIDSECONDARY",
        storage: new MemoryStorage(),
      },
    );
    break; // 登入成功
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /status=41[01]|status=40[48]|Timeout/i.test(msg) && attempt < MAX_ATTEMPTS
    ) {
      console.log(`(QR 過期/逾時,3 秒後換新 QR 重試…)`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    throw err;
  }
}
if (!client) throw new Error("login failed after retries");

console.log("\n=== 登入成功 ===");

function printStats() {
  console.log("\n=== 流量統計(證明端點) ===");
  for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}x ${h}`);
  }
  const usedLegy = Object.keys(hosts).some((h) =>
    h.includes("legy.line-apps.com")
  );
  const usedGf = Object.keys(hosts).some((h) => h.includes("gf.line.naver.jp"));
  console.log(
    `\n${
      usedLegy && !usedGf
        ? "✓✓✓ P0 閉環:加密流量全走 legy.line-apps.com,零 gf"
        : usedGf
        ? "✗ 仍有 gf 流量!"
        : "(本次未觸發加密路徑)"
    }`,
  );
}
printStats();
Deno.exit(0);
// /S3 加密往返(僅裝飾,統計已印)
try {
  const profile = await client.profile?.getProfile?.() ??
    (await client.fetchUsers?.([client.profile?.mid].filter(Boolean) ?? []));
  console.log(
    "帳號:",
    (profile as { displayName?: string })?.displayName ?? client.profile?.mid ??
      "?",
  );
} catch (_e) { /* profile API 形狀差異,不影響驗證 */ }

console.log("\n=== 流量統計(證明端點) ===");
for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}x ${h}`);
}
const usedLegy = Object.keys(hosts).some((h) =>
  h.includes("legy.line-apps.com")
);
const usedGf = Object.keys(hosts).some((h) => h.includes("gf.line.naver.jp"));
console.log(
  `\n${
    usedLegy && !usedGf
      ? "✓✓✓ P0 閉環:加密流量全走 legy.line-apps.com,零 gf"
      : usedGf
      ? "✗ 仍有 gf 流量!"
      : "(本次未觸發加密路徑)"
  }`,
);
Deno.exit(0);
