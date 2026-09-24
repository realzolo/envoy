"use client";

import {
  Check,
  ChevronDown,
  Clipboard,
  ExternalLink,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  Plus,
  Power,
  RotateCcw,
  ShieldCheck,
  Webhook,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import type { ProviderType } from "@/modules/providers/contracts";

type Row = Record<string, unknown>;
type Data = Record<string, unknown>;
type Notice = { kind: "success" | "error"; text: string } | null;

const input = "h-10 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-700";
const providerTypes: ProviderType[] = ["resend", "ses", "sendgrid", "mailgun", "postmark"];
const awsRegions = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
  "me-central-1", "me-south-1", "af-south-1", "us-gov-east-1", "us-gov-west-1"
];

const providerMeta: Record<Exclude<ProviderType, "mock">, {
  name: string;
  mark: string;
  accent: string;
  requirement: string;
  credentialPath: string;
  credentialDocs: string;
  webhookPath: string;
  webhookDocs: string;
}> = {
  resend: {
    name: "Resend",
    mark: "R",
    accent: "border-emerald-900/70 bg-emerald-950/30 text-emerald-300",
    requirement: "API key",
    credentialPath: "API Keys",
    credentialDocs: "https://resend.com/docs/dashboard/api-keys/introduction",
    webhookPath: "Webhooks > Signing secret",
    webhookDocs: "https://resend.com/docs/webhooks/verify-webhooks-requests"
  },
  ses: {
    name: "Amazon SES",
    mark: "A",
    accent: "border-amber-900/70 bg-amber-950/30 text-amber-300",
    requirement: "AWS IAM",
    credentialPath: "IAM role or runtime credentials",
    credentialDocs: "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html",
    webhookPath: "SNS topic used by your SES event destination",
    webhookDocs: "https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html"
  },
  sendgrid: {
    name: "SendGrid",
    mark: "S",
    accent: "border-blue-900/70 bg-blue-950/30 text-blue-300",
    requirement: "API key",
    credentialPath: "Settings > API Keys",
    credentialDocs: "https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication",
    webhookPath: "Settings > Mail Settings > Event Webhooks > Verification key",
    webhookDocs: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features"
  },
  mailgun: {
    name: "Mailgun",
    mark: "M",
    accent: "border-red-900/70 bg-red-950/30 text-red-300",
    requirement: "API key + domain",
    credentialPath: "Account Settings > API Keys",
    credentialDocs: "https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt",
    webhookPath: "Account Settings > API Security > Webhook signing key",
    webhookDocs: "https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks"
  },
  postmark: {
    name: "Postmark",
    mark: "P",
    accent: "border-cyan-900/70 bg-cyan-950/30 text-cyan-300",
    requirement: "Server API token",
    credentialPath: "Server > API Tokens",
    credentialDocs: "https://postmarkapp.com/developer/api/overview",
    webhookPath: "Server > Webhooks",
    webhookDocs: "https://postmarkapp.com/developer/webhooks/webhooks-overview"
  }
};

function rows(value: unknown) {
  return Array.isArray(value) ? value as Row[] : []
}

function value(row: Row, key: string) {
  return String(row[key] ?? "")
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

function meta(type: string) {
  return providerMeta[(providerTypes.includes(type as ProviderType) ? type : "resend") as Exclude<ProviderType, "mock">]
}

function optional(form: FormData, name: string) {
  const result = String(form.get(name) ?? "").trim();
  return result || undefined
}

function required(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim()
}

async function mutate(body: Row) {
  const response = await fetch("/api/admin/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(payload.error ?? "Action failed");
  return payload.result
}

function useProviderAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function run(body: Row, success: string) {
    setPending(true);
    setNotice(null);
    try {
      const result = await mutate(body);
      setNotice({ kind: "success", text: success });
      router.refresh();
      return result
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Action failed" });
      throw error
    } finally {
      setPending(false)
    }
  }

  return { run, pending, notice, setNotice }
}

function InlineNotice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <div role="status"
              className={`mt-3 rounded-md border px-3 py-2 text-xs ${notice.kind === "success" ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-300" : "border-red-900/60 bg-red-950/20 text-red-300"}`}>
    {notice.text}
  </div>
}

