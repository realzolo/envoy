"use client";
import { ActionButton,type Data,DataTable,date,JsonPreview,rows,StatusTag,TableCard,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { Space,Typography } from "@arco-design/web-react";
import { IconRotateLeft } from "@arco-design/web-react/icon";
export function Events({ data }: { data: Data }) {
  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <TableCard title="Raw provider events">
        <DataTable
          data={rows(data.rawEvents)}
          minWidth="980px"
          columns={[
            { title: "Native type", render: (_, event) => <Typography.Text code>{value(event, "native_type")}</Typography.Text> },
            { title: "Account", render: (_, event) => <Space size="mini"><Typography.Text>{value(event, "account")}</Typography.Text><Typography.Text type="secondary">({value(event, "type")})</Typography.Text></Space> },
            { title: "Provider event ID", render: (_, event) => <Typography.Text code>{value(event, "provider_event_id")}</Typography.Text> },
            { title: "Verification", render: (_, event) => <StatusTag>{event.signature_valid && event.replay_valid ? "Verified" : "Rejected"}</StatusTag> },
            { title: "Received", render: (_, event) => date(event.received_at) },
            { title: "Processing", render: (_, event) => event.terminated_at ? <StatusTag>Terminated</StatusTag> : event.processing_error ? <Typography.Text type="error">{value(event, "processing_error")}</Typography.Text> : <StatusTag>{event.processed_at ? "Processed" : "Pending"}</StatusTag> },
            { title: "Action", render: (_, event) => <Space>{!event.terminated_at && !event.content_purged_at ? <ActionButton body={{method:"POST",path:`/api/admin/provider-events/${encodeURIComponent(String(event.id))}/replays`,payload:{id: event.id}}}><IconRotateLeft />Replay</ActionButton> : null}{!event.terminated_at && Number(event.processing_attempt_count)>=20 && !event.processed_at ? <ActionButton danger body={{method:"POST",path:`/api/admin/provider-events/${encodeURIComponent(String(event.id))}/termination`,payload:{id:event.id}}} confirmText="Permanently stop this exhausted receipt? Unfinished copies are rejected and retention may remove content. Successful copies are preserved.">Terminate recovery</ActionButton> : null}</Space> },
          ]}
        />
      </TableCard>
      <TableCard title="Canonical delivery events">
        <DataTable
          data={rows(data.canonicalEvents)}
          minWidth="900px"
          columns={[
            { title: "Type", render: (_, event) => <Typography.Text code>{value(event, "event_type")}</Typography.Text> },
            { title: "Scope / recipient", render: (_, event) => `${value(event, "scope")} / ${value(event, "recipient_email") || "Entire submission"}` },
            { title: "Occurred", render: (_, event) => date(event.occurred_at) },
            { title: "Canonical payload", render: (_, event) => <JsonPreview data={event.canonical_payload} title="Canonical event payload" /> },
          ]}
        />
      </TableCard>
    </Space>
  );
}
