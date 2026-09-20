"use client";

import {
  Check,
  Clipboard,
  FlaskConical,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";

type Row = Record<string, unknown>;
type Data = Record<string, unknown>;
const input = "h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300 outline-none focus:border-zinc-600";
const label = "space-y-1.5 text-xs text-zinc-500";
const rows = (value: unknown) => Array.isArray(value) ? value as Row[] : [];
const value = (row: Row, key: string) => String(row[key] ?? "");
const date = (inputValue: unknown) => inputValue ? new Date(String(inputValue)).toLocaleString("en-GB", { timeZone: "UTC" }) : "Never";

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

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");

  async function run(body: Row) {
    setPending(true);
    setNotice("");
    try {
      const result = await mutate(body);
      setNotice(result ? JSON.stringify(result, null, 2) : "Completed");
      router.refresh();
      return result
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Action failed");
      throw error
    } finally {
      setPending(false)
    }
  }

  return { run, pending, notice, setNotice }
}

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <details className="rounded-lg border border-zinc-800 bg-[#090909]">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-zinc-200"><Plus
      size={14}/>{title}<span className="ml-auto text-xs text-zinc-600">{description}</span></summary>
    <div className="border-t border-zinc-800 p-4">{children}</div>
  </details>
}

function Submit({ pending, labelText }: { pending: boolean; labelText: string }) {
  return <button disabled={pending}
                 className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 disabled:opacity-50">{pending ?
    <LoaderCircle size={14} className="animate-spin"/> : <Check size={14}/>} {labelText}</button>
}

function Notice({ text }: { text: string }) {
  if (!text) return null;
  return <pre
    className={`mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs ${text.startsWith("{") || text === "Completed" ? "border-emerald-900/50 bg-emerald-950/20 text-emerald-300" : "border-red-900/50 bg-red-950/20 text-red-300"}`}>{text}</pre>
}

