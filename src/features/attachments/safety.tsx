"use client";
import { ActionButton,CopyableValue,type Data,DataTable,date,record,rows,StatusTag,TableCard,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { Card,Space,Typography } from "@arco-design/web-react";
export function AttachmentSafety({ data }: { data:Data }) {
  const configuration=record(data.configuration);
  return <Space direction="vertical" size="large" className={styles.stack}>
    <Card title="Safety policy"><Typography.Paragraph>
      {configuration.mode === "integrity_only" ? "Integrity verification only (malware scanning disabled)" : "Clean scanner result required"} · Policy {value(configuration,"version")} · Scanner {configuration.configured ? "configured" : "not configured"} · Concurrency {value(configuration,"concurrency")} · Deadline {value(configuration,"timeout")} ms.
      Configuration is not a live health check. Integrity-only files are marked verified, never clean.
    </Typography.Paragraph><DataTable data={rows(data.observations)} columns={[
      {title:"Observed state",render:(_,r)=><StatusTag>{value(r,"status")}</StatusTag>},{title:"Count",render:(_,r)=>value(r,"count")},
      {title:"Last result",render:(_,r)=>r.last_observed_at ? date(r.last_observed_at) : "Not observed"}
    ]}/></Card>
    <TableCard title="Attachment tasks (latest 200)"><DataTable data={rows(data.tasks)} columns={[
      {title:"Resource",render:(_,r)=><CopyableValue text={value(r,"resource_id")} label="attachment ID"/>},
      {title:"Scope",render:(_,r)=>`${value(r,"kind")} / ${value(r,"service_id") || "administrator"}`},
      {title:"State / reason",render:(_,r)=><Space direction="vertical"><StatusTag>{value(r,"status")}</StatusTag><Typography.Text>{value(r,"reason")}</Typography.Text></Space>},
      {title:"Attempts / policy",render:(_,r)=>`${value(r,"attempt_count")} / ${value(r,"policy_version")}`},
      {title:"Observed",render:(_,r)=>r.checked_at ? date(r.checked_at) : "Not processed"},
      {title:"Recovery",render:(_,r)=>r.status === "unavailable" ? <ActionButton body={{method:"POST",path:`/api/admin/attachment-tasks/${encodeURIComponent(String(r.resource_id))}/retries`,payload:{id:r.resource_id, kind:r.kind}}} confirmText="Reprocess retained bytes under the current safety policy?">Reprocess</ActionButton> : "—"}
    ]}/></TableCard>
  </Space>;
}
