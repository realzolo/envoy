"use client";
import { ActionButton,CopyableValue,type Data,DataTable,date,JsonPreview,rows,StatusTag,TableCard,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { Space,Typography } from "@arco-design/web-react";
export function Logs({ data }: { data: Data }) {
  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <TableCard title="Failed and overdue work (latest 200)">
        <DataTable data={rows(data.failedWork)} minWidth="900px" columns={[
          { title: "Work", render: (_, item) => <Space direction="vertical" size="mini"><Typography.Text code>{value(item, "event_type")}</Typography.Text><CopyableValue text={value(item, "id")} label="work ID" /></Space> },
          { title: "Resource", render: (_, item) => `${value(item, "aggregate_type")} / ${value(item, "aggregate_id")}` },
          { title: "Status", render: (_, item) => <StatusTag>{value(item, "status")}</StatusTag> },
          { title: "Attempts", render: (_, item) => value(item, "attempt_count") },
          { title: "Due", render: (_, item) => date(item.available_at) },
          { title: "Action", render: (_, item) => item.status === "failed" ? <ActionButton body={{method:"POST",path:`/api/admin/outbox-events/${encodeURIComponent(String(item.id))}/retries`,payload:{id: item.id}}} confirmText="Retry publishing this failed work item?">Retry work</ActionButton> : <Typography.Text type="secondary">Recovery scan will inspect overdue work</Typography.Text> },
        ]} />
      </TableCard>
      <TableCard title="Audit log">
        <DataTable
          data={rows(data.audit)}
          minWidth="900px"
          columns={[
            { title: "Actor", render: (_, audit) => value(audit, "actor") },
            { title: "Action", render: (_, audit) => <Typography.Text code>{value(audit, "action")}</Typography.Text> },
            { title: "Resource", render: (_, audit) => `${value(audit, "resource_type")} / ${value(audit, "resource_id")}` },
            { title: "Details", render: (_, audit) => <JsonPreview data={audit.details} title="Audit details" /> },
            { title: "Time", render: (_, audit) => date(audit.created_at) },
          ]}
        />
      </TableCard>
    </Space>
  );
}