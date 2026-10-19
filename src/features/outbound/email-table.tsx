"use client";

import { LocalTime } from "@/components/local-time";
import styles from "@/components/mail-views.module.css";
import type { DeliveryStatus,EmailRecord } from "@/lib/types";
import { messageFilterQuery,type MessageFilters } from "@/modules/admin/contracts";
import type { TableColumnProps } from "@arco-design/web-react";
import {
Link as ArcoLink,
Button,Empty,Form,Input,
Select,Space,Table,Tag,Typography,
} from "@arco-design/web-react";
import { IconRefresh,IconSearch,IconSend } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { useState,useTransition } from "react";

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
  delivered: "green", accepted: "arcoblue", submitting: "arcoblue", queued: "gray",
  deferred: "orange", unknown: "orange", bounced: "red", failed: "red", canceled: "gray", suppressed: "purple",
};

const statusLabels = Object.fromEntries(statusOptions.map((option) => [option.value, option.label]));

const columns = (back: string): TableColumnProps<EmailRecord>[] => [
  {
    title: "Recipient", dataIndex: "recipient", width: 260,
    render: (_, email) => (
      <div>
        <ArcoLink className={styles.cellLink} href={`/emails/${email.id}?back=${encodeURIComponent(back)}`}>
          <span className={styles.cellText} title={email.recipient}>{email.recipient}</span>
        </ArcoLink>
        <Typography.Text className={styles.cellSubtext} type="secondary" title={email.referenceId ?? email.id}>
          {email.referenceId ?? email.id}
        </Typography.Text>
      </div>
    ),
  },
  {
    title: "Subject", dataIndex: "subject",
    render: (_, email) => (
      <ArcoLink className={styles.cellLink} href={`/emails/${email.id}?back=${encodeURIComponent(back)}`}>
        <span className={styles.cellText} title={email.subject}>{email.subject || "(No subject)"}</span>
      </ArcoLink>
    ),
  },
  {
    title: "Service", dataIndex: "service", width: 150,
    render: (service: string) => <span className={styles.cellText} title={service}>{service}</span>,
  },
  {
    title: "Status", dataIndex: "status", width: 130,
    render: (status: DeliveryStatus) => <Tag color={statusColors[status]} bordered={false}>{statusLabels[status]}</Tag>,
  },
  {
    title: "Accepted at", dataIndex: "createdAt", width: 240,
    render: (_, email) => <span className={styles.timestamp}><LocalTime value={email.createdAt} /></span>,
  },
];

export function EmailTable({ records, compact = false, variant = "page", filters = { q: "", status: "all" }, nextCursor }: {
  records: EmailRecord[];
  compact?: boolean;
  variant?: "embedded" | "page";
  filters?: MessageFilters;
  nextCursor?: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(filters.q);
  const [status, setStatus] = useState<MessageFilters["status"]>(filters.status);
  const [pending, startTransition] = useTransition();
  const filteredByUser = Boolean(filters.q) || filters.status !== "all";
  const navigate = (next: MessageFilters) => startTransition(() => router.push(`/emails?${messageFilterQuery(next, true)}`));
  const reset = () => {
    setQuery("");
    setStatus("all");
    startTransition(() => router.push("/emails"));
  };
  const emptyState = (
    <Empty description={
      <Space direction="vertical" size="medium" align="center">
        <Typography.Text type="secondary">
          {filteredByUser ? "No deliveries match these filters." : filters.cursor ? "No more deliveries on this page." : "No messages have been sent yet."}
        </Typography.Text>
        {filteredByUser || filters.cursor ? (
          <Button icon={<IconRefresh />} onClick={reset}>Reset filters</Button>
        ) : <Button href="/emails/compose" icon={<IconSend />} type="primary">Send a test</Button>}
      </Space>
    } />
  );

  return (
    <div className={styles.table}>
      {!compact && <>
        <Form className={styles.filters} layout="vertical" onSubmit={() => navigate({ q: query, status })}>
          <div className={styles.filterGrid}>
            <Form.Item label="Search messages">
              <Input allowClear placeholder="ID, reference, recipient, subject, or service" prefix={<IconSearch />} value={query} onChange={setQuery} />
            </Form.Item>
            <Form.Item label="Delivery status">
              <Select options={statusOptions} value={status} onChange={setStatus} />
            </Form.Item>
            <Space className={styles.filterActions}>
              <Button htmlType="submit" icon={<IconSearch />} loading={pending} type="primary">Search</Button>
              <Button icon={<IconRefresh />} onClick={reset} disabled={pending}>Reset</Button>
            </Space>
          </div>
        </Form>
        <div className={styles.resultBar}>
          <Typography.Text bold>Recipient deliveries</Typography.Text>
          <Typography.Text type="secondary">{records.length.toLocaleString("en-US")} on this page · local time</Typography.Text>
        </div>
      </>}
      <Table<EmailRecord>
        border={variant === "page"}
        columns={columns(`/emails?${messageFilterQuery(filters, true)}`)}
        data={records}
        loading={pending}
        hover
        noDataElement={emptyState}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1180 }}
        tableLayoutFixed
        size={compact ? "small" : "default"}
      />
      {!compact && <div className={styles.pagination}>
        {filters.cursor && <Button disabled={pending} onClick={() => navigate({ ...filters, cursor: undefined })}>First page</Button>}
        <Button disabled={!nextCursor || pending} onClick={() => navigate({ ...filters, cursor: nextCursor ?? undefined })}>Next page</Button>
      </div>}
    </div>
  );
}
