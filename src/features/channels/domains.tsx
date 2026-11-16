"use client";
import { ActionButton,ActionForm,type Data,DnsRecords,Field,formValue,type FormValues,formValues,mutate,Notice,Panel,record,requiredRule,type Row,rows,StatusTag,Submit,useAction,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { AddDomainProvider } from "@/features/outbound/config-editors";
import { Button,Card,Checkbox,Collapse,Grid,Input,Modal,Space,Typography } from "@arco-design/web-react";
import { IconRefresh,IconSettings } from "@arco-design/web-react/icon";
import { useEffect,useRef,useState } from "react";
import { useRouter } from "next/navigation";

function IdentityRecoveryActions({ identity }: { identity: Row }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "request" | "polling">("idle");
  const [notice, setNotice] = useState<{kind:"success" | "error";text:string} | null>(null);
  const request = useRef<AbortController | null>(null);
  const identityId = value(identity,"id");
  const providerType = value(identity,"type");
  const basePath = `/api/admin/provider-identities/${encodeURIComponent(identityId)}`;
  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (phase !== "polling") return;
    const controller = new AbortController();
    const deadline = Date.now() + 180_000;
    const deadlineTimer = setTimeout(() => {
      controller.abort();
      setPhase("idle");
      setNotice({kind:"success",text:"Automatic page checks have stopped after 3 minutes. Use Sync provider to check the verification result again."});
    }, 180_000);
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = record(await mutate({method:"POST",path:`${basePath}/refresh`,payload:{}},controller.signal));
        if (controller.signal.aborted) return;
        router.refresh();
        if (result.status === "verified" || result.status === "failed") {
          setPhase("idle");
          setNotice(result.status === "verified"
            ? {kind:"success",text:"Domain verified. The latest provider records are displayed below."}
            : {kind:"error",text:"DNS verification failed. Review the provider records and correct your DNS before verifying again."});
        } else if (Date.now() >= deadline) {
          setPhase("idle");
          setNotice({kind:"success",text:"Verification is still pending. Automatic page checks have stopped; use Sync provider to check again."});
        } else {
          timer = setTimeout(() => void poll(), 10_000);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase("idle");
        setNotice({kind:"error",text:`Automatic sync stopped: ${error instanceof Error ? error.message : "Provider unavailable"}. The last successfully synced records are retained.`});
      }
    }
    timer = setTimeout(() => void poll(), 5_000);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadlineTimer); };
  }, [phase,basePath,router]);

  async function run(operation:"refresh" | "verify" | "reconcile") {
    // The ref also guards rapid clicks before React renders the loading state.
    if (request.current || phase !== "idle") return;
    const controller = new AbortController();
    request.current = controller;
    setPhase("request");
    setNotice(null);
    try {
      const result = record(await mutate({method:"POST",path:`${basePath}/${operation}`,payload:{}},controller.signal));
      if (controller.signal.aborted) return;
      router.refresh();
      const verifying = operation === "verify" && result.verificationRequested === true;
      setPhase(verifying ? "polling" : "idle");
      setNotice({kind:"success",text:verifying
        ? "DNS verification submitted. Checking the provider every 10 seconds for up to 3 minutes."
        : typeof result.message === "string" ? result.message : "Provider records synced."});
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase("idle");
      setNotice({kind:"error",text:error instanceof Error ? error.message : "Provider action failed"});
    } finally { if (request.current === controller) request.current = null; }
  }

  const busy = phase !== "idle";
  return <Space direction="vertical" size="small" className={styles.stack}>
    <Space wrap>
      <Button disabled={busy} loading={phase === "request"} onClick={() => void run("refresh")}><IconRefresh />Sync provider</Button>
      {providerType === "resend" && <>
        <Button disabled={busy} onClick={() => void run("verify")}>Verify DNS</Button>
        <Button disabled={busy} onClick={() => Modal.confirm({
          title:"Repair provider binding",
          content:"Find this exact domain in the selected provider account and replace its saved domain ID and DNS records? Service bindings and mail history are retained.",
          onOk:() => run("reconcile"),
        })}>Repair binding</Button>
      </>}
      {phase === "polling" && <Button onClick={() => { setPhase("idle"); setNotice({kind:"success",text:"Automatic page checks stopped. Use Sync provider to check the verification result."}); }}>Stop page checks</Button>}
    </Space>
    <Notice notice={notice} />
  </Space>;
}

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
          title={<Space><Typography.Text code>{value(domain, "domain")}</Typography.Text>{Boolean(domain.archived_at) && <StatusTag>Archived</StatusTag>}</Space>}
          extra={<Space wrap><Button size="small" onClick={() => setEditingInbound(domain)}>Inbound sources</Button><Button size="small" onClick={() => setAddingProvider(domain)}>Add provider</Button>{!domain.archived_at && <ActionButton danger confirmText="Archive this domain? This disables the domain and removes its Service sending and receiving grants. Mail history and the provider domain are retained. Restoring requires configuring Service grants again." body={{method:"POST",path:`/api/admin/domains/${encodeURIComponent(String(domain.id))}/archive`,payload:{}}}>Archive</ActionButton>}<ActionButton danger confirmText="Remove this domain from Envoy? Referenced domains must be disabled instead. The provider domain is retained." body={{method:"DELETE",path:`/api/admin/domains/${encodeURIComponent(String(domain.id))}`,payload:{}}}>Delete</ActionButton><ActionButton body={{method:"PATCH",path:`/api/admin/domains/${encodeURIComponent(String(domain.id))}`,payload:{id: domain.id, enabled: domain.status !== "active"}}}>{domain.archived_at ? "Restore" : domain.status === "active" ? "Disable" : "Enable"}</ActionButton></Space>}
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
                header={<Space size="small" wrap><Typography.Text>{value(identity, "account")}</Typography.Text><StatusTag>{identity.archivedAt ? "Archived" : value(identity, "status")}</StatusTag></Space>}
                extra={<Space size="small" wrap>{!managedTypes.has(value(identity, "type")) && <Typography.Text type="secondary">Verified in provider dashboard</Typography.Text>}<ActionButton body={{method:"PATCH",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}`,payload:{id: identity.id, enabled: identity.status === "disabled"}}}>{identity.archivedAt ? "Restore" : identity.status === "disabled" ? "Enable" : "Disable"}</ActionButton></Space>}
              >
                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">Provider identity</Typography.Text>
                  <Typography.Text code>{value(identity, "externalId") || "Not reported"}</Typography.Text>
                  <Typography.Text type="secondary">Last synced: {identity.lastCheckedAt ? new Date(String(identity.lastCheckedAt)).toLocaleString() : "Never"}. Records below are the provider&apos;s required DNS configuration.</Typography.Text>
                  {Boolean(identity.lastSyncAttemptAt) && <Typography.Text type="secondary">Last sync attempt: {new Date(String(identity.lastSyncAttemptAt)).toLocaleString()}</Typography.Text>}
                  {Boolean(identity.syncError) && <Notice notice={{kind:"error",text:`Last sync failed: ${String(identity.syncError)}. The records below are from the last successful sync.`}} />}
                  {identity.status !== "disabled" && managedTypes.has(value(identity,"type")) && <IdentityRecoveryActions key={value(identity,"id")} identity={identity} />}
                  {!identity.archivedAt && <ActionButton danger confirmText="Archive this provider association? This disables the identity and removes Service sending grants that use it. History and the remote provider domain are retained. Restoring requires configuring sending grants again." body={{method:"POST",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}/archive`,payload:{}}}>Archive provider</ActionButton>}
                  <ActionButton danger confirmText="Remove this provider association from Envoy? Referenced identities cannot be deleted. The provider domain is retained." body={{method:"DELETE",path:`/api/admin/provider-identities/${encodeURIComponent(String(identity.id))}`,payload:{}}}>Remove provider</ActionButton>
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
