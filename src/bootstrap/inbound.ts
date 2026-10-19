import { createHash } from "node:crypto";
import { sealSecret } from "@/platform/crypto/envelope";
import { loadWebhookEndpoint } from "@/modules/channels/public";
import { serializeVerification } from "@/integrations/providers/verification";
import { createWebhookIngress } from "@/modules/inbound/application/webhook-ingress";
import { webhookRepository } from "@/modules/inbound/infrastructure/webhook.repository";
import sanitizeHtml from "sanitize-html";
import { createUnitOfWork } from "@/platform/database";
import { createId } from "@/platform/ids";
import { digest } from "@/modules/attachments/public";
import { objectStore } from "@/platform/storage/object-store";
import { registerObjectUpload } from "@/platform/storage/object-cleanup/public";
import { createInboundService } from "@/modules/inbound/application/service";
import { createInboundChanges } from "@/modules/inbound/application/changes";
import { inboundRepository } from "@/modules/inbound/infrastructure/message.repository";
import { inboundChangesRepository } from "@/modules/inbound/infrastructure/changes.read-repository";
import { createInboundManagement } from "@/modules/inbound/application/management";
import { inboundManagementRepository } from "@/modules/inbound/infrastructure/management.repository";
import { providerRegistry } from "@/integrations/providers/registry";

export const inbound = createInboundService({
  get repository() { return inboundRepository(); }, unitOfWork: createUnitOfWork(inboundRepository), id: createId,
  digest, sanitizeHtml, uploads: { register: registerObjectUpload, put: (key, bytes, contentType) => objectStore().put(key, bytes, contentType) },
});
export const listInboundChanges = createInboundChanges(createUnitOfWork(inboundChangesRepository));
export const inboundManagement = createInboundManagement(createUnitOfWork(inboundManagementRepository), { id: createId, supportsInbound: type => !!providerRegistry(type).inbound });

export const webhookIngress = createWebhookIngress({
  loadEndpoint: loadWebhookEndpoint, unitOfWork: createUnitOfWork(webhookRepository), id: createId,
  digest: bytes => createHash("sha256").update(bytes).digest("hex"), seal: sealSecret, encodeVerification: serializeVerification,
  uploads: { register: registerObjectUpload, put: (key, bytes, contentType) => objectStore().put(key, bytes, contentType) },
});
