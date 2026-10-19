import type { ProviderDescriptor,ProviderType } from '@/integrations/providers/contracts';
import type { scanPolicy } from '@/modules/attachments/public';
type ScanPolicy=ReturnType<typeof scanPolicy>;

export type Timestamp = string | Date;
export type AdminSection = 'attachments'|'providers'|'domains'|'routing'|'api-keys'|'webhooks'|'events'|'suppressions'|'inbound'|'logs';
export type ServiceDomainGrantDto={id:string;service_id:string;sending_domain_id:string|null;send_allowed:boolean;receive_allowed:boolean;status:string;revision:number};
export type DomainGrantDto=ServiceDomainGrantDto & {service:string;domain:string};
export type ServiceDto = {id:string;name:string;suppression_management_allowed:boolean;configuration_revision:number;domain_grants:ServiceDomainGrantDto[];status:string;callback_id:string|null;callback_url:string|null;callback_status:string|null};
export type ProviderAccountDto = {id:string;type:ProviderType;name:string;status:string;public_config:object;health:string;health_details:object;quota:object;created_at:Timestamp;credential_version:number;webhook_endpoint_id:string;opaque_token:string;webhook_status:string;security_configured:boolean;expected_topic_arn:string|null;ip_allowlist:string[];last_event_at:Timestamp|null};
export type DomainIdentityDto = {id:string;accountId:string;account:string;type:ProviderType;accountStatus:string;status:string;externalId:string|null;dnsRecords:object[];lastCheckedAt:Timestamp|null};
export type DomainDto = {id:string;domain:string;status:string;identities:DomainIdentityDto[]|null};
export type RoutingTargetDto = {id:string;accountId:string;account:string;type:ProviderType;identityId:string;domain:string;priority:number;weight:number;rateLimit:number;status:string;circuitOpenUntil:Timestamp|null};
export type RoutingPolicyDto = {id:string;name:string;priority:number;status:string;service_scope:"all"|"selected";services:{id:string;name:string}[];sending_domain_id:string;sending_domain:string;message_category:string|null;targets:RoutingTargetDto[]|null};
export type ServiceCredentialDto = {id:string;key_prefix:string;status:string;created_at:Timestamp;valid_from:Timestamp;valid_to:Timestamp|null;last_used_at:Timestamp|null;service:string;service_id:string};
export type ProviderWebhookDto = {id:string;opaque_token:string;status:string;security_configured:boolean;expected_topic_arn:string|null;ip_allowlist:string[];created_at:Timestamp;provider_account_id:string;account:string;type:ProviderType};
export type CallbackEndpointDto = {id:string;name:string;url:string;status:string;subscribed_events:string[];service_id:string;service:string;dead_letters:string;in_flight:string};
export type CallbackDeliveryDto = {id:string;endpoint_id:string;endpoint:string;event_type:string;event_id:string|null;payload_purged_at:Timestamp|null;status:string;attempt_count:number;next_attempt_at:Timestamp;response_code:number|null;last_error:string|null;delivered_at:Timestamp|null;created_at:Timestamp};
export type RawEventDto = {id:string;native_type:string;provider_event_id:string;signature_valid:boolean;replay_valid:boolean;received_at:Timestamp;processed_at:Timestamp|null;processing_error:string|null;processing_attempt_count:number;terminated_at:Timestamp|null;content_purged_at:Timestamp|null;raw_payload_purged_at:Timestamp|null;account:string;type:ProviderType};
export type CanonicalEventDto = {id:string;event_type:string;occurred_at:Timestamp;canonical_payload:object;recipient_email:string|null;scope:string};
export type SuppressionDto = {id:string;service:string|null;scope_type:string;list_id:string|null;email_normalized:string;reason:string;source:string;bounce_count:number;expires_at:Timestamp|null;created_at:Timestamp|null};
export type InboundMessageDto = {id:string;service_id:string|null;service:string|null;content_purged_at:Timestamp|null;from_email:string;to_emails:string[];subject:string;status:string;received_at:Timestamp;author_date:Timestamp|null;ingress_received_at:Timestamp;ready_at:Timestamp|null;attachment_count:string};
export type InboundRouteDto = {id:string;status:string;domain:string;service:string;opaque_token:string;provider_type:ProviderType;callback:string|null;notification_state:string};
export type FailedWorkDto = {id:string;aggregate_type:string;aggregate_id:string;event_type:string;status:string;attempt_count:number;available_at:Timestamp;created_at:Timestamp};
export type AuditEntryDto = {id:string;actor:string;action:string;resource_type:string;resource_id:string|null;details:object;created_at:Timestamp};
export type AttachmentTaskDto = {resource_id:string;kind:string;service_id:string;status:string;reason:string|null;attempt_count:number;policy_version:string;checked_at:Timestamp|null;lease_expires_at:Timestamp|null;next_attempt_at:Timestamp|null};
export type AttachmentObservationDto = {status:string;count:number;last_observed_at:Timestamp|null};
/** Explicit read contracts; generic table/form helpers do not define persistence contracts. */
export type AdminData = {configuration?:ScanPolicy;tasks?:AttachmentTaskDto[];observations?:AttachmentObservationDto[];grants?:DomainGrantDto[];failedWork?:FailedWorkDto[];audit?:AuditEntryDto[];callbacks?:CallbackEndpointDto[];callbackDeliveries?:CallbackDeliveryDto[];canonicalEvents?:CanonicalEventDto[];credentials?:ServiceCredentialDto[];descriptors?:ProviderDescriptor[];domains?:DomainDto[];inbound?:InboundMessageDto[];inboundRoutes?:InboundRouteDto[];policies?:RoutingPolicyDto[];providers?:ProviderAccountDto[];rawEvents?:RawEventDto[];services?:ServiceDto[];suppressions?:SuppressionDto[];webhooks?:ProviderWebhookDto[]};

