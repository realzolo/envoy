"use client";

import { ActionButton,ActionForm,DataTable,Field,Notice,Secret,StatusTag,TableCard,date,record,requiredRule,rows,useAction,value,type Data,type Row } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { serviceConfigurationSchema,type ServiceConfiguration,type ServiceDomainBinding } from "@/lib/service-configuration";
import { Alert,Button,Checkbox,Collapse,Drawer,Form,Empty,Input,Modal,Select,Space,Typography } from "@arco-design/web-react";
import { useState } from "react";

type EditorBinding = ServiceDomainBinding & { send: boolean };
type EditorConfiguration = Omit<ServiceConfiguration, "domains"> & { domains: EditorBinding[] };

function DomainBindingsEditor({ domains, value: bindings = [], onChange }: {
  domains: Row[]; value?: EditorBinding[]; onChange?: (bindings: EditorBinding[]) => void;
}) {
  const selected = bindings.map(binding => binding.domainId);
  const update = (domainId: string, change: Partial<EditorBinding>) => onChange?.(bindings.map(binding => binding.domainId === domainId ? { ...binding, ...change } : binding));
  return <Space direction="vertical" size="medium" className={styles.stack}>
    <Select mode="multiple" showSearch allowClear maxTagCount={2} placeholder="Select domains" value={selected}
      options={domains.filter(domain => domain.status === "active" || selected.includes(value(domain, "id"))).map(domain => ({ value: value(domain, "id"), label: `${value(domain, "domain")}${domain.status === "active" ? "" : " (disabled)"}` }))}
      onChange={(domainIds: string[]) => onChange?.(domainIds.map(domainId => bindings.find(binding => binding.domainId === domainId) ?? { domainId, receive: true, send: false, outboundIdentityId: null }))} />
    {bindings.map(binding => {
      const domain = domains.find(item => item.id === binding.domainId);
      const identities = rows(domain?.identities);
      const ready = identities.filter(identity => identity.sendReady === true);
      const choices = identities.filter(identity => identity.sendReady === true || identity.id === binding.outboundIdentityId);
      const selectedIdentity = identities.find(identity => identity.id === binding.outboundIdentityId);
      return <Space key={binding.domainId} direction="vertical" size="mini" align="start">
        <Space wrap align="center">
          <Typography.Text code>{value(domain ?? {}, "domain")}</Typography.Text>
          <Checkbox checked={binding.receive} onChange={receive => update(binding.domainId, { receive })}>Receive for this Service</Checkbox>
          <Checkbox checked={binding.send} disabled={!binding.send && !ready.length} onChange={send => update(binding.domainId, {
            send, outboundIdentityId: send ? ready.length === 1 ? value(ready[0], "id") : null : null,
          })}>Send</Checkbox>
          {binding.send && (choices.length > 1 || !binding.outboundIdentityId) && <Select style={{ minWidth: 190 }} placeholder="Choose sending provider" value={binding.outboundIdentityId ?? undefined}
            options={choices.map(identity => ({ value: value(identity, "id"), label: `${value(identity, "account")} (${value(identity, "status")})` }))}
            onChange={identityId => update(binding.domainId, { outboundIdentityId: identityId ? String(identityId) : null })} />}
          {binding.send && binding.outboundIdentityId && choices.length === 1 && <Typography.Text type="secondary">Send via {value(selectedIdentity ?? {}, "account")}</Typography.Text>}
        </Space>
        {binding.send && selectedIdentity && selectedIdentity.sendReady !== true && <Typography.Text type="warning">This provider is unavailable. Select another provider or turn off Send.</Typography.Text>}
        {binding.send && !binding.outboundIdentityId && <Typography.Text type="error">Choose a sending provider.</Typography.Text>}
        {!binding.receive && !binding.send && <Typography.Text type="error">Enable Receive or Send, or remove this domain.</Typography.Text>}
      </Space>;
    })}
  </Space>;
}

