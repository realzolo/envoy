"use client";

import { ActionForm,DataTable,Field,Notice,formValue,record,requiredRule,rows,useAction,value,type Data,type Row } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { Checkbox,Form,Grid,Input,InputNumber,Modal,Select,Space,Typography } from "@arco-design/web-react";
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
      <Typography.Text>Resend reuses an existing domain or creates one if needed. SES identities are provisioned automatically. For other providers, confirm this domain is verified in the provider dashboard before associating it.</Typography.Text>
      {available.length ? <Checkbox.Group value={selected} onChange={next => setSelected(next.map(String))} options={available.map(row => ({ value: value(row, "id"), label: `${value(row, "name")} (${value(row, "type")})` }))} /> : <Typography.Text type="secondary">Every eligible provider is already associated.</Typography.Text>}
      <Notice notice={action.notice} />
    </Space>
  </Modal>;
}

type Target = { identityId: string; accountId: string; priority: number; weight: number; rateLimit: number };
export function EditRouting({ policy, data, onClose }: { policy: Row; data: Data; onClose: () => void }) {
  const action = useAction();
  const [form] = Form.useForm();
  const [domainId, setDomainId] = useState(value(policy, "sending_domain_id"));
  const [targets, setTargets] = useState<Target[]>(rows(policy.targets).map(row => ({ identityId: value(row, "identityId"), accountId: value(row, "accountId"), priority: Number(row.priority ?? 100), weight: Number(row.weight ?? 100), rateLimit: Number(row.rateLimit ?? 1000) })));
  const domain = rows(data.domains).find(row => row.id === domainId);
  const identities = rows(domain?.identities).filter(row => row.status === "verified" && row.accountStatus === "active");
  function changeTargets(selected: string[]) {
    setTargets(selected.map(identityId => targets.find(row => row.identityId === identityId) ?? { identityId, accountId: value(identities.find(row => row.id === identityId) ?? {}, "accountId"), priority: 100, weight: 100, rateLimit: 1000 }));
  }
  function updateTarget(identityId: string, field: "priority" | "weight" | "rateLimit", next: number) { setTargets(targets.map(row => row.identityId === identityId ? { ...row, [field]: next } : row)); }
  return <Modal title="Edit routing policy" visible style={{ width: 780, maxWidth: "calc(100vw - 24px)" }} onCancel={onClose} confirmLoading={action.pending} okButtonProps={{ disabled: !targets.length }} onOk={async () => {
    const values = await form.validate();
    try { await action.run({method:"PUT",path:`/api/admin/routing-policies/${encodeURIComponent(String(policy.id))}`,payload:{id: policy.id, name: formValue(values, "name"), productId: formValue(values, "productId"), serviceId: formValue(values, "serviceId"), domainId, category: formValue(values, "category"), priority: Number(values.priority), targets}}); onClose(); } catch { /* Preserve configuration and inline error. */ }
  }}>
    <ActionForm fieldErrors={action.fields} form={form} layout="vertical" initialValues={{ name: policy.name, productId: policy.product_id ?? "", serviceId: policy.service_id ?? "", category: policy.message_category ?? "", priority: Number(policy.priority) }}>
      <Grid.Row gutter={[16, 0]}>
      <Grid.Col xs={24} md={12}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
      <Grid.Col xs={24} md={12}><Field field="productId" label="Product"><Select options={[{ value: "", label: "Any product" }, ...rows(data.products).map(row => ({ value: value(row, "id"), label: value(row, "name") }))]} /></Field></Grid.Col>
      <Grid.Col xs={24} md={12}><Field field="serviceId" label="Service"><Select options={[{ value: "", label: "Any service" }, ...rows(data.services).map(row => ({ value: value(row, "id"), label: `${value(row, "product")} / ${value(row, "name")}` }))]} /></Field></Grid.Col>
      <Grid.Col xs={24} md={12}><Field label="Sending domain" required><Select value={domainId} options={rows(data.domains).filter(row => row.status === "active").map(row => ({ value: value(row, "id"), label: value(row, "domain") }))} onChange={next => { setDomainId(String(next)); setTargets([]); }} /></Field></Grid.Col>
      <Grid.Col xs={24} md={12}><Field field="category" label="Category (blank matches any)"><Input /></Field></Grid.Col>
      <Grid.Col xs={24} md={12}><Field field="priority" label="Policy priority (lower is preferred)" required><InputNumber min={0} max={10000} /></Field></Grid.Col>
      <Grid.Col xs={24} md={24}><Field label="Provider targets" required><Checkbox.Group value={targets.map(row => row.identityId)} onChange={next => changeTargets(next.map(String))} options={identities.map(row => ({ value: value(row, "id"), label: value(row, "account") }))} /></Field></Grid.Col>
      </Grid.Row>
    </ActionForm>
    <DataTable searchable={false} data={targets.map(row => ({ ...row, id: row.identityId }))} pagination={false} columns={[
      { title: "Provider", render: (_, row) => value(identities.find(identity => identity.id === row.identityId) ?? row, "account") || value(row, "accountId") },
      { title: "Priority", render: (_, row) => <InputNumber aria-label="Target priority" min={0} max={10000} value={Number(row.priority)} onChange={next => updateTarget(value(row, "identityId"), "priority", Number(next))} /> },
      { title: "Weight", render: (_, row) => <InputNumber aria-label="Target weight" min={1} max={10000} value={Number(row.weight)} onChange={next => updateTarget(value(row, "identityId"), "weight", Number(next))} /> },
      { title: "Requests/min", render: (_, row) => <InputNumber aria-label="Target rate limit" min={1} max={1000000} value={Number(row.rateLimit)} onChange={next => updateTarget(value(row, "identityId"), "rateLimit", Number(next))} /> },
    ]} />
    <Notice notice={action.notice} />
  </Modal>;
}
