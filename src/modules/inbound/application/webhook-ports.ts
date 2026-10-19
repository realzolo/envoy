import type { UnitOfWork } from "@/platform/transactions";
import type { ProviderModule, ProviderSendContext, ProviderType, WebhookVerification } from "@/integrations/providers/contracts";

export type VerifiedReceipt = {
  id: string; accountId: string; endpointId: string; providerEventId: string; nativeType: string;
  rawBody: Buffer | null; objectKey: string | null; verification: unknown; securityVersion: number;
  expiresAt: Date | null; normalizedJson: string | null;
};
export interface WebhookRepository {
  insertReceipt(receipt: VerifiedReceipt): Promise<boolean>;
  existingId(accountId: string, eventId: string): Promise<string>;
  completeUploads(keys: string[]): Promise<void>;
  enqueue(id: string, outboxId: string): Promise<void>;
}
export interface WebhookDependencies {
  loadEndpoint(provider: ProviderType, token: string): Promise<{
    id: string; provider_account_id: string; security_version: number; module: ProviderModule;
    context: ProviderSendContext; security: Record<string, unknown>;
  } | null>;
  unitOfWork: UnitOfWork<WebhookRepository>;
  digest(bytes: Uint8Array): string;
  id(prefix: string): string;
  seal(value: unknown, owner: string, version: number): unknown;
  encodeVerification(value: WebhookVerification): unknown;
  uploads: { register(key: string): Promise<void>; put(key: string, bytes: Uint8Array, contentType: string): Promise<unknown> };
}
