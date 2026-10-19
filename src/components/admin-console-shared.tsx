"use client";

import { Alert,Button,Card,Empty,Form,Input,Message,Modal,Space,Table,Tag,Tooltip,Typography,type PaginationProps,type TableColumnProps } from "@arco-design/web-react";
import { IconCheck,IconDown,IconUp } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { createContext,useContext,useState,type ComponentProps,type ReactNode } from "react";

import styles from "@/components/admin-views.module.css";
import { LocalTime } from "@/components/local-time";

export type Row = Record<string, unknown>;
export type { AdminData as Data } from "@/modules/admin/contracts";
export type AdminMutation = {method:"POST"|"PUT"|"PATCH"|"DELETE";path:string;payload:Record<string,unknown>};
export type FormValues = Record<string, unknown>;
export type ActionNotice = { kind: "success" | "error"; text: string } | null;

export const requiredRule = [{ required: true }];
export const rows = (input: unknown) => Array.isArray(input) ? input as Row[] : [];
export const record = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) ? input as Row : {};
export const value = (row: Row, key: string) => String(row[key] ?? "");
export const formValue = (values: FormValues, key: string) => String(values[key] ?? "");
export const formValues = (values: FormValues, key: string) => Array.isArray(values[key]) ? values[key].map(String) : [];
export const optionalValue = (values: FormValues, key: string) => {
  const result = formValue(values, key).trim();
  return result || undefined;
};
export const date = (input: unknown) => input ? <LocalTime value={input instanceof Date ? input.toISOString() : String(input)} /> : <>Not scheduled</>;

export function statusColor(status: string) {
  const normalized = status.toLowerCase();
  if (["active", "verified", "processed", "delivered", "ready", "completed", "clean"].some(item => normalized.includes(item))) return "green";
  if (["failed", "error", "rejected", "dead_letter"].some(item => normalized.includes(item))) return "red";
  if (["disabled", "revoked", "suspended", "skipped"].includes(normalized)) return "gray";
  if (["pending", "unknown", "degraded", "needs", "queued", "submitting", "deferred", "retrying", "delivering"].some(item => normalized.includes(item))) return "orange";
  return "arcoblue";
}

export function StatusTag({ children }: { children: ReactNode }) {
  const status = String(children ?? "Unknown");
  return <Tag color={statusColor(status)}>{status || "Unknown"}</Tag>;
}

export class AdminActionError extends Error {
  constructor(message: string, public fields: Record<string, string> = {}) { super(message); }
}
const FieldErrorContext = createContext<Record<string, string>>({});
export function useServerFieldError(field?: string) {
  const errors = useContext(FieldErrorContext);
  if (!field) return undefined;
  return errors[field] ?? Object.entries(errors).find(([path]) => path.startsWith(`${field}.`) || path.endsWith(`.${field}`))?.[1];
}
export function ActionForm({ fieldErrors, className, ...props }: ComponentProps<typeof Form> & { fieldErrors?: Record<string, string> }) {
  return <FieldErrorContext.Provider value={fieldErrors ?? {}}><Form labelAlign="left" colon={false} {...props} className={[styles.form, ...(Array.isArray(className) ? className : [className])].filter(Boolean).join(" ")} /></FieldErrorContext.Provider>;
}

export async function mutate(body: AdminMutation) {
  const response = await fetch(body.path, {
    method: body.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body.payload),
  });
  const payload = await response.json() as { error?: string; result?: unknown; fields?: Record<string, string> };
  if (!response.ok) throw new AdminActionError(payload.error ?? "Action failed", payload.fields);
  return payload.result;
}

export function actionResultText(result: unknown) {
  const details = record(result);
  if (Array.isArray(details.identities)) {
    const failed = rows(details.identities).filter(identity => identity.status === "failed");
    if (failed.length) {
      const errors = [...new Set(failed.map(identity => value(identity, "error")).filter(Boolean))];
      return `Domain saved, but ${failed.length} provider ${failed.length === 1 ? "identity failed" : "identities failed"}. ${errors.join("; ") || "Refresh the failed identities to retry."}`;
    }
    return "Domain saved. Provider identities are associated; refresh DNS for any pending verification.";
  }
  if (details.queued === false) return `No new work queued: ${String(details.reason ?? "not eligible").replaceAll("_", " ")}.`;
  if (typeof details.count === "number") return `${details.count} records queued for retry.`;
  if (typeof details.id === "string") return `Saved ${details.id}.`;
  return "Action completed successfully.";
}

function actionResultFailed(result: unknown) {
  const details = record(result);
  return details.queued === false || rows(details.identities).some(identity => identity.status === "failed");
}

export function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNoticeState] = useState<ActionNotice>(null);

  async function run(body: AdminMutation) {
    setPending(true);
    setFields({});
    setNoticeState(null);
    try {
      const result = await mutate(body);
      setNoticeState({ kind: actionResultFailed(result) ? "error" : "success", text: actionResultText(result) });
      router.refresh();
      return result;
    } catch (error) {
      if (error instanceof AdminActionError) setFields(error.fields);
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
    fields,
    setNotice: (text: string) => setNoticeState({ kind: "success", text }),
  };
}

