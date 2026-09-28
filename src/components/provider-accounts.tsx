"use client";

import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Grid,
  Input,
  Radio,
  Select,
  Space,
  Tag,
  Typography,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconClose,
  IconLaunch,
  IconLock,
  IconPlus,
  IconPoweroff,
  IconRefresh,
  IconRotateLeft,
  IconSafe,
  IconSend,
  IconSettings,
} from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import type { ProviderType } from "@/modules/providers/contracts";

type Row = Record<string, unknown>;
type Data = Record<string, unknown>;
type FormValues = Record<string, unknown>;
type Notice = { kind: "success" | "error"; text: string } | null;

const requiredRule = [{ required: true }];
const providerTypes: ProviderType[] = ["resend", "ses", "sendgrid", "mailgun", "postmark"];
const awsRegions = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
  "me-central-1", "me-south-1", "af-south-1", "us-gov-east-1", "us-gov-west-1",
];

const providerMeta: Record<Exclude<ProviderType, "mock">, {
  name: string;
  mark: string;
  color: string;
  requirement: string;
  credentialPath: string;
  credentialDocs: string;
  webhookPath: string;
  webhookDocs: string;
}> = {
  resend: {
    name: "Resend",
    mark: "R",
    color: "green",
    requirement: "API key",
    credentialPath: "API Keys",
    credentialDocs: "https://resend.com/docs/dashboard/api-keys/introduction",
    webhookPath: "Webhooks > Signing secret",
    webhookDocs: "https://resend.com/docs/webhooks/verify-webhooks-requests",
  },
  ses: {
    name: "Amazon SES",
    mark: "A",
    color: "orange",
    requirement: "AWS IAM",
    credentialPath: "IAM role or runtime credentials",
    credentialDocs: "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html",
    webhookPath: "SNS topic used by your SES event destination",
    webhookDocs: "https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html",
  },
  sendgrid: {
    name: "SendGrid",
    mark: "S",
    color: "arcoblue",
    requirement: "API key",
    credentialPath: "Settings > API Keys",
    credentialDocs: "https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication",
    webhookPath: "Event Webhooks and Inbound Parse each have a separate verification key",
    webhookDocs: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features",
  },
  mailgun: {
    name: "Mailgun",
    mark: "M",
    color: "red",
    requirement: "API key + domain",
    credentialPath: "Account Settings > API Keys",
    credentialDocs: "https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt",
    webhookPath: "Account Settings > API Security > Webhook signing key",
    webhookDocs: "https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks",
  },
  postmark: {
    name: "Postmark",
    mark: "P",
    color: "purple",
    requirement: "Server API token",
    credentialPath: "Server > API Tokens",
    credentialDocs: "https://postmarkapp.com/developer/api/overview",
    webhookPath: "Server > Webhooks",
    webhookDocs: "https://postmarkapp.com/developer/webhooks/webhooks-overview",
  },
};

function rows(input: unknown) {
  return Array.isArray(input) ? input as Row[] : [];
}

function value(row: Row, key: string) {
  return String(row[key] ?? "");
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Row : {};
}

function formValue(values: FormValues, key: string) {
  return String(values[key] ?? "");
}

function optional(values: FormValues, name: string) {
  const result = formValue(values, name).trim();
  return result || undefined;
}

function required(values: FormValues, name: string) {
  return formValue(values, name).trim();
}

function meta(type: string) {
  return providerMeta[(providerTypes.includes(type as ProviderType) ? type : "resend") as Exclude<ProviderType, "mock">];
}

export function postmarkWebhookUrl(path: string, username: string, password: string, origin: string) {
  const url = new URL(path, origin);
  url.username = username;
  url.password = password;
  return url.toString();
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

function useProviderAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function run(body: Row, success: string | ((result: unknown) => Notice)) {
    setPending(true);
    setNotice(null);
    try {
      const result = await mutate(body);
      setNotice(typeof success === "function" ? success(result) : { kind: "success", text: success });
      router.refresh();
      return result;
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Action failed" });
      throw error;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, notice, setNotice };
}

function InlineNotice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <Alert type={notice.kind === "success" ? "success" : "error"} content={notice.text} showIcon />;
}

