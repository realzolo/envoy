import { createHmac, randomBytes } from "node:crypto";
import { createUnitOfWork } from "@/platform/database";
import { createId } from "@/platform/ids";
import { openSecret, sealSecret } from "@/platform/crypto/envelope";
import { callbackRepository } from "@/modules/callbacks/infrastructure/callback.repository";
import { postCallback, resolveCallbackTarget } from "@/modules/callbacks/infrastructure/http-transport";
import { createCallbackService } from "@/modules/callbacks/application/service";

export async function validateCallbackUrl(url: string) { return (await resolveCallbackTarget(url)).url.toString(); }

export const callbackService = createCallbackService({
  get repository() { return callbackRepository(); }, unitOfWork: createUnitOfWork(callbackRepository), id: createId, now: () => new Date(Date.now()),
  transport: {
    validate: validateCallbackUrl,
    async send(url, body, headers, beforeSend) {
      const target = await resolveCallbackTarget(url);
      await beforeSend();
      return postCallback(target, body, headers);
    },
  },
  secrets: {
    generate: () => `ev_cb_${randomBytes(24).toString("base64url")}`,
    seal: (secret, id) => sealSecret({ secret }, id, 1),
    sign(claim, timestamp, body) {
      const secret = openSecret<{ secret: string }>(claim, claim.endpointId, 1).secret;
      return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    },
  },
});
