"use client";

import { LocalTime } from "@/components/local-time";
import styles from "@/components/mail-views.module.css";
import { PageHeader } from "@/components/page-header";
import { RetryDeliveryButton } from "@/features/outbound/retry-delivery-button";
import type { DeliveryStatus } from "@/lib/types";
import {
Alert,Card,Collapse,Descriptions,Empty,Input,Space,Tabs,Tag,Timeline,Typography,
} from "@arco-design/web-react";
import { useRouter } from "next/navigation";

import type {DeliveryDetailDto as DeliveryDetail} from '@/modules/admin/contracts';

const statusColors: Record<DeliveryStatus, string> = {
  delivered: "green", accepted: "arcoblue", submitting: "arcoblue", queued: "gray",
  deferred: "orange", unknown: "orange", bounced: "red", failed: "red", canceled: "gray", suppressed: "purple",
};

const retryReasons: Record<string, string> = {
  content_expired: "The saved message content has expired.",
  suppressed: "This recipient is suppressed or has a compliance restriction.",
  configuration_disabled: "The product, sender authorization, or sending domain is unavailable.",
  status_not_retryable: "The current delivery status does not allow a manual retry.",
  not_found: "This delivery is no longer available.",
};

function labelForStatus(status: string) {
  return status.replace(/[_.]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function colorForEvent(status: string) {
  if (["accepted", "delivered", "opened", "clicked"].includes(status)) return "green";
  if (["unknown", "deferred", "reconciling"].includes(status)) return "orange";
  if (["failed", "bounced", "complained"].includes(status)) return "red";
  return "gray";
}

function displayValue(value: unknown) {
  return value === null || value === undefined || value === "" ? "Not reported" : String(value);
}

function timestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function JsonDetails({ value }: { value: unknown }) {
  return <Input.TextArea autoSize={{ minRows: 3, maxRows: 12 }} readOnly spellCheck={false} value={JSON.stringify(value, null, 2) ?? "Not reported"} />;
}

export function DeliveryDetailView({ detail, back = "/emails" }: { detail: DeliveryDetail; back?: string }) {
  const router = useRouter();

  return (
    <section className={styles.page}>
      <PageHeader
        actions={detail.retry.allowed ? <RetryDeliveryButton id={detail.id} unknown={detail.retry.requiresUnknownAcknowledgement} /> : undefined}
        backIcon
        description={`Delivery to ${detail.recipient}`}
        onBack={() => router.push(back)}
        title={detail.subject || "(No subject)"}
      />
      {detail.lifecycle === "unknown" && <Alert
        content="The provider has not confirmed the outcome. Automatic checks are limited; a manual retry may send a duplicate and requires your confirmation."
        showIcon
        title="Delivery outcome is unknown"
        type="warning"
      />}
      {detail.lastError && <Alert type="error" showIcon title={String(detail.lastError.code ?? "Delivery failed")} content={String(detail.lastError.message ?? "Inspect activity and submission attempts for diagnostics.")} />}
      <Card className={styles.card} bordered={false} title="Delivery overview" extra={<Tag color={statusColors[detail.status]} bordered={false}>{labelForStatus(detail.status)}</Tag>}>
        <Descriptions className={styles.descriptions} column={{ xs: 1, md: 2, xl: 3 }} layout="vertical" tableLayout="fixed" data={[
          { label: "Recipient", value: `${detail.recipient} (${detail.recipientRole ?? "to"})` },
          { label: "From", value: detail.from },
          { label: "Product / category", value: `${detail.product} / ${detail.category}` },
          { label: "Accepted at", value: <LocalTime value={detail.createdAt} /> },
          { label: "Last updated", value: <LocalTime value={detail.updatedAt} /> },
          { label: "Lifecycle / engagement / compliance", value: `${labelForStatus(detail.lifecycle)} / ${labelForStatus(detail.engagement)} / ${labelForStatus(detail.compliance)}` },
          { label: "Message ID", value: <Typography.Text copyable>{detail.messageId ?? "Not reported"}</Typography.Text> },
          { label: "Delivery ID", value: <Typography.Text copyable>{detail.id}</Typography.Text> },
          { label: "Reference", value: detail.referenceId ?? "Not set" },
        ]} />
        {!detail.retry.allowed && detail.retry.reason && <Typography.Text type="secondary">
          Manual retry unavailable: {retryReasons[detail.retry.reason] ?? labelForStatus(detail.retry.reason)}
        </Typography.Text>}
      </Card>
      <Card className={styles.card} bordered={false}>
        <Tabs className={styles.detailTabs} defaultActiveTab="activity" headerPadding={false}>
          <Tabs.TabPane key="activity" title={`Activity (${detail.events.length})`}>
            {detail.events.length ? <Timeline>
              {detail.events.map((event) => {
                const type = String(event.event_type);
                return <Timeline.Item key={String(event.id)} dotColor={`rgb(var(--${colorForEvent(type)}-6))`}>
                  <div className={styles.eventContent}>
                    <div className={styles.eventHeading}>
                      <Typography.Text bold>{labelForStatus(type)}</Typography.Text>
                      {event.scope === "submission" && <Tag>Submission event</Tag>}
                      <Typography.Text type="secondary"><LocalTime value={timestamp(event.occurred_at)} /></Typography.Text>
                    </div>
                    <Collapse bordered={false}>
                      <Collapse.Item name="payload" header="Event details">
                        <JsonDetails value={event.canonical_payload} />
                      </Collapse.Item>
                    </Collapse>
                  </div>
                </Timeline.Item>;
              })}
            </Timeline> : <Empty description="No delivery events yet. Activity will appear here as processing continues." />}
          </Tabs.TabPane>
          <Tabs.TabPane key="content" title="Message content">
            {detail.content.content_policy === "sensitive" ? <Alert showIcon type="info" content="Sensitive message content is encrypted for delivery and is never available for preview. Delivery status and receipt history remain available." /> : detail.content.content_purged_at ? <Alert showIcon type="info" content="Message content has expired under the retention policy. Identifiers and delivery history are retained." /> : <div className={styles.tabPanel}>
              <Descriptions className={styles.descriptions} column={{ xs: 1, md: 2 }} data={[
                { label: "From", value: detail.from },
                ...([ ["To", detail.content.to_recipients], ["Cc", detail.content.cc_recipients], ["Bcc", detail.content.bcc_recipients], ["Reply-To", detail.content.reply_to] ] as const).map(([label, addresses]) => ({ label, value: addresses.map(address => address.name ? `${address.name} <${address.email}>` : address.email).join(", ") || "Not set" })),
                { label: "Attachments", value: detail.content.attachment_snapshot.map(item => String(item.fileName ?? item.fileId)).join(", ") || "None" },
                { label: "In-Reply-To", value: detail.content.in_reply_to ?? "Not set" },
                { label: "References", value: detail.content.references_ids.join(" ") || "Not set" },
              ]} />
              {Object.keys(detail.content.headers).length > 0 && <Collapse><Collapse.Item name="headers" header="Custom mail headers"><JsonDetails value={detail.content.headers} /></Collapse.Item></Collapse>}
              {detail.content.html_body || detail.content.text_body ? <Tabs type="capsule" defaultActiveTab={detail.content.html_body ? "html" : "text"}>
                {detail.content.html_body && <Tabs.TabPane key="html" title="HTML preview">
                  <iframe className={styles.previewFrame} title="Accepted HTML content" sandbox="" srcDoc={detail.content.html_body} />
                </Tabs.TabPane>}
                {detail.content.text_body && <Tabs.TabPane key="text" title="Plain text">
                  <Input.TextArea autoSize={{ minRows: 8, maxRows: 24 }} readOnly value={detail.content.text_body} />
                </Tabs.TabPane>}
              </Tabs> : <Empty description="No saved message content." />}
            </div>}
          </Tabs.TabPane>
          <Tabs.TabPane key="attempts" title={`Routing attempts (${detail.attempts.length})`}>
            {detail.attempts.length ? <Collapse defaultActiveKey={[String(detail.attempts[0].id)]}>
              {detail.attempts.map((attempt) => {
                const status = String(attempt.status);
                return <Collapse.Item key={String(attempt.id)} name={String(attempt.id)} header={<Space wrap>
                  <Typography.Text bold>Attempt {String(attempt.attempt_number)}</Typography.Text>
                  <Typography.Text type="secondary">{displayValue(attempt.provider_account)}</Typography.Text>
                  <Tag color={colorForEvent(status)} bordered={false}>{labelForStatus(status)}</Tag>
                </Space>}>
                  <div className={styles.tabPanel}>
                    {Boolean(attempt.error_message) && <Alert showIcon type="error" content={displayValue(attempt.error_message)} />}
                    <Descriptions className={styles.descriptions} layout="vertical" tableLayout="fixed" column={{ xs: 1, md: 2, xl: 3 }} data={[
                      { label: "Submission ID", value: displayValue(attempt.submission_id) },
                      { label: "Provider", value: displayValue(attempt.provider_type) },
                      { label: "Provider external ID", value: displayValue(attempt.external_message_id) },
                      { label: "Actual RFC Message-ID", value: attempt.rfc_message_id ? displayValue(attempt.rfc_message_id) : "Unknown / unconfirmed" },
                      { label: "Outcome confirmed", value: attempt.outcome_determinate === true ? "Yes" : attempt.outcome_determinate === false ? "No" : "Not reported" },
                      { label: "Started", value: attempt.started_at ? <LocalTime value={timestamp(attempt.started_at)} /> : "Not reported" },
                      { label: "Finished", value: attempt.finished_at ? <LocalTime value={timestamp(attempt.finished_at)} /> : "Not reported" },
                      ...(attempt.error_category || attempt.error_code ? [{ label: "Error category / code", value: `${displayValue(attempt.error_category)} / ${displayValue(attempt.error_code)}` }] : []),
                      ...(attempt.retry_authorized_at ? [{ label: "Duplicate risk accepted", span: 3, value: <Space wrap>{displayValue(attempt.retry_authorized_by)}<LocalTime value={timestamp(attempt.retry_authorized_at)} /></Space> }] : []),
                    ]} />
                    <Collapse bordered={false}>
                      <Collapse.Item name="routing" header="Routing snapshot"><JsonDetails value={attempt.routing_snapshot} /></Collapse.Item>
                    </Collapse>
                  </div>
                </Collapse.Item>;
              })}
            </Collapse> : <Empty description="No routing attempts yet. The message is waiting for processing." />}
          </Tabs.TabPane>
        </Tabs>
      </Card>
    </section>
  );
}