function initialConfiguration(service: Row | undefined): EditorConfiguration {
  return {
    serviceName: service ? value(service, "name") : "",
    domains: service ? rows(service.domain_bindings).map(binding => ({ domainId: value(binding, "sending_domain_id"), receive: binding.receive_enabled === true, send: Boolean(binding.outbound_provider_identity_id), outboundIdentityId: binding.outbound_provider_identity_id ? value(binding, "outbound_provider_identity_id") : null })) : [],
    callbackUrl: service ? value(service, "callback_url") : "",
    suppressionManagement: service?.suppression_management_allowed === true,
  };
}

function ServiceEditor({ service, data, onClose, onSaved }: { service?: Row; data: Data; onClose: () => void; onSaved: (result: Row) => void }) {
  const action = useAction();
  const [form] = Form.useForm();
  const [initial] = useState(() => initialConfiguration(service));
  const [revision] = useState(() => service?.configuration_revision);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState(initial);
  const noMail = draft.domains.length === 0;

  function review(input: EditorConfiguration) {
    if (input.domains.some(binding => binding.send && !binding.outboundIdentityId)) {
      setValidationErrors({domains: "Choose a sending provider for every domain with Send enabled."});
      return;
    }
    const parsed = serviceConfigurationSchema.safeParse({ ...input, domains: input.domains.map(binding => ({
      domainId: binding.domainId, receive: binding.receive, outboundIdentityId: binding.outboundIdentityId,
    })) });
    setValidationErrors({});
    if (!parsed.success) {
      setValidationErrors(Object.fromEntries(parsed.error.issues.map(issue => [issue.path.join("."), issue.message])));
      return;
    }
    const configuration = parsed.data;
    Modal.confirm({
      className: styles.readable,
      title: service ? "Save service configuration?" : "Create service?",
      okText: service ? "Save configuration" : "Create service and issue key",
      content: <Space direction="vertical" className={styles.stack}>
        <Typography.Text>Service: {service ? `${initial.serviceName} → ` : ""}{configuration.serviceName}</Typography.Text>
        <Typography.Text>Domains: {configuration.domains.map(binding => `${value(rows(data.domains).find(domain => domain.id === binding.domainId) ?? {}, "domain")} (${[binding.receive ? "receive" : "", binding.outboundIdentityId ? "send" : ""].filter(Boolean).join(" + ")})`).join(", ") || "None"}</Typography.Text>
        <Typography.Text>Event callback URL: {service ? `${initial.callbackUrl || "Polling only"} → ` : ""}{configuration.callbackUrl || "Polling only"}</Typography.Text>
        <Typography.Text>Suppression management: {service ? `${initial.suppressionManagement ? "Allowed" : "Disabled"} → ` : ""}{configuration.suppressionManagement ? "Allowed" : "Disabled"}</Typography.Text>
        <Typography.Text bold>{service ? `This configuration applies to every active API key for ${configuration.serviceName}. A new key is not required.` : `The first API key${configuration.callbackUrl ? " and callback signing secret" : ""} will be shown once.`}</Typography.Text>
        {!configuration.domains.length && <Alert type="info" content="This service has no domains." />}
      </Space>,
      onOk: async () => {
        const result = record(await action.run(service ? {method:"PUT",path:`/api/admin/services/${encodeURIComponent(String(service.id))}`,payload:{id: service.id, revision, configuration}} : {method:"POST",path:`/api/admin/services`,payload:{configuration}}));
        onSaved(result);
        onClose();
      },
    });
  }

  return <Drawer className={styles.readable} title={service ? `Edit configuration · ${value(service, "name")}` : "Create service"} visible width="min(760px, 100vw)" onCancel={onClose} autoFocus focusLock
    footer={<Space wrap><Button onClick={onClose}>Cancel</Button><Button type="primary" loading={action.pending} onClick={() => form.submit()}>Review configuration</Button></Space>}>
    <Space direction="vertical" size="large" className={styles.stack}>
      <ActionForm fieldErrors={{ ...action.fields, ...validationErrors }} form={form} initialValues={initial} layout="vertical" onValuesChange={(_, input) => { const values = input as Partial<EditorConfiguration>; setValidationErrors({}); setDraft({ ...initial, ...values, domains: values.domains ?? initial.domains }); }} onSubmit={values => review(values as EditorConfiguration)}>
        <Field field="serviceName" label="Service name" hint="Use a unique name to identify the application or workload." required rules={requiredRule}><Input placeholder="e.g. Order notifications" /></Field>
        <Field field="domains" label="Domains" hint="Each selected domain can receive mail for this Service and use one sending provider."><DomainBindingsEditor domains={rows(data.domains)} /></Field>
        <Field field="callbackUrl" label="Event callback URL" hint="Leave empty to poll for events. A new signing secret is shown once when the callback is first configured."><Input placeholder="https://api.example.com/mail/events" allowClear /></Field>
        {service?.callback_status === "disabled" && initial.callbackUrl && <Alert type="info" content="Callback delivery is paused. Editing the service keeps it paused; resume delivery under Callbacks." />}
        <Collapse bordered={false}><Collapse.Item name="advanced" header="Advanced permissions">
          <Field field="suppressionManagement" label="Suppression management" triggerPropName="checked" hint="Allows this service to manage its own recipient and list suppression rules."><Checkbox>Allow suppression management</Checkbox></Field>
        </Collapse.Item></Collapse>
      </ActionForm>
      {noMail && <Alert type="info" content="This service has no domains. You can bind domains later." />}
      <Notice notice={action.notice} />
    </Space>
  </Drawer>;
}

