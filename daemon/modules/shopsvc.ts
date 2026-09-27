/** Minimal stand-in for linejs' generated ShopService.
 *
 * Upstream generates the class but never wires it onto BaseClient, and the
 * `./service/shop` file is not part of the package's public exports. The only
 * call the daemon needs is getOwnedProductSummaries, so it goes through the
 * same `client.request.request` channel the generated service uses, with the
 * same protocol/path constants (`/TSHOP4`, compact protocol 4).
 */
import type { Client } from "@evex/linejs";
import { LINEStruct } from "@evex/linejs/thrift";
import type * as LINETypes from "@evex/linejs-types";

type BaseClient = Client["base"];

export class ShopService {
  constructor(private readonly client: BaseClient) {}

  getOwnedProductSummaries(
    param: Parameters<typeof LINEStruct.getOwnedProductSummaries_args>[0],
  ): Promise<LINETypes.getOwnedProductSummaries_result["success"]> {
    return this.client.request.request(
      LINEStruct.getOwnedProductSummaries_args(param),
      "getOwnedProductSummaries",
      4,
      true,
      "/TSHOP4",
    ) as Promise<LINETypes.getOwnedProductSummaries_result["success"]>;
  }
}
