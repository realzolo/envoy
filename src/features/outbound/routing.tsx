"use client";
import { ActionButton,ActionForm,type Data,Field,formValue,type FormValues,Notice,Panel,Prerequisite,record,requiredRule,RoutingSimulation,type Row,rows,StatusTag,Submit,useAction,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { EditRouting } from "@/features/outbound/config-editors";
import { Button,Card,Grid,Input,List,Select,Space,Typography } from "@arco-design/web-react";
import { useState } from "react";
export function Routing({ data }: { data: Data }) {
  const [editingPolicy, setEditingPolicy] = useState<Row | null>(null);
  const create = useAction();
  const simulate = useAction();
  const [simulationResult, setSimulationResult] = useState<Row | null>(null);
  const domains = rows(data.domains);
  const eligibleDomains = domains.filter(domain => domain.status === "active" && rows(domain.identities).some(identity => identity.status === "verified" && identity.accountStatus === "active"));
  const [domainId, setDomainId] = useState(() => value(eligibleDomains[0] ?? {}, "id"));
  const selectedDomainId = eligibleDomains.some(domain => value(domain, "id") === domainId) ? domainId : value(eligibleDomains[0] ?? {}, "id");
  const selectedDomain = eligibleDomains.find(domain => value(domain, "id") === selectedDomainId);
  const eligibleIdentities = rows(selectedDomain?.identities).filter(identity => identity.status === "verified" && identity.accountStatus === "active");
  const [identityId, setIdentityId] = useState(() => value(eligibleIdentities[0] ?? {}, "id"));
  const selectedIdentityId = eligibleIdentities.some(identity => value(identity, "id") === identityId) ? identityId : value(eligibleIdentities[0] ?? {}, "id");

  function changeDomain(nextDomainId: string | number) {
    const next = String(nextDomainId);
    setDomainId(next);
    const nextDomain = eligibleDomains.find(domain => value(domain, "id") === next);
    const nextIdentity = rows(nextDomain?.identities).find(identity => identity.status === "verified" && identity.accountStatus === "active");
    setIdentityId(value(nextIdentity ?? {}, "id"));
  }

  async function submit(values: FormValues) {
    const identity = rows(domains.find(domain => value(domain, "id") === selectedDomainId)?.identities).find(item => item.id === selectedIdentityId);
    try {
      await create.run({method:"POST",path:`/api/admin/routing-policies`,payload:{name: formValue(values, "name"), productId: formValue(values, "productId"), serviceId: formValue(values, "serviceId"), domainId: selectedDomainId, category: formValue(values, "category"), targets: [{ accountId: identity?.accountId, identityId: selectedIdentityId }]}});
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  async function simulateSubmit(values: FormValues) {
    try {
      const result = await simulate.run({method:"POST",path:`/api/admin/routing-simulations`,payload:{domainId: selectedDomainId, productId: formValue(values, "productId"), serviceId: formValue(values, "serviceId"), category: formValue(values, "category")}});
      setSimulationResult(record(result));
    } catch {
      setSimulationResult(null);
    }
  }

  const policies = rows(data.policies);
  if (!eligibleDomains.length) {
    return <Prerequisite title="Verify a provider identity first" description="A routing policy can only target a verified domain identity." href="/domains" action="Manage domains" />;
  }

  const productOptions = [{ value: "", label: "Any" }, ...rows(data.products).map(product => ({ value: value(product, "id"), label: value(product, "name") }))];
  const serviceOptions = [{ value: "", label: "Any" }, ...rows(data.services).map(service => ({ value: value(service, "id"), label: `${value(service, "product")} / ${value(service, "name")}` }))];

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Create routing policy"
        description="Match a verified identity to a sending domain"
        defaultExpanded={policies.length === 0}
      >
        <ActionForm fieldErrors={create.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)} initialValues={{ productId: "", serviceId: "" }}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="productId" label="Product"><Select options={productOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="serviceId" label="Service"><Select options={serviceOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Sending domain" required><Select value={selectedDomainId} options={eligibleDomains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} onChange={changeDomain} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="category" label="Category"><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Provider identity" required><Select value={selectedIdentityId} options={eligibleIdentities.map(identity => ({ value: value(identity, "id"), label: `${value(identity, "account")} / ${value(identity, "status")}` }))} onChange={next => setIdentityId(String(next))} /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={create.pending} labelText="Create policy" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={create.notice} />
      </Panel>
      <Panel
        title="Route simulator"
        description="Read-only deterministic eligibility inspection"
        defaultExpanded={false}
      >
        <ActionForm fieldErrors={simulate.fields} layout="vertical" onSubmit={values => void simulateSubmit(values as FormValues)} initialValues={{ productId: "", serviceId: "" }}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field label="Sending domain" required><Select value={selectedDomainId} options={eligibleDomains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} onChange={changeDomain} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="productId" label="Product"><Select options={productOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="serviceId" label="Service"><Select options={serviceOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="category" label="Category"><Input /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={simulate.pending} labelText="Simulate" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <RoutingSimulation result={simulationResult} />
        <Notice notice={simulate.notice?.kind === "error" ? simulate.notice : null} />
      </Panel>
      {policies.map(policy => (
        <Card
          className={styles.card}
          key={value(policy, "id")}
          title={value(policy, "name")}
          extra={<Space><Button size="small" onClick={() => setEditingPolicy(policy)}>Edit targets</Button><ActionButton body={{method:"PATCH",path:`/api/admin/routing-policies/${encodeURIComponent(String(policy.id))}`,payload:{id: policy.id, enabled: policy.status !== "active"}}}>{policy.status === "active" ? "Disable" : "Enable"}</ActionButton></Space>}
        >
          <Space direction="vertical" size="medium">
            <Typography.Text type="secondary">{value(policy, "sending_domain")} / {value(policy, "product") || "Any product"} / {value(policy, "service") || "Any service"} / {value(policy, "message_category") || "Any category"}</Typography.Text>
            <List size="small">
              {rows(policy.targets).map(target => (
                <List.Item
                  extra={<StatusTag>{value(target, "status")}</StatusTag>}
                  key={value(target, "id")}
                >
                  <List.Item.Meta
                    description={<Typography.Text code>{value(target, "domain")}</Typography.Text>}
                    title={value(target, "account")}
                  />
                </List.Item>
              ))}
            </List>
          </Space>
        </Card>
      ))}
      {editingPolicy && <EditRouting key={value(editingPolicy, "id")} policy={editingPolicy} data={data} onClose={() => setEditingPolicy(null)} />}
    </Space>
  );
}