import type { CanonicalEvent, WebhookVerification } from "@/integrations/providers/contracts";
import { isTrustedSnsSubscribeUrl } from "@/integrations/providers/ses/sns-security";
import { loadProviderAccount } from "@/modules/channels/public";
import { InboundTerminalError, processInboundEvent } from "@/modules/inbound/public";
import { openSecret, type Envelope } from "@/platform/crypto/envelope";
import { objectStore } from "@/platform/storage/object-store";
import type { RawProviderReceipt } from "../contracts";
import { restoreVerification } from "@/integrations/providers/verification";
export const providerEventDecoder = {
    async decode(raw: RawProviderReceipt) {
        const account = await loadProviderAccount(raw.provider_account_id, { allowNonActive: true });
        let verified: WebhookVerification | undefined;
        let events: CanonicalEvent[];
        if (raw.raw_payload_purged_at && raw.normalized_events) {
            events = raw.normalized_events.map(event => ({ ...event, occurredAt: new Date(event.occurredAt) }));
        }
        else {
            const reference = raw.verification as {
                objectKey?: unknown;
            };
            const receipt = typeof reference.objectKey === "string" ? JSON.parse(Buffer.from(await objectStore().get(reference.objectKey)).toString("utf8")) : raw.verification;
            verified = restoreVerification(openSecret(receipt as Envelope, `provider-receipt:${raw.id}`, 1));
            if (raw.provider_type === "ses") {
                const payload = verified.parsed as Record<string, unknown>;
                if (payload.Type === "SubscriptionConfirmation" && typeof payload.SubscribeURL === "string" && typeof payload.TopicArn === "string" && isTrustedSnsSubscribeUrl(payload.SubscribeURL, payload.TopicArn))
                    await fetch(payload.SubscribeURL, { redirect: "error", signal: AbortSignal.timeout(5000) });
            }
            events = await account.module.webhook.normalize(verified, account.context);
        }
        return { events, async receiveInbound(): Promise<boolean> {
                if (!account.module.inbound)
                    return false;
                if (!verified)
                    throw new Error("Inbound replay requires a retained verified receipt");
                await processInboundEvent({ providerAccountId: raw.provider_account_id, webhookEndpointId: raw.webhook_endpoint_id,
                    rawEventId: raw.id, verified, receive: value => account.module.inbound!.receive(value, account.context) });
                return true;
            } };
    },
    isTerminal(error: unknown) { return error instanceof InboundTerminalError; },
};