export function Field({
  label,
  field,
  required = false,
  hint,
  initialValue,
  rules,
  children,
  triggerPropName,
}: {
  triggerPropName?: "checked";
  label: ReactNode;
  field?: string;
  required?: boolean;
  hint?: ReactNode;
  initialValue?: string | number | string[];
  rules?: { required?: boolean; type?: string }[];
  children: ReactNode;
}) {
  const serverError = useServerFieldError(field);
  return (
    <Form.Item
      validateStatus={serverError ? "error" : undefined}
      help={serverError}
      label={label}
      field={field}
      triggerPropName={triggerPropName}
      required={required}
      {...(initialValue !== undefined ? { initialValue } : {})}
      rules={rules}
      extra={hint}
    >
      {children}
    </Form.Item>
  );
}

export function Panel({ title, description, children, defaultExpanded = true }: {
  title: string;
  description: string;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Card
      className={styles.card}
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
      <Space direction="vertical" size={expanded ? "large" : "small"} className={styles.stack}>
        <Typography.Text type="secondary">{description}</Typography.Text>
        {expanded && <div className={styles.panelContent}>{children}</div>}
      </Space>
    </Card>
  );
}

export function Submit({ pending, labelText, disabled = false }: { pending: boolean; labelText: string; disabled?: boolean }) {
  return <Button htmlType="submit" type="primary" icon={<IconCheck />} loading={pending} disabled={disabled}>{labelText}</Button>;
}

export function Notice({ notice }: { notice: ActionNotice }) {
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

export function ActionButton({
  body,
  children,
  danger = false,
  confirmText,
  confirmTitle,
  confirmOkText,
}: {
  body: AdminMutation;
  children: ReactNode;
  danger?: boolean;
  confirmText?: string;
  confirmTitle?: string;
  confirmOkText?: string;
}) {
  const action = useAction();

  async function run() {
    try {
      const result = await action.run(body);
      if (actionResultFailed(result)) Message.warning(actionResultText(result));
      else Message.success(actionResultText(result));
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
      size="default"
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

export function EmptyState({ text }: { text: string }) {
  return <Empty description={text} />;
}

export function Prerequisite({ title, description, href, action }: {
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

export const dataTablePagination: PaginationProps = {
  defaultPageSize: 10,
  hideOnSinglePage: true,
  showTotal: true,
};

export function DataTable({
  data,
  columns,
  minWidth,
  emptyText = "No records found.",
  bordered = false,
  pagination = dataTablePagination,
  searchable = true,
}: {
  data: Row[];
  columns: TableColumnProps<Row>[];
  minWidth?: string;
  emptyText?: string;
  bordered?: boolean;
  pagination?: PaginationProps | false;
  searchable?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const term = search.trim().toLocaleLowerCase();
  const filtered = term ? data.filter(row => Object.values(row).some(item => typeof item === "string" || typeof item === "number" ? String(item).toLocaleLowerCase().includes(term) : false)) : data;
  const tableColumns = columns.map(column => ({ ...column, width: column.width ?? (String(column.title).startsWith("Action") ? 200 : 180) }));
  const columnsWidth = tableColumns.reduce((width, column) => width + (typeof column.width === "number" ? column.width : 180), 0);
  return (
    <div className={styles.table}>
      {searchable && <div className={styles.toolbar}>
        <Input.Search className={styles.search} allowClear placeholder="Search loaded records" aria-label="Search loaded records" value={search} onChange={next => { setSearch(next); setPage(1); }} />
        <Typography.Text type="secondary">{term ? `${filtered.length} of ${data.length}` : data.length} {data.length === 1 ? "record" : "records"} loaded</Typography.Text>
      </div>}
    <Table<Row>
      size="default"
      tableLayoutFixed
      border={bordered}
      data={filtered}
      columns={tableColumns}
      rowKey={row => value(row, "id") || JSON.stringify(row)}
      pagination={pagination === false ? false : { ...pagination, current: page, onChange: (current, pageSize) => { setPage(current); pagination.onChange?.(current, pageSize); } }}
      scroll={{ x: Math.max(Number.parseFloat(minWidth ?? "0") || 0, columnsWidth) }}
      noDataElement={<EmptyState text={term ? "No loaded records match your search." : emptyText} />}
    />
    </div>
  );
}

export function TableCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card className={styles.card} title={title}>
      {children}
    </Card>
  );
}

export function JsonPreview({ data, title = "Record details" }: { data: unknown; title?: string }) {
  const text = JSON.stringify(data, null, 2) ?? "null";
  return <Button type="text" size="small" onClick={() => Modal.info({ title, style: { width: 800, maxWidth: "calc(100vw - 32px)" }, content: <div className={styles.section}><Typography.Text copyable={{ text }}>JSON payload</Typography.Text><pre className={styles.code}>{text}</pre></div> })}>View details</Button>;
}

export function CopyableValue({ text, label }: { text: string; label: string }) {
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

export function DnsRecords({ records }: { records: unknown }) {
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
      searchable={false}
      bordered
      data={entries}
      minWidth="620px"
      columns={[
        { title: "Type", width: 80, render: (_, entry) => <Typography.Text>{value(entry, "type") || "DNS"}</Typography.Text> },
        { title: "Name", width: 220, render: (_, entry) => <CopyableValue text={value(entry, "name")} label="DNS name" /> },
        { title: "Value", width: 400, render: (_, entry) => <CopyableValue text={value(entry, "dnsValue")} label="DNS value" /> },
        { title: "Status", width: 120, render: (_, entry) => <StatusTag>{value(entry, "status") || "Not reported"}</StatusTag> },
      ]}
    />
  );
}

export function routingReason(reason: string) {
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

export function RoutingSimulation({ result }: { result: Row | null }) {
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

export function Secret({ value: secret, label = "Copy this value now. It cannot be shown again." }: { value: string; label?: string }) {
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
