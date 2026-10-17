"use client";

import styles from "@/components/admin-views.module.css";

import { Button, Card, Checkbox, Collapse, Form, Grid, Input, List, Select, Space, Typography } from "@arco-design/web-react";
import { IconDelete, IconExclamationCircle, IconRefresh, IconRotateLeft } from "@arco-design/web-react/icon";

import { useState } from "react";
import { ProviderAccounts } from "@/components/provider-accounts";

import { ActionForm, type Row, type Data, type FormValues, requiredRule, rows, record, value, formValue, formValues, optionalValue, date, StatusTag, useAction, Field, Panel, Submit, Notice, ActionButton, EmptyState, Prerequisite, DataTable, TableCard, DnsRecords, RoutingSimulation, Secret, CopyableValue, JsonPreview } from "@/components/admin-console-shared";
import { EditSender, EditRouting, AddDomainProvider } from "@/components/admin-config-editors";
import { Callbacks } from "@/components/admin-callbacks";
import { Inbound } from "@/components/admin-inbound";
function Providers({ data }: { data: Data }) {
  return <ProviderAccounts data={data} />;
}

function Domains({ data }: { data: Data }) {
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
      await action.run({
        action: "domain.create",
        domain: formValue(values, "domain"),
        accountIds: formValues(values, "accountIds").filter(id => allowedAccountIds.has(id)),
      });
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
          extra={<Space><Button size="small" onClick={() => setAddingProvider(domain)}>Add provider</Button><ActionButton body={{ action: "domain.toggle", id: domain.id, enabled: domain.status !== "active" }}>{domain.status === "active" ? "Disable" : "Enable"}</ActionButton></Space>}
        >
          <Collapse bordered>
            {rows(domain.identities).map(identity => (
              <Collapse.Item
                key={value(identity, "id")}
                name={value(identity, "id")}
                header={<Space size="small"><Typography.Text>{value(identity, "account")}</Typography.Text><StatusTag>{value(identity, "status")}</StatusTag></Space>}
                extra={<Space size="small">{managedTypes.has(value(identity, "type")) ? <ActionButton body={{ action: "identity.refresh", id: identity.id }}><IconRefresh />Refresh DNS</ActionButton> : <Typography.Text type="secondary">Verified in provider dashboard</Typography.Text>}<ActionButton body={{ action: "identity.toggle", id: identity.id, enabled: identity.status === "disabled" }}>{identity.status === "disabled" ? "Enable" : "Disable"}</ActionButton></Space>}
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

function SenderGrants({ data }: { data: Data }) {
  const action = useAction();
  const products = rows(data.products).filter(item => item.status === "active");
  const domains = rows(data.domains).filter(item => item.status === "active");
  const [productId, setProductId] = useState(value(products[0] ?? {}, "id"));
  const services = rows(data.services).filter(item => item.product_id === productId);
  async function submit(values: FormValues) {
    try {
      await action.run({ action: "grant.create", productId, serviceId: formValue(values, "serviceId"), domainId: formValue(values, "domainId"), fromLocalPart: formValue(values, "fromLocalPart") });
    } catch { /* Inline notice owns this request. */ }
  }
  return <Space direction="vertical" size="large" className={styles.stack}>
    <Panel title="Authorize sender addresses" description="Grant a product or service permission to use a domain or exact address. Domain verification alone does not grant permission." defaultExpanded={!rows(data.grants).length}>
      {products.length && domains.length ? <ActionForm key={productId} fieldErrors={action.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)} initialValues={{ serviceId: "", domainId: value(domains[0], "id"), fromLocalPart: "" }}>
        <Grid.Row gutter={[16, 0]}>
          <Grid.Col md={12} xs={24}><Field label="Product" required><Select value={productId} onChange={next => setProductId(String(next))} options={products.map(item => ({ value: value(item, "id"), label: value(item, "name") }))} /></Field></Grid.Col>
          <Grid.Col md={12} xs={24}><Field field="serviceId" label="Service"><Select options={[{ value: "", label: "All services in product" }, ...services.map(item => ({ value: value(item, "id"), label: value(item, "name") }))]} /></Field></Grid.Col>
          <Grid.Col md={12} xs={24}><Field field="domainId" label="Domain" required rules={requiredRule}><Select options={domains.map(item => ({ value: value(item, "id"), label: value(item, "domain") }))} /></Field></Grid.Col>
          <Grid.Col md={12} xs={24}><Field field="fromLocalPart" label="Exact local part" hint="Leave empty to authorize any address in the domain"><Input placeholder="orders" /></Field></Grid.Col>
          <Grid.Col xs={24}><Submit pending={action.pending} labelText="Grant permission" /></Grid.Col>
        </Grid.Row>
      </ActionForm> : <Typography.Text>Create a product and sending domain first.</Typography.Text>}
      <Notice notice={action.notice} />
    </Panel>
    <TableCard title="Sender permissions"><DataTable data={rows(data.grants)} emptyText="No sender permissions. Authorize a domain or address before sending." columns={[
      { title: "Product / service", render: (_, grant) => `${value(grant, "product")} / ${value(grant, "service") || "All services"}` },
      { title: "Authorized From", render: (_, grant) => `${value(grant, "from_local_part") || "*"}@${value(grant, "domain")}` },
      { title: "Status", render: (_, grant) => <StatusTag>{value(grant, "status")}</StatusTag> },
      { title: "Action", render: (_, grant) => <ActionButton body={{ action: "grant.toggle", id: grant.id, enabled: grant.status !== "active" }} confirmText={grant.status === "active" ? "Revoke this permission? Queued messages using it will be checked again before sending." : undefined}>{grant.status === "active" ? "Revoke" : "Activate"}</ActionButton> },
    ]} /></TableCard>
  </Space>;
}

function Senders({ data }: { data: Data }) {
  const [editingSender, setEditingSender] = useState<Row | null>(null);
  const action = useAction();
  const products = rows(data.products).filter(product => product.status === "active");
  const domains = rows(data.domains).filter(domain => domain.status === "active" && rows(domain.identities).some(identity => identity.status === "verified" && identity.accountStatus === "active"));
  const senders = rows(data.senders);

  async function submit(values: FormValues) {
    try {
      await action.run({
        action: "sender.create",
        productId: formValue(values, "productId"),
        domainId: formValue(values, "domainId"),
        name: formValue(values, "name"),
        fromName: formValue(values, "fromName"),
        fromLocalPart: formValue(values, "fromLocalPart"),
        replyTo: formValue(values, "replyTo"),
        category: formValue(values, "category"),
      });
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  if (!products.length || !domains.length) {
    return <Space direction="vertical" size="large" className={styles.stack}><SenderGrants data={data} /><Typography.Text type="secondary">Optional sender presets become available after a provider identity is verified.</Typography.Text></Space>;
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <SenderGrants data={data} />
      <Panel
        title="Create optional sender preset"
        description="A console shortcut that fills standard From, Reply-To, and category fields. Sending authorization is configured separately."
        defaultExpanded={senders.length === 0}
      >
        <ActionForm fieldErrors={action.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}>
              <Field field="productId" label="Product" initialValue={value(products[0], "id")} required rules={requiredRule}>
                <Select options={products.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} />
              </Field>
            </Grid.Col>
            <Grid.Col md={8} xs={24}>
              <Field field="domainId" label="Domain" initialValue={value(domains[0], "id")} required rules={requiredRule}>
                <Select options={domains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} />
              </Field>
            </Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="name" label="Preset name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="fromName" label="From name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="fromLocalPart" label="From local part" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="category" label="Category" initialValue="transactional" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={16} xs={24}><Field field="replyTo" label="Reply-To" rules={[{ type: "email" }]}><Input type="email" /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Space><Submit pending={action.pending} labelText="Create preset" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={action.notice} />
      </Panel>
      <TableCard title="Optional sender presets">
        <DataTable
          data={senders}
          emptyText="No optional sender presets configured."
          columns={[
            { title: "Preset", render: (_, sender) => value(sender, "name") },
            { title: "Product", render: (_, sender) => value(sender, "product") },
            { title: "From", render: (_, sender) => <Typography.Text code>{value(sender, "from_name")} &lt;{value(sender, "from_local_part")}@{value(sender, "domain")}&gt;</Typography.Text> },
            { title: "Category", render: (_, sender) => value(sender, "message_category") },
            { title: "Status", render: (_, sender) => <StatusTag>{value(sender, "status")}</StatusTag> },
            { title: "Action", render: (_, sender) => <Space><Button size="small" onClick={() => setEditingSender(sender)}>Edit</Button><ActionButton body={{ action: "sender.toggle", id: sender.id, enabled: sender.status !== "active" }}>{sender.status === "active" ? "Disable" : "Enable"}</ActionButton></Space> },
          ]}
        />
      </TableCard>
      {editingSender && <EditSender key={value(editingSender, "id")} sender={editingSender} data={data} onClose={() => setEditingSender(null)} />}
    </Space>
  );
}

function Routing({ data }: { data: Data }) {
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
      await create.run({
        action: "routing.create",
        name: formValue(values, "name"),
        productId: formValue(values, "productId"),
        serviceId: formValue(values, "serviceId"),
        domainId: selectedDomainId,
        category: formValue(values, "category"),
        targets: [{ accountId: identity?.accountId, identityId: selectedIdentityId }],
      });
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  async function simulateSubmit(values: FormValues) {
    try {
      const result = await simulate.run({
        action: "routing.simulate",
        domainId: selectedDomainId,
        productId: formValue(values, "productId"),
        serviceId: formValue(values, "serviceId"),
        category: formValue(values, "category"),
      });
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
          extra={<Space><Button size="small" onClick={() => setEditingPolicy(policy)}>Edit targets</Button><ActionButton body={{ action: "routing.toggle", id: policy.id, enabled: policy.status !== "active" }}>{policy.status === "active" ? "Disable" : "Enable"}</ActionButton></Space>}
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

function Credentials({ data }: { data: Data }) {
  const action = useAction();
  const productAction = useAction();
  const [productForm] = Form.useForm();
  const [key, setKey] = useState("");
  const products = rows(data.products);
  const activeProducts = products.filter(product => product.status === "active");
  const credentials = rows(data.credentials);

  async function createProduct(values: FormValues) {
    try {
      await productAction.run({ action: "product.create", name: formValue(values, "name") });
      productForm.resetFields();
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  async function submit(values: FormValues) {
    try {
      setKey("");
      const result = await action.run({ action: "credential.create", productId: formValue(values, "productId"), serviceName: formValue(values, "serviceName") }) as { key?: string };
      setKey(result?.key ?? "");
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  async function rotate(id: string) {
    try {
      setKey("");
      const result = await action.run({ action: "credential.rotate", id }) as { key?: string };
      setKey(result.key ?? "");
      action.setNotice("Credential rotated. Copy the replacement key below.");
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Create product"
        description="A product owns its services, senders, and delivery rules."
        defaultExpanded={products.length === 0}
      >
        <ActionForm fieldErrors={productAction.fields} form={productForm} layout="vertical" onSubmit={values => void createProduct(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col xs={24}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={productAction.pending} labelText="Create product" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={productAction.notice} />
      </Panel>
      {products.length ? (
        <TableCard title="Products">
          <DataTable
            data={products}
            minWidth="440px"
            columns={[
              { title: "Product", render: (_, product) => value(product, "name") },
              { title: "Status", render: (_, product) => <StatusTag>{value(product, "status")}</StatusTag> },
              { title: "Action", render: (_, product) => <ActionButton body={{ action: "product.toggle", id: product.id, enabled: product.status !== "active" }}>{product.status === "active" ? "Suspend" : "Activate"}</ActionButton> },
            ]}
          />
        </TableCard>
      ) : <EmptyState text="No products configured. Create the first product to issue a service credential." />}
      {activeProducts.length ? (
        <>
          <Panel
            title="Issue service credential"
            description="The plaintext key is shown once"
            defaultExpanded={credentials.length === 0}
          >
            <ActionForm fieldErrors={action.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)}>
              <Grid.Row gutter={[16, 0]}>
                <Grid.Col md={12} xs={24}><Field field="productId" label="Product" initialValue={value(activeProducts[0], "id")} required rules={requiredRule}><Select options={activeProducts.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} /></Field></Grid.Col>
                <Grid.Col md={12} xs={24}><Field field="serviceName" label="Service name" required rules={requiredRule}><Input /></Field></Grid.Col>
                <Grid.Col xs={24}><Space><Submit pending={action.pending} labelText="Issue credential" /></Space></Grid.Col>
              </Grid.Row>
            </ActionForm>
            {key && <Secret value={key} />}
            <Notice notice={action.notice} />
          </Panel>
          <TableCard title="Service credentials">
            <DataTable
              data={credentials}
              columns={[
                { title: "Service", render: (_, credential) => value(credential, "service") },
                { title: "Product", render: (_, credential) => value(credential, "product") },
                { title: "Prefix", render: (_, credential) => <Typography.Text code>{value(credential, "key_prefix")}...</Typography.Text> },
                { title: "Last used", render: (_, credential) => date(credential.last_used_at) },
                { title: "Status", render: (_, credential) => <StatusTag>{value(credential, "status")}</StatusTag> },
                {
                  title: "Actions",
                  render: (_, credential) => (
                    <Space size="small">
                      <Button size="small" icon={<IconRotateLeft />} loading={action.pending} onClick={() => void rotate(value(credential, "id"))}>Rotate</Button>
                      <ActionButton
                        danger
                        body={{ action: "credential.revoke", id: credential.id }}
                        confirmOkText="Revoke"
                        confirmText="This immediately invalidates the credential and cannot be undone."
                        confirmTitle="Revoke credential?"
                      >
                        <IconDelete />Revoke
                      </ActionButton>
                    </Space>
                  ),
                },
              ]}
            />
          </TableCard>
        </>
      ) : <Prerequisite title="Create an active product first" description="A service credential must be scoped to an active product." href="/api-keys" action="Create product" />}
    </Space>
  );
}

function Events({ data }: { data: Data }) {
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
            { title: "Processing", render: (_, event) => event.processing_error ? <Typography.Text type="error">{value(event, "processing_error")}</Typography.Text> : <StatusTag>{event.processed_at ? "Processed" : "Pending"}</StatusTag> },
            { title: "Action", render: (_, event) => <ActionButton body={{ action: "event.replay", id: event.id }}><IconRotateLeft />Replay</ActionButton> },
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

function Suppressions({ data }: { data: Data }) {
  const action = useAction();
  const [scope, setScope] = useState<"global" | "product" | "list">("global");
  const products = rows(data.products).filter(product => product.status === "active");
  const suppressions = rows(data.suppressions);

  async function submit(values: FormValues) {
    try {
      const expiresAt = optionalValue(values, "expiresAt");
      await action.run({
        action: "suppression.create",
        email: formValue(values, "email"),
        scope,
        productId: scope === "global" ? undefined : formValue(values, "productId"),
        listId: scope === "list" ? formValue(values, "listId") : undefined,
        reason: formValue(values, "reason"),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Add suppression"
        description="Global, product, or list scope"
        defaultExpanded={suppressions.length === 0}
      >
        <ActionForm fieldErrors={action.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field field="email" label="Email" required rules={[{ required: true, type: "email" }]}><Input type="email" /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Scope" required><Select value={scope} options={[{ value: "global", label: "Global" }, { value: "product", label: "Product" }, { value: "list", label: "List" }]} onChange={next => setScope(next as typeof scope)} /></Field></Grid.Col>
            {scope !== "global" && <Grid.Col md={8} xs={24}><Field field="productId" label="Product" required rules={requiredRule}><Select placeholder="Choose a product" options={products.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} /></Field></Grid.Col>}
            {scope === "list" && <Grid.Col md={8} xs={24}><Field field="listId" label="List ID" required rules={requiredRule}><Input placeholder="marketing-newsletter" /></Field></Grid.Col>}
            <Grid.Col md={8} xs={24}><Field field="reason" label="Reason" initialValue="manual" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="expiresAt" label="Expires at" hint="Optional"><Input type="datetime-local" /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} disabled={scope !== "global" && !products.length} labelText="Add suppression" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={action.notice} />
      </Panel>
      <TableCard title="Suppressions">
        <DataTable
          data={suppressions}
          columns={[
            { title: "Email", render: (_, suppression) => value(suppression, "email_normalized") },
            { title: "Scope", render: (_, suppression) => `${value(suppression, "scope_type")} ${value(suppression, "product")}${value(suppression, "list_id") ? ` / ${value(suppression, "list_id")}` : ""}` },
            { title: "Reason", render: (_, suppression) => value(suppression, "reason") },
            { title: "Source", render: (_, suppression) => value(suppression, "source") },
            { title: "Expires", render: (_, suppression) => suppression.expires_at ? date(suppression.expires_at) : "Permanent" },
            {
              title: "Action",
              render: (_, suppression) => (
                <ActionButton
                  danger
                  body={{ action: "suppression.remove", id: suppression.id }}
                  confirmOkText="Remove"
                  confirmText="This recipient will become eligible for delivery again immediately."
                  confirmTitle="Remove suppression?"
                >
                  <IconDelete />Remove
                </ActionButton>
              ),
            },
          ]}
        />
      </TableCard>
    </Space>
  );
}

function Logs({ data }: { data: Data }) {
  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <TableCard title="Failed and overdue work (latest 200)">
        <DataTable data={rows(data.failedWork)} minWidth="900px" columns={[
          { title: "Work", render: (_, item) => <Space direction="vertical" size="mini"><Typography.Text code>{value(item, "event_type")}</Typography.Text><CopyableValue text={value(item, "id")} label="work ID" /></Space> },
          { title: "Resource", render: (_, item) => `${value(item, "aggregate_type")} / ${value(item, "aggregate_id")}` },
          { title: "Status", render: (_, item) => <StatusTag>{value(item, "status")}</StatusTag> },
          { title: "Attempts", render: (_, item) => value(item, "attempt_count") },
          { title: "Due", render: (_, item) => date(item.available_at) },
          { title: "Action", render: (_, item) => item.status === "failed" ? <ActionButton body={{ action: "outbox.retry", id: item.id }} confirmText="Retry publishing this failed work item?">Retry work</ActionButton> : <Typography.Text type="secondary">Recovery scan will inspect overdue work</Typography.Text> },
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

export function AdminConsole({ section, data }: { section: string; data: Data }) {
  if (section === "providers") return <Providers data={data} />;
  if (section === "domains") return <Domains data={data} />;
  if (section === "senders") return <Senders data={data} />;
  if (section === "routing") return <Routing data={data} />;
  if (section === "api-keys") return <Credentials data={data} />;
  if (section === "webhooks") return <Callbacks data={data} />;
  if (section === "events") return <Events data={data} />;
  if (section === "suppressions") return <Suppressions data={data} />;
  if (section === "inbound") return <Inbound data={data} />;
  if (section === "logs") return <Logs data={data} />;
  return <EmptyState text="Unknown section." />;
}

export function RetryDeliveryButton({ id, unknown }: { id: string; unknown: boolean }) {
  return (
    <ActionButton
      body={{ action: "delivery.retry", id, acknowledgeDuplicateRisk: unknown }}
      confirmOkText={unknown ? "Accept risk and retry" : "Retry"}
      confirmText={unknown ? "The provider outcome is unknown. Retrying may send a duplicate. Accept the risk and continue?" : "Retry this delivery?"}
      confirmTitle={unknown ? "Retry with duplicate risk?" : "Retry delivery?"}
    >
      {unknown ? <IconExclamationCircle /> : <IconRotateLeft />}Manual retry
    </ActionButton>
  );
}
