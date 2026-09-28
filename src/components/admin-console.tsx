"use client";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Empty,
  Form,
  Grid,
  Input,
  List,
  Message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type PaginationProps,
  type TableColumnProps,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconDelete,
  IconDown,
  IconExclamationCircle,
  IconRefresh,
  IconRotateLeft,
  IconSend,
  IconUp,
} from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { ProviderAccounts } from "@/components/provider-accounts";

type Row = Record<string, unknown>;
type Data = Record<string, unknown>;
type FormValues = Record<string, unknown>;
type ActionNotice = { kind: "success" | "error"; text: string } | null;

const requiredRule = [{ required: true }];
const rows = (input: unknown) => Array.isArray(input) ? input as Row[] : [];
const record = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) ? input as Row : {};
const value = (row: Row, key: string) => String(row[key] ?? "");
const formValue = (values: FormValues, key: string) => String(values[key] ?? "");
const formValues = (values: FormValues, key: string) => Array.isArray(values[key]) ? values[key].map(String) : [];
const optionalValue = (values: FormValues, key: string) => {
  const result = formValue(values, key).trim();
  return result || undefined;
};
const date = (input: unknown) => input ? new Date(String(input)).toLocaleString("en-GB", { timeZone: "UTC" }) : "Never";

function statusColor(status: string) {
  const normalized = status.toLowerCase();
  if (["active", "verified", "processed", "delivered", "ready", "completed"].some(item => normalized.includes(item))) return "green";
  if (["disabled", "failed", "error", "rejected", "revoked", "suspended"].some(item => normalized.includes(item))) return "red";
  if (["pending", "unknown", "degraded", "needs"].some(item => normalized.includes(item))) return "orange";
  return "arcoblue";
}

function StatusTag({ children }: { children: ReactNode }) {
  const status = String(children ?? "Unknown");
  return <Tag color={statusColor(status)} size="small">{status || "Unknown"}</Tag>;
}

async function mutate(body: Row) {
  const response = await fetch("/api/admin/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(payload.error ?? "Action failed");
  return payload.result;
}

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNoticeState] = useState<ActionNotice>(null);

  async function run(body: Row) {
    setPending(true);
    setNoticeState(null);
    try {
      const result = await mutate(body);
      setNoticeState({ kind: "success", text: "Action completed successfully." });
      router.refresh();
      return result;
    } catch (error) {
      setNoticeState({
        kind: "error",
        text: error instanceof Error ? error.message : "Action failed",
      });
      throw error;
    } finally {
      setPending(false);
    }
  }

  return {
    run,
    pending,
    notice,
    setNotice: (text: string) => setNoticeState({ kind: "success", text }),
  };
}

function Field({
  label,
  field,
  required = false,
  hint,
  initialValue,
  rules,
  children,
}: {
  label: ReactNode;
  field?: string;
  required?: boolean;
  hint?: ReactNode;
  initialValue?: string | number | string[];
  rules?: { required?: boolean; type?: string }[];
  children: ReactNode;
}) {
  return (
    <Form.Item
      label={label}
      field={field}
      required={required}
      initialValue={initialValue}
      rules={rules}
      extra={hint}
    >
      {children}
    </Form.Item>
  );
}

function Panel({ title, description, children, defaultExpanded = true }: {
  title: string;
  description: string;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Card
      title={title}
      extra={(
        <Tooltip content={expanded ? "Hide form" : "Show form"}>
          <Button
            aria-label={expanded ? `Hide ${title} form` : `Show ${title} form`}
            icon={expanded ? <IconUp /> : <IconDown />}
            onClick={() => setExpanded((current) => !current)}
            shape="circle"
            type="text"
          />
        </Tooltip>
      )}
    >
      <Space direction="vertical" size={expanded ? "large" : "small"} className="admin-panel">
        <Typography.Text type="secondary">{description}</Typography.Text>
        {expanded && <div className="admin-panel__content">{children}</div>}
      </Space>
    </Card>
  );
}

function Submit({ pending, labelText, disabled = false }: { pending: boolean; labelText: string; disabled?: boolean }) {
  return <Button htmlType="submit" type="primary" icon={<IconCheck />} loading={pending} disabled={disabled}>{labelText}</Button>;
}

function Notice({ notice }: { notice: ActionNotice }) {
  if (!notice) return null;
  return (
    <Alert
      type={notice.kind}
      title={notice.kind === "success" ? "Action completed" : "Action failed"}
      content={notice.text}
      showIcon
    />
  );
}