import type { DeliveryStatus } from "@/lib/types";

export type MessageFilters = { q: string; status: "all" | DeliveryStatus; cursor?: string };
const statuses = new Set(["all", "queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled", "suppressed"]);

export function messageFilters(params: URLSearchParams): MessageFilters {
  const status = params.get("status") ?? "all";
  return {
    q: (params.get("q") ?? "").trim().slice(0, 200),
    status: statuses.has(status) ? status as MessageFilters["status"] : "all",
    cursor: params.get("cursor")?.slice(0, 500) || undefined
  }
}

export function messageFilterQuery(filters: MessageFilters, includeCursor = false) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status !== "all") params.set("status", filters.status);
  if (includeCursor && filters.cursor) params.set("cursor", filters.cursor);
  return params.toString()
}

export type MessageAttachmentDto={fileId:string;fileName:string;contentType:string;size:number;disposition:'attachment'|'inline';contentId:string|null};
export type MessageContentDto={content_policy:string;html_body:string|null;text_body:string|null;reply_to:Array<{email:string;name?:string}>;to_recipients:Array<{email:string;name?:string}>;cc_recipients:Array<{email:string;name?:string}>;bcc_recipients:Array<{email:string;name?:string}>;attachment_snapshot:MessageAttachmentDto[];headers:Record<string,string>;in_reply_to:string|null;references_ids:string[];content_purged_at:Timestamp|null};
export type DeliveryAttemptDto={id:string;submission_id:string;attempt_number:number;status:string;outcome_determinate:boolean;external_message_id:string|null;rfc_message_id:string|null;error_category:string|null;error_code:string|null;error_message:string|null;diagnostic:object|null;routing_snapshot:object;started_at:Timestamp;finished_at:Timestamp|null;retry_authorized_at:Timestamp|null;retry_authorized_by:string|null;reconciliation_count:number;reconcile_after:Timestamp|null;provider_account:string;provider_type:ProviderType};
export type DeliveryEventDto={id:string;event_type:string;occurred_at:Timestamp;canonical_payload:object;scope:string};
export type DeliveryDetailDto=import('@/lib/types').EmailRecord & {updatedAt:string;retry:{allowed:boolean;reason:string|null;requiresUnknownAcknowledgement:boolean};content:MessageContentDto;lifecycle:string;engagement:string;compliance:string;attempts:DeliveryAttemptDto[];events:DeliveryEventDto[]};