function Field({ label, hint, children, className = "" }: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string
}) {
  return <label className={`block space-y-1.5 ${className}`}>
    <span className="text-xs font-medium text-zinc-400">{label}</span>
    {children}
    {hint && <span className="block text-[11px] leading-4 text-zinc-600">{hint}</span>}
  </label>
}

function SecretField({ name, label, placeholder, required: isRequired = true, hint }: {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  hint?: string
}) {
  const [visible, setVisible] = useState(false);
  return <Field label={label} hint={hint}>
    <span className="relative block">
      <input name={name} type={visible ? "text" : "password"} required={isRequired} placeholder={placeholder}
             autoComplete="new-password" className={`${input} pr-10 font-mono`}/>
      <button type="button" onClick={() => setVisible(current => !current)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-zinc-600 hover:text-zinc-300"
              title={visible ? "Hide secret" : "Show secret"} aria-label={visible ? "Hide secret" : "Show secret"}>
        {visible ? <EyeOff size={15}/> : <Eye size={15}/>} 
      </button>
    </span>
  </Field>
}

function SubmitButton({ pending, children, icon = <Check size={14}/> }: {
  pending: boolean;
  children: ReactNode;
  icon?: ReactNode
}) {
  return <button disabled={pending}
                 className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50">
    {pending ? <LoaderCircle size={14} className="animate-spin"/> : icon}{children}
  </button>
}

function ProviderFields({ type }: { type: ProviderType }) {
  if (type === "resend") return <SecretField name="apiKey" label="API key" placeholder="re_..."
                                                   hint="Use a Full access key so Envoy can create and inspect sending domains."/>;
  if (type === "sendgrid") return <>
    <SecretField name="apiKey" label="API key" placeholder="SG...."/>
    <Field label="API region" hint="Choose EU only for a SendGrid EU regional subuser.">
      <select name="providerRegion" className={input} defaultValue="global">
        <option value="global">Global</option>
        <option value="eu">European Union</option>
      </select>
    </Field>
  </>;
  if (type === "mailgun") return <>
    <SecretField name="apiKey" label="API key" placeholder="key-..."/>
    <Field label="Sending domain" hint="The Mailgun domain used in the Messages API URL.">
      <input name="sendingDomain" required placeholder="mg.example.com" className={input}/>
    </Field>
    <Field label="Mailgun region">
      <select name="providerRegion" className={input} defaultValue="us">
        <option value="us">United States</option>
        <option value="eu">European Union</option>
      </select>
    </Field>
  </>;
  if (type === "postmark") return <>
    <SecretField name="serverToken" label="Server API token" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
    <Field label="Message stream" hint="Postmark uses outbound for transactional email by default.">
      <input name="messageStream" defaultValue="outbound" required className={input}/>
    </Field>
  </>;
  return <SesFields/>;
}

function SesFields() {
  const [authMode, setAuthMode] = useState("runtime");
  return <>
    <Field label="AWS region" hint="SES identities and most receiving resources are regional.">
      <input name="providerRegion" list="aws-regions" defaultValue="us-east-1" required className={input}/>
      <datalist id="aws-regions">{awsRegions.map(region => <option key={region} value={region}/>)}</datalist>
    </Field>
    <Field label="Authentication" hint="Runtime IAM credentials are recommended for AWS workloads.">
      <select name="authMode" value={authMode} onChange={event => setAuthMode(event.target.value)} className={input}>
        <option value="runtime">Runtime IAM credentials</option>
        <option value="role">Assume an IAM role</option>
        <option value="keys">Access keys</option>
      </select>
    </Field>
    {authMode === "role" && <>
      <Field label="Role ARN"><input name="roleArn" required placeholder="arn:aws:iam::123456789012:role/envoy" className={`${input} font-mono`}/></Field>
      <SecretField name="externalId" label="External ID" required={false} hint="Optional. Use the value required by the role trust policy."/>
    </>}
    {authMode === "keys" && <>
      <Field label="Access key ID"><input name="accessKeyId" required placeholder="AKIA..." className={`${input} font-mono`}/></Field>
      <SecretField name="secretAccessKey" label="Secret access key"/>
      <SecretField name="sessionToken" label="Session token" required={false}/>
    </>}
    <Field label="Configuration set" hint="Optional. Set this when SES delivery events are published from a configuration set.">
      <input name="configurationSet" placeholder="envoy-events" className={input}/>
    </Field>
  </>
}

function CreateProvider({ onClose, alwaysOpen = false }: { onClose: () => void; alwaysOpen?: boolean }) {
  const action = useProviderAction();
  const [type, setType] = useState<ProviderType>("resend");
  const [accountName, setAccountName] = useState("Resend production");
  const selected = meta(type);

  function choose(next: ProviderType) {
    const previousDefault = `${meta(type).name} production`;
    if (!accountName || accountName === previousDefault) setAccountName(`${meta(next).name} production`);
    setType(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let configuration: Row = {};
    let credentials: Row = {};
    if (type === "resend") credentials = { apiKey: required(form, "apiKey") };
    if (type === "sendgrid") {
      configuration = { region: required(form, "providerRegion") };
      credentials = { apiKey: required(form, "apiKey") }
    }
    if (type === "mailgun") {
      configuration = { region: required(form, "providerRegion"), sendingDomain: required(form, "sendingDomain") };
      credentials = { apiKey: required(form, "apiKey") }
    }
    if (type === "postmark") {
      configuration = { messageStream: required(form, "messageStream") };
      credentials = { serverToken: required(form, "serverToken") }
    }
    if (type === "ses") {
      const authMode = required(form, "authMode");
      configuration = {
        region: required(form, "providerRegion"),
        ...(optional(form, "configurationSet") ? { configurationSet: optional(form, "configurationSet") } : {}),
        ...(authMode === "role" ? {
          roleArn: required(form, "roleArn"),
          ...(optional(form, "externalId") ? { externalId: optional(form, "externalId") } : {})
        } : {})
      };
      credentials = authMode === "keys" ? {
        accessKeyId: required(form, "accessKeyId"),
        secretAccessKey: required(form, "secretAccessKey"),
        ...(optional(form, "sessionToken") ? { sessionToken: optional(form, "sessionToken") } : {})
      } : {}
    }
    try {
      await action.run({ action: "provider.create", type, name: accountName, configuration, credentials }, `${selected.name} account connected. Test the connection, then configure its webhook.`);
      if (!alwaysOpen) onClose()
    } catch {
    }
  }

  return <section className="overflow-hidden rounded-lg border border-zinc-800 bg-[#090909]">
    <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-4">
      <div>
        <h2 className="text-sm font-medium text-zinc-100">Connect a provider</h2>
        <p className="mt-1 text-xs text-zinc-600">Choose a service, then enter the credentials shown in its dashboard.</p>
      </div>
      {!alwaysOpen && <button type="button" onClick={onClose}
                              className="ml-auto flex size-8 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300"
                              title="Close" aria-label="Close provider setup"><X size={15}/></button>}
    </div>
    <div className="grid border-b border-zinc-800 sm:grid-cols-5">
      {providerTypes.map(provider => {
        const item = meta(provider);
        const active = provider === type;
        return <button key={provider} type="button" onClick={() => choose(provider)} aria-pressed={active}
                       className={`flex min-h-20 items-center gap-3 border-b border-zinc-800 px-4 text-left last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0 ${active ? "bg-zinc-900/80" : "hover:bg-zinc-950"}`}>
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${item.accent}`}>{item.mark}</span>
          <span className="min-w-0"><span className={`block text-xs font-medium ${active ? "text-zinc-100" : "text-zinc-400"}`}>{item.name}</span>
            <span className="mt-1 block truncate text-[10px] text-zinc-700">{item.requirement}</span></span>
        </button>
      })}
    </div>
    <form onSubmit={submit} className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="p-5 lg:border-r lg:border-zinc-800">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account name" hint="A label for your team; it is not sent to the provider." className="sm:col-span-2">
            <input value={accountName} onChange={event => setAccountName(event.target.value)} required maxLength={120}
                   placeholder={`${selected.name} production`} className={input}/>
          </Field>
          <ProviderFields key={type} type={type}/>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
          <SubmitButton pending={action.pending}>Connect account</SubmitButton>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-600"><ShieldCheck size={13}/>Secrets are encrypted and never shown again</span>
        </div>
        <InlineNotice notice={action.notice}/>
      </div>
      <aside className="border-t border-zinc-800 p-5 lg:border-t-0">
        <p className="text-[11px] font-medium uppercase text-zinc-600">From {selected.name}</p>
        <p className="mt-2 text-sm text-zinc-300">{selected.credentialPath}</p>
        <a href={selected.credentialDocs} target="_blank" rel="noreferrer"
           className="mt-3 inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200">
          Open official documentation <ExternalLink size={12}/>
        </a>
        <div className="mt-5 border-t border-zinc-800 pt-4">
          <p className="text-xs leading-5 text-zinc-500">Webhook verification is configured after this account is created, when its unique callback URL is available.</p>
        </div>
      </aside>
    </form>
  </section>
}

function ActionButton({ body, success, children, danger = false }: {
  body: Row;
  success: string;
  children: ReactNode;
  danger?: boolean
}) {
  const action = useProviderAction();
  return <span className="inline-flex items-center gap-2">
    <button type="button" disabled={action.pending} onClick={async () => {
      try {
        await action.run(body, success)
      } catch {
      }
    }} className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs disabled:opacity-50 ${danger ? "border-red-900/60 text-red-400 hover:bg-red-950/20" : "border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}>
      {action.pending ? <LoaderCircle size={13} className="animate-spin"/> : null}{children}
    </button>
    {action.notice && <span className={`max-w-52 truncate text-[11px] ${action.notice.kind === "error" ? "text-red-400" : "text-emerald-500"}`}
                            title={action.notice.text}>{action.notice.text}</span>}
  </span>
}

function CopyEndpoint({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={async () => {
    await navigator.clipboard.writeText(`${window.location.origin}${path}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600)
  }} className="flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                 title="Copy full callback URL" aria-label="Copy full callback URL">
    {copied ? <Check size={13}/> : <Clipboard size={13}/>} 
  </button>
}

function WebhookForm({ account }: { account: Row }) {
  const action = useProviderAction();
  const type = value(account, "type") as ProviderType;
  const selected = meta(type);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let settings: Row = {};
    if (type === "resend") settings = { signingSecret: required(form, "signingSecret") };
    if (type === "sendgrid") settings = { publicKey: required(form, "publicKey") };
    if (type === "mailgun") settings = { webhookSigningKey: required(form, "webhookSigningKey") };
    if (type === "postmark") settings = {
      username: required(form, "username"),
      password: required(form, "password"),
      ipAllowlist: required(form, "ipAllowlist").split(/[\s,]+/).filter(Boolean)
    };
    if (type === "ses") settings = { expectedTopicArn: required(form, "expectedTopicArn") };
    try {
      await action.run({ action: "webhook.rotate_security", id: account.webhook_endpoint_id, settings }, "Webhook verification saved")
    } catch {
    }
  }

  return <form onSubmit={submit} className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
    <div className="grid gap-3 sm:grid-cols-2">
      {type === "resend" && <SecretField name="signingSecret" label="Signing secret" placeholder="whsec_..."/>}
      {type === "sendgrid" && <Field label="Verification public key" className="sm:col-span-2">
        <textarea name="publicKey" required rows={5} placeholder="-----BEGIN PUBLIC KEY-----"
                  className={`${input} h-auto py-2 font-mono text-xs`}/>
      </Field>}
      {type === "mailgun" && <SecretField name="webhookSigningKey" label="Webhook signing key"/>}
      {type === "postmark" && <>
        <Field label="Basic Auth username"><input name="username" defaultValue="envoy" required autoComplete="off" className={input}/></Field>
        <SecretField name="password" label="Basic Auth password"/>
        <Field label="Postmark source IPs" hint="Optional. Separate IP addresses or CIDR ranges with commas." className="sm:col-span-2">
          <input name="ipAllowlist" placeholder="3.134.147.250, 50.31.156.6" className={`${input} font-mono`}/>
        </Field>
      </>}
      {type === "ses" && <Field label="Expected SNS topic ARN" hint="The exact SNS topic configured as the SES event destination." className="sm:col-span-2">
        <input name="expectedTopicArn" required placeholder="arn:aws:sns:us-east-1:123456789012:envoy-events"
               className={`${input} font-mono`}/>
      </Field>}
      <div className="sm:col-span-2"><SubmitButton pending={action.pending} icon={<ShieldCheck size={14}/>}>Save verification</SubmitButton>
        <InlineNotice notice={action.notice}/></div>
    </div>
    <aside className="border-t border-zinc-800 pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
      <p className="text-[11px] font-medium uppercase text-zinc-600">Find this in {selected.name}</p>
      <p className="mt-2 text-xs leading-5 text-zinc-400">{selected.webhookPath}</p>
      <a href={selected.webhookDocs} target="_blank" rel="noreferrer"
         className="mt-3 inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200">Official webhook guide <ExternalLink size={12}/></a>
    </aside>
  </form>
}

function CredentialForm({ account }: { account: Row }) {
  const action = useProviderAction();
  const type = value(account, "type") as ProviderType;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let secret: Row = {};
    if (type === "resend" || type === "sendgrid" || type === "mailgun") secret = { apiKey: required(form, "apiKey") };
    if (type === "postmark") secret = { serverToken: required(form, "serverToken") };
    if (type === "ses" && optional(form, "accessKeyId")) secret = {
      accessKeyId: required(form, "accessKeyId"),
      secretAccessKey: required(form, "secretAccessKey"),
      ...(optional(form, "sessionToken") ? { sessionToken: optional(form, "sessionToken") } : {})
    };
    try {
      await action.run({ action: "provider.rotate", id: account.id, secret }, "Credential rotated")
    } catch {
    }
  }

  return <form onSubmit={submit} className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
    {(type === "resend" || type === "sendgrid" || type === "mailgun") &&
      <SecretField name="apiKey" label="New API key" placeholder={type === "resend" ? "re_..." : type === "sendgrid" ? "SG...." : "key-..."}/>} 
    {type === "postmark" && <SecretField name="serverToken" label="New server API token"/>}
    {type === "ses" && <>
      <Field label="Access key ID" hint="Leave both key fields blank to return to runtime IAM credentials.">
        <input name="accessKeyId" placeholder="AKIA..." className={`${input} font-mono`}/>
      </Field>
      <SecretField name="secretAccessKey" label="Secret access key" required={false}/>
      <SecretField name="sessionToken" label="Session token" required={false}/>
    </>}
    <div className="sm:col-span-2"><SubmitButton pending={action.pending} icon={<RotateCcw size={14}/>}>Rotate credential</SubmitButton>
      <InlineNotice notice={action.notice}/></div>
  </form>
}

