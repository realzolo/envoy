import { createUnitOfWork } from '@/platform/database';
import type { PoolClient } from 'pg';
import type * as Rows from '../application/content-ports';
import type { ContentKind, ContentRepository } from '../application/content-ports';
import { inboundDomainAccess, outboundDomainAccess } from './authorization';
export function createContentRepository(client: PoolClient): ContentRepository {
    return {
        enqueueObjectDeletion(input: {
            key: string;
        }) {
            return client.query<Rows.EnqueueObjectDeletionRow>(`INSERT INTO pending_object_deletions(object_key,available_at) VALUES($1,now())
    ON CONFLICT(object_key) DO UPDATE SET available_at=EXCLUDED.available_at`, [input.key]);
        },
        lockRawReceipt(input: {
            id: string;
        }) { return client.query<Rows.LockRawReceiptRow>("SELECT id FROM raw_provider_events WHERE id=$1 FOR UPDATE", [input.id]); },
        findPurgeableRawReceipt(input: {
            id: string;
        }) {
            return client.query<Rows.FindPurgeableRawReceiptRow>(`SELECT r.raw_object_key,r.verification->>'objectKey' AS receipt_object_key
    FROM raw_provider_events r WHERE r.id=$1 AND (r.processed_at IS NOT NULL OR r.terminated_at IS NOT NULL) AND r.content_purged_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM inbound_messages i WHERE i.raw_provider_event_id=r.id AND i.content_purged_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN messages m ON m.id=d.message_id WHERE de.raw_provider_event_id=r.id AND m.content_purged_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM submission_events se JOIN submissions sub ON sub.id=se.submission_id JOIN messages m ON m.id=sub.message_id WHERE se.raw_provider_event_id=r.id AND m.content_purged_at IS NULL)`, [input.id]);
        },
        purgeRawReceipt(input: {
            id: string;
        }) { return client.query<Rows.PurgeRawReceiptRow>("UPDATE raw_provider_events SET normalized_events=NULL,raw_body=NULL,raw_object_key=NULL,headers='{}',verification='{}',content_purged_at=clock_timestamp() WHERE id=$1", [input.id]); },
        lockOwnedContent(input: {
            id: string;
            serviceId: string;
            kind: ContentKind;
        }) { const kind = input.kind; const table = kind === 'inbound' ? 'inbound_messages' : kind === 'message' ? 'messages' : 'outbound_files'; return client.query<Rows.LockOwnedContentRow>(`SELECT * FROM ${table} WHERE id=$1 AND service_id=$2 AND ${kind === 'inbound' ? inboundDomainAccess(table) : outboundDomainAccess(table)} FOR UPDATE`, [input.id, input.serviceId]); },
        findRetainedFileReferences(input: {
            referenceSnapshot: string;
        }) { return client.query<Rows.FindRetainedFileReferencesRow>("SELECT id FROM messages WHERE content_purged_at IS NULL AND attachment_snapshot @> $1::jsonb LIMIT 1", [input.referenceSnapshot]); },
        purgeOutboundFile(input: {
            id: string;
        }) { return client.query<Rows.PurgeOutboundFileRow>("UPDATE outbound_files SET file_name='',content_purged_at=clock_timestamp() WHERE id=$1", [input.id]); },
        lockMessageSubmissions(input: {
            id: string;
        }) { return client.query<Rows.LockMessageSubmissionsRow>("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [input.id]); },
        lockMessageDeliveries(input: {
            id: string;
        }) { return client.query<Rows.LockMessageDeliveriesRow>("SELECT id FROM deliveries WHERE message_id=$1 ORDER BY id FOR UPDATE", [input.id]); },
        findUnsettledMessageWork(input: {
            id: string;
        }) {
            return client.query<Rows.FindUnsettledMessageWorkRow>(`SELECT 1 FROM deliveries WHERE message_id=$1 AND lifecycle_status NOT IN ('delivered','bounced','failed','canceled')
          UNION ALL SELECT 1 FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE s.message_id=$1 AND a.status IN ('submitting','unknown','reconciling') LIMIT 1`, [input.id]);
        },
        lockContentCallbacks(input: {
            id: string;
            kind: ContentKind;
        }) {
            const kind = input.kind;
            return client.query<Rows.LockContentCallbacksRow>(`SELECT c.id,c.status FROM callback_deliveries c
        WHERE ${kind === "inbound" ? "c.inbound_message_id=$1" : `c.delivery_event_id IN (SELECT e.id FROM delivery_events e JOIN deliveries d ON d.id=e.delivery_id WHERE d.message_id=$1)
          OR c.submission_event_id IN (SELECT e.id FROM submission_events e JOIN submissions s ON s.id=e.submission_id WHERE s.message_id=$1)`}
        ORDER BY c.id FOR UPDATE`, [input.id]);
        },
        purgeCallbackPayloads(input: {
            ids: string[];
        }) {
            return client.query<Rows.PurgeCallbackPayloadsRow>(`UPDATE callback_deliveries SET payload='{}',payload_purged_at=clock_timestamp(),
        status=CASE WHEN status='delivered' THEN status ELSE 'terminated' END,
        terminated_at=CASE WHEN status='delivered' THEN terminated_at ELSE COALESCE(terminated_at,clock_timestamp()) END,updated_at=now()
        WHERE id=ANY($1::text[])`, [input.ids]);
        },
        lockInboundAttachments(input: {
            id: string;
        }) { return client.query<Rows.LockInboundAttachmentsRow>("SELECT object_key FROM inbound_attachments WHERE inbound_message_id=$1 AND content_purged_at IS NULL FOR UPDATE", [input.id]); },
        purgeInboundAttachmentMetadata(input: {
            id: string;
        }) { return client.query<Rows.PurgeInboundAttachmentMetadataRow>("UPDATE inbound_attachments SET file_name='',content_id=NULL,content_purged_at=clock_timestamp() WHERE inbound_message_id=$1 AND content_purged_at IS NULL", [input.id]); },
        purgeInboundMessage(input: {
            id: string;
        }) { return client.query<Rows.PurgeInboundMessageRow>("UPDATE inbound_messages SET subject='',sanitized_html=NULL,text_body=NULL,raw_mime_object_key=NULL,content_purged_at=clock_timestamp() WHERE id=$1", [input.id]); },
        purgeMessageBody(input: {
            id: string;
        }) {
            return client.query<Rows.PurgeMessageBodyRow>(`UPDATE messages SET sensitive_content=NULL,sensitive_content_purged_at=COALESCE(sensitive_content_purged_at,clock_timestamp()),subject='',html_body=NULL,text_body='',headers='{}',metadata='{}',provider_tags='{}',
          attachment_snapshot='[]',content_purged_at=clock_timestamp() WHERE id=$1`, [input.id]);
        },
        findMessageRawReceipts(input: {
            id: string;
        }) {
            return client.query<Rows.FindMessageRawReceiptsRow>(`SELECT DISTINCT raw_provider_event_id AS id FROM (
          SELECT e.raw_provider_event_id FROM delivery_events e JOIN deliveries d ON d.id=e.delivery_id WHERE d.message_id=$1
          UNION ALL SELECT e.raw_provider_event_id FROM submission_events e JOIN submissions sub ON sub.id=e.submission_id WHERE sub.message_id=$1
        ) source WHERE raw_provider_event_id IS NOT NULL ORDER BY id`, [input.id]);
        },
        lockOutboundFiles(input: {
            ids: string[];
        }) { return client.query<Rows.LockOutboundFilesRow>("SELECT id FROM outbound_files WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [input.ids]); },
        findUnsharedOutboundFile(input: {
            id: string;
            serviceId: string;
            referenceSnapshot: string;
        }) {
            return client.query<Rows.FindUnsharedOutboundFileRow>(`SELECT f.object_key FROM outbound_files f WHERE f.id=$1 AND f.service_id=$2 AND f.content_purged_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.content_purged_at IS NULL AND m.attachment_snapshot @> $3::jsonb)`, [input.id, input.serviceId, input.referenceSnapshot]);
        },
        purgeUnsharedOutboundFile(input: {
            id: string;
        }) { return client.query<Rows.PurgeUnsharedOutboundFileRow>("UPDATE outbound_files SET file_name='',content_purged_at=clock_timestamp() WHERE id=$1", [input.id]); },
        recordContentPurge(input: {
            actor: string;
            resourceType: string;
            id: string;
            details: {
                source: string;
            };
        }) { return client.query<Rows.RecordContentPurgeRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'content.purge',$2,$3,$4)", [input.actor, input.resourceType, input.id, input.details]); },
        readContentTombstone(input: {
            id: string;
            kind: ContentKind;
        }) { const kind = input.kind; const table = kind === 'inbound' ? 'inbound_messages' : kind === 'message' ? 'messages' : 'outbound_files'; return client.query<Rows.ReadContentTombstoneRow>(`SELECT content_purged_at FROM ${table} WHERE id=$1`, [input.id]); }
    };
}
export const contentUnitOfWork = createUnitOfWork(createContentRepository);
