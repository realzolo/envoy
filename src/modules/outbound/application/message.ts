import { createMessageSchema, type AcceptedMessage, type CreateMessageInput } from "@/lib/contracts";
import { encodeCursor } from "@/lib/pagination";
import { diagnostic } from "@/modules/outbound/domain/diagnostics";
import { createId } from "@/platform/ids";
import type { ServiceIdentity } from "@/server/auth";
import { createHash } from "node:crypto";
import type { MessageContent, RetryOptions } from "../contracts";
import { assertSendDeadline, DEADLINE_CODE, DEADLINE_MESSAGE } from "../domain/deadline";
import { DuplicateRiskError, IdempotencyConflictError, MessageValidationError } from "../domain/errors";
import { capabilityIssue, subsetEnvelope } from "../domain/message";
import type { OutboundDependencies, OutboundRepositories } from "./ports";
export function createMessageService(dependencies: Omit<OutboundDependencies, "messages">) {
    const { applyDeliveryEvent } = dependencies.events;
    function stable(value: unknown): unknown {
        if (Array.isArray(value))
            return value.map(stable);
        if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
        return value;
    }
    function hashPayload(input: unknown) { return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex"); }
    async function isSuppressed(client: OutboundRepositories, serviceId: string, email: string, listId?: string) {
        return Boolean((await client.message.isRecipientSuppressed({ email: email, serviceId: serviceId, listId: listId ?? null })).rowCount);
    }
    async function assertRoutable(client: OutboundRepositories, message: MessageContent, recipients: {
        email: string;
        name?: string;
    }[]) {
        const rows = (await client.message.findBoundProviderType({ sendingDomainId: message.sending_domain_id, serviceId: message.service_id })).rows;
        if (!rows.length)
            throw new MessageValidationError(["No verified sending provider is bound to this service and domain."], "NO_ELIGIBLE_ROUTE");
        const envelope = subsetEnvelope(message, recipients);
        const issues = rows.map(row => capabilityIssue(message, dependencies.providerCapabilities(row.type), envelope));
        if (issues.every(Boolean))
            throw new MessageValidationError([...new Set(issues.filter((value): value is string => Boolean(value)))], "UNSUPPORTED_MESSAGE_CAPABILITY");
    }
    async function createSubmission(client: OutboundRepositories, messageId: string, deliveryIds: string[]) {
        if (!deliveryIds.length)
            return null;
        const id = createId("sub");
        await client.message.insertSubmission({ id: id, messageId: messageId });
        await client.message.insertSubmissionRecipients({ id: id, deliveryIds: deliveryIds });
        await client.message.assignSubmissionToDeliveries({ id: id, deliveryIds: deliveryIds });
        await client.message.enqueueSubmission({ outboxId: createId("out"), submissionId: id, payload: { submissionId: id } });
        return id;
    }
    async function acceptMessage(args: {
        identity: ServiceIdentity;
        idempotencyKey: string;
        input: CreateMessageInput;
        requestId?: string;
    }) {
        const validated = createMessageSchema.safeParse(args.input);
        if (!validated.success)
            throw new MessageValidationError(validated.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
        const input = validated.data;
        if (!args.idempotencyKey.trim() || args.idempotencyKey.length > 256)
            throw new MessageValidationError(["A valid idempotency key is required."]);
        return dependencies.unitOfWork.run(async (client) => {
            await client.message.lockIdempotencyKey({ lockKey: JSON.stringify([args.identity.serviceId, args.idempotencyKey]) });
            const existing = (await client.message.findIdempotentMessage({ serviceId: args.identity.serviceId, idempotencyKey: args.idempotencyKey })).rows[0];
            const hashed = input.contentPolicy === "sensitive" ? dependencies.payloadDigest(JSON.stringify(stable(input)), `message-payload:${args.identity.serviceId}`, existing?.payload_hash_key_version ?? undefined) : { digest: hashPayload(input), keyVersion: null };
            const payloadHash = hashed.digest;
            const receipt = (row: {
                id: string;
                accepted_at: Date;
                service: string;
                message_category: string;
                recipient_count: number;
                reference_id: string | null;
            }): AcceptedMessage => ({
                id: row.id, processingState: "queued", outcome: "pending", service: row.service, category: row.message_category,
                recipientCount: row.recipient_count, acceptedAt: row.accepted_at.toISOString(), ...(row.reference_id ? { referenceId: row.reference_id } : {}),
            });
            if (existing) {
                if (existing.payload_hash !== payloadHash)
                    throw new IdempotencyConflictError();
                return { duplicate: true, message: receipt(existing) };
            }
            const now = Date.now();
            try {
                assertSendDeadline(input.sendBefore, now);
            }
            catch {
                throw new MessageValidationError([DEADLINE_MESSAGE], DEADLINE_CODE);
            }
            if (input.contentPolicy === "sensitive" && (!input.sendBefore || Date.parse(input.sendBefore) > now + 900000))
                throw new MessageValidationError(["Sensitive content requires sendBefore within the next 900 seconds."], "INVALID_SENSITIVE_RETENTION");
            const domainId = await client.authorizedDomain(args.identity, input.from.email);
            if (!domainId)
                throw new MessageValidationError(["This service is not authorized to send from the supplied address."], "SENDER_NOT_AUTHORIZED");
            const attachments = await client.resolveOutboundAttachments(args.identity.serviceId, input.attachments, domainId);
            const id = createId("msg");
            const content: MessageContent = {
                id, service_id: args.identity.serviceId, sending_domain_id: domainId,
                sender_snapshot: { service: args.identity.serviceName, fromName: input.from.name, fromEmail: input.from.email, domainId },
                to_recipients: input.to, cc_recipients: input.cc, bcc_recipients: input.bcc, reply_to: input.replyTo,
                subject: input.subject, html_body: input.html ?? null, text_body: input.text ?? null,
                headers: input.headers, in_reply_to: input.inReplyTo ?? null, references_ids: input.references,
                attachment_snapshot: attachments, provider_tags: input.tags ?? {}, message_category: input.category,
                content_purged_at: null, metadata: input.metadata ?? {}, content_policy: input.contentPolicy, send_before: input.sendBefore ? new Date(input.sendBefore) : null,
            };
            const recipients = [];
            for (const role of ["to", "cc", "bcc"] as const)
                for (const address of input[role])
                    recipients.push({ ...address, role, blocked: await isSuppressed(client, args.identity.serviceId, address.email, input.metadata?.listId) });
            const allowed = recipients.filter(item => !item.blocked);
            if (allowed.length)
                await assertRoutable(client, content, allowed);
            try {
                assertSendDeadline(input.sendBefore);
            }
            catch {
                throw new MessageValidationError([DEADLINE_MESSAGE], DEADLINE_CODE);
            }
            const stored = dependencies.persistedContent(content);
            const accepted = (await client.message.insertMessage({ content: stored, recipientCount: recipients.length,
                requestId: args.requestId ?? null, idempotencyKey: args.idempotencyKey, payloadHash,
                referenceId: input.referenceId ?? null, keyVersion: hashed.keyVersion })).rows[0];
            const deliveryIds: string[] = [];
            for (const recipient of recipients) {
                const deliveryId = createId("dlv");
                await client.message.insertDelivery({ deliveryId: deliveryId, messageId: id, email: recipient.email, recipientName: input.contentPolicy === "sensitive" ? null : recipient.name ?? null, role: recipient.role });
                if (!recipient.blocked)
                    deliveryIds.push(deliveryId);
                await applyDeliveryEvent(client, deliveryId, {
                    id: deliveryId, type: recipient.blocked ? "suppressed" : "queued", occurredAt: accepted.accepted_at,
                    metadata: recipient.blocked ? { diagnostic: diagnostic("RECIPIENT_SUPPRESSED", "The recipient is blocked by the current suppression policy.", "policy") } : {},
                }, `message:${id}:${deliveryId}:accepted`);
            }
            await createSubmission(client, id, deliveryIds);
            return { duplicate: false, message: receipt({ id, accepted_at: accepted.accepted_at, service: args.identity.serviceName, message_category: input.category, recipient_count: recipients.length, reference_id: input.referenceId ?? null }) };
        });
    }
    async function listMessages(serviceId: string, options: {
        limit: number;
        cursor?: {
            at: Date | string;
            id: string;
        } | null;
        processingState?: string | null;
        outcome?: string | null;
        referenceId?: string | null;
    }) {
        const rows = (await dependencies.repositories.message.listAuthorizedMessages({ serviceId: serviceId, referenceId: options.referenceId ?? null, at: options.cursor?.at ?? null, relatedId: options.cursor?.id ?? null, processingState: options.processingState ?? null, outcome: options.outcome ?? null, limit: options.limit + 1 })).rows;
        const more = rows.length > options.limit;
        const data = (more ? rows.slice(0, options.limit) : rows).map(row => ({
            id: row.id, processingState: row.processing_state, outcome: row.outcome, counts: row.counts, contentPolicy: row.content_policy, sendBefore: row.send_before?.toISOString() ?? null,
            service: row.service, category: row.category, from: { email: row.sender_snapshot.fromEmail, name: row.sender_snapshot.fromName },
            subject: row.subject, referenceId: row.reference_id, recipientCount: row.recipient_count, acceptedAt: row.accepted_at.toISOString(),
        }));
        return { data, nextCursor: more ? encodeCursor(rows[options.limit - 1]) : null };
    }
    async function getMessage(id: string, serviceId: string) {
        const message = (await dependencies.repositories.message.findAuthorizedMessage({ id: id, serviceId: serviceId })).rows[0];
        if (!message)
            return null;
        const deliveries = (await dependencies.repositories.message.listMessageDeliveries({ id: id })).rows;
        return { ...message, deliveries };
    }
    async function cancelMessage(id: string, serviceId: string) {
        return dependencies.unitOfWork.run(async (client) => {
            if (!(await client.message.lockAuthorizedMessage({ id: id, serviceId: serviceId })).rowCount)
                return null;
            await client.message.lockMessageSubmissions({ id: id });
            const rows = (await client.message.lockCancelableDeliveries({ id: id })).rows;
            for (const row of rows)
                await applyDeliveryEvent(client, row.id, { id: createId("cancel"), type: "canceled", occurredAt: new Date(), metadata: { source: "service_api" } }, `cancel:${createId("evt")}`, { forceLifecycle: true });
            await client.message.cancelEmptySubmissions({ id: id });
            return { messageId: id, canceled: rows.length };
        });
    }
    async function retryState(client: OutboundRepositories, deliveryId: string) {
        return (await client.message.lockDeliveryRetryState({ deliveryId: deliveryId })).rows[0];
    }
    function eligibility(row: Awaited<ReturnType<typeof retryState>>) {
        if (!row)
            return { allowed: false, reason: "not_found", requiresUnknownAcknowledgement: false };
        const reason = row.live ? "submission_in_progress" : row.provider_pending ? "provider_delivery_pending" : row.deadline_expired ? "send_deadline_exceeded" : row.content_expired ? "content_expired" : row.blocked || row.compliance_status !== "clean" ? "suppressed" : !row.enabled ? "sender_not_authorized" : !["failed", "deferred", "unknown", "bounced"].includes(row.lifecycle_status) ? "status_not_retryable" : null;
        return { allowed: !reason, reason, requiresUnknownAcknowledgement: row.uncertain || row.lifecycle_status === "unknown" };
    }
    async function getDeliveryRetryEligibility(deliveryId: string) {
        return dependencies.unitOfWork.run(async (client) => {
            await client.message.lockDeliveryMessage({ deliveryId: deliveryId });
            return eligibility(await retryState(client, deliveryId));
        });
    }
    async function retryMessage(id: string, serviceId: string, input: {
        deliveryIds?: string[];
        acknowledgeDuplicateRisk: boolean;
    }, idempotencyKey: string, actor = `service:${serviceId}`) {
        if (!idempotencyKey?.trim() || idempotencyKey.length > 256)
            throw new MessageValidationError(["Idempotency-Key is required for retry."]);
        const payloadHash = hashPayload(input);
        return dependencies.unitOfWork.run(async (client) => {
            const message = (await client.message.lockRetryMessage({ id: id, serviceId: serviceId })).rows[0];
            if (!message)
                return null;
            const prior = (await client.message.findRetryReceipt({ id: id, idempotencyKey: idempotencyKey })).rows[0];
            if (prior) {
                if (prior.payload_hash !== payloadHash)
                    throw new IdempotencyConflictError();
                return prior.result;
            }
            await client.message.lockRetrySubmissions({ id: id });
            const all = (await client.message.listRetryRecipients({ id: id })).rows;
            const wanted = input.deliveryIds ? new Set(input.deliveryIds) : null;
            if (wanted && (!wanted.size || wanted.size !== input.deliveryIds!.length || [...wanted].some(target => !all.some(row => row.id === target))))
                throw new MessageValidationError(["deliveryIds must be unique recipients belonging to this message."], "INVALID_RETRY_TARGET");
            const eligible = [];
            const skipped = [];
            for (const row of all) {
                if (wanted && !wanted.has(row.id))
                    continue;
                const state = await retryState(client, row.id);
                const check = eligibility(state);
                if (!check.allowed) {
                    skipped.push({ deliveryId: row.id, reason: check.reason });
                    continue;
                }
                if (check.requiresUnknownAcknowledgement && !input.acknowledgeDuplicateRisk)
                    throw new DuplicateRiskError("Unknown outcomes require duplicate-risk acknowledgement.");
                eligible.push({ ...row, state: state! });
            }
            if (wanted && skipped.length)
                throw new MessageValidationError(skipped.map(row => `${row.deliveryId}: ${row.reason}`), "RETRY_NOT_ALLOWED");
            if (eligible.length)
                await assertRoutable(client, dependencies.sendingContent(message), eligible.map(row => ({ email: row.recipient_email, name: row.recipient_name ?? undefined })));
            for (const row of eligible) {
                if (row.state.current_attempt_id)
                    await client.message.authorizeAttemptRetry({ currentAttemptId: row.state.current_attempt_id, actor: actor });
                await applyDeliveryEvent(client, row.id, { id: createId("retry"), type: "queued", occurredAt: new Date(), metadata: { source: "authorized_retry", actor } }, `retry:${createId("evt")}`, { forceLifecycle: true });
            }
            const submissionId = await createSubmission(client, id, eligible.map(row => row.id));
            const result = { messageId: id, submissionId, queued: eligible.length, skipped };
            await client.message.saveRetryReceipt({ id: id, idempotencyKey: idempotencyKey, payloadHash: payloadHash, result: result });
            return result;
        });
    }
    async function retryDelivery(deliveryId: string, options: RetryOptions) {
        const message = (await dependencies.repositories.message.findDeliveryOwner({ deliveryId: deliveryId })).rows[0];
        if (!message)
            return { deliveryId, queued: false, reason: "not_found" };
        const result = await retryMessage(message.id, message.service_id, { deliveryIds: [deliveryId], acknowledgeDuplicateRisk: options.acknowledgeUnknown }, createId("retry"), options.actor);
        return { deliveryId, queued: Boolean(result?.queued), reason: result?.skipped[0]?.reason ?? null };
    }
    return { isSuppressed, assertRoutable, createSubmission, acceptMessage, listMessages, getMessage, cancelMessage, getDeliveryRetryEligibility, retryMessage, retryDelivery };
}