function ActionButton({
  body,
  children,
  danger = false,
  confirmText,
  confirmTitle,
  confirmOkText,
}: {
  body: Row;
  children: ReactNode;
  danger?: boolean;
  confirmText?: string;
  confirmTitle?: string;
  confirmOkText?: string;
}) {
  const action = useAction();

  async function run() {
    try {
      await action.run(body);
      Message.success("Action completed successfully.");
    } catch (error) {
      Message.error(error instanceof Error ? error.message : "Action failed");
      throw error;
    }
  }

  function request() {
    if (!confirmText) {
      void run().catch(() => undefined);
      return;
    }
    Modal.confirm({
      title: confirmTitle ?? (danger ? "Confirm destructive action" : "Confirm action"),
      content: confirmText,
      okText: confirmOkText ?? (danger ? "Confirm" : "Continue"),
      cancelText: "Cancel",
      okButtonProps: { status: danger ? "danger" : "default" },
      onOk: run,
    });
  }

  return (
    <Button
      type={danger ? "outline" : "secondary"}
      status={danger ? "danger" : "default"}
      size="small"
      loading={action.pending}
      onClick={event => {
        event.stopPropagation();
        request();
      }}
    >
      {children}
    </Button>
  );
}

function EmptyState({ text }: { text: string }) {
  return <Empty description={text} />;
}

function Prerequisite({ title, description, href, action }: {
  title: string;
  description: string;
  href: string;
  action: string;
}) {
  return (
    <Card>
      <Empty
        description={(
          <Space direction="vertical" align="center">
            <Typography.Text bold>{title}</Typography.Text>
            <Typography.Text type="secondary">{description}</Typography.Text>
            <Button href={href} type="primary">{action}</Button>
          </Space>
        )}
      />
    </Card>
  );
}

const dataTablePagination: PaginationProps = {
  defaultPageSize: 10,
  hideOnSinglePage: true,
  showTotal: true,
};

function DataTable({
  data,
  columns,
  minWidth,
  emptyText = "No records found.",
  bordered = false,
  pagination = dataTablePagination,
}: {
  data: Row[];
  columns: TableColumnProps<Row>[];
  minWidth?: string;
  emptyText?: string;
  bordered?: boolean;
  pagination?: PaginationProps | false;
}) {
  return (
    <Table<Row>
      border={bordered}
      data={data}
      columns={columns}
      rowKey={row => value(row, "id") || JSON.stringify(row)}
      pagination={pagination}
      scroll={minWidth ? { x: minWidth } : undefined}
      noDataElement={<EmptyState text={emptyText} />}
    />
  );
}

function TableCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card title={title}>
      {children}
    </Card>
  );
}

function CopyableValue({ text, label }: { text: string; label: string }) {
  if (!text) return <Typography.Text type="secondary">Not reported</Typography.Text>;
  return (
    <Typography.Text
      code
      copyable={{ text, tooltips: [`Copy ${label}`, `Copied ${label}`] }}
    >
      {text}
    </Typography.Text>
  );
}

function DnsRecords({ records }: { records: unknown }) {
  const entries = rows(records).map(item => {
    const dns = record(item);
    return {
      id: `${value(dns, "type")}:${value(dns, "name")}:${value(dns, "value")}`,
      type: value(dns, "type"),
      name: value(dns, "name"),
      dnsValue: value(dns, "value"),
      status: value(dns, "status"),
    };
  }).filter(item => item.type || item.name || item.dnsValue);
  if (!entries.length) return null;
  return (
    <DataTable
      bordered
      data={entries}
      minWidth="620px"
      columns={[
        { title: "Type", render: (_, entry) => <Typography.Text>{value(entry, "type") || "DNS"}</Typography.Text> },
        { title: "Name", render: (_, entry) => <CopyableValue text={value(entry, "name")} label="DNS name" /> },
        { title: "Value", render: (_, entry) => <CopyableValue text={value(entry, "dnsValue")} label="DNS value" /> },
        { title: "Status", render: (_, entry) => <StatusTag>{value(entry, "status") || "Not reported"}</StatusTag> },
      ]}
    />
  );
}