function Button({ body, children, danger = false, confirmText }: {
  body: Row;
  children: ReactNode;
  danger?: boolean;
  confirmText?: string
}) {
  const action = useAction();
  return <span className="inline-flex items-center gap-2"><button type="button" disabled={action.pending}
                                                                  onClick={async () => {
                                                                    if (confirmText && !confirm(confirmText)) return;
                                                                    try {
                                                                      await action.run(body)
                                                                    } catch {
                                                                    }
                                                                  }}
                                                                  className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs ${danger ? "border-red-900/60 text-red-400" : "border-zinc-800 text-zinc-400 hover:bg-zinc-900"}`}>{action.pending ?
    <LoaderCircle size={13} className="animate-spin"/> : null}{children}</button>
    {action.notice &&
      <span className="max-w-44 truncate text-[11px] text-zinc-500" title={action.notice}>{action.notice}</span>}</span>
}

function Empty({ text }: { text: string }) {
  return <div
    className="rounded-lg border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-600">{text}</div>
}

function Table({ headers, children, min = "760px" }: { headers: string[]; children: ReactNode; min?: string }) {
  return <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#090909]">
    <div className="overflow-x-auto">
      <table className="w-full text-left" style={{ minWidth: min }}>
        <thead>
        <tr className="border-b border-zinc-800 text-[11px] text-zinc-600">{headers.map(item => <th key={item}
                                                                                                    className="px-4 py-3 font-medium">{item}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  </div>
}

function Cell({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <td className={`px-4 py-3.5 text-xs text-zinc-400 ${mono ? "font-mono" : ""}`}>{children}</td>
}

function Providers({ data }: { data: Data }) {
  const action = useAction();
  const providers = rows(data.providers);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const d = new FormData(form);
    try {
      await action.run({
        action: "provider.create",
        type: d.get("type"),
        name: d.get("name"),
        region: d.get("region"),
        publicConfig: JSON.parse(String(d.get("publicConfig"))),
        secret: JSON.parse(String(d.get("secret"))),
        webhookSecurity: JSON.parse(String(d.get("webhookSecurity"))),
        expectedTopicArn: d.get("expectedTopicArn"),
        ipAllowlist: String(d.get("ipAllowlist") ?? "").split(",").map(item => item.trim()).filter(Boolean)
      })
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Create provider account"
                                           description="Secrets are write-only and envelope encrypted">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Provider<select name="type"
                                                                                                           className={input}>{rows(data.descriptors).map(item =>
      <option key={value(item, "type")}
              value={value(item, "type")}>{value(item, "displayName")}</option>)}</select></label><label
      className={label}>Account name<input name="name" required className={input}/></label><label className={label}>Region<input
      name="region" required defaultValue="us-east-1" className={input}/></label><label
      className={`${label} md:col-span-3`}>Public configuration JSON<textarea name="publicConfig" rows={3}
                                                                              defaultValue={'{"behavior":"deliver"}'}
                                                                              className={`${input} h-auto py-2 font-mono text-xs`}/></label><label
      className={`${label} md:col-span-3`}>Credential JSON<textarea name="secret" rows={3}
                                                                    defaultValue={'{"token":"local-mock-token"}'}
                                                                    className={`${input} h-auto py-2 font-mono text-xs`}/></label><label
      className={`${label} md:col-span-3`}>Webhook security JSON<textarea name="webhookSecurity" rows={3}
                                                                          defaultValue={'{"token":"local-webhook-token"}'}
                                                                          className={`${input} h-auto py-2 font-mono text-xs`}/></label><label
      className={label}>Expected SNS Topic ARN (SES)<input name="expectedTopicArn" className={input}/></label><label
      className={label}>Webhook IP allowlist<input name="ipAllowlist" placeholder="203.0.113.10, 203.0.113.11"
                                                   className={input}/></label>
      <div className="flex items-end"><Submit pending={action.pending} labelText="Create account"/></div>
    </form>
    <Notice text={action.notice}/></Panel><ProviderQuotaForm providers={providers}/>{providers.length ?
    <div className="grid gap-4 lg:grid-cols-2">{providers.map(item => <section key={value(item, "id")}
                                                                               className="rounded-lg border border-zinc-800 bg-[#090909] p-5">
      <div className="flex items-start justify-between">
        <div><h2 className="text-sm font-medium text-zinc-100">{value(item, "name")}</h2><p
          className="mt-1 font-mono text-xs text-zinc-600">{value(item, "type")} / {value(item, "region")}</p></div>
        <span
          className={`text-xs ${item.status === "active" ? "text-emerald-400" : "text-amber-400"}`}>{value(item, "status")}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-zinc-700">Health</dt>
          <dd className="mt-1 text-zinc-400">{value(item, "health")}</dd>
        </div>
        <div>
          <dt className="text-zinc-700">Revision</dt>
          <dd className="mt-1 text-zinc-400">{value(item, "config_revision")}</dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2"><Button body={{ action: "provider.test", id: item.id }}><FlaskConical
        size={13}/>Test connection</Button><Button body={{
        action: "provider.toggle",
        id: item.id,
        enabled: item.status !== "active"
      }}>{item.status === "active" ? "Disable" : "Enable"}</Button></div>
      <details className="mt-4 border-t border-zinc-800 pt-3">
        <summary className="cursor-pointer text-xs text-zinc-500">Rotate credential</summary>
        <RotateProvider id={value(item, "id")}/></details>
    </section>)}</div> : <Empty text="No provider accounts have been configured."/>}</div>
}

function RotateProvider({ id }: { id: string }) {
  const action = useAction();
  const [secret, setSecret] = useState("{}");
  return <div className="mt-3"><textarea value={secret} onChange={e => setSecret(e.target.value)} rows={3}
                                         className={`${input} h-auto py-2 font-mono text-xs`}/>
    <button type="button" onClick={async () => {
      try {
        await action.run({ action: "provider.rotate", id, secret: JSON.parse(secret) })
      } catch {
      }
    }}
            className="mt-2 inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300">
      <RotateCcw size={13}/>Rotate
    </button>
    <Notice text={action.notice}/></div>
}

function RotateWebhook({ id }: { id: string }) {
  const action = useAction();
  const [security, setSecurity] = useState("{}");
  const [topic, setTopic] = useState("");
  const [ips, setIps] = useState("");
  return <details>
    <summary className="cursor-pointer text-xs text-zinc-500">Security</summary>
    <div className="mt-2 w-72 space-y-2"><textarea aria-label="Webhook security JSON" value={security}
                                                   onChange={e => setSecurity(e.target.value)} rows={3}
                                                   className={`${input} h-auto py-2 font-mono text-xs`}/><input
      aria-label="Expected SNS Topic ARN" value={topic} onChange={e => setTopic(e.target.value)}
      placeholder="Expected SNS Topic ARN" className={input}/><input aria-label="Webhook IP allowlist" value={ips}
                                                                     onChange={e => setIps(e.target.value)}
                                                                     placeholder="IP allowlist" className={input}/>
      <button type="button" onClick={async () => {
        try {
          await action.run({
            action: "webhook.rotate_security",
            id,
            security: JSON.parse(security),
            expectedTopicArn: topic || undefined,
            ipAllowlist: ips ? ips.split(",").map(item => item.trim()).filter(Boolean) : undefined
          })
        } catch {
        }
      }} className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300">
        <RotateCcw size={13}/>Rotate security
      </button>
      <Notice text={action.notice}/></div>
  </details>
}

function ProviderQuotaForm({ providers }: { providers: Row[] }) {
  const action = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({ action: "provider.update_quota", id: d.get("id"), quota: JSON.parse(String(d.get("quota"))) })
    } catch {
    }
  }

  return <Panel title="Update provider quota" description="Limits are evaluated by the routing engine">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-[240px_1fr_auto]"><label className={label}>Account<select
      name="id" className={input}>{providers.map(p => <option key={value(p, "id")}
                                                              value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
      className={label}>Quota JSON<input name="quota" defaultValue={'{"monthlyLimit":100000}'}
                                         className={`${input} font-mono`}/></label>
      <div className="flex items-end"><Submit pending={action.pending} labelText="Save quota"/></div>
    </form>
    <Notice text={action.notice}/></Panel>
}

function Domains({ data }: { data: Data }) {
  const action = useAction();
  const domains = rows(data.domains);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const d = new FormData(event.currentTarget);
    try {
      await action.run({
        action: "domain.create",
        domain: d.get("domain"),
        region: d.get("region"),
        inboundEnabled: d.get("inboundEnabled") === "on",
        accountIds: d.getAll("accountIds")
      })
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Add logical domain"
                                           description="Provision identities on selected providers">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Domain<input name="domain"
                                                                                                        required
                                                                                                        placeholder="mail.example.com"
                                                                                                        className={input}/></label><label
      className={label}>Region<input name="region" defaultValue="us-east-1" required className={input}/></label><label
      className="flex items-end gap-2 pb-2 text-xs text-zinc-400"><input type="checkbox" name="inboundEnabled"/>Enable
      inbound</label>
      <fieldset className="md:col-span-3">
        <legend className="mb-2 text-xs text-zinc-500">Provider accounts</legend>
        <div className="flex flex-wrap gap-3">{rows(data.providers).filter(p => p.status === "active").map(p => <label
          key={value(p, "id")} className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox"
                                                                                                name="accountIds"
                                                                                                value={value(p, "id")}/>{value(p, "name")}
        </label>)}</div>
      </fieldset>
      <div className="md:col-span-3"><Submit pending={action.pending} labelText="Create domain and identities"/><Notice
        text={action.notice}/></div>
    </form>
  </Panel>{domains.map(domain => <section key={value(domain, "id")}
                                          className="rounded-lg border border-zinc-800 bg-[#090909] p-5">
    <div className="flex flex-wrap items-center gap-3"><h2
      className="font-mono text-sm text-zinc-200">{value(domain, "domain")}</h2><span
      className="text-xs text-zinc-600">{value(domain, "region")}</span>{Boolean(domain.inbound_enabled) &&
      <span className="text-xs text-sky-400">Inbound</span>}<span className="ml-auto"><Button body={{
      action: "domain.toggle",
      id: domain.id,
      enabled: domain.status !== "active"
    }}>{domain.status === "active" ? "Disable" : "Enable"}</Button></span></div>
    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows(domain.identities).map(identity => <div
      key={value(identity, "id")} className="rounded-md border border-zinc-800 p-3">
      <div className="flex justify-between text-xs"><span
        className="text-zinc-300">{value(identity, "account")}</span><span
        className={identity.status === "verified" ? "text-emerald-400" : "text-amber-400"}>{value(identity, "status")}</span>
      </div>
      <p className="mt-2 font-mono text-[11px] text-zinc-700">{value(identity, "externalId")}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button
        body={{ action: "identity.refresh", id: identity.id }}><RefreshCw size={13}/>Refresh DNS</Button><Button body={{
        action: "identity.toggle",
        id: identity.id,
        enabled: identity.status === "disabled"
      }}>{identity.status === "disabled" ? "Enable" : "Disable"}</Button></div>
      {Array.isArray(identity.dnsRecords) && identity.dnsRecords.length > 0 && <pre
        className="mt-3 max-h-32 overflow-auto text-[10px] text-zinc-600">{JSON.stringify(identity.dnsRecords, null, 2)}</pre>}
    </div>)}</div>
  </section>)}</div>
}

function Senders({ data }: { data: Data }) {
  const action = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "sender.create",
        productId: d.get("productId"),
        domainId: d.get("domainId"),
        name: d.get("name"),
        fromName: d.get("fromName"),
        fromLocalPart: d.get("fromLocalPart"),
        replyTo: d.get("replyTo"),
        category: d.get("category")
      })
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Create sender profile"
                                           description="Visible From identity resolved before queuing">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Product<select
      name="productId" className={input}>{rows(data.products).map(p => <option key={value(p, "id")}
                                                                               value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
      className={label}>Domain<select name="domainId" className={input}>{rows(data.domains).map(d => <option
      key={value(d, "id")} value={value(d, "id")}>{value(d, "domain")}</option>)}</select></label><label
      className={label}>Profile name<input name="name" required className={input}/></label><label className={label}>From
      name<input name="fromName" required className={input}/></label><label className={label}>From local part<input
      name="fromLocalPart" required className={input}/></label><label className={label}>Category<input name="category"
                                                                                                       defaultValue="transactional"
                                                                                                       required
                                                                                                       className={input}/></label><label
      className={`${label} md:col-span-2`}>Reply-To<input name="replyTo" type="email" className={input}/></label>
      <div className="flex items-end"><Submit pending={action.pending} labelText="Create profile"/></div>
    </form>
    <Notice text={action.notice}/></Panel><Table
    headers={["Profile", "Product", "From", "Category", "Status", "Action"]}>{rows(data.senders).map(s => <tr
    key={value(s, "id")} className="border-b border-zinc-900">
    <Cell>{value(s, "name")}</Cell><Cell>{value(s, "product")}</Cell><Cell
    mono>{value(s, "from_name")} &lt;{value(s, "from_local_part")}@{value(s, "domain")}&gt;</Cell><Cell>{value(s, "message_category")}</Cell><Cell>{value(s, "status")}</Cell><Cell><Button
    body={{
      action: "sender.toggle",
      id: s.id,
      enabled: s.status !== "active"
    }}>{s.status === "active" ? "Disable" : "Enable"}</Button></Cell></tr>)}</Table></div>
}

function Routing({ data }: { data: Data }) {
  const create = useAction();
  const simulate = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const identityId = String(d.get("identityId"));
    const identity = rows(data.domains).flatMap(domain => rows(domain.identities)).find(item => item.id === identityId);
    try {
      await create.run({
        action: "routing.create",
        name: d.get("name"),
        productId: d.get("productId"),
        serviceId: d.get("serviceId"),
        templateId: d.get("templateId"),
        category: d.get("category"),
        region: d.get("region"),
        priority: Number(d.get("policyPriority")),
        targets: [{
          accountId: identity?.accountId,
          identityId,
          priority: Number(d.get("targetPriority")),
          weight: Number(d.get("weight")),
          rateLimit: Number(d.get("rateLimit"))
        }]
      })
    } catch {
    }
  }

  async function simulateSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await simulate.run({
        action: "routing.simulate",
        productId: d.get("productId"),
        category: d.get("category"),
        region: d.get("region")
      })
    } catch {
    }
  }

  const identities = rows(data.domains).flatMap(domain => rows(domain.identities).map(identity => ({
    ...identity,
    domain: domain.domain
  })));
  return <div className="space-y-5"><Panel title="Create routing policy"
                                           description="Priority and weighted target selection">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Name<input name="name"
                                                                                                      required
                                                                                                      className={input}/></label><label
      className={label}>Product<select name="productId" className={input}>
      <option value="">Any</option>
      {rows(data.products).map(p => <option key={value(p, "id")} value={value(p, "id")}>{value(p, "name")}</option>)}
    </select></label><label className={label}>Service<select name="serviceId" className={input}>
      <option value="">Any</option>
      {rows(data.services).map(s => <option key={value(s, "id")}
                                            value={value(s, "id")}>{value(s, "product")} / {value(s, "name")}</option>)}
    </select></label><label className={label}>Template<select name="templateId" className={input}>
      <option value="">Any</option>
      {rows(data.templates).map(t => <option key={value(t, "id")} value={value(t, "id")}>{value(t, "key")}</option>)}
    </select></label><label className={label}>Category<input name="category" className={input}/></label><label
      className={label}>Destination region<input name="region" className={input}/></label><label className={label}>Provider
      identity<select name="identityId" required className={input}>{identities.map(i => <option key={value(i, "id")}
                                                                                                value={value(i, "id")}>{value(i, "account")} / {String(i.domain)} / {value(i, "status")}</option>)}</select></label><label
      className={label}>Policy priority<input name="policyPriority" type="number" defaultValue="100" className={input}/></label><label
      className={label}>Target priority<input name="targetPriority" type="number" defaultValue="100" className={input}/></label><label
      className={label}>Weight<input name="weight" type="number" min="1" defaultValue="100"
                                     className={input}/></label><label className={label}>Rate limit / minute<input
      name="rateLimit" type="number" min="1" defaultValue="1000" className={input}/></label>
      <div className="flex items-end"><Submit pending={create.pending} labelText="Create policy"/></div>
    </form>
    <Notice text={create.notice}/></Panel><Panel title="Route simulator"
                                                 description="Read-only deterministic eligibility inspection">
    <form onSubmit={simulateSubmit} className="grid gap-3 md:grid-cols-4"><label className={label}>Product<select
      name="productId" className={input}>
      <option value="">Any</option>
      {rows(data.products).map(p => <option key={value(p, "id")} value={value(p, "id")}>{value(p, "name")}</option>)}
    </select></label><label className={label}>Category<input name="category" className={input}/></label><label
      className={label}>Region<input name="region" className={input}/></label>
      <div className="flex items-end"><Submit pending={simulate.pending} labelText="Simulate"/></div>
    </form>
    <Notice text={simulate.notice}/></Panel>{rows(data.policies).map(p => <section key={value(p, "id")}
                                                                                   className="rounded-lg border border-zinc-800 bg-[#090909] p-5">
    <div className="flex items-center justify-between"><h2 className="text-sm text-zinc-200">{value(p, "name")}</h2>
      <div className="flex items-center gap-2"><span
        className="text-xs text-zinc-600">Priority {value(p, "priority")}</span><Button body={{
        action: "routing.toggle",
        id: p.id,
        enabled: p.status !== "active"
      }}>{p.status === "active" ? "Disable" : "Enable"}</Button></div>
    </div>
    <p
      className="mt-2 text-xs text-zinc-600">{value(p, "product") || "Any product"} / {value(p, "service") || "Any service"} / {value(p, "template") || value(p, "message_category") || "Any message"}</p>
    <div className="mt-4 space-y-2">{rows(p.targets).map(t => <div key={value(t, "id")}
                                                                   className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 text-xs">
      <span className="text-zinc-300">{value(t, "account")}</span><span
      className="font-mono text-zinc-600">{value(t, "domain")}</span><span
      className="text-zinc-600">P{value(t, "priority")} W{value(t, "weight")}</span><span
      className="ml-auto text-zinc-500">{value(t, "status")}</span></div>)}</div>
  </section>)}</div>
}

function Credentials({ data }: { data: Data }) {
  const action = useAction();
  const [key, setKey] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      const result = await action.run({
        action: "credential.create",
        productId: d.get("productId"),
        serviceName: d.get("serviceName")
      }) as { key?: string };
      setKey(result?.key ?? "")
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Issue service credential"
                                           description="The plaintext key is shown once">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Product<select
      name="productId" className={input}>{rows(data.products).map(p => <option key={value(p, "id")}
                                                                               value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
      className={label}>Service name<input name="serviceName" required className={input}/></label>
      <div className="flex items-end"><Submit pending={action.pending} labelText="Issue credential"/></div>
    </form>
    {key && <Secret value={key}/>}<Notice text={action.notice}/></Panel><Table
    headers={["Service", "Product", "Prefix", "Last used", "Status", "Actions"]}>{rows(data.credentials).map(c => <tr
    key={value(c, "id")} className="border-b border-zinc-900">
    <Cell>{value(c, "service")}</Cell><Cell>{value(c, "product")}</Cell><Cell
    mono>{value(c, "key_prefix")}...</Cell><Cell>{date(c.last_used_at)}</Cell><Cell>{value(c, "status")}</Cell><Cell>
    <div className="flex gap-2"><Button body={{ action: "credential.rotate", id: c.id }}><RotateCcw
      size={13}/>Rotate</Button><Button danger confirmText="Revoke this credential immediately?"
                                        body={{ action: "credential.revoke", id: c.id }}><Trash2
      size={13}/>Revoke</Button></div>
  </Cell></tr>)}</Table></div>
}

function Secret({ value: secret }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="mt-3 flex items-center rounded-md border border-amber-900/50 bg-amber-950/20 p-3"><code
    className="min-w-0 flex-1 break-all text-xs text-amber-200">{secret}</code>
    <button type="button" onClick={async () => {
      await navigator.clipboard.writeText(secret);
      setCopied(true)
    }} className="ml-2 text-amber-300">{copied ? <Check size={14}/> : <Clipboard size={14}/>}</button>
  </div>
}

function RotateCallback({ id }: { id: string }) {
  const action = useAction();
  const [secret, setSecret] = useState("");
  return <details>
    <summary className="cursor-pointer text-xs text-zinc-500">Secret</summary>
    <div className="mt-2 w-64"><input type="password" value={secret} onChange={e => setSecret(e.target.value)}
                                      minLength={16} placeholder="New signing secret" className={input}/>
      <button type="button" onClick={async () => {
        try {
          await action.run({ action: "callback.rotate_secret", id, secret })
        } catch {
        }
      }}
              className="mt-2 inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300">
        <RotateCcw size={13}/>Rotate secret
      </button>
      <Notice text={action.notice}/></div>
  </details>
}

function Callbacks({ data }: { data: Data }) {
  const action = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "callback.create",
        serviceId: d.get("serviceId"),
        name: d.get("name"),
        url: d.get("url"),
        secret: d.get("secret"),
        events: ["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received"]
      })
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Add callback endpoint"
                                           description="Canonical events with HMAC signatures">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><label className={label}>Service<select
      name="serviceId" className={input}>{rows(data.services).map(s => <option key={value(s, "id")}
                                                                               value={value(s, "id")}>{value(s, "product")} / {value(s, "name")}</option>)}</select></label><label
      className={label}>Name<input name="name" required className={input}/></label><label className={label}>URL<input
      name="url" type="url" required className={input}/></label><label className={label}>Signing secret<input
      name="secret" minLength={16} required className={input}/></label>
      <div className="md:col-span-2"><Submit pending={action.pending} labelText="Add endpoint"/><Notice
        text={action.notice}/></div>
    </form>
  </Panel>
    <div className="flex justify-end"><Button body={{ action: "callback.replay_dlq" }}><RotateCcw size={13}/>Replay dead
      letters</Button></div>
    <Table headers={["Endpoint", "Service", "URL", "Events", "DLQ", "Actions"]}
           min="980px">{rows(data.callbacks).map(c => <tr key={value(c, "id")} className="border-b border-zinc-900">
      <Cell>{value(c, "name")}
        <div className="mt-1 text-zinc-700">{value(c, "status")}</div>
      </Cell><Cell>{value(c, "product")} / {value(c, "service")}</Cell><Cell
      mono>{value(c, "url")}</Cell><Cell>{Array.isArray(c.subscribed_events) ? c.subscribed_events.length : 0}</Cell><Cell>{value(c, "dead_letters")}</Cell><Cell>
      <div className="flex items-start gap-2"><Button body={{ action: "callback.test", id: c.id }}><Send size={13}/>Test</Button><Button
        body={{
          action: "callback.toggle",
          id: c.id,
          enabled: c.status !== "active"
        }}>{c.status === "active" ? "Disable" : "Enable"}</Button><RotateCallback id={value(c, "id")}/></div>
    </Cell></tr>)}</Table><h2 className="pt-3 text-sm font-medium text-zinc-200">Provider ingress endpoints</h2><Table
      headers={["Provider", "Account", "Opaque endpoint", "Status", "Created", "Actions"]}
      min="1040px">{rows(data.webhooks).map(w => <tr key={value(w, "id")} className="border-b border-zinc-900">
      <Cell>{value(w, "type")}</Cell><Cell>{value(w, "account")}</Cell><Cell
      mono>/api/provider-events/{value(w, "type")}/{value(w, "opaque_token")}</Cell><Cell>{value(w, "status")}</Cell><Cell>{date(w.created_at)}</Cell><Cell>
      <div className="flex items-start gap-2"><Button body={{
        action: "webhook.toggle",
        id: w.id,
        enabled: w.status !== "active"
      }}>{w.status === "active" ? "Disable" : "Enable"}</Button><RotateWebhook id={value(w, "id")}/></div>
    </Cell></tr>)}</Table></div>
}

function Events({ data }: { data: Data }) {
  return <div className="space-y-6">
    <section><h2 className="mb-3 text-sm font-medium text-zinc-200">Raw provider events</h2><Table
      headers={["Native type", "Account", "Provider event ID", "Verification", "Received", "Processing", "Action"]}
      min="980px">{rows(data.rawEvents).map(e => <tr key={value(e, "id")} className="border-b border-zinc-900"><Cell
      mono>{value(e, "native_type")}</Cell><Cell>{value(e, "account")} <span
      className="text-zinc-700">({value(e, "type")})</span></Cell><Cell
      mono>{value(e, "provider_event_id")}</Cell><Cell>{e.signature_valid && e.replay_valid ? "Verified" : "Rejected"}</Cell><Cell>{date(e.received_at)}</Cell><Cell>{e.processing_error ?
      <span
        className="text-red-400">{value(e, "processing_error")}</span> : e.processed_at ? "Processed" : "Pending"}</Cell><Cell><Button
      body={{ action: "event.replay", id: e.id }}><RotateCcw size={13}/>Replay</Button></Cell></tr>)}</Table></section>
    <section><h2 className="mb-3 text-sm font-medium text-zinc-200">Canonical delivery events</h2><Table
      headers={["Type", "Recipient", "Occurred", "Canonical payload"]} min="900px">{rows(data.canonicalEvents).map(e =>
      <tr key={value(e, "id")} className="border-b border-zinc-900"><Cell
        mono>{value(e, "event_type")}</Cell><Cell>{value(e, "recipient_email")}</Cell><Cell>{date(e.occurred_at)}</Cell><Cell
        mono><span className="line-clamp-2">{JSON.stringify(e.canonical_payload)}</span></Cell></tr>)}</Table></section>
  </div>
}

function Suppressions({ data }: { data: Data }) {
  const action = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "suppression.create",
        email: d.get("email"),
        scope: d.get("scope"),
        productId: d.get("productId"),
        listId: d.get("listId"),
        reason: d.get("reason")
      })
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Add suppression" description="Global, product, or list scope">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Email<input name="email"
                                                                                                       type="email"
                                                                                                       required
                                                                                                       className={input}/></label><label
      className={label}>Scope<select name="scope" className={input}>
      <option value="global">Global</option>
      <option value="product">Product</option>
      <option value="list">List</option>
    </select></label><label className={label}>Product<select name="productId" className={input}>
      <option value="">None</option>
      {rows(data.products).map(p => <option key={value(p, "id")} value={value(p, "id")}>{value(p, "name")}</option>)}
    </select></label><label className={label}>List ID<input name="listId" className={input}/></label><label
      className={label}>Reason<input name="reason" required defaultValue="manual" className={input}/></label>
      <div className="flex items-end"><Submit pending={action.pending} labelText="Add suppression"/></div>
    </form>
    <Notice text={action.notice}/></Panel><Table
    headers={["Email", "Scope", "Reason", "Source", "Expires", "Action"]}>{rows(data.suppressions).map(s => <tr
    key={value(s, "id")} className="border-b border-zinc-900">
    <Cell>{value(s, "email_normalized")}</Cell><Cell>{value(s, "scope_type")} {value(s, "product")}</Cell><Cell>{value(s, "reason")}</Cell><Cell>{value(s, "source")}</Cell><Cell>{s.expires_at ? date(s.expires_at) : "Permanent"}</Cell><Cell><Button
    danger body={{ action: "suppression.remove", id: s.id }}><Trash2 size={13}/>Remove</Button></Cell></tr>)}</Table>
  </div>
}

function Inbound({ data }: { data: Data }) {
  const action = useAction();
  const items = rows(data.inbound);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "inbound_route.create",
        webhookEndpointId: d.get("webhookEndpointId"),
        domainId: d.get("domainId"),
        productId: d.get("productId"),
        serviceId: d.get("serviceId"),
        callbackId: d.get("callbackId"),
        localPartPattern: d.get("localPartPattern")
      })
    } catch {
    }
  }

  return <div className="space-y-6"><Panel title="Create inbound route"
                                           description="Route provider ingress by domain and local part">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Provider endpoint<select
      name="webhookEndpointId" className={input}>{rows(data.webhooks).map(w => <option key={value(w, "id")}
                                                                                       value={value(w, "id")}>{value(w, "account")} / {value(w, "type")}</option>)}</select></label><label
      className={label}>Inbound domain<select name="domainId"
                                              className={input}>{rows(data.domains).filter(d => d.inbound_enabled && d.status === "active").map(d =>
      <option key={value(d, "id")} value={value(d, "id")}>{value(d, "domain")}</option>)}</select></label><label
      className={label}>Local-part pattern<input name="localPartPattern" required defaultValue="*"
                                                 className={input}/></label><label className={label}>Product<select
      name="productId" className={input}>{rows(data.products).map(p => <option key={value(p, "id")}
                                                                               value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
      className={label}>Service<select name="serviceId" className={input}>
      <option value="">None</option>
      {rows(data.services).map(s => <option key={value(s, "id")} value={value(s, "id")}>{value(s, "name")}</option>)}
    </select></label><label className={label}>Callback<select name="callbackId" className={input}>
      <option value="">None</option>
      {rows(data.callbacks).map(c => <option key={value(c, "id")} value={value(c, "id")}>{value(c, "name")}</option>)}
    </select></label>
      <div className="md:col-span-3"><Submit pending={action.pending} labelText="Create route"/><Notice
        text={action.notice}/></div>
    </form>
  </Panel>
    <section><h2 className="mb-3 text-sm font-medium text-zinc-200">Inbound routes</h2><Table
      headers={["Pattern", "Domain", "Product", "Service", "Provider", "Callback", "Status", "Action"]}>{rows(data.inboundRoutes).map(r =>
      <tr key={value(r, "id")} className="border-b border-zinc-900"><Cell
        mono>{value(r, "local_part_pattern")}@{value(r, "domain")}</Cell><Cell>{value(r, "domain")}</Cell><Cell>{value(r, "product")}</Cell><Cell>{value(r, "service") || "None"}</Cell><Cell>{value(r, "provider_type")}</Cell><Cell>{value(r, "callback") || "None"}</Cell><Cell>{value(r, "status")}</Cell><Cell><Button
        body={{
          action: "inbound_route.toggle",
          id: r.id,
          enabled: r.status !== "active"
        }}>{r.status === "active" ? "Disable" : "Enable"}</Button></Cell></tr>)}</Table></section>
    <section><h2 className="mb-3 text-sm font-medium text-zinc-200">Inbound messages</h2>{items.length ?
      <Table headers={["From", "To", "Subject", "Product", "Attachments", "Status", "Received"]}>{items.map(i => <tr
        key={value(i, "id")} className="border-b border-zinc-900">
        <Cell>{value(i, "from_email")}</Cell><Cell>{Array.isArray(i.to_emails) ? i.to_emails.join(", ") : ""}</Cell><Cell>{value(i, "subject")}</Cell><Cell>{value(i, "product")}</Cell><Cell>{value(i, "attachment_count")}</Cell><Cell>{value(i, "status")}</Cell><Cell>{date(i.received_at)}</Cell>
      </tr>)}</Table> : <Empty text="No inbound messages have been received."/>}</section>
  </div>
}

function Logs({ data }: { data: Data }) {
  return <div className="space-y-6">
    <section><h2 className="mb-3 text-sm font-medium text-zinc-200">Audit log</h2><Table
      headers={["Actor", "Action", "Resource", "Details", "Time"]} min="900px">{rows(data.audit).map(a => <tr
      key={value(a, "id")} className="border-b border-zinc-900"><Cell>{value(a, "actor")}</Cell><Cell
      mono>{value(a, "action")}</Cell><Cell>{value(a, "resource_type")} / {value(a, "resource_id")}</Cell><Cell
      mono>{JSON.stringify(a.details)}</Cell><Cell>{date(a.created_at)}</Cell></tr>)}</Table></section>
    <section><h2 className="mb-3 text-sm font-medium text-zinc-200">Configuration revisions</h2><Table
      headers={["Resource", "Revision", "Actor", "Time", "Snapshot"]} min="900px">{rows(data.revisions).map(r => <tr
      key={value(r, "id")} className="border-b border-zinc-900">
      <Cell>{value(r, "resource_type")} / {value(r, "resource_id")}</Cell><Cell>{value(r, "revision")}</Cell><Cell>{value(r, "actor")}</Cell><Cell>{date(r.created_at)}</Cell><Cell
      mono>{JSON.stringify(r.config)}</Cell></tr>)}</Table></section>
  </div>
}

function Settings({ data }: { data: Data }) {
  const action = useAction();
  const settings = (data.settings ?? {}) as Row;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "settings.update",
        settings: {
          workspace_name: d.get("workspace_name"),
          default_environment: d.get("default_environment"),
          event_retention_days: Number(d.get("event_retention_days")),
          content_retention_days: Number(d.get("content_retention_days"))
        }
      })
    } catch {
    }
  }

  return <form onSubmit={submit}
               className="max-w-3xl divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-[#090909]">{[["workspace_name", "Workspace name"], ["default_environment", "Default environment"], ["event_retention_days", "Event retention days"], ["content_retention_days", "Message content retention days"]].map(([key, title]) =>
    <label key={key} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center"><span
      className="flex-1 text-sm text-zinc-300">{title}</span><input name={key}
                                                                    defaultValue={String(settings[key] ?? "")}
                                                                    type={key.includes("days") ? "number" : "text"}
                                                                    className={`${input} sm:w-64`}/></label>)}
    <div className="p-5"><Submit pending={action.pending} labelText="Save settings"/><Notice text={action.notice}/>
    </div>
  </form>
}

export function AdminConsole({ section, data }: { section: string; data: Data }) {
  if (section === "providers") return <Providers data={data}/>;
  if (section === "domains") return <Domains data={data}/>;
  if (section === "senders") return <Senders data={data}/>;
  if (section === "routing") return <Routing data={data}/>;
  if (section === "api-keys") return <Credentials data={data}/>;
  if (section === "webhooks") return <Callbacks data={data}/>;
  if (section === "events") return <Events data={data}/>;
  if (section === "suppressions") return <Suppressions data={data}/>;
  if (section === "inbound") return <Inbound data={data}/>;
  if (section === "logs") return <Logs data={data}/>;
  if (section === "settings") return <Settings data={data}/>;
  return <Empty text="Unknown section."/>
}

export function RetryDeliveryButton({ id, unknown }: { id: string; unknown: boolean }) {
  return <Button body={{ action: "delivery.retry", id, acknowledgeDuplicateRisk: unknown }}
                 confirmText={unknown ? "The provider outcome is unknown. Retrying may send a duplicate. Accept the risk and continue?" : "Retry this delivery?"}>{unknown ?
    <ShieldAlert size={13}/> : <RotateCcw size={13}/>}Manual retry</Button>
}
