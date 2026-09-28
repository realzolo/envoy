"use client";

import {
  Button,
  Empty,
  Form,
  Grid,
  Input,
  Link as ArcoLink,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconRefresh, IconSearch, IconSend } from "@arco-design/web-react/icon";
import { useMemo, useState } from "react";
import type { DeliveryStatus, EmailRecord } from "@/lib/types";

const messagePagination = {
  defaultPageSize: 20,
  hideOnSinglePage: true,
  showJumper: true,
  showTotal: true,
  sizeCanChange: true,
  sizeOptions: [10, 20, 50],
};

const statusOptions: Array<{ value: "all" | DeliveryStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "delivered", label: "Delivered" },
  { value: "accepted", label: "Accepted" },
  { value: "submitting", label: "Submitting" },
  { value: "queued", label: "Queued" },
  { value: "deferred", label: "Deferred" },
  { value: "unknown", label: "Unknown" },
  { value: "bounced", label: "Bounced" },
  { value: "failed", label: "Failed" },
  { value: "canceled", label: "Canceled" },
  { value: "suppressed", label: "Suppressed" },
];

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

const statusLabels = Object.fromEntries(
  statusOptions
    .filter((option): option is { value: DeliveryStatus; label: string } => option.value !== "all")
    .map((option) => [option.value, option.label]),
) as Record<DeliveryStatus, string>;

const columns: TableColumnProps<EmailRecord>[] = [
  {
    title: "Recipient",
    dataIndex: "recipient",
    width: 260,
    render: (_, email) => (
      <ArcoLink href={`/emails/${email.id}`}>
        <Typography.Ellipsis rows={1} showTooltip>
          {email.recipient}
        </Typography.Ellipsis>
      </ArcoLink>
    ),
  },
  {
    title: "Subject",
    dataIndex: "subject",
    render: (_, email) => (
      <ArcoLink href={`/emails/${email.id}`}>
        <Typography.Ellipsis rows={1} showTooltip>
          {email.subject}
        </Typography.Ellipsis>
      </ArcoLink>
    ),
  },
  {
    title: "Product",
    dataIndex: "product",
    width: 160,
    render: (product) => (
      <Typography.Ellipsis rows={1} showTooltip>
        <Typography.Text type="secondary">{product}</Typography.Text>
      </Typography.Ellipsis>
    ),
  },
  {
    title: "Status",
    dataIndex: "status",
    width: 126,
    render: (status: DeliveryStatus) => (
      <Tag color={statusColors[status]} bordered={false} size="small">
        {statusLabels[status]}
      </Tag>
    ),
  },
  {
    title: "Time",
    dataIndex: "relativeTime",
    width: 110,
    align: "right",
    render: (relativeTime) => <Typography.Text type="secondary">{relativeTime}</Typography.Text>,
  },
];

export function EmailTable({
  records,
  compact = false,
  variant = "page",
}: {
  records: EmailRecord[];
  compact?: boolean;
  variant?: "embedded" | "page";
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | DeliveryStatus>("all");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((email) => {
      const statusMatches = status === "all" || email.status === status;
      const queryMatches =
        !normalized ||
        email.recipient.toLowerCase().includes(normalized) ||
        email.subject.toLowerCase().includes(normalized) ||
        email.product.toLowerCase().includes(normalized);
      return statusMatches && queryMatches;
    });
  }, [query, records, status]);

  const displayedRecords = compact ? filtered.slice(0, 5) : filtered;
  const filteredByUser = Boolean(query.trim()) || status !== "all";

  const emptyState = records.length === 0 ? (
    <Empty
      description={(
        <Space direction="vertical" size="medium" align="center">
          <Typography.Text type="secondary">No messages have been sent yet.</Typography.Text>
          <Button href="/emails/compose" icon={<IconSend />} type="primary">Send a test</Button>
        </Space>
      )}
    />
  ) : (
    <Empty
      description={(
        <Space direction="vertical" size="medium" align="center">
          <Typography.Text type="secondary">No messages match the current filters.</Typography.Text>
          <Button
            icon={<IconRefresh />}
            onClick={() => {
              setQuery("");
              setStatus("all");
            }}
            type="secondary"
          >
            Clear filters
          </Button>
        </Space>
      )}
    />
  );

  return (
    <>
      {!compact && (
        <Form className="message-filters" layout="vertical">
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={16} xs={24}>
              <Form.Item label="Search messages">
                <Input
                  allowClear
                  placeholder="Search recipient, subject, or product"
                  prefix={<IconSearch aria-hidden="true" />}
                  value={query}
                  onChange={setQuery}
                />
              </Form.Item>
            </Grid.Col>
            <Grid.Col md={8} xs={24}>
              <Form.Item label="Delivery status">
                <Select
                  options={statusOptions}
                  value={status}
                  onChange={(value) => setStatus(value as "all" | DeliveryStatus)}
                />
              </Form.Item>
            </Grid.Col>
          </Grid.Row>
        </Form>
      )}

      {!compact && (
        <div className="table-summary">
          <Typography.Text type="secondary">
            {filtered.length.toLocaleString()} {filtered.length === 1 ? "message" : "messages"}
          </Typography.Text>
          {filteredByUser && (
            <Button
              icon={<IconRefresh aria-hidden="true" />}
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
              size="small"
              type="text"
            >
              Reset filters
            </Button>
          )}
        </div>
      )}

      <Table<EmailRecord>
        border={variant === "page"}
        className="message-table"
        columns={columns}
        data={displayedRecords}
        hover
        noDataElement={emptyState}
        pagination={compact ? false : messagePagination}
        rowKey="id"
        scroll={displayedRecords.length ? { x: 760 } : undefined}
        size={compact ? "small" : "default"}
      />
    </>
  );
}
