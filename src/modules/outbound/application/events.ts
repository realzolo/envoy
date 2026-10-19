import type { CanonicalEvent } from "@/integrations/providers/contracts";
import { contentFreeOutboundEvents } from "@/integrations/providers/event-facts";
import { diagnostic, type Diagnostic } from "@/modules/outbound/domain/diagnostics";
import { createId } from "@/platform/ids";
import { PROVIDER_EVENT_RECEIVED } from "@/platform/outbox/events";
import { lifecycleTypes, shouldProjectLifecycle } from "../domain/delivery-state";
import type { DeliveryStateEvent } from "../contracts";
import type { OutboundDependencies, OutboundRepositories } from "./ports";
export function createEventsService(dependencies: Omit<OutboundDependencies, "events" | "messages">) {
    function eventDiagnostic(event: DeliveryStateEvent): Diagnostic | null {
        if (event.metadata.diagnostic && typeof event.metadata.diagnostic === "object")
            return event.metadata.diagnostic as Diagnostic;
        if (event.type === "bounced")
            return diagnostic(event.bounce?.classification === "hard" ? "MAILBOX_PERMANENTLY_REJECTED" : "MAILBOX_TEMPORARILY_REJECTED", dependencies.safeDiagnostic(event.bounce?.message ?? "The recipient server rejected delivery."), "recipient_delivery", { acceptance: "accepted", providerCode: event.bounce?.code, smtpStatus: event.bounce?.code?.match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0], occurredAt: event.occurredAt.toISOString() });
        if (event.type === "failed" || event.type === "deferred")
            return diagnostic(event.type === "failed" ? "DELIVERY_FAILED" : "DELIVERY_DEFERRED", dependencies.safeDiagnostic(event.metadata.reason ?? event.bounce?.message ?? (event.type === "failed" ? "Delivery failed." : "The recipient server temporarily deferred delivery.")), "recipient_delivery", { acceptance: "accepted", retryable: event.type === "deferred", providerCode: typeof event.metadata.providerCode === "string" ? dependencies.safeDiagnostic(event.metadata.providerCode) : event.bounce?.code, smtpStatus: typeof event.metadata.smtpStatus === "string" ? dependencies.safeDiagnostic(event.metadata.smtpStatus) : undefined, retryDecision: { action: "none", reason: event.type === "deferred" ? "provider_managed_retry" : "not_retryable" }, occurredAt: event.occurredAt.toISOString() });
        if (event.type === "suppressed")
            return diagnostic("RECIPIENT_SUPPRESSED", "The recipient is blocked by suppression policy.", event.externalMessageId ? "recipient_delivery" : "policy", { acceptance: event.externalMessageId ? "accepted" : "not_accepted", occurredAt: event.occurredAt.toISOString() });
        return null;
    }
    function sensitiveEvent(event: DeliveryStateEvent): DeliveryStateEvent {
        const error = eventDiagnostic(event);
        const safe = error ? { ...error, message: error.code === "SEND_DEADLINE_EXCEEDED" ? "The message sending deadline has passed; no new provider submission is allowed." : "Sensitive message delivery diagnostic withheld.",
            providerCode: undefined, smtpStatus: undefined,
            retryDecision: { ...error.retryDecision, reason: error.retryDecision.action === "manual_review" ? "manual_review_required" : undefined } } : undefined;
        return { id: event.id, externalMessageId: event.externalMessageId, type: event.type, occurredAt: event.occurredAt,
            recipient: event.recipient, ...(event.bounce ? { bounce: { classification: event.bounce.classification } } : {}),
            metadata: safe ? { diagnostic: safe } : {} };
    }
    async function enqueueCallbacks(client: OutboundRepositories, serviceId: string, eventId: string, event: DeliveryStateEvent, data: Record<string, unknown> & {
        messageId: string;
    }, scope: "recipient" | "submission") {
        const owned = await client.events.findCallbackMessage({ messageId: data.messageId, serviceId: serviceId });
        if (!owned.rowCount)
            return;
        const type = `email.${event.type}`;
        const endpoints = (await client.events.listSubscribedEndpoints({ serviceId: serviceId, type: type })).rows;
        for (const endpoint of endpoints) {
            const id = createId("cbx");
            const payload = { id: eventId, apiVersion: "v1", type, scope, occurredAt: event.occurredAt.toISOString(), data };
            const inserted = await client.events.insertCallbackDelivery({ id: id, endpointId: endpoint.id, deliveryEventId: scope === "recipient" ? eventId : null, submissionEventId: scope === "submission" ? eventId : null, type: type, payload: payload });
            if (inserted.rowCount)
                await client.events.enqueueCallback({ outboxId: createId("out"), callbackDeliveryId: id, payload: { callbackDeliveryId: id } });
        }
    }
    async function applySuppression(client: OutboundRepositories, delivery: {
        recipient_email: string;
        product_id: string;
    }, event: DeliveryStateEvent, providerEvent: boolean) {
        if (event.type === "complained" || (event.type === "suppressed" && providerEvent) || (event.type === "bounced" && event.bounce?.classification === "hard")) {
            await client.events.insertGlobalSuppression({ suppressionId: createId("sup"), recipientEmail: delivery.recipient_email, reason: event.type === "bounced" ? "hard_bounce" : event.type });
        }
        else if (event.type === "unsubscribed") {
            const listId = typeof event.metadata.listId === "string" ? event.metadata.listId : null;
            await client.events.insertUnsubscribeSuppression({ suppressionId: createId("sup"), scope: listId ? "list" : "product", productId: delivery.product_id, listId: listId, recipientEmail: delivery.recipient_email });
        }
        else if (event.type === "bounced" && event.bounce?.classification === "soft") {
            const count = await client.events.countRecentSoftBounces({ recipientEmail: delivery.recipient_email });
            if (Number(count.rows[0]?.count ?? 0) >= 3)
                await client.events.insertSoftBounceSuppression({ suppressionId: createId("sup"), recipientEmail: delivery.recipient_email, bounceCount: Number(count.rows[0]?.count ?? 0) });
        }
    }
    async function applyDeliveryEvent(client: OutboundRepositories, deliveryId: string, event: DeliveryStateEvent, sourceKey: string, options: {
        rawEventId?: string | null;
        attemptId?: string;
        forceLifecycle?: boolean;
        providerEvent?: boolean;
        projectLifecycle?: boolean;
    } = {}) {
        const current = (await client.events.lockDeliveryState({ deliveryId: deliveryId })).rows[0];
        if (!current)
            return false;
        if ((await client.events.findDeliveryContentPolicy({ deliveryId: deliveryId })).rows[0]?.content_policy === "sensitive")
            event = sensitiveEvent(event);
        const eventId = createId("dev");
        const key = event.type === "accepted" && options.attemptId ? `attempt:${options.attemptId}:${deliveryId}:accepted` : sourceKey;
        const error = eventDiagnostic(event);
        const payload = { ...event, id: eventId, attemptId: options.attemptId, sourceId: event.id, metadata: { ...event.metadata, ...(error ? { diagnostic: error } : {}) } };
        const inserted = await client.events.insertDeliveryEvent({ eventId: eventId, deliveryId: deliveryId, rawEventId: options.rawEventId ?? null, type: event.type, occurredAt: event.occurredAt, payload: payload, key: key });
        if (!inserted.rowCount)
            return true;
        const attemptSubmission = options.attemptId ? (await client.events.findAttemptSubmission({ attemptId: options.attemptId })).rows[0]?.submission_id : null;
        if (options.attemptId && current.current_attempt_id === null && current.lifecycle_status === "queued" && ["accepted", "delivered"].includes(event.type) && attemptSubmission) {
            // A conclusive late receipt can stop an authorized retry before its network call begins.
            // Once a new attempt has started, retain the old fact without rewriting the newer attempt.
            await client.events.restoreConclusiveAttempt({ deliveryId: deliveryId, attemptId: options.attemptId, attemptSubmission: attemptSubmission });
            current.current_attempt_id = options.attemptId;
            current.current_submission_id = attemptSubmission;
        }
        const currentAttempt = !options.attemptId || (options.attemptId === current.current_attempt_id && attemptSubmission === current.current_submission_id);
        let projects = false;
        if (lifecycleTypes.includes(event.type) && currentAttempt && options.projectLifecycle !== false) {
            const previous = (await client.events.findLatestLifecycleEvent({ deliveryId: deliveryId, eventId: eventId, lifecycleTypes: lifecycleTypes, attemptId: options.attemptId ?? null })).rows[0];
            projects = shouldProjectLifecycle(current.lifecycle_status, event, previous, options.forceLifecycle);
            if (projects)
                await client.events.projectLifecycle({ deliveryId: deliveryId, type: event.type, occurredAt: event.occurredAt });
        }
        else if ((event.type === "clicked" || event.type === "opened") && currentAttempt) {
            await client.events.projectEngagement({ deliveryId: deliveryId, type: event.type });
        }
        else if (["complained", "unsubscribed", "suppressed"].includes(event.type)) {
            await client.events.projectCompliance({ deliveryId: deliveryId, type: event.type });
            if (event.type === "suppressed" && currentAttempt && ["queued", "deferred", "failed", ...(options.providerEvent ? ["submitting", "accepted", "unknown"] : [])].includes(current.lifecycle_status)) {
                await client.events.failSuppressedDelivery({ deliveryId: deliveryId });
                projects = true;
            }
        }
        if (projects && error)
            await client.events.recordDeliveryDiagnostic({ deliveryId: deliveryId, error: error });
        else if (projects && ["queued", "delivered", "accepted"].includes(event.type))
            await client.events.clearDeliveryDiagnostic({ deliveryId: deliveryId });
        const delivery = (await client.events.findDeliveryCallbackContext({ deliveryId: deliveryId })).rows[0];
        await applySuppression(client, delivery, event, options.providerEvent ?? false);
        await enqueueCallbacks(client, delivery.service_id, eventId, event, {
            messageId: delivery.message_id, deliveryId: delivery.id, requestId: delivery.request_id, referenceId: delivery.reference_id,
            recipient: delivery.recipient_email, recipientRole: delivery.recipient_role, product: delivery.product, category: delivery.category,
            lifecycle: lifecycleTypes.includes(event.type) ? event.type : delivery.lifecycle_status, currentLifecycle: delivery.lifecycle_status, ...(options.attemptId ? { attemptId: options.attemptId } : {}),
            engagement: delivery.engagement_status, compliance: delivery.compliance_status, ...(error ? { diagnostic: error } : {}),
            ...(event.bounce ? { bounce: { ...event.bounce, message: event.bounce.message ? dependencies.safeDiagnostic(event.bounce.message) : undefined } } : {}),
        }, "recipient");
        return true;
    }
    async function applySubmissionEvent(client: OutboundRepositories, submissionId: string, event: DeliveryStateEvent, sourceKey: string, attemptId?: string, rawEventId?: string | null) {
        if ((await client.events.findSubmissionContentPolicy({ submissionId: submissionId })).rows[0]?.content_policy === "sensitive")
            event = sensitiveEvent(event);
        const id = createId("sev");
        const error = eventDiagnostic(event);
        const payload = { ...event, id, attemptId, sourceId: event.id, metadata: { ...event.metadata, ...(error ? { diagnostic: error } : {}) } };
        const key = event.type === "accepted" && attemptId ? `attempt:${attemptId}:accepted` : sourceKey;
        const inserted = await client.events.insertSubmissionEvent({ id: id, submissionId: submissionId, attemptId: attemptId ?? null, type: event.type, key: key, occurredAt: event.occurredAt, payload: payload, rawEventId: rawEventId ?? null });
        if (!inserted.rowCount)
            return true;
        const owner = (await client.events.findSubmissionOwner({ submissionId: submissionId })).rows[0];
        await enqueueCallbacks(client, owner.service_id, id, event, { messageId: owner.id, submissionId, requestId: owner.request_id, referenceId: owner.reference_id, ...(attemptId ? { attemptId } : {}), ...(error ? { diagnostic: error } : {}) }, "submission");
        return true;
    }
    async function applyCanonicalEvent(providerAccountId: string, rawEventId: string | null, event: CanonicalEvent) {
        if (!event.externalMessageId)
            return false;
        return dependencies.unitOfWork.run(async (client) => {
            const found = (await client.events.findProviderAttempt({ providerAccountId: providerAccountId, externalMessageId: event.externalMessageId })).rows[0];
            if (!found)
                return false;
            await client.events.lockEventMessage({ messageId: found.message_id });
            await client.events.lockEventSubmission({ submissionId: found.submission_id });
            await client.events.lockEventAttempt({ id: found.id });
            const rows = (await client.events.listEventRecipients({ submissionId: found.submission_id, recipient: event.recipient ?? null })).rows;
            if (event.recipient && !rows.length)
                return false;
            // Trusted post-submission facts prove acceptance even when the sender lost
            // its HTTP response. Resolve transport uncertainty as accepted for the immutable request group;
            // message-scoped facts still never invent recipient delivery or engagement.
            if (["accepted", "deferred", "delivered", "bounced", "failed", "opened", "clicked", "complained", "unsubscribed", "suppressed"].includes(event.type)) {
                const resolved = await client.events.resolveVerifiedAcceptance({ id: found.id });
                if (resolved.rowCount) {
                    await client.events.acceptCurrentSubmission({ submissionId: found.submission_id, relatedId: found.id });
                    const acceptance: DeliveryStateEvent = { id: `accepted:${event.id}`, type: "accepted", occurredAt: resolved.rows[0].started_at, metadata: { source: "verified_provider_fact" } };
                    await applySubmissionEvent(client, found.submission_id, acceptance, `attempt:${found.id}:accepted`, found.id, rawEventId);
                    const group = (await client.events.listSubmissionRecipients({ submissionId: found.submission_id })).rows;
                    for (const recipient of group)
                        await applyDeliveryEvent(client, recipient.id, acceptance, `attempt:${found.id}:${recipient.id}:accepted`, { rawEventId, attemptId: found.id, providerEvent: true });
                }
            }
            if (!event.recipient && event.type !== "accepted") {
                // Message-scoped provider facts are retained without inventing per-recipient results.
                return applySubmissionEvent(client, found.submission_id, event, `provider:${providerAccountId}:${event.id}:${event.type}`, found.id, rawEventId);
            }
            for (const row of rows)
                await applyDeliveryEvent(client, row.id, event, `provider:${providerAccountId}:${event.id}:${event.type}:${row.id}`, { rawEventId, attemptId: found.id, providerEvent: true });
            return true;
        });
    }
    async function processRawProviderEvent(rawEventId: string) {
        const raw = (await dependencies.repositories.events.claimProviderEvent({ rawEventId: rawEventId })).rows[0];
        if (!raw)
            return;
        try {
            if (!raw.signature_valid || !raw.replay_valid)
                throw new Error("Persisted webhook has no verified receipt");
            const decoded = await dependencies.providerEvents.decode(raw);
            const events = decoded.events;
            const facts = contentFreeOutboundEvents(events);
            if (facts && !raw.normalized_events)
                await dependencies.repositories.events.saveNormalizedFacts({ id: raw.id, factsJson: JSON.stringify(facts) });
            for (const item of events) {
                if (item.type === "inbound.received" && await decoded.receiveInbound())
                    continue;
                else if (!await applyCanonicalEvent(raw.provider_account_id, raw.id, item))
                    throw new Error("Provider event is waiting for its delivery attempt to be associated");
            }
            if (!facts) {
                await dependencies.repositories.events.completeProviderEvent({ id: raw.id });
            }
            else {
                // Outbound normalized facts are sufficient for replay. Never retain an extra provider echo of sensitive content.
                await dependencies.unitOfWork.run(async (client) => {
                    const stored = (await client.events.lockProviderReceipt({ id: raw.id })).rows[0];
                    for (const key of [stored.raw_object_key, stored.receipt_object_key])
                        if (key)
                            await client.events.enqueueObjectDeletion({ key: key });
                    await client.events.completeAndPurgeProviderReceipt({ id: raw.id });
                });
            }
        }
        catch (error) {
            const message = dependencies.providerEvents.isTerminal(error) ? "Inbound event processing was rejected." : "Provider event processing failed; durable verified receipt/facts retained for retry.";
            if (dependencies.providerEvents.isTerminal(error)) {
                await dependencies.repositories.events.rejectInboundReceipt({ id: raw.id, message: message });
                return;
            }
            await dependencies.unitOfWork.run(async (client) => {
                await client.events.deferProviderEvent({ id: raw.id, message: message });
                if (raw.processing_attempt_count < 20)
                    await client.events.enqueueProviderEvent({ outboxId: createId("out"), rawEventId: raw.id, eventType: PROVIDER_EVENT_RECEIVED, payload: { rawEventId: raw.id } });
            });
        }
    }
    return { applyDeliveryEvent, applySubmissionEvent, applyCanonicalEvent, processRawProviderEvent };
}