function Credentials({ service, credentials, onClose }: { service: Row; credentials: Row[]; onClose: () => void }) {
  const action = useAction();
  const [key, setKey] = useState("");
  async function issue(id?: string) {
    try {
      setKey("");
      const result = record(await action.run(id ? {method:"POST",path:`/api/admin/service-credentials/${encodeURIComponent(String(id))}/rotation`,payload:{id}} : {method:"POST",path:`/api/admin/services/${encodeURIComponent(String(service.id))}/credentials`,payload:{serviceId: service.id}}));
      setKey(value(result, "key"));
      action.setNotice(id ? "Replacement issued. Switch callers and revoke the old key within 24 hours." : "Key issued for this service's existing configuration.");
    } catch { /* The notice retains the failure. */ }
  }
  return <Drawer title={`Credentials · ${value(service, "name")}`} visible width="min(1120px, 100vw)" onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>} autoFocus focusLock>
    <Space direction="vertical" size="large" className={styles.stack}>
      <Typography.Text type="secondary">All keys use this service configuration. Plaintext keys are shown once.</Typography.Text>
      <Button type="primary" disabled={service.status !== "active"} loading={action.pending} onClick={() => void issue()}>Issue key</Button>
      {key && <Secret value={key} />}
      <Notice notice={action.notice} />
      <DataTable data={credentials} minWidth="960px" columns={[
        { title: "Key ID", render: (_, credential) => <Typography.Text code>{value(credential, "id")}</Typography.Text> },
        { title: "Prefix", render: (_, credential) => `${value(credential, "key_prefix")}…` },
        { title: "Created", render: (_, credential) => date(credential.created_at) },
        { title: "Last used", render: (_, credential) => credential.last_used_at ? date(credential.last_used_at) : "Never" },
        { title: "Valid until", render: (_, credential) => credential.valid_to ? date(credential.valid_to) : "No fixed expiry" },
        { title: "Status", render: (_, credential) => <StatusTag>{credential.status === "active" && credential.valid_to && Date.parse(String(credential.valid_to)) <= Date.now() ? "Expired" : value(credential, "status")}</StatusTag> },
        { title: "Actions", render: (_, credential) => <Space wrap>
          <Button size="small" disabled={service.status !== "active" || credential.status !== "active" || Boolean(credential.valid_to && Date.parse(String(credential.valid_to)) <= Date.now())} loading={action.pending} onClick={() => void issue(value(credential, "id"))}>Issue replacement</Button>
          {credential.status === "active" && <ActionButton danger body={{method:"DELETE",path:`/api/admin/service-credentials/${encodeURIComponent(String(credential.id))}`,payload:{id: credential.id}}} confirmTitle="Revoke key?" confirmOkText="Revoke" confirmText="This key will stop working immediately. Other keys and the service configuration remain available.">Revoke</ActionButton>}
        </Space> },
      ]} />
    </Space>
  </Drawer>;
}