function routingReason(reason: string) {
  const labels: Record<string, string> = {
    circuit_open: "Temporarily paused after recent failures",
    account_unavailable: "Provider account is unavailable",
    account_unhealthy: "Provider connection is unhealthy",
    identity_unverified: "Provider identity is not verified",
    domain_disabled: "Sending domain is disabled",
    monthly_quota_exhausted: "Monthly provider limit reached",
    daily_quota_exhausted: "Daily provider limit reached",
  };
  return labels[reason] ?? reason.replaceAll("_", " ");
}

function RoutingSimulation({ result }: { result: Row | null }) {
  if (!result) return null;
  const chosen = record(result.chosen);
  const rejected = rows(result.candidates).filter(candidate => candidate.eligible !== true);
  const selectedAccount = value(chosen, "account") || value(chosen, "provider_name");
  const selectedDomain = value(chosen, "domain");
  return (
    <Alert
      type={selectedAccount ? "success" : "warning"}
      title={selectedAccount ? "Routing target selected" : "No eligible routing target"}
      content={(
        <Space direction="vertical" size="small">
          <Typography.Text>
            {selectedAccount ? <>Selected <Typography.Text bold>{selectedAccount}</Typography.Text>{selectedDomain ? <> for <Typography.Text code>{selectedDomain}</Typography.Text>.</> : "."}</> : "No eligible routing target was found."}
          </Typography.Text>
          {rejected.map(candidate => {
            const reasons = rows(record(candidate).reasons).map(String).map(routingReason);
            return <Typography.Text type="secondary" key={value(candidate, "target_id")}>{value(candidate, "account") || "Provider target"}{reasons.length ? `: ${reasons.join(", ")}` : ": Not eligible"}</Typography.Text>;
          })}
        </Space>
      )}
      showIcon
    />
  );
}

function Providers({ data }: { data: Data }) {
  return <ProviderAccounts data={data} />;
}

