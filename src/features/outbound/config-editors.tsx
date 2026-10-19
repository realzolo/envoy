"use client";

import { Notice, record, rows, useAction, value, type Row } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { Checkbox, Modal, Space, Typography } from "@arco-design/web-react";
import { useState } from "react";

export function AddDomainProvider({ domain, providers, onClose }: { domain: Row; providers: Row[]; onClose: () => void }) {
  const action = useAction();
  const existing = new Set(rows(domain.identities).map(row => value(row, "accountId")));
  const available = providers.filter(row => !existing.has(value(row, "id")) && row.status === "active" && (row.type !== "mailgun" || record(row.public_config).sendingDomain === domain.domain));
  const [selected, setSelected] = useState<string[]>([]);
  return <Modal title={`Add providers to ${value(domain, "domain")}`} style={{ width: 640, maxWidth: "calc(100vw - 32px)" }} visible onCancel={onClose} confirmLoading={action.pending} okButtonProps={{ disabled: !selected.length }} onOk={async () => {
    try { await action.run({method:"POST",path:`/api/admin/domains`,payload:{domain: domain.domain, accountIds: selected}}); onClose(); } catch { /* Keep the selection for correction. */ }
  }}>
    <Space direction="vertical" size="large" className={styles.stack}>
      <Typography.Text>Resend and Amazon SES set up the identity and show DNS records to verify. For SendGrid, Mailgun, and Postmark, verify this domain in the provider dashboard first.</Typography.Text>
      {available.length ? <Checkbox.Group value={selected} onChange={next => setSelected(next.map(String))} options={available.map(row => ({ value: value(row, "id"), label: `${value(row, "name")} (${value(row, "type")})` }))} /> : <Typography.Text type="secondary">Every eligible provider is already associated.</Typography.Text>}
      <Notice notice={action.notice} />
    </Space>
  </Modal>;
}