function QuotaForm({ account }: { account: Row }) {
  const action = useProviderAction();
  const quota = record(account.quota);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const monthly = optional(form, "monthlyLimit");
    const daily = optional(form, "dailyLimit");
    const next = {
      ...(daily !== undefined ? { dailyLimit: Number(daily) } : {}),
      ...(monthly !== undefined ? { monthlyLimit: Number(monthly) } : {})
    };
    try {
      await action.run({ action: "provider.update_quota", id: account.id, quota: next }, "Routing limits saved")
    } catch {
    }
  }

  return <form onSubmit={submit} className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-[1fr_1fr_auto]">
    <Field label="Daily messages" hint="Blank means unlimited.">
      <input type="number" min="0" step="1" name="dailyLimit" defaultValue={quota.dailyLimit === undefined ? "" : String(quota.dailyLimit)} className={input}/>
    </Field>
    <Field label="Monthly messages" hint="Blank means unlimited.">
      <input type="number" min="0" step="1" name="monthlyLimit" defaultValue={quota.monthlyLimit === undefined ? "" : String(quota.monthlyLimit)} className={input}/>
    </Field>
    <div className="flex items-end"><SubmitButton pending={action.pending}>Save limits</SubmitButton></div>
    <div className="sm:col-span-3"><InlineNotice notice={action.notice}/></div>
  </form>
}