function Domains({ data }: { data: Data }) {
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

  if (!providers.length) {
    return <Prerequisite title="Connect a provider account" description="Add an active provider account before associating a sending domain." href="/providers" action="Manage provider accounts" />;
  }

  return (
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Add sending domain"
        description="Provision or associate identities on selected providers"
        defaultExpanded={domains.length === 0}
      >
        <Form
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
                hint="Resend and Amazon SES create the provider identity and show DNS records. For SendGrid, Mailgun, and Postmark, select only an account where this domain is already verified in its official dashboard. A Mailgun account can use only its configured sending domain."
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
              <Space><Submit pending={action.pending} labelText="Create domain and identities" /></Space>
            </Grid.Col>
          </Grid.Row>
        </Form>
        <Notice notice={action.notice} />
      </Panel>
      {domains.map(domain => (
        <Card
          key={value(domain, "id")}
          title={<Typography.Text code>{value(domain, "domain")}</Typography.Text>}
          extra={<ActionButton body={{ action: "domain.toggle", id: domain.id, enabled: domain.status !== "active" }}>{domain.status === "active" ? "Disable" : "Enable"}</ActionButton>}
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
    </Space>
  );
}

function Senders({ data }: { data: Data }) {
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
    return <Prerequisite title="Create the sender prerequisites" description={products.length ? "Verify a sending domain before creating a sender profile." : "Create a product and verify a sending domain before creating a sender profile."} href={products.length ? "/domains" : "/api-keys"} action={products.length ? "Manage domains" : "Create a product"} />;
  }

  return (
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Create sender profile"
        description="Visible From identity resolved before queuing"
        defaultExpanded={senders.length === 0}
      >
        <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row align="end" gutter={[16, 0]}>
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
            <Grid.Col md={8} xs={24}><Field field="name" label="Profile name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="fromName" label="From name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="fromLocalPart" label="From local part" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="category" label="Category" initialValue="transactional" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={16} xs={24}><Field field="replyTo" label="Reply-To" rules={[{ type: "email" }]}><Input type="email" /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Space><Submit pending={action.pending} labelText="Create profile" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
        <Notice notice={action.notice} />
      </Panel>
      <TableCard title="Sender profiles">
        <DataTable
          data={senders}
          emptyText="No sender profiles configured."
          columns={[
            { title: "Profile", render: (_, sender) => value(sender, "name") },
            { title: "Product", render: (_, sender) => value(sender, "product") },
            { title: "From", render: (_, sender) => <Typography.Text code>{value(sender, "from_name")} &lt;{value(sender, "from_local_part")}@{value(sender, "domain")}&gt;</Typography.Text> },
            { title: "Category", render: (_, sender) => value(sender, "message_category") },
            { title: "Status", render: (_, sender) => <StatusTag>{value(sender, "status")}</StatusTag> },
            { title: "Action", render: (_, sender) => <ActionButton body={{ action: "sender.toggle", id: sender.id, enabled: sender.status !== "active" }}>{sender.status === "active" ? "Disable" : "Enable"}</ActionButton> },
          ]}
        />
      </TableCard>
    </Space>
  );
}

function Routing({ data }: { data: Data }) {
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
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Create routing policy"
        description="Match a verified identity to a sending domain"
        defaultExpanded={policies.length === 0}
      >
        <Form layout="vertical" onSubmit={values => void submit(values as FormValues)} initialValues={{ productId: "", serviceId: "" }}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="productId" label="Product"><Select options={productOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="serviceId" label="Service"><Select options={serviceOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Sending domain" required><Select value={selectedDomainId} options={eligibleDomains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} onChange={changeDomain} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="category" label="Category"><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Provider identity" required><Select value={selectedIdentityId} options={eligibleIdentities.map(identity => ({ value: value(identity, "id"), label: `${value(identity, "account")} / ${value(identity, "status")}` }))} onChange={next => setIdentityId(String(next))} /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={create.pending} labelText="Create policy" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
        <Notice notice={create.notice} />
      </Panel>
      <Panel
        title="Route simulator"
        description="Read-only deterministic eligibility inspection"
        defaultExpanded={false}
      >
        <Form layout="vertical" onSubmit={values => void simulateSubmit(values as FormValues)} initialValues={{ productId: "", serviceId: "" }}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field label="Sending domain" required><Select value={selectedDomainId} options={eligibleDomains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} onChange={changeDomain} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="productId" label="Product"><Select options={productOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="serviceId" label="Service"><Select options={serviceOptions} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="category" label="Category"><Input /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={simulate.pending} labelText="Simulate" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
        <RoutingSimulation result={simulationResult} />
        <Notice notice={simulate.notice?.kind === "error" ? simulate.notice : null} />
      </Panel>
      {policies.map(policy => (
        <Card
          key={value(policy, "id")}
          title={value(policy, "name")}
          extra={<ActionButton body={{ action: "routing.toggle", id: policy.id, enabled: policy.status !== "active" }}>{policy.status === "active" ? "Disable" : "Enable"}</ActionButton>}
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
    </Space>
  );
}

function Secret({ value: secret, label = "Copy this value now. It cannot be shown again." }: { value: string; label?: string }) {
  return (
    <Alert
      type="warning"
      title={label}
      content={(
        <Typography.Text code copyable={{ text: secret, tooltips: ["Copy secret", "Copied"] }}>
          {secret}
        </Typography.Text>
      )}
      showIcon
    />
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
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Create product"
        description="A product owns its services, senders, and delivery rules."
        defaultExpanded={products.length === 0}
      >
        <Form form={productForm} layout="vertical" onSubmit={values => void createProduct(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col xs={24}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={productAction.pending} labelText="Create product" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
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
            <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
              <Grid.Row gutter={[16, 0]}>
                <Grid.Col md={12} xs={24}><Field field="productId" label="Product" initialValue={value(activeProducts[0], "id")} required rules={requiredRule}><Select options={activeProducts.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} /></Field></Grid.Col>
                <Grid.Col md={12} xs={24}><Field field="serviceName" label="Service name" required rules={requiredRule}><Input /></Field></Grid.Col>
                <Grid.Col xs={24}><Space><Submit pending={action.pending} labelText="Issue credential" /></Space></Grid.Col>
              </Grid.Row>
            </Form>
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

function RotateCallback({ id }: { id: string }) {
  const action = useAction();
  const [secret, setSecret] = useState("");
  return (
    <Collapse bordered={false}>
      <Collapse.Item name="rotate" header="Rotate secret">
        <Space direction="vertical" size="small">
          <Typography.Text type="secondary">Rotating invalidates the previous signing secret immediately.</Typography.Text>
          <Button
            size="small"
            icon={<IconRotateLeft />}
            loading={action.pending}
            onClick={async () => {
              try {
                const result = await action.run({ action: "callback.rotate_secret", id }) as { secret?: string };
                setSecret(result.secret ?? "");
                action.setNotice("A new signing secret was generated.");
              } catch {
                // Inline notice owns failures from this request.
              }
            }}
          >
            Rotate secret
          </Button>
          {secret && <Secret value={secret} />}
          <Notice notice={action.notice} />
        </Space>
      </Collapse.Item>
    </Collapse>
  );
}

function Callbacks({ data }: { data: Data }) {
  const action = useAction();
  const services = rows(data.services).filter(service => service.product_status === "active");
  const callbacks = rows(data.callbacks);
  const [events, setEvents] = useState(["email.delivered", "email.bounced", "email.failed"]);
  const [secret, setSecret] = useState("");
  const eventOptions = [
    ["email.accepted", "Accepted"],
    ["email.delivered", "Delivered"],
    ["email.bounced", "Bounced"],
    ["email.failed", "Failed"],
    ["email.suppressed", "Suppressed"],
    ["inbound.received", "Inbound received"],
  ] as const;

  async function submit(values: FormValues) {
    try {
      const result = await action.run({ action: "callback.create", serviceId: formValue(values, "serviceId"), name: formValue(values, "name"), url: formValue(values, "url"), events }) as { secret?: string };
      setSecret(result.secret ?? "");
      action.setNotice("Callback endpoint created. Copy the generated signing secret below.");
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  if (!services.length) {
    return <Prerequisite title="Create an active service first" description="Callbacks are owned by a service so recipients can identify the product that emitted each event." href="/api-keys" action="Create a service credential" />;
  }

  return (
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Add callback endpoint"
        description="Canonical events with HMAC signatures"
        defaultExpanded={callbacks.length === 0}
      >
        <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={12} xs={24}><Field field="serviceId" label="Service" initialValue={value(services[0], "id")} required rules={requiredRule}><Select options={services.map(service => ({ value: value(service, "id"), label: `${value(service, "product")} / ${value(service, "name")}` }))} /></Field></Grid.Col>
            <Grid.Col md={12} xs={24}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={12} xs={24}><Field field="url" label="URL" required rules={requiredRule}><Input type="url" placeholder="https://api.example.com/envoy/events" /></Field></Grid.Col>
            <Grid.Col md={12} xs={24}><Field label="Events" required><Checkbox.Group value={events} options={eventOptions.map(([event, title]) => ({ value: event, label: title }))} onChange={next => setEvents(next.map(String))} /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} disabled={!events.length} labelText="Add endpoint" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
        <Notice notice={action.notice} />
        {secret && <Secret value={secret} label="Generated signing secret. Store it in the callback consumer now." />}
      </Panel>
      <Space wrap>
        <ActionButton
          body={{ action: "callback.replay_dlq" }}
          confirmOkText="Replay"
          confirmText="Replay every dead letter belonging to an active callback endpoint?"
          confirmTitle="Replay eligible dead letters?"
        >
          <IconRotateLeft />Replay eligible dead letters
        </ActionButton>
      </Space>
      <TableCard title="Callback endpoints">
        <DataTable
          data={callbacks}
          minWidth="980px"
          columns={[
            { title: "Endpoint", render: (_, callback) => <Space direction="vertical" size="mini"><Typography.Text>{value(callback, "name")}</Typography.Text><StatusTag>{value(callback, "status")}</StatusTag></Space> },
            { title: "Service", render: (_, callback) => `${value(callback, "product")} / ${value(callback, "service")}` },
            { title: "URL", render: (_, callback) => <Typography.Text code>{value(callback, "url")}</Typography.Text> },
            { title: "Events", render: (_, callback) => Array.isArray(callback.subscribed_events) ? callback.subscribed_events.join(", ") : "" },
            { title: "DLQ", render: (_, callback) => value(callback, "dead_letters") },
            {
              title: "Actions",
              render: (_, callback) => (
                <Space align="start" size="small">
                  {callback.status === "active" && <ActionButton body={{ action: "callback.test", id: callback.id }}><IconSend />Test</ActionButton>}
                  <ActionButton body={{ action: "callback.toggle", id: callback.id, enabled: callback.status !== "active" }}>{callback.status === "active" ? "Disable" : "Enable"}</ActionButton>
                  <RotateCallback id={value(callback, "id")} />
                </Space>
              ),
            },
          ]}
        />
      </TableCard>
    </Space>
  );
}

function Events({ data }: { data: Data }) {
  return (
    <Space direction="vertical" size="large" className="admin-stack">
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
            { title: "Recipient", render: (_, event) => value(event, "recipient_email") },
            { title: "Occurred", render: (_, event) => date(event.occurred_at) },
            { title: "Canonical payload", render: (_, event) => {
              const payload = JSON.stringify(event.canonical_payload);
              return <Typography.Text code copyable={{ text: payload, tooltips: ["Copy canonical payload", "Copied"] }} ellipsis={{ showTooltip: true }}>{payload}</Typography.Text>;
            } },
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
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Add suppression"
        description="Global, product, or list scope"
        defaultExpanded={suppressions.length === 0}
      >
        <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field field="email" label="Email" required rules={[{ required: true, type: "email" }]}><Input type="email" /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Scope" required><Select value={scope} options={[{ value: "global", label: "Global" }, { value: "product", label: "Product" }, { value: "list", label: "List" }]} onChange={next => setScope(next as typeof scope)} /></Field></Grid.Col>
            {scope !== "global" && <Grid.Col md={8} xs={24}><Field field="productId" label="Product" required rules={requiredRule}><Select placeholder="Choose a product" options={products.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} /></Field></Grid.Col>}
            {scope === "list" && <Grid.Col md={8} xs={24}><Field field="listId" label="List ID" required rules={requiredRule}><Input placeholder="marketing-newsletter" /></Field></Grid.Col>}
            <Grid.Col md={8} xs={24}><Field field="reason" label="Reason" initialValue="manual" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="expiresAt" label="Expires at" hint="Optional"><Input type="datetime-local" /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} disabled={scope !== "global" && !products.length} labelText="Add suppression" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
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

function Inbound({ data }: { data: Data }) {
  const action = useAction();
  const items = rows(data.inbound);
  const inboundRoutes = rows(data.inboundRoutes);
  const endpoints = rows(data.webhooks).filter(endpoint => endpoint.status === "active" && endpoint.security_configured);
  const products = rows(data.products).filter(product => product.status === "active");
  const availableDomains = rows(data.domains).filter(domain => domain.status === "active" && rows(domain.identities).some(identity => identity.status === "verified" && endpoints.some(endpoint => endpoint.provider_account_id === identity.accountId)));
  const initialEndpoint = endpoints.find(endpoint => availableDomains.some(domain => rows(domain.identities).some(identity => identity.status === "verified" && identity.accountId === endpoint.provider_account_id)));
  const [webhookEndpointId, setWebhookEndpointId] = useState(value(initialEndpoint ?? endpoints[0] ?? {}, "id"));
  const [productId, setProductId] = useState(value(products[0] ?? {}, "id"));
  const [serviceId, setServiceId] = useState("");
  const [callbackId, setCallbackId] = useState("");
  const selectedEndpoint = endpoints.find(endpoint => endpoint.id === webhookEndpointId);
  const domains = availableDomains.filter(domain => rows(domain.identities).some(identity => identity.status === "verified" && identity.accountId === selectedEndpoint?.provider_account_id));
  const [domainId, setDomainId] = useState(value(domains[0] ?? {}, "id"));
  const selectedDomainId = domains.some(domain => value(domain, "id") === domainId) ? domainId : value(domains[0] ?? {}, "id");
  const services = rows(data.services).filter(service => service.product_status === "active" && service.product_id === productId);
  const callbacks = rows(data.callbacks).filter(callback => callback.product_id === productId && callback.service_id === serviceId && callback.status === "active" && Array.isArray(callback.subscribed_events) && callback.subscribed_events.includes("inbound.received"));

  function selectEndpoint(next: string | number) {
    const nextId = String(next);
    setWebhookEndpointId(nextId);
    const endpoint = endpoints.find(item => value(item, "id") === nextId);
    const nextDomains = availableDomains.filter(domain => rows(domain.identities).some(identity => identity.status === "verified" && identity.accountId === endpoint?.provider_account_id));
    setDomainId(value(nextDomains[0] ?? {}, "id"));
  }

  function selectProduct(next: string | number) {
    setProductId(String(next));
    setServiceId("");
    setCallbackId("");
  }

  function selectService(next: string | number) {
    setServiceId(String(next));
    setCallbackId("");
  }

  async function submit(values: FormValues) {
    try {
      await action.run({
        action: "inbound_route.create",
        webhookEndpointId,
        domainId: selectedDomainId,
        productId,
        serviceId: serviceId || undefined,
        callbackId: serviceId ? callbackId : undefined,
        localPartPattern: formValue(values, "localPartPattern"),
      });
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  if (!endpoints.length || !products.length || !availableDomains.length) {
    return <Prerequisite title="Create inbound route prerequisites" description={!endpoints.length ? "Configure event verification on an active provider account before accepting inbound mail." : !availableDomains.length ? "Verify a sending domain with the selected provider account." : "Create an active product before routing inbound mail."} href={!endpoints.length ? "/providers" : !availableDomains.length ? "/domains" : "/api-keys"} action={!endpoints.length ? "Configure provider webhooks" : !availableDomains.length ? "Manage domains" : "Create a product"} />;
  }

  return (
    <Space direction="vertical" size="large" className="admin-stack">
      <Panel
        title="Create inbound route"
        description="Route provider ingress by domain and local part"
        defaultExpanded={inboundRoutes.length === 0}
      >
        <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field label="Provider endpoint" required><Select value={webhookEndpointId} options={endpoints.map(endpoint => ({ value: value(endpoint, "id"), label: `${value(endpoint, "account")} / ${value(endpoint, "type")}` }))} onChange={selectEndpoint} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Inbound domain" required><Select value={selectedDomainId} options={domains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} onChange={next => setDomainId(String(next))} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="localPartPattern" label="Local-part pattern" initialValue="*" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Product" required><Select value={productId} options={products.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} onChange={selectProduct} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Service"><Select value={serviceId} options={[{ value: "", label: "None" }, ...services.map(service => ({ value: value(service, "id"), label: value(service, "name") }))]} onChange={selectService} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Callback"><Select disabled={!serviceId} value={callbackId} options={[{ value: "", label: serviceId ? "None" : "Choose a service first" }, ...callbacks.map(callback => ({ value: value(callback, "id"), label: value(callback, "name") }))]} onChange={next => setCallbackId(String(next))} /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} labelText="Create route" /></Space></Grid.Col>
          </Grid.Row>
        </Form>
        <Notice notice={action.notice} />
      </Panel>
      <TableCard title="Inbound routes">
        <DataTable
          data={inboundRoutes}
          columns={[
            { title: "Pattern", render: (_, route) => <Typography.Text code>{value(route, "local_part_pattern")}@{value(route, "domain")}</Typography.Text> },
            { title: "Domain", render: (_, route) => value(route, "domain") },
            { title: "Product", render: (_, route) => value(route, "product") },
            { title: "Service", render: (_, route) => value(route, "service") || "None" },
            { title: "Provider", render: (_, route) => value(route, "provider_type") },
            { title: "Callback", render: (_, route) => value(route, "callback") || "None" },
            { title: "Status", render: (_, route) => <StatusTag>{value(route, "status")}</StatusTag> },
            { title: "Action", render: (_, route) => <ActionButton body={{ action: "inbound_route.toggle", id: route.id, enabled: route.status !== "active" }}>{route.status === "active" ? "Disable" : "Enable"}</ActionButton> },
          ]}
        />
      </TableCard>
      {items.length ? (
        <TableCard title="Inbound messages">
          <DataTable
            data={items}
            columns={[
              { title: "From", render: (_, item) => value(item, "from_email") },
              { title: "To", render: (_, item) => Array.isArray(item.to_emails) ? item.to_emails.join(", ") : "" },
              { title: "Subject", render: (_, item) => value(item, "subject") },
              { title: "Product", render: (_, item) => value(item, "product") },
              { title: "Attachments", render: (_, item) => value(item, "attachment_count") },
              { title: "Status", render: (_, item) => <StatusTag>{value(item, "status")}</StatusTag> },
              { title: "Received", render: (_, item) => date(item.received_at) },
            ]}
          />
        </TableCard>
      ) : (
        <Card title="Inbound messages">
          <EmptyState text="No inbound messages have been received." />
        </Card>
      )}
    </Space>
  );
}

function Logs({ data }: { data: Data }) {
  return (
    <Space direction="vertical" size="large" className="admin-stack">
      <TableCard title="Audit log">
        <DataTable
          data={rows(data.audit)}
          minWidth="900px"
          columns={[
            { title: "Actor", render: (_, audit) => value(audit, "actor") },
            { title: "Action", render: (_, audit) => <Typography.Text code>{value(audit, "action")}</Typography.Text> },
            { title: "Resource", render: (_, audit) => `${value(audit, "resource_type")} / ${value(audit, "resource_id")}` },
            { title: "Details", render: (_, audit) => <Typography.Text code>{JSON.stringify(audit.details)}</Typography.Text> },
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