function Field({
  label,
  field,
  hint,
  required: isRequired = false,
  initialValue,
  rules,
  children,
}: {
  label: ReactNode;
  field?: string;
  hint?: ReactNode;
  required?: boolean;
  initialValue?: string | number | string[];
  rules?: { required?: boolean; type?: string }[];
  children: ReactNode;
}) {
  return (
    <Form.Item
      field={field}
      label={label}
      required={isRequired}
      initialValue={initialValue}
      rules={rules}
      extra={hint}
    >
      {children}
    </Form.Item>
  );
}

function FormColumn({ children, span = 12 }: { children: ReactNode; span?: number }) {
  return <Grid.Col xs={24} md={span}>{children}</Grid.Col>;
}

function SecretField({ field, label, placeholder, required: isRequired = true, hint }: {
  field: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <Field field={field} label={label} required={isRequired} rules={isRequired ? requiredRule : undefined} hint={hint}>
      <Input.Password placeholder={placeholder} autoComplete="new-password" visibilityToggle />
    </Field>
  );
}

function SubmitButton({ pending, children, icon = <IconCheck /> }: {
  pending: boolean;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return <Button htmlType="submit" type="primary" loading={pending} icon={icon}>{children}</Button>;
}

function ProviderFields({ type, authMode }: { type: ProviderType; authMode: string }) {
  if (type === "resend") {
    return <FormColumn><SecretField field="apiKey" label="API key" placeholder="re_..." hint="Use a Full access key so Envoy can create and inspect sending domains." /></FormColumn>;
  }
  if (type === "sendgrid") {
    return <>
      <FormColumn><SecretField field="apiKey" label="API key" placeholder="SG...." /></FormColumn>
      <FormColumn><Field field="providerRegion" label="API region" initialValue="global" required rules={requiredRule} hint="Choose EU only for a SendGrid EU regional subuser.">
        <Select options={[{ value: "global", label: "Global" }, { value: "eu", label: "European Union" }]} />
      </Field></FormColumn>
    </>;
  }
  if (type === "mailgun") {
    return <>
      <FormColumn><SecretField field="apiKey" label="API key" placeholder="key-..." /></FormColumn>
      <FormColumn><Field field="sendingDomain" label="Sending domain" required rules={requiredRule} hint="The Mailgun domain used in the Messages API URL."><Input placeholder="mg.example.com" /></Field></FormColumn>
      <FormColumn><Field field="providerRegion" label="Mailgun region" initialValue="us" required rules={requiredRule}>
        <Select options={[{ value: "us", label: "United States" }, { value: "eu", label: "European Union" }]} />
      </Field></FormColumn>
    </>;
  }
  if (type === "postmark") {
    return <>
      <FormColumn><SecretField field="serverToken" label="Server API token" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></FormColumn>
      <FormColumn><Field field="messageStream" label="Message stream" initialValue="outbound" required rules={requiredRule} hint="Postmark uses outbound for transactional email by default."><Input /></Field></FormColumn>
    </>;
  }
  return <SesFields authMode={authMode} />;
}

function SesFields({ authMode }: { authMode: string }) {
  return (
    <>
      <FormColumn><Field field="providerRegion" label="AWS region" initialValue="us-east-1" required rules={requiredRule} hint="SES identities and most receiving resources are regional.">
        <Select showSearch options={awsRegions.map(region => ({ value: region, label: region }))} />
      </Field></FormColumn>
      <FormColumn><Field field="authMode" label="Authentication" initialValue="runtime" required rules={requiredRule} hint="Runtime IAM credentials are recommended for AWS workloads.">
        <Select options={[{ value: "runtime", label: "Runtime IAM credentials" }, { value: "role", label: "Assume an IAM role" }, { value: "keys", label: "Access keys" }]} />
      </Field></FormColumn>
      {authMode === "role" && <>
        <FormColumn><Field field="roleArn" label="Role ARN" required rules={requiredRule}><Input placeholder="arn:aws:iam::123456789012:role/envoy" /></Field></FormColumn>
        <FormColumn><SecretField field="externalId" label="External ID" required={false} hint="Optional. Use the value required by the role trust policy." /></FormColumn>
      </>}
      {authMode === "keys" && <>
        <FormColumn><Field field="accessKeyId" label="Access key ID" required rules={requiredRule}><Input placeholder="AKIA..." /></Field></FormColumn>
        <FormColumn><SecretField field="secretAccessKey" label="Secret access key" /></FormColumn>
        <FormColumn><SecretField field="sessionToken" label="Session token" required={false} /></FormColumn>
      </>}
      <FormColumn><Field field="configurationSet" label="Configuration set" hint="Optional. Set this when SES delivery events are published from a configuration set."><Input placeholder="envoy-events" /></Field></FormColumn>
    </>
  );
}

function CreateProvider({ onClose, alwaysOpen = false }: { onClose: () => void; alwaysOpen?: boolean }) {
  const action = useProviderAction();
  const [type, setType] = useState<ProviderType>("resend");
  const [accountName, setAccountName] = useState("Resend");
  const [authMode, setAuthMode] = useState("runtime");
  const selected = meta(type);

  function choose(next: ProviderType) {
    const previousDefault = meta(type).name;
    if (!accountName || accountName === previousDefault) setAccountName(meta(next).name);
    setAuthMode("runtime");
    setType(next);
  }

  async function submit(values: FormValues) {
    let configuration: Row = {};
    let credentials: Row = {};
    if (type === "resend") credentials = { apiKey: required(values, "apiKey") };
    if (type === "sendgrid") {
      configuration = { region: required(values, "providerRegion") };
      credentials = { apiKey: required(values, "apiKey") };
    }
    if (type === "mailgun") {
      configuration = { region: required(values, "providerRegion"), sendingDomain: required(values, "sendingDomain") };
      credentials = { apiKey: required(values, "apiKey") };
    }
    if (type === "postmark") {
      configuration = { messageStream: required(values, "messageStream") };
      credentials = { serverToken: required(values, "serverToken") };
    }
    if (type === "ses") {
      const selectedAuthMode = required(values, "authMode");
      configuration = {
        region: required(values, "providerRegion"),
        ...(optional(values, "configurationSet") ? { configurationSet: optional(values, "configurationSet") } : {}),
        ...(selectedAuthMode === "role" ? {
          roleArn: required(values, "roleArn"),
          ...(optional(values, "externalId") ? { externalId: optional(values, "externalId") } : {}),
        } : {}),
      };
      credentials = selectedAuthMode === "keys" ? {
        accessKeyId: required(values, "accessKeyId"),
        secretAccessKey: required(values, "secretAccessKey"),
        ...(optional(values, "sessionToken") ? { sessionToken: optional(values, "sessionToken") } : {}),
      } : {};
    }
    try {
      await action.run({ action: "provider.create", type, name: accountName, configuration, credentials }, `${selected.name} account connected. Test sending, then configure its event webhook.`);
      if (!alwaysOpen) onClose();
    } catch {
      // The in-form Alert renders request failures.
    }
  }

  return (
    <Card
      title="Connect a provider"
      extra={!alwaysOpen && <Button type="text" shape="circle" icon={<IconClose />} title="Close" aria-label="Close provider setup" onClick={onClose} />}
    >
      <Space direction="vertical" size="large" className="admin-stack">
        <Typography.Text type="secondary">Choose a service, then enter the credentials shown in its dashboard.</Typography.Text>
        <Radio.Group
          type="button"
          mode="outline"
          value={type}
          options={providerTypes.map(provider => {
            const item = meta(provider);
            return {
              value: provider,
              label: <Space size="mini"><Tag color={item.color}>{item.mark}</Tag><span>{item.name}</span></Space>,
            };
          })}
          onChange={next => choose(next as ProviderType)}
        />
        <Grid.Row gutter={24} align="start">
          <Grid.Col xs={24} xl={16}>
            <Form
              key={type}
              layout="vertical"
              initialValues={{ accountName }}
              onSubmit={values => void submit(values as FormValues)}
              onValuesChange={changed => {
                if ("accountName" in changed) setAccountName(String(changed.accountName ?? ""));
                if ("authMode" in changed) setAuthMode(String(changed.authMode ?? "runtime"));
              }}
            >
              <Grid.Row gutter={16}>
                <FormColumn span={24}>
                  <Field field="accountName" label="Account name" required rules={requiredRule} hint="A label for your team; it is not sent to the provider."><Input maxLength={120} placeholder={selected.name} /></Field>
                </FormColumn>
                <ProviderFields type={type} authMode={authMode} />
                <FormColumn span={24}>
                  <Space size="small" wrap>
                    <SubmitButton pending={action.pending}>Connect account</SubmitButton>
                    <Space size="mini"><IconLock /><Typography.Text type="secondary">Secrets are encrypted and never shown again</Typography.Text></Space>
                  </Space>
                </FormColumn>
              </Grid.Row>
            </Form>
          </Grid.Col>
          <Grid.Col xs={24} xl={8}>
            <Alert
              type="info"
              showIcon
              title={`From ${selected.name}`}
              content={(
                <Space direction="vertical" size="small">
                  <Typography.Text>{selected.credentialPath}</Typography.Text>
                  <Button type="text" href={selected.credentialDocs} target="_blank" icon={<IconLaunch />}>Open official documentation</Button>
                  <Typography.Text type="secondary">Event verification is configured after this account is created, when its unique provider webhook URL is available.</Typography.Text>
                </Space>
              )}
            />
          </Grid.Col>
        </Grid.Row>
        <InlineNotice notice={action.notice} />
      </Space>
    </Card>
  );
}

function ActionButton({ body, success, children, danger = false }: {
  body: Row;
  success: string | ((result: unknown) => Notice);
  children: ReactNode;
  danger?: boolean;
}) {
  const action = useProviderAction();
  return (
    <Space size="mini" wrap>
      <Button
        type={danger ? "outline" : "secondary"}
        status={danger ? "danger" : "default"}
        size="small"
        loading={action.pending}
        onClick={async event => {
          event.stopPropagation();
          try {
            await action.run(body, success);
          } catch {
            // The adjacent message renders request failures.
          }
        }}
      >
        {children}
      </Button>
      {action.notice && <Typography.Text type={action.notice.kind === "error" ? "error" : "success"} ellipsis={{ showTooltip: true }}>{action.notice.text}</Typography.Text>}
    </Space>
  );
}

const subscribeToBrowserOrigin = () => () => {};

function CopyableEndpoint({ path }: { path: string }) {
  const origin = useSyncExternalStore(
    subscribeToBrowserOrigin,
    () => window.location.origin,
    () => "",
  );

  const endpoint = origin ? `${origin}${path}` : "";
  return (
    <Typography.Text
      code
      copyable={endpoint ? {
        text: endpoint,
        tooltips: ["Copy full provider webhook URL", "Copied"],
      } : false}
    >
      {path}
    </Typography.Text>
  );
}

function WebhookForm({ account }: { account: Row }) {
  const action = useProviderAction();
  const type = value(account, "type") as ProviderType;
  const selected = meta(type);
  const endpointPath = `/api/provider-events/${type}/${value(account, "opaque_token")}`;
  const [postmarkUrl, setPostmarkUrl] = useState("");

  async function submit(values: FormValues) {
    let settings: Row = {};
    if (type === "resend") settings = { signingSecret: required(values, "signingSecret") };
    if (type === "sendgrid") {
      settings = {
        eventWebhookPublicKey: required(values, "eventWebhookPublicKey"),
        ...(optional(values, "inboundParsePublicKey") ? { inboundParsePublicKey: optional(values, "inboundParsePublicKey") } : {}),
      };
    }
    if (type === "mailgun") settings = { webhookSigningKey: required(values, "webhookSigningKey") };
    const postmarkUsername = type === "postmark" ? required(values, "username") : "";
    const postmarkPassword = type === "postmark" ? required(values, "password") : "";
    if (type === "postmark") {
      settings = {
        username: postmarkUsername,
        password: postmarkPassword,
        ipAllowlist: required(values, "ipAllowlist").split(/[\s,]+/).filter(Boolean),
      };
    }
    if (type === "ses") settings = { expectedTopicArn: required(values, "expectedTopicArn") };
    try {
      await action.run({ action: "webhook.rotate_security", id: account.webhook_endpoint_id, settings }, "Event verification saved");
      if (type === "postmark") setPostmarkUrl(postmarkWebhookUrl(endpointPath, postmarkUsername, postmarkPassword, window.location.origin));
    } catch {
      // The in-form Alert renders request failures.
    }
  }

  return (
    <Grid.Row gutter={24} align="start">
      <Grid.Col xs={24} xl={16}>
        <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={16}>
            {type === "resend" && <FormColumn><SecretField field="signingSecret" label="Signing secret" placeholder="whsec_..." /></FormColumn>}
            {type === "sendgrid" && <>
              <FormColumn span={24}><Field field="eventWebhookPublicKey" label="Event Webhook public key" required rules={requiredRule} hint="Required for delivery and engagement events."><Input.TextArea autoSize={{ minRows: 5, maxRows: 8 }} placeholder="-----BEGIN PUBLIC KEY-----" /></Field></FormColumn>
              <FormColumn span={24}><Field field="inboundParsePublicKey" label="Inbound Parse public key" hint="Add the separate Parse security-policy key only when receiving inbound email."><Input.TextArea autoSize={{ minRows: 5, maxRows: 8 }} placeholder="-----BEGIN PUBLIC KEY-----" /></Field></FormColumn>
            </>}
            {type === "mailgun" && <FormColumn><SecretField field="webhookSigningKey" label="Webhook signing key" /></FormColumn>}
            {type === "postmark" && <>
              <FormColumn><Field field="username" label="Basic Auth username" initialValue="envoy" required rules={requiredRule} hint="Included in the generated Postmark provider webhook URL after saving."><Input autoComplete="off" /></Field></FormColumn>
              <FormColumn><SecretField field="password" label="Basic Auth password" hint="Use a new random value; it is encoded into the one-time provider webhook URL." /></FormColumn>
              <FormColumn span={24}><Field field="ipAllowlist" label="Postmark source IPs" hint="Optional. Separate exact IP addresses with commas."><Input placeholder="3.134.147.250, 50.31.156.6" /></Field></FormColumn>
            </>}
            {type === "ses" && <FormColumn span={24}><Field field="expectedTopicArn" label="Expected SNS topic ARN" required rules={requiredRule} hint="The exact SNS topic configured as the SES event destination."><Input placeholder="arn:aws:sns:us-east-1:123456789012:envoy-events" /></Field></FormColumn>}
            <FormColumn span={24}><SubmitButton pending={action.pending} icon={<IconSafe />}>Save verification</SubmitButton></FormColumn>
          </Grid.Row>
        </Form>
      </Grid.Col>
      <Grid.Col xs={24} xl={8}>
        <Alert
          type="info"
          showIcon
          title={`Find this in ${selected.name}`}
          content={(
            <Space direction="vertical" size="small">
              <Typography.Text>{selected.webhookPath}</Typography.Text>
              <Button type="text" href={selected.webhookDocs} target="_blank" icon={<IconLaunch />}>Official webhook guide</Button>
              {type === "sendgrid" && <Button type="text" href="https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks" target="_blank" icon={<IconLaunch />}>Inbound Parse security guide</Button>}
            </Space>
          )}
        />
      </Grid.Col>
      {action.notice && <Grid.Col xs={24}><InlineNotice notice={action.notice} /></Grid.Col>}
      {postmarkUrl && (
        <Grid.Col xs={24}>
          <Alert
            type="warning"
            title="Copy this Postmark provider webhook URL now"
            content={<Typography.Text code copyable={{ text: postmarkUrl, tooltips: ["Copy Postmark provider webhook URL", "Copied"] }}>{postmarkUrl}</Typography.Text>}
            showIcon
          />
        </Grid.Col>
      )}
    </Grid.Row>
  );
}

function CredentialForm({ account }: { account: Row }) {
  const action = useProviderAction();
  const type = value(account, "type") as ProviderType;

  async function submit(values: FormValues) {
    let secret: Row = {};
    if (type === "resend" || type === "sendgrid" || type === "mailgun") secret = { apiKey: required(values, "apiKey") };
    if (type === "postmark") secret = { serverToken: required(values, "serverToken") };
    if (type === "ses" && optional(values, "accessKeyId")) {
      secret = {
        accessKeyId: required(values, "accessKeyId"),
        secretAccessKey: required(values, "secretAccessKey"),
        ...(optional(values, "sessionToken") ? { sessionToken: optional(values, "sessionToken") } : {}),
      };
    }
    try {
      await action.run({ action: "provider.rotate", id: account.id, secret }, "Credential rotated. Test the new credential before routing resumes.");
    } catch {
      // The in-form Alert renders request failures.
    }
  }

  return (
    <Form layout="vertical" onSubmit={values => void submit(values as FormValues)}>
      <Grid.Row gutter={16}>
        {(type === "resend" || type === "sendgrid" || type === "mailgun") && <FormColumn><SecretField field="apiKey" label="New API key" placeholder={type === "resend" ? "re_..." : type === "sendgrid" ? "SG...." : "key-..."} /></FormColumn>}
        {type === "postmark" && <FormColumn><SecretField field="serverToken" label="New server API token" /></FormColumn>}
        {type === "ses" && <>
          <FormColumn><Field field="accessKeyId" label="Access key ID" hint="Leave both key fields blank to return to runtime IAM credentials."><Input placeholder="AKIA..." /></Field></FormColumn>
          <FormColumn><SecretField field="secretAccessKey" label="Secret access key" required={false} /></FormColumn>
          <FormColumn><SecretField field="sessionToken" label="Session token" required={false} /></FormColumn>
        </>}
        <FormColumn span={24}><SubmitButton pending={action.pending} icon={<IconRotateLeft />}>Rotate credential</SubmitButton></FormColumn>
        {action.notice && <FormColumn span={24}><InlineNotice notice={action.notice} /></FormColumn>}
      </Grid.Row>
    </Form>
  );
}

function QuotaForm({ account }: { account: Row }) {
  const action = useProviderAction();
  const quota = record(account.quota);

  async function submit(values: FormValues) {
    const monthly = optional(values, "monthlyLimit");
    const daily = optional(values, "dailyLimit");
    const quotaUpdate = {
      ...(daily !== undefined ? { dailyLimit: Number(daily) } : {}),
      ...(monthly !== undefined ? { monthlyLimit: Number(monthly) } : {}),
    };
    try {
      await action.run({ action: "provider.update_quota", id: account.id, quota: quotaUpdate }, "Routing limits saved");
    } catch {
      // The in-form Alert renders request failures.
    }
  }

  return (
    <Form
      layout="vertical"
      initialValues={{
        dailyLimit: quota.dailyLimit === undefined ? "" : String(quota.dailyLimit),
        monthlyLimit: quota.monthlyLimit === undefined ? "" : String(quota.monthlyLimit),
      }}
      onSubmit={values => void submit(values as FormValues)}
    >
      <Grid.Row gutter={16}>
        <FormColumn><Field field="dailyLimit" label="Daily messages" hint="Blank means unlimited."><Input type="number" min="0" step="1" /></Field></FormColumn>
        <FormColumn><Field field="monthlyLimit" label="Monthly messages" hint="Blank means unlimited."><Input type="number" min="0" step="1" /></Field></FormColumn>
        <FormColumn span={24}><SubmitButton pending={action.pending}>Save limits</SubmitButton></FormColumn>
        {action.notice && <FormColumn span={24}><InlineNotice notice={action.notice} /></FormColumn>}
      </Grid.Row>
    </Form>
  );
}

function badgeStatus(tone: "good" | "warn" | "muted"): "success" | "warning" | "default" {
  if (tone === "good") return "success";
  if (tone === "warn") return "warning";
  return "default";
}

function Account({ account }: { account: Row }) {
  const type = value(account, "type") as ProviderType;
  const selected = meta(type);
  const endpointPath = `/api/provider-events/${type}/${value(account, "opaque_token")}`;
  const active = account.status === "active";
  const waitingForTest = account.status === "degraded";
  const health = value(account, "health") || "unknown";
  const configured = account.security_configured === true;
  const webhookActive = account.webhook_status === "active";
  const publicConfig = record(account.public_config);
  const configRegion = value(publicConfig, "region");
  const detail = type === "mailgun" ? String(publicConfig.sendingDomain ?? "") : type === "postmark" ? `Stream: ${String(publicConfig.messageStream ?? "outbound")}` : type === "ses" ? configRegion : type === "sendgrid" ? configRegion === "eu" ? "EU region" : "Global region" : "";
  const sending = active && health === "healthy" ? { status: "Ready", tone: "good" as const } : active || waitingForTest ? { status: "Needs test", tone: "warn" as const } : { status: "Disabled", tone: "muted" as const };
  const eventWebhook = !webhookActive ? { status: "Disabled", tone: "muted" as const } : !configured ? { status: "Verification needed", tone: "warn" as const } : { status: "Ready to receive", tone: "good" as const };

  return (
    <Card
      title={value(account, "name") || selected.name}
      extra={<Tag color={selected.color}>{selected.name}</Tag>}
    >
      <Space direction="vertical" size="large" className="admin-stack">
        <Descriptions
          column={{ xs: 1, sm: 2, xl: 3 }}
          data={[
            {
              label: "Provider",
              value: <Space size="small"><Tag color={selected.color}>{selected.mark}</Tag><Typography.Text>{selected.name}{detail ? ` · ${detail}` : ""}</Typography.Text></Space>,
            },
            {
              label: "Sending",
              value: <Badge status={badgeStatus(sending.tone)} text={sending.status} />,
            },
            {
              label: "Event webhook",
              value: <Badge status={badgeStatus(eventWebhook.tone)} text={eventWebhook.status} />,
            },
          ]}
        />
        <Space direction="vertical" size="mini">
          <Typography.Text type="secondary">Provider webhook URL</Typography.Text>
          {type === "postmark" ? <Typography.Text type="secondary">Save event verification below to generate its Basic Auth URL.</Typography.Text> : <CopyableEndpoint path={endpointPath} />}
        </Space>
        <Space wrap size="small">
          <ActionButton body={{ action: "provider.test", id: account.id }} success={result => {
            const healthy = (result as { healthy?: boolean }).healthy === true;
            return healthy ? { kind: "success", text: "Connection verified. Account is ready for domain setup." } : { kind: "error", text: "Connection failed. Review the provider credential and account settings." };
          }}><IconSend />Test connection</ActionButton>
          <ActionButton body={{ action: "webhook.toggle", id: account.webhook_endpoint_id, enabled: !webhookActive }} success={webhookActive ? "Event webhook disabled" : "Event webhook enabled"} danger={webhookActive}><IconSettings />{webhookActive ? "Disable event webhook" : "Enable event webhook"}</ActionButton>
          {!waitingForTest && <ActionButton body={{ action: "provider.toggle", id: account.id, enabled: !active }} success={active ? "Account disabled" : "Account enabled for testing"} danger={active}><IconPoweroff />{active ? "Disable" : "Enable for test"}</ActionButton>}
        </Space>
        <Collapse bordered>
          <Collapse.Item name="webhook" header={<Space size="small"><IconSettings />{configured ? "Update event verification" : "Configure event verification"}</Space>}>
            <WebhookForm account={account} />
          </Collapse.Item>
          <Collapse.Item name="credentials" header={<Space size="small"><IconRefresh />Rotate credential <Typography.Text type="secondary">v{value(account, "credential_version")}</Typography.Text></Space>}>
            <CredentialForm account={account} />
          </Collapse.Item>
          <Collapse.Item name="quota" header={<Space size="small"><IconRotateLeft />Routing limits</Space>}>
            <QuotaForm account={account} />
          </Collapse.Item>
        </Collapse>
      </Space>
    </Card>
  );
}

export function ProviderAccounts({ data }: { data: Data }) {
  const providers = rows(data.providers);
  const [showCreate, setShowCreate] = useState(providers.length === 0);

  return (
    <Space direction="vertical" size="large" className="admin-stack">
      <Grid.Row align="center" justify="space-between" gutter={16}>
        <Grid.Col flex="auto">
          <Space direction="vertical" size="mini">
            <Typography.Text>{providers.length} connected {providers.length === 1 ? "account" : "accounts"}</Typography.Text>
            <Typography.Text type="secondary">Credentials and event verification are managed independently.</Typography.Text>
          </Space>
        </Grid.Col>
        {!showCreate && <Grid.Col flex="none"><Button type="primary" icon={<IconPlus />} onClick={() => setShowCreate(true)}>Add provider</Button></Grid.Col>}
      </Grid.Row>
      {showCreate && <CreateProvider onClose={() => setShowCreate(false)} alwaysOpen={providers.length === 0} />}
      {providers.length > 0 ? <Space direction="vertical" size="medium" className="provider-account-list">{providers.map(provider => <Account key={value(provider, "id")} account={provider} />)}</Space> : (
        <Empty description="No provider accounts yet. Connect one above to start configuring domains and routes." />
      )}
    </Space>
  );
}
