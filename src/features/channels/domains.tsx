"use client";
import { ActionButton,ActionForm,type Data,DnsRecords,Field,formValue,type FormValues,formValues,Notice,Panel,record,requiredRule,type Row,rows,StatusTag,Submit,useAction,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { AddDomainProvider } from "@/features/outbound/config-editors";
import { Button,Card,Checkbox,Collapse,Grid,Input,Space,Typography } from "@arco-design/web-react";
import { IconRefresh } from "@arco-design/web-react/icon";
import { useState } from "react";
export function Domains({ data }: { data: Data }) {
  const [addingProvider, setAddingProvider] = useState<Row | null>(null);
  const action = useAction();
  const [draftDomain, setDraftDomain] = useState("");
  const domains = rows(data.domains);
  const descriptors = rows(data.descriptors);
  const managedTypes = new Set(descriptors.filter(item => record(item.capabilities).domainManagement === true).map(item => value(item, "type")));
  const providers = rows(data.providers).filter(provider => provider.status === "active");

  async function submit(values: FormValues) {
    const allowedAccountIds = new Set(providers.filter(provider => {
      const type = value(provider, "type");
      const mailgunDomain = type === "mailgun" ? String(record(provider.public_config).sendingDomain ?? "").toLowerCase() : "";
      return !mailgunDomain || !draftDomain.trim() || mailgunDomain === draftDomain.trim().toLowerCase();
    }).map(provider => value(provider, "id")));
    try {
      await action.run({method:"POST",path:`/api/admin/domains`,payload:{domain: formValue(values, "domain"), accountIds: formValues(values, "accountIds").filter(id => allowedAccountIds.has(id))}});
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Register domain"
        description="Register an inbound domain, or select providers to provision outbound identities"
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
                field="accountIds"
                label="Provider accounts"
                hint="Leave providers unselected for an inbound-only domain. Resend reuses an existing domain or creates one if needed. Amazon SES creates the provider identity. Both show DNS records. For SendGrid, Mailgun, and Postmark, select only an account where this domain is already verified in its official dashboard. A Mailgun account can use only its configured sending domain."
              >
                <Checkbox.Group
                  options={providers.map(provider => {
                    const type = value(provider, "type");
                    const mailgunDomain = type === "mailgun" ? String(record(provider.public_config).sendingDomain ?? "").toLowerCase() : "";
                    const incompatible = Boolean(mailgunDomain && draftDomain.trim() && mailgunDomain !== draftDomain.trim().toLowerCase());
                    return {
                      value: value(provider, "id"),
                      disabled: incompatible,
                      label: <Space size="mini"><Typography.Text>{value(provider, "name")}</Typography.Text><Typography.Text type="secondary">{incompatible ? `(uses ${mailgunDomain})` : managedTypes.has(type) ? "(Envoy-managed)" : "(Already verified)"}</Typography.Text></Space>,
                    };
                  })}
                />
              </Field>
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
          extra={<Space><Button size="small" onClick={() => setAddingProvider(domain)}>Add provider</Button><ActionButton body={{method:"PATCH",path:`/api/admin/domains/${encodeURIComponent(String(domain.id))}`,payload:{id: domain.id, enabled: domain.status !== "active"}}}>{domain.status === "active" ? "Disable" : "Enable"}</ActionButton></Space>}
        >
          <Collapse bordered>
            {rows(domain.identities).map(identity => (
              <Collapse.Item
                key={value(identity, "id")}
                name={value(identity, "id")}
                header={<Space size="small"><Typography.Text>{value(identity, "account")}</Typography.Text><StatusTag>{value(identity, "status")}</StatusTag></Space>}
                extra={<Space size="small">{managedTypes.has(value(identity, "type")) ? <ActionButton body={{method:"POST",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}/refresh`,payload:{id: identity.id}}}><IconRefresh />Refresh DNS</ActionButton> : <Typography.Text type="secondary">Verified in provider dashboard</Typography.Text>}<ActionButton body={{method:"PATCH",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}`,payload:{id: identity.id, enabled: identity.status === "disabled"}}}>{identity.status === "disabled" ? "Enable" : "Disable"}</ActionButton></Space>}
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
    </Space>
  );
}