export function Services({ data }: { data: Data }) {
  const services = rows(data.services);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [credentialServiceId, setCredentialServiceId] = useState<string | null>(null);
  const [issuedSecrets, setIssuedSecrets] = useState<{ key: string; callbackSecret: string } | null>(null);
  const selectedService = services.find(service => service.id === credentialServiceId);

  return <Space direction="vertical" size="large" className={styles.stack}>
    <Space><Button type="primary" onClick={() => setEditingId("new")}>Create service</Button></Space>
    <Modal title={issuedSecrets?.key ? "Service created" : "Callback configured"} visible={issuedSecrets !== null} onCancel={() => setIssuedSecrets(null)} footer={<Button type="primary" onClick={() => setIssuedSecrets(null)}>Done</Button>}>
      <Space direction="vertical" size="large" className={styles.stack}>
        <Typography.Text type="secondary">Copy these values now. They cannot be shown again.</Typography.Text>
        {issuedSecrets?.key && <Secret value={issuedSecrets.key} label="Service Key" />}
        {issuedSecrets?.callbackSecret && <Secret value={issuedSecrets.callbackSecret} label="Callback signing secret" />}
      </Space>
    </Modal>
    <TableCard title="Services">{services.length ? <DataTable data={services} minWidth="980px" columns={[
      { title: "Service", render: (_, service) => value(service, "name") },
      { title: "Status", render: (_, service) => <StatusTag>{value(service, "status")}</StatusTag> },
      { title: "Sending domains", render: (_, service) => rows(service.domain_bindings).filter(binding => binding.outbound_provider_identity_id).length },
      { title: "Receiving domains", render: (_, service) => rows(service.domain_bindings).filter(binding => binding.receive_enabled === true).length },
      { title: "Event callback", render: (_, service) => !service.callback_url ? "Polling only" : service.callback_status === "active" ? "Configured" : "Paused" },
      { title: "Actions", render: (_, service) => <Space wrap>
        <Button size="small" onClick={() => setEditingId(value(service, "id"))}>Edit configuration</Button>
        <Button size="small" onClick={() => setCredentialServiceId(value(service, "id"))}>Manage credentials</Button>
        <ActionButton body={{method:"PATCH",path:`/api/admin/services/${encodeURIComponent(String(service.id))}`,payload:{id:service.id,enabled:service.status!=="active"}}}
          danger={service.status === "active"} confirmTitle={service.status === "active" ? "Pause service?" : "Resume service?"}
          confirmText={service.status === "active" ? "API access and new mail sending and receiving will stop. Existing messages and credentials are retained." : "API access and mail permissions will become available again."}>
          {service.status === "active" ? "Pause" : "Resume"}
        </ActionButton>
      </Space> },
    ]} /> : <Empty description="Create a service to configure mail permissions, receive events, and issue API keys." />}</TableCard>
    {editingId && <ServiceEditor key={editingId} service={services.find(service => service.id === editingId)} data={data} onClose={() => setEditingId(null)} onSaved={result => {
      const callback = record(result.callback);
      const key = value(result, "key"), callbackSecret = value(callback, "secret");
      if (key || callbackSecret) setIssuedSecrets({ key, callbackSecret });
    }} />}
    {selectedService && <Credentials service={selectedService} credentials={rows(data.credentials).filter(credential => credential.service_id === selectedService.id)} onClose={() => setCredentialServiceId(null)} />}
  </Space>;
}
