"use client";

import {
  Alert,
  Card,
  Descriptions,
  Empty,
  Grid,
  Input,
  Space,
  Tag,
  Timeline,
  Typography,
} from "@arco-design/web-react";
import { IconBranch } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { RetryDeliveryButton } from "@/components/admin-console";
import { PageHeader } from "@/components/page-header";
import type { DeliveryStatus, EmailRecord } from "@/lib/types";

type DeliveryDetail = EmailRecord & {
  lifecycle: string;
  engagement: string;
  compliance: string;
  attempts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
};

const statusColors: Record<DeliveryStatus, string> = {
  delivered: "green",
  accepted: "arcoblue",
  submitting: "arcoblue",
  queued: "gray",
  deferred: "orange",
  unknown: "orange",
  bounced: "red",
  failed: "red",
  canceled: "gray",
  suppressed: "purple",
};

function labelForStatus(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function colorForAttempt(status: string) {
  if (status === "accepted" || status === "delivered") return "green";
  if (status === "unknown" || status === "deferred") return "orange";
  if (status === "failed" || status === "bounced") return "red";
  return "gray";
}

function displayValue(value: unknown) {
  return value === null || value === undefined || value === "" ? "Not reported" : String(value);
}

export function DeliveryDetailView({ detail }: { detail: DeliveryDetail }) {
  const retryable = ["unknown", "failed", "bounced", "deferred"].includes(detail.lifecycle);
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        actions={retryable ? <RetryDeliveryButton id={detail.id} unknown={detail.lifecycle === "unknown"} /> : undefined}
        backIcon
        description={(
          <Space size="small">
            <Tag color={statusColors[detail.status]} bordered={false}>{labelForStatus(detail.status)}</Tag>
            <Typography.Text code>{detail.id}</Typography.Text>
          </Space>
        )}
        onBack={() => router.push("/emails")}
        title={detail.subject}
      />

      {detail.lifecycle === "unknown" && (
        <Alert
          content="The provider outcome is unknown. Envoy will reconcile before retrying. A manual retry can produce a duplicate and requires explicit operator acknowledgement."
          showIcon
          title="Provider outcome requires reconciliation"
          type="warning"
        />
      )}

      <Grid.Row gutter={[16, 16]}>
        <Grid.Col lg={16} xs={24}>
          <Card title="Canonical timeline">
          {detail.events.length ? (
            <Timeline>
              {detail.events.map((event) => (
                <Timeline.Item
                  key={String(event.id)}
                  dotColor="rgb(var(--green-6))"
                  label={
                    <Typography.Text type="secondary">
                      <time>{new Date(String(event.occurred_at)).toLocaleString("en-GB")}</time>
                    </Typography.Text>
                  }
                >
                  <Space direction="vertical" size="small" style={{ width: "100%" }}>
                    <Typography.Text bold>{String(event.event_type)}</Typography.Text>
                    <Input.TextArea
                      autoSize={{ minRows: 3, maxRows: 12 }}
                      readOnly
                      spellCheck={false}
                      value={JSON.stringify(event.canonical_payload, null, 2) ?? "Not reported"}
                    />
                  </Space>
                </Timeline.Item>
              ))}
            </Timeline>
          ) : (
            <Empty description="No canonical events yet." />
          )}
          </Card>
        </Grid.Col>

        <Grid.Col lg={8} xs={24}>
          <Card title="Delivery">
            <Descriptions
              column={1}
              data={[
                { label: "Recipient", value: detail.recipient },
                { label: "From", value: detail.from },
                { label: "Product", value: detail.product },
                { label: "Category", value: detail.category },
                { label: "Lifecycle", value: labelForStatus(detail.lifecycle) },
                { label: "Engagement", value: labelForStatus(detail.engagement) },
                { label: "Compliance", value: labelForStatus(detail.compliance) },
                { label: "Accepted", value: detail.createdAt },
              ]}
              layout="vertical"
              size="small"
            />
          </Card>
        </Grid.Col>
      </Grid.Row>

      <Space direction="vertical" size="medium" style={{ width: "100%" }}>
        <Typography.Title heading={4} style={{ margin: 0 }}>
          <Space align="center" size="mini">
            <IconBranch aria-hidden="true" />
            Routing attempts
          </Space>
        </Typography.Title>
        {detail.attempts.length ? (
          <Space direction="vertical" size="medium" style={{ width: "100%" }}>
            {detail.attempts.map((attempt) => {
              const status = String(attempt.status);

              return (
                <Card
                  extra={
                    <Tag color={colorForAttempt(status)} bordered={false} size="small">
                      {labelForStatus(status)}
                    </Tag>
                  }
                  key={String(attempt.id)}
                  title={`Attempt ${String(attempt.attempt_number)}`}
                >
                  <Space direction="vertical" size="medium" style={{ width: "100%" }}>
                    <Typography.Text type="secondary">
                      {displayValue(attempt.provider_account)} ({displayValue(attempt.provider_type)})
                    </Typography.Text>
                  <Descriptions
                    column={{ xs: 1, md: 2 }}
                    data={[
                      {
                        label: "External ID",
                        value: (
                          <Typography.Text code>{displayValue(attempt.external_message_id)}</Typography.Text>
                        ),
                      },
                      {
                        label: "Outcome determinate",
                        value: displayValue(attempt.outcome_determinate),
                      },
                      {
                        label: "Routing snapshot",
                        span: 2,
                        value: (
                          <Input.TextArea
                            autoSize={{ minRows: 3, maxRows: 12 }}
                            readOnly
                            spellCheck={false}
                            value={JSON.stringify(attempt.routing_snapshot, null, 2) ?? "Not reported"}
                          />
                        ),
                      },
                      ...(attempt.error_message
                        ? [
                            {
                              label: "Provider error",
                              span: 2,
                              value: (
                                <Typography.Text type="error">
                                  {displayValue(attempt.error_category)} / {displayValue(attempt.error_code)}: {displayValue(
                                    attempt.error_message,
                                  )}
                                </Typography.Text>
                              ),
                            },
                          ]
                        : []),
                    ]}
                    layout="vertical"
                    size="small"
                  />
                  </Space>
                </Card>
              );
            })}
          </Space>
        ) : (
          <Empty description="No routing attempts yet." />
        )}
      </Space>
    </Space>
  );
}
