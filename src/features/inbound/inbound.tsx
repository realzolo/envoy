"use client";

import styles from "@/components/admin-views.module.css";

import { Alert,Button,Card,Collapse,Descriptions,Space,Typography } from "@arco-design/web-react";

import { useState } from "react";

import { CopyableValue,type Data,DataTable,date,EmptyState,record,rows,StatusTag,TableCard,value } from "@/components/admin-console-shared";
import { ResourceDetail } from "@/components/admin-resource-detail";

export function Inbound({ data }: { data: Data }) {
  const items = rows(data.inbound);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      {items.length ? (
        <TableCard title="Inbound messages">
          <DataTable
            data={items}
            columns={[
              { title: "From", render: (_, item) => value(item, "from_email") },
              { title: "To", render: (_, item) => Array.isArray(item.to_emails) ? item.to_emails.join(", ") : "" },
              { title: "Subject", render: (_, item) => <Button type="text" onClick={() => setSelectedId(value(item, "id"))}>{value(item, "subject") || "(No subject)"}</Button> },
              { title: "Service / visibility", render: (_, item) => <Space direction="vertical" size="mini"><Typography.Text>{value(item, "service") || "No receiving Service"}</Typography.Text>{!item.service_id && <Typography.Text type="secondary">Administrator only</Typography.Text>}</Space> },
              { title: "Attachments", render: (_, item) => value(item, "attachment_count") },
              { title: "Status", render: (_, item) => <StatusTag>{value(item, "status")}</StatusTag> },
              { title: "Stored", render: (_, item) => date(item.received_at) },
            ]}
          />
        </TableCard>
      ) : (
        <Card className={styles.card} title="Inbound messages">
          <EmptyState text="No inbound messages have been received." />
        </Card>
      )}
      {selectedId && <ResourceDetail key={selectedId} title="Inbound message" path={`/api/admin/inbound/${encodeURIComponent(selectedId)}`} onClose={() => setSelectedId(null)}>{item => <>
        <div className={styles.section}>
        <Typography.Text bold>{value(item, "subject") || "(No subject)"}</Typography.Text>
        <Descriptions column={1} layout="vertical" tableLayout="fixed" data={[
          { label: "Status", value: <StatusTag>{value(item, "status")}</StatusTag> },
          { label: "Stored", value: date(item.received_at) },
          { label: "Author Date", value: item.author_date ? date(item.author_date) : "Not supplied / invalid" },
          { label: "Trusted ingress", value: item.ingress_received_at ? date(item.ingress_received_at) : "Unknown" },
          { label: "Readable since", value: item.ready_at ? date(item.ready_at) : "Unknown / not ready" },
          { label: "Envoy ID", value: <CopyableValue text={value(item, "id")} label="inbound message ID" /> },
          { label: "RFC Message-ID", value: value(item, "message_id") || "Not supplied" },
          { label: "SMTP recipients", value: Array.isArray(item.envelope_recipients) && item.envelope_recipients.length ? item.envelope_recipients.join(", ") : "Unknown / unverified" },
          { label: "Reply-To", value: Array.isArray(item.reply_to) ? item.reply_to.join(", ") : "" },
          { label: "In-Reply-To", value: value(item, "in_reply_to") || "Not supplied" },
          { label: "References", value: Array.isArray(item.references_ids) ? item.references_ids.join(" ") : "" },
          { label: "From", value: value(item, "from_email") },
          { label: "To", value: Array.isArray(item.to_emails) ? item.to_emails.join(", ") : "" },
          { label: "Service", value: value(item, "service") || "Administrator only" },
        ]} />
        </div>
        {item.rejection_reason ? <Alert type="error" content={value(item, "rejection_reason")} showIcon /> : null}
        {item.content_purged_at ? <Alert type="info" content="Message content was removed under the retention policy." /> : <>
          <Collapse defaultActiveKey={["text"]}>
            <Collapse.Item name="text" header="Plain-text content"><pre className={styles.code}>{value(item, "text_body") || "No plain-text content."}</pre></Collapse.Item>
            {item.sanitized_html ? <Collapse.Item name="html" header="Isolated HTML preview"><iframe title="Inbound HTML preview" className={styles.preview} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${value(item, "sanitized_html")}`} /></Collapse.Item> : null}
          </Collapse>
        </>}
        <div className={styles.section}><Typography.Text bold>Attachments</Typography.Text>
        <DataTable searchable={false} minWidth="640px" data={rows(item.attachments)} columns={[
          { title: "File", render: (_, file) => value(file, "file_name") },
          { title: "Size / type", render: (_, file) => `${Number(file.size_bytes).toLocaleString("en-US")} B · ${value(file, "content_type")}` },
          { title: "Scan", render: (_, file) => <StatusTag>{value(record(file.usage), "state")}</StatusTag> },
          { title: "Download", render: (_, file) => file.content_purged_at ? "Removed" : item.status === "ready" && file.downloadable !== false ? <Button href={`/api/admin/inbound/${encodeURIComponent(value(item, "id"))}/attachments/${encodeURIComponent(value(file, "id"))}`} size="small">Download</Button> : "Unavailable" },
        ]} emptyText="No attachments." />
        </div>
      </>}</ResourceDetail>}
    </Space>
  );
}