function Status({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "muted" }) {
  const color = tone === "good" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-zinc-600";
  return <div>
    <dt className="text-[11px] text-zinc-600">{label}</dt>
    <dd className="mt-1.5 flex items-center gap-2 text-xs text-zinc-300"><span className={`size-1.5 rounded-full ${color}`}/>{value}</dd>
  </div>
}

function Account({ account }: { account: Row }) {
  const type = value(account, "type") as ProviderType;
  const selected = meta(type);
  const endpointPath = `/api/provider-events/${type}/${value(account, "opaque_token")}`;
  const active = account.status === "active";
  const health = value(account, "health") || "unknown";
  const configured = account.security_configured === true;
  const publicConfig = record(account.public_config);
  const detail = type === "mailgun" ? String(publicConfig.sendingDomain ?? account.region) :
    type === "postmark" ? String(publicConfig.messageStream ?? "outbound") :
      type === "ses" ? value(account, "region") : type === "sendgrid" && account.region === "eu" ? "EU region" : "Global";

  return <article className="overflow-hidden rounded-lg border border-zinc-800 bg-[#090909]">
    <header className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${selected.accent}`}>{selected.mark}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="truncate text-sm font-medium text-zinc-100">{value(account, "name")}</h2>
          <span className="text-xs text-zinc-600">{selected.name}</span>
        </div>
        <p className="mt-1 truncate text-xs text-zinc-600">{detail}</p>
      </div>
      <dl className="grid grid-cols-3 gap-x-8">
        <Status label="Account" value={active ? "Enabled" : "Disabled"} tone={active ? "good" : "muted"}/>
        <Status label="Connection" value={health === "healthy" ? "Healthy" : health === "unhealthy" ? "Failed" : "Not tested"}
                tone={health === "healthy" ? "good" : health === "unhealthy" ? "warn" : "muted"}/>
        <Status label="Webhook" value={configured ? "Verified" : "Needs setup"} tone={configured ? "good" : "warn"}/>
      </dl>
    </header>

    <div className="grid gap-4 border-t border-zinc-800 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="text-[11px] text-zinc-600">Callback URL</p>
        <div className="mt-1.5 flex items-center gap-2">
          <code className="min-w-0 truncate text-xs text-zinc-400">{endpointPath}</code>
          <CopyEndpoint path={endpointPath}/>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <ActionButton body={{ action: "provider.test", id: account.id }} success="Connection check completed">
          <FlaskConical size={13}/>Test connection
        </ActionButton>
        <ActionButton body={{ action: "provider.toggle", id: account.id, enabled: !active }}
                      success={active ? "Account disabled" : "Account enabled"} danger={active}>
          <Power size={13}/>{active ? "Disable" : "Enable"}
        </ActionButton>
      </div>
    </div>

    <div className="border-t border-zinc-800">
      <details className="group px-5">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-xs text-zinc-400 hover:text-zinc-200">
          <Webhook size={14}/>{configured ? "Update webhook verification" : "Configure webhook"}
          <ChevronDown size={13} className="ml-auto transition-transform group-open:rotate-180"/>
        </summary>
        <div className="border-t border-zinc-900 pb-5"><WebhookForm account={account}/></div>
      </details>
      <details className="group border-t border-zinc-800 px-5">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-xs text-zinc-400 hover:text-zinc-200">
          <KeyRound size={14}/>Rotate credential <span className="text-zinc-700">v{value(account, "credential_version")}</span>
          <ChevronDown size={13} className="ml-auto transition-transform group-open:rotate-180"/>
        </summary>
        <div className="border-t border-zinc-900 pb-5"><CredentialForm account={account}/></div>
      </details>
      <details className="group border-t border-zinc-800 px-5">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-xs text-zinc-400 hover:text-zinc-200">
          <RotateCcw size={14}/>Routing limits
          <ChevronDown size={13} className="ml-auto transition-transform group-open:rotate-180"/>
        </summary>
        <div className="border-t border-zinc-900 pb-5"><QuotaForm account={account}/></div>
      </details>
    </div>
  </article>
}

export function ProviderAccounts({ data }: { data: Data }) {
  const providers = rows(data.providers);
  const [showCreate, setShowCreate] = useState(providers.length === 0);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm text-zinc-300">{providers.length} connected {providers.length === 1 ? "account" : "accounts"}</p>
        <p className="mt-1 text-xs text-zinc-600">Credentials and event verification are managed independently.</p>
      </div>
      {!showCreate && <button type="button" onClick={() => setShowCreate(true)}
                            className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white">
        <Plus size={14}/>Add provider
      </button>}
    </div>
    {showCreate && <CreateProvider onClose={() => setShowCreate(false)} alwaysOpen={providers.length === 0}/>} 
    {providers.length > 0 ? <div className="space-y-3">{providers.map(provider => <Account key={value(provider, "id")} account={provider}/>)}</div> :
      <div className="rounded-lg border border-dashed border-zinc-800 py-14 text-center">
        <p className="text-sm text-zinc-500">No provider accounts yet</p>
        <p className="mt-1 text-xs text-zinc-700">Connect one above to start configuring domains and routes.</p>
      </div>}
  </div>
}
