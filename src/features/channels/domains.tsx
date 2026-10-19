"use client";
import { ActionButton,ActionForm,type Data,DnsRecords,Field,formValue,type FormValues,formValues,Notice,Panel,record,requiredRule,type Row,rows,StatusTag,Submit,useAction,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { AddDomainProvider } from "@/features/outbound/config-editors";
import { Button,Card,Checkbox,Collapse,Grid,Input,Modal,Space,Typography } from "@arco-design/web-react";
import { IconRefresh,IconSettings } from "@arco-design/web-react/icon";
import { useState } from "react";

function InboundSourcesEditor({ domain, providers, onClose }: { domain: Row; providers: Row[]; onClose: () => void }) {
  const action = useAction();
  const [selected, setSelected] = useState<string[]>(() => rows(domain.inbound_source_account_ids).map(String));
  return <Modal title={`Inbound sources · ${value(domain, "domain")}`} visible onCancel={onClose}
    confirmLoading={action.pending} onOk={async () => {
      try {
        await action.run({method:"PUT",path:`/api/admin/domains/${encodeURIComponent(value(domain, "id"))}/inbound-sources`,payload:{accountIds:selected}});
        onClose();
      } catch { /* The notice retains the failure. */ }
    }}>
    <Space direction="vertical" size="medium" className={styles.stack}>
      <Typography.Text type="secondary">Only signed inbound events from selected accounts can reach Services receiving this domain.</Typography.Text>
      <Checkbox.Group value={selected} onChange={next => setSelected(next.map(String))}
        options={providers.map(provider => ({value:value(provider,"id"),label:`${value(provider,"name")} (${provider.status === "active" && provider.webhook_status === "active" && provider.security_configured ? "ready" : "not ready"})`}))} />
      <Notice notice={action.notice} />
    </Space>
  </Modal>;
}

export function Domains({ data }: { data: Data }) {
  const [addingProvider, setAddingProvider] = useState<Row | null>(null);
  const [editingInbound, setEditingInbound] = useState<Row | null>(null);
  const action = useAction();
  const [draftDomain, setDraftDomain] = useState("");
  const domains = rows(data.domains);
  const descriptors = rows(data.descriptors);
  const managedTypes = new Set(descriptors.filter(item => record(item.capabilities).domainManagement === true).map(item => value(item, "type")));
  const allProviders = rows(data.providers);
  const providers = allProviders.filter(provider => provider.status === "active");
  const readyInbound = providers.filter(provider => provider.webhook_status === "active" && provider.security_configured === true);

  async function submit(values: FormValues) {
    const allowedAccountIds = new Set(providers.filter(provider => {
      const type = value(provider, "type");
      const mailgunDomain = type === "mailgun" ? String(record(provider.public_config).sendingDomain ?? "").toLowerCase() : "";
      return !mailgunDomain || !draftDomain.trim() || mailgunDomain === draftDomain.trim().toLowerCase();
    }).map(provider => value(provider, "id")));
    try {
      await action.run({method:"POST",path:`/api/admin/domains`,payload:{domain: formValue(values, "domain"), accountIds: formValues(values, "accountIds").filter(id => allowedAccountIds.has(id)), ...(readyInbound.length > 1 ? {inboundAccountIds:formValues(values,"inboundAccountIds")} : {})}});
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Register domain"
        description="Add a domain for inbound mail, or select provider accounts for outbound sending"
        defaultExpanded={domains.length === 0}
      >
        <ActionForm fieldErrors={action.fields}
          layout="vertical"
          onSubmit={values => void submit(values as FormValues)}
          onValuesChange={changed => {
            if ("domain" in changed) setDraftDomain(String(changed.domain ?? ""));
          }}
        >
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col xs={24}>
              <Field field="domain" label="Domain" required rules={requiredRule}>
                <Input placeholder="mail.example.com" allowClear />
              </Field>
            </Grid.Col>
            <Grid.Col xs={24}>
              <Field
                field={providers.length ? "accountIds" : undefined}
                label="Provider accounts"
                hint={providers.length ? "Optional for inbound-only domains. Resend and Amazon SES set up the identity and show the DNS records to verify. For SendGrid, Mailgun, and Postmark, verify the domain in the provider dashboard first. Mailgun must use its configured sending domain." : "You can register an inbound-only domain now and add a provider later."}
              >
                {providers.length ? <Checkbox.Group
                  options={providers.map(provider => {
                    const type = value(provider, "type");
                    const mailgunDomain = type === "mailgun" ? String(record(provider.public_config).sendingDomain ?? "").toLowerCase() : "";
                    const incompatible = Boolean(mailgunDomain && draftDomain.trim() && mailgunDomain !== draftDomain.trim().toLowerCase());
                    return {
                      value: value(provider, "id"),
                      disabled: incompatible,
                      label: <Space size="mini" wrap><Typography.Text>{value(provider, "name")}</Typography.Text><Typography.Text type="secondary">{incompatible ? `(uses ${mailgunDomain})` : managedTypes.has(type) ? "(DNS records here)" : "(verify at provider)"}</Typography.Text></Space>,
                    };
                  })}
                /> : <Space direction="vertical" size="small" align="start">
                  <Typography.Text type="secondary">{allProviders.length ? "No provider accounts are ready. Enable an account if needed, then run Test connection on the Provider Accounts page." : "No provider accounts connected yet. Connect one and run Test connection to use it for outbound mail."}</Typography.Text>
                  <Button href="/providers" type="text" icon={<IconSettings />}>Manage provider accounts</Button>
                </Space>}
              </Field>
            </Grid.Col>
            <Grid.Col xs={24}>
              {readyInbound.length > 1 && <Field field="inboundAccountIds" label="Inbound source accounts" hint="Select the accounts configured to receive this domain. Leave empty for an outbound-only domain.">
                <Checkbox.Group options={readyInbound.map(provider => ({value:value(provider,"id"),label:value(provider,"name")}))} />
              </Field>}
              {readyInbound.length === 1 && <Typography.Text type="secondary">Inbound source: {value(readyInbound[0],"name")} (automatic)</Typography.Text>}
              {!readyInbound.length && <Typography.Text type="secondary">No inbound source is ready. Configure a Provider webhook before receiving mail.</Typography.Text>}
            </Grid.Col>
            <Grid.Col xs={24}>
              <Space><Submit pending={action.pending} labelText="Register domain" /></Space>
            </Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={action.notice} />
      </Panel>
      {domains.map(domain => (
        <Card
          className={styles.card}
          key={value(domain, "id")}
          title={<Typography.Text code>{value(domain, "domain")}</Typography.Text>}
          extra={<Space wrap><Button size="small" onClick={() => setEditingInbound(domain)}>Inbound sources</Button><Button size="small" onClick={() => setAddingProvider(domain)}>Add provider</Button><ActionButton body={{method:"PATCH",path:`/api/admin/domains/${encodeURIComponent(String(domain.id))}`,payload:{id: domain.id, enabled: domain.status !== "active"}}}>{domain.status === "active" ? "Disable" : "Enable"}</ActionButton></Space>}
        >
          <Space wrap style={{ marginBottom: 16 }}>
            <Typography.Text>Inbound:</Typography.Text>
            {domain.status !== "active" ? <StatusTag>Disabled</StatusTag> : Number(domain.receiving_service_count)
              ? <Typography.Text>{Number(domain.receiving_service_count)} receiving Service{Number(domain.receiving_service_count) === 1 ? "" : "s"}</Typography.Text>
              : <Typography.Text type="secondary">No receiving Service</Typography.Text>}
            {!Number(domain.receiving_service_count) && <Button href="/api-keys" type="text" size="small">Configure Service</Button>}
            <Typography.Text type="secondary">Sources: {rows(domain.inbound_source_account_ids).map(id => value(allProviders.find(provider => provider.id === id) ?? {},"name") || String(id)).join(", ") || "None"}</Typography.Text>
          </Space>
          <Collapse bordered>
            {rows(domain.identities).map(identity => (
              <Collapse.Item
                key={value(identity, "id")}
                name={value(identity, "id")}
                header={<Space size="small" wrap><Typography.Text>{value(identity, "account")}</Typography.Text><StatusTag>{value(identity, "status")}</StatusTag></Space>}
                extra={<Space size="small" wrap>{managedTypes.has(value(identity, "type")) ? <ActionButton body={{method:"POST",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}/refresh`,payload:{id: identity.id}}}><IconRefresh />Refresh DNS</ActionButton> : <Typography.Text type="secondary">Verified in provider dashboard</Typography.Text>}<ActionButton body={{method:"PATCH",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}`,payload:{id: identity.id, enabled: identity.status === "disabled"}}}>{identity.status === "disabled" ? "Enable" : "Disable"}</ActionButton></Space>}
              >
                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">Provider identity</Typography.Text>
                  <Typography.Text code>{value(identity, "externalId") || "Not reported"}</Typography.Text>
                  <DnsRecords records={identity.dnsRecords} />
                </Space>
              </Collapse.Item>
            ))}
          </Collapse>
        </Card>
      ))}
      {addingProvider && <AddDomainProvider key={value(addingProvider, "id")} domain={addingProvider} providers={providers} onClose={() => setAddingProvider(null)} />}
      {editingInbound && <InboundSourcesEditor key={value(editingInbound,"id")} domain={editingInbound} providers={allProviders} onClose={() => setEditingInbound(null)} />}
    </Space>
  );
}
