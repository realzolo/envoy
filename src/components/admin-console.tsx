"use client";

import {
  Check,
  Clipboard,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { ProviderAccounts } from "@/components/provider-accounts";

type Row = Record<string, unknown>;
type Data = Record<string, unknown>;
const input = "h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300 outline-none focus:border-zinc-600";
const label = "space-y-1.5 text-xs text-zinc-500";
const rows = (value: unknown) => Array.isArray(value) ? value as Row[] : [];
const value = (row: Row, key: string) => String(row[key] ?? "");
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
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

function Panel({ title, description, children, defaultOpen = false }: {
  title: string;
  description: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return <details open={defaultOpen} className="rounded-lg border border-zinc-800 bg-[#090909]">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-zinc-200"><Plus
      size={14}/>{title}<span className="ml-auto text-xs text-zinc-600">{description}</span></summary>
    <div className="border-t border-zinc-800 p-4">{children}</div>
  </details>
}

function Submit({ pending, labelText, disabled = false }: { pending: boolean; labelText: string; disabled?: boolean }) {
  return <button disabled={pending || disabled}
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

function Prerequisite({ title, description, href, action }: {
  title: string;
  description: string;
  href: string;
  action: string;
}) {
  return <section className="border-y border-zinc-800 px-1 py-12 text-center">
    <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-500">{description}</p>
    <Link href={href} className="mt-5 inline-flex h-9 items-center rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950">
      {action}
    </Link>
  </section>
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

function CopyableValue({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return <span className="text-zinc-700">Not reported</span>;
  return <span className="flex min-w-0 items-center gap-1.5">
    <code className="min-w-0 break-all font-mono text-[11px] text-zinc-400">{text}</code>
    <button type="button" title={`Copy ${label}`} aria-label={`Copy ${label}`} onClick={async () => {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600)
    }} className="flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-900 hover:text-zinc-200">
      {copied ? <Check size={13}/> : <Clipboard size={13}/>}
    </button>
  </span>
}

function DnsRecords({ records }: { records: unknown }) {
  const entries = rows(records).map(item => {
    const dns = record(item);
    return {
      type: value(dns, "type"),
      name: value(dns, "name"),
      dnsValue: value(dns, "value"),
      status: value(dns, "status")
    }
  }).filter(item => item.type || item.name || item.dnsValue);
  if (!entries.length) return null;
  return <div className="mt-4 overflow-hidden rounded-md border border-zinc-800">
    <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left">
      <thead><tr className="border-b border-zinc-800 text-[10px] uppercase text-zinc-600"><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Value</th><th className="px-3 py-2 font-medium">Status</th></tr></thead>
      <tbody>{entries.map(entry => <tr key={`${entry.type}:${entry.name}:${entry.dnsValue}`} className="border-b border-zinc-900 last:border-0"><td className="px-3 py-2 text-[11px] text-zinc-300">{entry.type || "DNS"}</td><td className="px-3 py-2"><CopyableValue text={entry.name} label="DNS name"/></td><td className="px-3 py-2"><CopyableValue text={entry.dnsValue} label="DNS value"/></td><td className="px-3 py-2 text-[11px] text-zinc-500">{entry.status || "Not reported"}</td></tr>)}</tbody>
    </table></div>
  </div>
}

function routingReason(reason: string) {
  const labels: Record<string, string> = {
    circuit_open: "Temporarily paused after recent failures",
    account_unavailable: "Provider account is unavailable",
    account_unhealthy: "Provider connection is unhealthy",
    identity_unverified: "Provider identity is not verified",
    domain_disabled: "Sending domain is disabled",
    monthly_quota_exhausted: "Monthly provider limit reached",
    daily_quota_exhausted: "Daily provider limit reached"
  };
  return labels[reason] ?? reason.replaceAll("_", " ")
}

function RoutingSimulation({ result }: { result: Row | null }) {
  if (!result) return null;
  const chosen = record(result.chosen);
  const rejected = rows(result.candidates).filter(candidate => candidate.eligible !== true);
  const selectedAccount = value(chosen, "account") || value(chosen, "provider_name");
  const selectedDomain = value(chosen, "domain");
  return <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
    <p className="text-xs text-zinc-300">{selectedAccount ? <>Selected <span className="font-medium text-zinc-100">{selectedAccount}</span>{selectedDomain ? <> for <span className="font-mono text-zinc-200">{selectedDomain}</span></> : null}.</> : "No eligible routing target was found."}</p>
    {rejected.length > 0 && <ul className="mt-3 space-y-1.5 text-[11px] text-zinc-500">{rejected.map(candidate => {
      const reasons = rows(record(candidate).reasons).map(String).map(routingReason);
      return <li key={value(candidate, "target_id")}><span className="text-zinc-400">{value(candidate, "account") || "Provider target"}</span>{reasons.length ? `: ${reasons.join(", ")}` : ": Not eligible"}</li>
    })}</ul>}
  </div>
}

function Providers({ data }: { data: Data }) {
  return <ProviderAccounts data={data}/>
}

function Domains({ data }: { data: Data }) {
  const action = useAction();
  const [draftDomain, setDraftDomain] = useState("");
  const domains = rows(data.domains);
  const descriptors = rows(data.descriptors);
  const managedTypes = new Set(descriptors.filter(item => record(item.capabilities).domainManagement === true).map(item => value(item, "type")));
  const providers = rows(data.providers).filter(provider => provider.status === "active");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const d = new FormData(event.currentTarget);
    try {
      await action.run({
        action: "domain.create",
        domain: d.get("domain"),
        accountIds: d.getAll("accountIds")
      })
    } catch {
    }
  }

  if (!providers.length) return <Prerequisite title="Connect a provider account"
                                               description="Add an active provider account before associating a sending domain."
                                               href="/providers" action="Manage provider accounts"/>;

  return <div className="space-y-5"><Panel title="Add sending domain"
                                           description="Provision or associate identities on selected providers" defaultOpen={!domains.length}>
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={`${label} md:col-span-3`}>Domain<input name="domain"
                                                                                                        required
                                                                                                        value={draftDomain}
                                                                                                        onChange={event => setDraftDomain(event.target.value)}
                                                                                                        placeholder="mail.example.com"
                                                                                                        className={input}/></label>
      <fieldset className="md:col-span-3">
        <legend className="mb-2 text-xs text-zinc-500">Provider accounts</legend>
        <p className="mb-2 text-[11px] leading-4 text-zinc-600">Resend and Amazon SES create the provider identity and show DNS records. For SendGrid, Mailgun, and Postmark, select only an account where this domain is already verified in its official dashboard. A Mailgun account can use only its configured sending domain.</p><div className="flex flex-wrap gap-3">{providers.map(p => {
          const type = value(p, "type");
          const mailgunDomain = type === "mailgun" ? String(record(p.public_config).sendingDomain ?? "").toLowerCase() : "";
          const incompatibleMailgunDomain = Boolean(mailgunDomain && draftDomain.trim() && mailgunDomain !== draftDomain.trim().toLowerCase());
          return <label key={value(p, "id")} className={`flex items-center gap-2 text-xs ${incompatibleMailgunDomain ? "text-zinc-700" : "text-zinc-300"}`}><input type="checkbox"
            name="accountIds"
            disabled={incompatibleMailgunDomain}
            value={value(p, "id")}/>{value(p, "name")} <span className="text-zinc-600">{incompatibleMailgunDomain ? `(uses ${mailgunDomain})` : managedTypes.has(type) ? "(Envoy-managed)" : "(Already verified)"}</span>
          </label>
        })}</div>
      </fieldset>
      <div className="md:col-span-3"><Submit pending={action.pending} labelText="Create domain and identities"/><Notice
        text={action.notice}/></div>
    </form>
  </Panel>{domains.map(domain => <section key={value(domain, "id")}
                                          className="rounded-lg border border-zinc-800 bg-[#090909] p-5">
    <div className="flex flex-wrap items-center gap-3"><h2
      className="font-mono text-sm text-zinc-200">{value(domain, "domain")}</h2><span className="ml-auto"><Button body={{
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
      <div className="mt-3 flex flex-wrap gap-2">{managedTypes.has(value(identity, "type")) ? <Button
        body={{ action: "identity.refresh", id: identity.id }}><RefreshCw size={13}/>Refresh DNS</Button> : <span className="inline-flex h-8 items-center text-xs text-zinc-600">Verified in provider dashboard</span>}<Button body={{
        action: "identity.toggle",
        id: identity.id,
        enabled: identity.status === "disabled"
      }}>{identity.status === "disabled" ? "Enable" : "Disable"}</Button></div>
      <DnsRecords records={identity.dnsRecords}/>
    </div>)}</div>
  </section>)}</div>
}

function Senders({ data }: { data: Data }) {
  const action = useAction();
  const products = rows(data.products).filter(product => product.status === "active");
  const domains = rows(data.domains).filter(domain => domain.status === "active" && rows(domain.identities).some(identity => identity.status === "verified" && identity.accountStatus === "active"));
  const senders = rows(data.senders);

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

  if (!products.length || !domains.length) return <Prerequisite title="Create the sender prerequisites"
                                                                  description={products.length ? "Verify a sending domain before creating a sender profile." : "Create a product and verify a sending domain before creating a sender profile."}
                                                                  href={products.length ? "/domains" : "/api-keys"}
                                                                  action={products.length ? "Manage domains" : "Create a product"}/>;

  return <div className="space-y-5"><Panel title="Create sender profile"
                                           description="Visible From identity resolved before queuing" defaultOpen={!senders.length}>
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Product<select
      name="productId" className={input}>{products.map(p => <option key={value(p, "id")}
                                                                               value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
      className={label}>Domain<select name="domainId" className={input}>{domains.map(d => <option
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
    headers={["Profile", "Product", "From", "Category", "Status", "Action"]}>{senders.map(s => <tr
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
  const [simulationResult, setSimulationResult] = useState<Row | null>(null);
  const domains = rows(data.domains);
  const eligibleDomains = domains.filter(domain => domain.status === "active" && rows(domain.identities).some(identity => identity.status === "verified" && identity.accountStatus === "active"));
  const [domainId, setDomainId] = useState(() => value(eligibleDomains[0] ?? {}, "id"));
  const selectedDomainId = eligibleDomains.some(domain => value(domain, "id") === domainId) ? domainId : value(eligibleDomains[0] ?? {}, "id");
  const selectedDomain = eligibleDomains.find(domain => value(domain, "id") === selectedDomainId);
  const eligibleIdentities = rows(selectedDomain?.identities).filter(identity => identity.status === "verified" && identity.accountStatus === "active");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const selectedDomainId = String(d.get("domainId"));
    const identityId = String(d.get("identityId"));
    const identity = rows(domains.find(domain => value(domain, "id") === selectedDomainId)?.identities).find(item => item.id === identityId);
    try {
      await create.run({
        action: "routing.create",
        name: d.get("name"),
        productId: d.get("productId"),
        serviceId: d.get("serviceId"),
        domainId: selectedDomainId,
        category: d.get("category"),
        targets: [{
          accountId: identity?.accountId,
          identityId
        }]
      })
    } catch {
    }
  }

  async function simulateSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      const result = await simulate.run({
        action: "routing.simulate",
        domainId: d.get("domainId"),
        productId: d.get("productId"),
        serviceId: d.get("serviceId"),
        category: d.get("category")
      });
      setSimulationResult(record(result))
    } catch {
      setSimulationResult(null)
    }
  }

  const policies = rows(data.policies);
  if (!eligibleDomains.length) return <Prerequisite title="Verify a provider identity first"
                                                        description="A routing policy can only target a verified domain identity."
                                                        href="/domains" action="Manage domains"/>;

  return <div className="space-y-5"><Panel title="Create routing policy"
                                           description="Match a verified identity to a sending domain" defaultOpen={!policies.length}>
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
    </select></label><label className={label}>Sending domain<select name="domainId" value={selectedDomainId} onChange={event => setDomainId(event.target.value)} required className={input}>{eligibleDomains.map(domain => <option key={value(domain, "id")} value={value(domain, "id")}>{value(domain, "domain")}</option>)}</select></label><label className={label}>Category<input name="category" className={input}/></label><label className={label}>Provider
      identity<select key={selectedDomainId} name="identityId" required className={input}>{eligibleIdentities.map(i => <option key={value(i, "id")}
                                                                                                value={value(i, "id")}>{value(i, "account")} / {value(i, "status")}</option>)}</select></label>
      <div className="flex items-end"><Submit pending={create.pending} labelText="Create policy"/></div>
    </form>
    <Notice text={create.notice}/></Panel><Panel title="Route simulator"
                                                 description="Read-only deterministic eligibility inspection">
    <form onSubmit={simulateSubmit} className="grid gap-3 md:grid-cols-3"><label className={label}>Sending domain<select name="domainId" value={selectedDomainId} onChange={event => setDomainId(event.target.value)} required className={input}>{eligibleDomains.map(domain => <option key={value(domain, "id")} value={value(domain, "id")}>{value(domain, "domain")}</option>)}</select></label><label className={label}>Product<select
      name="productId" className={input}>
      <option value="">Any</option>
      {rows(data.products).map(p => <option key={value(p, "id")} value={value(p, "id")}>{value(p, "name")}</option>)}
    </select></label><label className={label}>Service<select name="serviceId" className={input}>
      <option value="">Any</option>
      {rows(data.services).map(s => <option key={value(s, "id")} value={value(s, "id")}>{value(s, "product")} / {value(s, "name")}</option>)}
    </select></label><label className={label}>Category<input name="category" className={input}/></label>
      <div className="flex items-end"><Submit pending={simulate.pending} labelText="Simulate"/></div>
    </form>
    <RoutingSimulation result={simulationResult}/><Notice text={simulate.notice.startsWith("{") ? "" : simulate.notice}/></Panel>{policies.map(p => <section key={value(p, "id")}
                                                                                   className="rounded-lg border border-zinc-800 bg-[#090909] p-5">
    <div className="flex items-center justify-between"><h2 className="text-sm text-zinc-200">{value(p, "name")}</h2>
      <div className="flex items-center gap-2"><Button body={{
        action: "routing.toggle",
        id: p.id,
        enabled: p.status !== "active"
      }}>{p.status === "active" ? "Disable" : "Enable"}</Button></div>
    </div>
    <p
      className="mt-2 text-xs text-zinc-600">{value(p, "sending_domain")} / {value(p, "product") || "Any product"} / {value(p, "service") || "Any service"} / {value(p, "message_category") || "Any category"}</p>
    <div className="mt-4 space-y-2">{rows(p.targets).map(t => <div key={value(t, "id")}
                                                                   className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 text-xs">
      <span className="text-zinc-300">{value(t, "account")}</span><span
      className="font-mono text-zinc-600">{value(t, "domain")}</span><span
      className="ml-auto text-zinc-500">{value(t, "status")}</span></div>)}</div>
  </section>)}</div>
}

function Credentials({ data }: { data: Data }) {
  const action = useAction();
  const productAction = useAction();
  const [key, setKey] = useState("");
  const products = rows(data.products);
  const activeProducts = products.filter(product => product.status === "active");
  const credentials = rows(data.credentials);

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const d = new FormData(form);
    try {
      await productAction.run({ action: "product.create", name: d.get("name") });
      form.reset()
    } catch {
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      setKey("");
      const result = await action.run({
        action: "credential.create",
        productId: d.get("productId"),
        serviceName: d.get("serviceName")
      }) as { key?: string };
      setKey(result?.key ?? "")
    } catch {
    }
  }

  async function rotate(id: string) {
    try {
      setKey("");
      const result = await action.run({ action: "credential.rotate", id }) as { key?: string };
      setKey(result.key ?? "");
      action.setNotice("Credential rotated. Copy the replacement key below.")
    } catch {
    }
  }

  return <div className="space-y-5">
    <Panel title="Create product" description="A product owns its services, senders, and delivery rules." defaultOpen={!products.length}>
      <form onSubmit={createProduct} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"><label className={label}>Name<input name="name"
                                                                                                               required
                                                                                                               className={input}/></label>
        <div className="flex items-end"><Submit pending={productAction.pending} labelText="Create product"/></div>
      </form>
      <Notice text={productAction.notice}/>
    </Panel>
    {products.length ? <Table headers={["Product", "Status", "Action"]} min="440px">{products.map(product => <tr
      key={value(product, "id")} className="border-b border-zinc-900"><Cell>{value(product, "name")}</Cell><Cell>{value(product, "status")}</Cell><Cell><Button body={{
      action: "product.toggle",
      id: product.id,
      enabled: product.status !== "active"
    }}>{product.status === "active" ? "Suspend" : "Activate"}</Button></Cell></tr>)}</Table> :
      <Empty text="No products configured. Create the first product to issue a service credential."/>}
    {activeProducts.length ? <>
      <Panel title="Issue service credential" description="The plaintext key is shown once" defaultOpen={!credentials.length}>
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Product<select
          name="productId" className={input}>{activeProducts.map(p => <option key={value(p, "id")}
                                                                                 value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
          className={label}>Service name<input name="serviceName" required className={input}/></label>
          <div className="flex items-end"><Submit pending={action.pending} labelText="Issue credential"/></div>
        </form>
        {key && <Secret value={key}/>}<Notice text={action.notice}/>
      </Panel>
      <Table headers={["Service", "Product", "Prefix", "Last used", "Status", "Actions"]}>{credentials.map(c => <tr
        key={value(c, "id")} className="border-b border-zinc-900">
        <Cell>{value(c, "service")}</Cell><Cell>{value(c, "product")}</Cell><Cell
        mono>{value(c, "key_prefix")}...</Cell><Cell>{date(c.last_used_at)}</Cell><Cell>{value(c, "status")}</Cell><Cell>
        <div className="flex gap-2"><button type="button" disabled={action.pending} onClick={() => void rotate(value(c, "id"))}
                                             className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-400 hover:bg-zinc-900 disabled:opacity-50">{action.pending ? <LoaderCircle size={13} className="animate-spin"/> : <RotateCcw size={13}/>}Rotate</button><Button danger confirmText="Revoke this credential immediately?"
                                            body={{ action: "credential.revoke", id: c.id }}><Trash2
          size={13}/>Revoke</Button></div>
      </Cell></tr>)}</Table>
    </> : <Prerequisite title="Create an active product first"
                         description="A service credential must be scoped to an active product."
                         href="/api-keys" action="Create product"/>}
  </div>
}

function Secret({ value: secret, label = "Copy this value now. It cannot be shown again." }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="mt-3 rounded-md border border-amber-900/50 bg-amber-950/20 p-3"><p
    className="mb-2 text-[11px] text-amber-300">{label}</p><div className="flex items-center"><code
    className="min-w-0 flex-1 break-all text-xs text-amber-200">{secret}</code>
    <button type="button" title="Copy secret" aria-label="Copy secret" onClick={async () => {
      await navigator.clipboard.writeText(secret);
      setCopied(true)
    }} className="ml-2 flex size-8 shrink-0 items-center justify-center text-amber-300 hover:text-amber-100">{copied ? <Check size={14}/> : <Clipboard size={14}/>}</button></div>
  </div>
}

function RotateCallback({ id }: { id: string }) {
  const action = useAction();
  const [secret, setSecret] = useState("");
  return <details>
    <summary className="cursor-pointer text-xs text-zinc-500">Rotate secret</summary>
    <div className="mt-2 w-64"><p className="text-[11px] leading-4 text-zinc-600">Rotating invalidates the previous signing secret immediately.</p>
      <button type="button" onClick={async () => {
        try {
          const result = await action.run({ action: "callback.rotate_secret", id }) as { secret?: string };
          setSecret(result.secret ?? "");
          action.setNotice("A new signing secret was generated.")
        } catch {
        }
      }}
              className="mt-2 inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300">
        <RotateCcw size={13}/>Rotate secret
      </button>
      {secret && <Secret value={secret}/>}
      <Notice text={action.notice}/></div>
  </details>
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
    ["inbound.received", "Inbound received"]
  ] as const;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      const result = await action.run({
        action: "callback.create",
        serviceId: d.get("serviceId"),
        name: d.get("name"),
        url: d.get("url"),
        events
      }) as { secret?: string };
      setSecret(result.secret ?? "");
      action.setNotice("Callback endpoint created. Copy the generated signing secret below.")
    } catch {
    }
  }

  if (!services.length) return <Prerequisite title="Create an active service first"
                                               description="Callbacks are owned by a service so recipients can identify the product that emitted each event."
                                               href="/api-keys" action="Create a service credential"/>;

  return <div className="space-y-5"><Panel title="Add callback endpoint"
                                           description="Canonical events with HMAC signatures" defaultOpen={!callbacks.length}>
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-2"><label className={label}>Service<select
      name="serviceId" className={input}>{services.map(s => <option key={value(s, "id")}
                                                                               value={value(s, "id")}>{value(s, "product")} / {value(s, "name")}</option>)}</select></label><label
      className={label}>Name<input name="name" required className={input}/></label><label className={label}>URL<input
      name="url" type="url" required placeholder="https://api.example.com/envoy/events" className={input}/></label><fieldset className="space-y-2">
      <legend className="text-xs text-zinc-500">Events</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{eventOptions.map(([event, title]) => <label key={event}
        className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={events.includes(event)} onChange={item => setEvents(current => item.target.checked ? [...current, event] : current.filter(value => value !== event))}/>{title}</label>)}</div>
    </fieldset>
      <div className="md:col-span-2"><Submit pending={action.pending} disabled={!events.length} labelText="Add endpoint"/><Notice
        text={action.notice}/>{secret && <Secret value={secret} label="Generated signing secret. Store it in the callback consumer now."/>}</div>
    </form>
  </Panel>
    <div className="flex justify-end"><Button body={{ action: "callback.replay_dlq" }} confirmText="Replay every dead letter belonging to an active callback endpoint?"><RotateCcw size={13}/>Replay eligible dead
      letters</Button></div>
    <Table headers={["Endpoint", "Service", "URL", "Events", "DLQ", "Actions"]}
           min="980px">{callbacks.map(c => <tr key={value(c, "id")} className="border-b border-zinc-900">
      <Cell>{value(c, "name")}
        <div className="mt-1 text-zinc-700">{value(c, "status")}</div>
      </Cell><Cell>{value(c, "product")} / {value(c, "service")}</Cell><Cell
      mono>{value(c, "url")}</Cell><Cell>{Array.isArray(c.subscribed_events) ? c.subscribed_events.join(", ") : ""}</Cell><Cell>{value(c, "dead_letters")}</Cell><Cell>
      <div className="flex items-start gap-2">{c.status === "active" && <Button body={{ action: "callback.test", id: c.id }}><Send size={13}/>Test</Button>}<Button
        body={{
          action: "callback.toggle",
          id: c.id,
          enabled: c.status !== "active"
        }}>{c.status === "active" ? "Disable" : "Enable"}</Button><RotateCallback id={value(c, "id")}/></div>
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
  const [scope, setScope] = useState<"global" | "product" | "list">("global");
  const products = rows(data.products).filter(product => product.status === "active");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "suppression.create",
        email: d.get("email"),
        scope,
        productId: scope === "global" ? undefined : d.get("productId"),
        listId: scope === "list" ? d.get("listId") : undefined,
        reason: d.get("reason"),
        expiresAt: d.get("expiresAt") ? new Date(String(d.get("expiresAt"))).toISOString() : undefined
      })
    } catch {
    }
  }

  return <div className="space-y-5"><Panel title="Add suppression" description="Global, product, or list scope" defaultOpen={!rows(data.suppressions).length}>
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Email<input name="email"
                                                                                                       type="email"
                                                                                                       required
                                                                                                       className={input}/></label><label
      className={label}>Scope<select name="scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)} className={input}>
      <option value="global">Global</option>
      <option value="product">Product</option>
      <option value="list">List</option>
    </select></label>{scope !== "global" && <label className={label}>Product<select name="productId" required className={input}>
      <option value="">Choose a product</option>
      {products.map(p => <option key={value(p, "id")} value={value(p, "id")}>{value(p, "name")}</option>)}
    </select></label>}{scope === "list" && <label className={label}>List ID<input name="listId" required placeholder="marketing-newsletter" className={input}/></label>}<label
      className={label}>Reason<input name="reason" required defaultValue="manual" className={input}/></label><label className={label}>Expires at <span className="text-zinc-700">(optional)</span><input name="expiresAt" type="datetime-local" className={input}/></label>
      <div className="flex items-end"><Submit pending={action.pending} disabled={scope !== "global" && !products.length} labelText="Add suppression"/></div>
    </form>
    <Notice text={action.notice}/></Panel><Table
    headers={["Email", "Scope", "Reason", "Source", "Expires", "Action"]}>{rows(data.suppressions).map(s => <tr
    key={value(s, "id")} className="border-b border-zinc-900">
    <Cell>{value(s, "email_normalized")}</Cell><Cell>{value(s, "scope_type")} {value(s, "product")}{value(s, "list_id") ? ` / ${value(s, "list_id")}` : ""}</Cell><Cell>{value(s, "reason")}</Cell><Cell>{value(s, "source")}</Cell><Cell>{s.expires_at ? date(s.expires_at) : "Permanent"}</Cell><Cell><Button
    danger body={{ action: "suppression.remove", id: s.id }}><Trash2 size={13}/>Remove</Button></Cell></tr>)}</Table>
  </div>
}

function Inbound({ data }: { data: Data }) {
  const action = useAction();
  const items = rows(data.inbound);
  const endpoints = rows(data.webhooks).filter(endpoint => endpoint.status === "active" && endpoint.security_configured);
  const products = rows(data.products).filter(product => product.status === "active");
  const availableDomains = rows(data.domains).filter(domain => domain.status === "active" && rows(domain.identities).some(identity => identity.status === "verified" && endpoints.some(endpoint => endpoint.provider_account_id === identity.accountId)));
  const initialEndpoint = endpoints.find(endpoint => availableDomains.some(domain => rows(domain.identities).some(identity => identity.status === "verified" && identity.accountId === endpoint.provider_account_id)));
  const [webhookEndpointId, setWebhookEndpointId] = useState(value(initialEndpoint ?? endpoints[0] ?? {}, "id"));
  const [productId, setProductId] = useState(value(products[0] ?? {}, "id"));
  const [serviceId, setServiceId] = useState("");
  const selectedEndpoint = endpoints.find(endpoint => endpoint.id === webhookEndpointId);
  const domains = availableDomains.filter(domain => rows(domain.identities).some(identity => identity.status === "verified" && identity.accountId === selectedEndpoint?.provider_account_id));
  const services = rows(data.services).filter(service => service.product_status === "active" && service.product_id === productId);
  const callbacks = rows(data.callbacks).filter(callback => callback.product_id === productId && callback.service_id === serviceId && callback.status === "active" && Array.isArray(callback.subscribed_events) && callback.subscribed_events.includes("inbound.received"));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    try {
      await action.run({
        action: "inbound_route.create",
        webhookEndpointId,
        domainId: d.get("domainId"),
        productId,
        serviceId: serviceId || undefined,
        callbackId: serviceId ? d.get("callbackId") : undefined,
        localPartPattern: d.get("localPartPattern")
      })
    } catch {
    }
  }

  if (!endpoints.length || !products.length || !availableDomains.length) return <Prerequisite title="Create inbound route prerequisites"
                                                                        description={!endpoints.length ? "Configure event verification on an active provider account before accepting inbound mail." : !availableDomains.length ? "Verify a sending domain with the selected provider account." : "Create an active product before routing inbound mail."}
                                                                        href={!endpoints.length ? "/providers" : !availableDomains.length ? "/domains" : "/api-keys"}
                                                                        action={!endpoints.length ? "Configure provider webhooks" : !availableDomains.length ? "Manage domains" : "Create a product"}/>;

  return <div className="space-y-6"><Panel title="Create inbound route"
                                           description="Route provider ingress by domain and local part" defaultOpen={!rows(data.inboundRoutes).length}>
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3"><label className={label}>Provider endpoint<select
      name="webhookEndpointId" value={webhookEndpointId} onChange={event => setWebhookEndpointId(event.target.value)} className={input}>{endpoints.map(w => <option key={value(w, "id")}
                                                                                       value={value(w, "id")}>{value(w, "account")} / {value(w, "type")}</option>)}</select></label><label
      className={label}>Inbound domain<select name="domainId"
                                              className={input}>{domains.map(d =>
      <option key={value(d, "id")} value={value(d, "id")}>{value(d, "domain")}</option>)}</select></label><label
      className={label}>Local-part pattern<input name="localPartPattern" required defaultValue="*"
                                                 className={input}/></label><label className={label}>Product<select
      name="productId" value={productId} onChange={event => { setProductId(event.target.value); setServiceId("") }} className={input}>{products.map(p => <option key={value(p, "id")}
                                                                               value={value(p, "id")}>{value(p, "name")}</option>)}</select></label><label
      className={label}>Service<select name="serviceId" value={serviceId} onChange={event => setServiceId(event.target.value)} className={input}>
      <option value="">None</option>
      {services.map(s => <option key={value(s, "id")} value={value(s, "id")}>{value(s, "name")}</option>)}
    </select></label><label className={label}>Callback<select key={serviceId} name="callbackId" disabled={!serviceId} className={input}>
      <option value="">{serviceId ? "None" : "Choose a service first"}</option>
      {callbacks.map(c => <option key={value(c, "id")} value={value(c, "id")}>{value(c, "name")}</option>)}
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
  </div>
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
  return <Empty text="Unknown section."/>
}

export function RetryDeliveryButton({ id, unknown }: { id: string; unknown: boolean }) {
  return <Button body={{ action: "delivery.retry", id, acknowledgeDuplicateRisk: unknown }}
                 confirmText={unknown ? "The provider outcome is unknown. Retrying may send a duplicate. Accept the risk and continue?" : "Retry this delivery?"}>{unknown ?
    <ShieldAlert size={13}/> : <RotateCcw size={13}/>}Manual retry</Button>
}
