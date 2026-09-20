"use client";

import { Code2, LoaderCircle, Monitor, Save, Send, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";

type Product = { id: string; name: string };
type EditableTemplate = {
  id?: string;
  key: string;
  name: string;
  description: string;
  category: string;
  subject: string;
  html: string;
  text: string;
  schema: Record<string, string>;
  sampleData: Record<string, unknown>;
  product: string;
  productId?: string
};

const field = "w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300 outline-none focus:border-zinc-600";

async function action(body: Record<string, unknown>) {
  const r = await fetch("/api/admin/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const p = await r.json() as { error?: string; result?: { templateId?: string } };
  if (!r.ok) throw new Error(p.error ?? "Action failed");
  return p.result
}

function interpolate(source: string, values: Record<string, unknown>) {
  return source.replace(/{{\s*([\w.]+)\s*}}/g, (_, key: string) => String(values[key] ?? `{{${key}}}`))
}

export function TemplateEditor({ template, products }: { template: EditableTemplate; products: Product[] }) {
  const router = useRouter();
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [html, setHtml] = useState(template.html);
  const [subject, setSubject] = useState(template.subject);
  const [sampleText, setSampleText] = useState(JSON.stringify(template.sampleData, null, 2));
  const [schemaText, setSchemaText] = useState(JSON.stringify(template.schema, null, 2));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [recipient, setRecipient] = useState("developer@example.com");
  const [source, setSource] = useState(false);
  const sample = useMemo(() => {
    try {
      return JSON.parse(sampleText) as Record<string, unknown>
    } catch {
      return {}
    }
  }, [sampleText]);
  const rendered = useMemo(() => interpolate(html, sample), [html, sample]);

  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setMessage("");
    try {
      const schema = JSON.parse(schemaText);
      const sampleData = JSON.parse(sampleText);
      const d = new FormData(form);
      const result = await action({
        action: "template.publish",
        templateId: template.id,
        productId: d.get("productId"),
        key: d.get("key"),
        name: d.get("name"),
        description: d.get("description"),
        category: d.get("category"),
        subject,
        html,
        text: d.get("text"),
        schema,
        sampleData
      });
      setMessage("Published a new version");
      if (!template.id && result?.templateId) {
        router.push(`/templates/${result.templateId}`)
      } else router.refresh()
    } catch (x) {
      setMessage(x instanceof Error ? x.message : "Publish failed")
    } finally {
      setPending(false)
    }
  }

  async function testSend() {
    if (!template.id) {
      setMessage("Publish the template before sending a test");
      return
    }
    setPending(true);
    setMessage("");
    try {
      await action({ action: "template.test", templateId: template.id, recipient });
      setMessage("Queued the test delivery");
      router.refresh()
    } catch (x) {
      setMessage(x instanceof Error ? x.message : "Test delivery failed")
    } finally {
      setPending(false)
    }
  }

  return <form onSubmit={publish} className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
    <aside className="space-y-4">
      <label className="block text-xs text-zinc-500">Product<select name="productId"
                                                                    defaultValue={template.productId ?? products.find(p => p.name === template.product)?.id}
                                                                    className={`${field} mt-1.5 h-9`}>{products.map(p =>
        <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="block text-xs text-zinc-500">Template key<input name="key" required defaultValue={template.key}
                                                                        placeholder="auth.login-code"
                                                                        className={`${field} mt-1.5 h-9 font-mono`}/></label>
      <label className="block text-xs text-zinc-500">Name<input name="name" required defaultValue={template.name}
                                                                className={`${field} mt-1.5 h-9`}/></label>
      <label className="block text-xs text-zinc-500">Category<input name="category" required
                                                                    defaultValue={template.category}
                                                                    className={`${field} mt-1.5 h-9`}/></label>
      <label className="block text-xs text-zinc-500">Description<textarea name="description"
                                                                          defaultValue={template.description} rows={2}
                                                                          className={`${field} mt-1.5 py-2`}/></label>
      <label className="block text-xs text-zinc-500">Subject<input value={subject}
                                                                   onChange={e => setSubject(e.target.value)} required
                                                                   className={`${field} mt-1.5 h-9`}/></label>
      <label className="block text-xs text-zinc-500">Variable schema<textarea value={schemaText}
                                                                              onChange={e => setSchemaText(e.target.value)}
                                                                              rows={5} spellCheck={false}
                                                                              className={`${field} mt-1.5 py-2 font-mono text-xs`}/></label>
      <label className="block text-xs text-zinc-500">Preview data<textarea value={sampleText}
                                                                           onChange={e => setSampleText(e.target.value)}
                                                                           rows={6} spellCheck={false}
                                                                           className={`${field} mt-1.5 py-2 font-mono text-xs`}/></label>
      <label className="block text-xs text-zinc-500">Plain text body<textarea name="text" defaultValue={template.text}
                                                                              rows={5}
                                                                              className={`${field} mt-1.5 py-2 font-mono text-xs`}/></label>
      <label className="block text-xs text-zinc-500">HTML source<textarea value={html}
                                                                          onChange={e => setHtml(e.target.value)}
                                                                          rows={12} required spellCheck={false}
                                                                          className={`${field} mt-1.5 py-2 font-mono text-xs`}/></label>
      <div className="flex flex-wrap gap-2">
        <button disabled={pending}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 disabled:opacity-50">{pending ?
          <LoaderCircle size={14} className="animate-spin"/> : <Save size={14}/>} Publish new version
        </button>
      </div>
      <div className="border-t border-zinc-800 pt-4"><label className="text-xs text-zinc-500">Test recipient<input
        type="email" value={recipient} onChange={e => setRecipient(e.target.value)} className={`${field} mt-1.5 h-9`}/></label>
        <button type="button" onClick={testSend} disabled={pending}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-800 text-sm text-zinc-300 hover:bg-zinc-900">
          <Send size={14}/>Send test message
        </button>
      </div>
      {message && <p role="status"
                     className={`text-xs ${message.startsWith("Published") || message.startsWith("Queued") ? "text-emerald-400" : "text-red-400"}`}>{message}</p>}
    </aside>
    <section className="overflow-hidden rounded-lg border border-zinc-800 bg-[#090909]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div><p className="text-sm text-zinc-200">{interpolate(subject, sample)}</p><p
          className="mt-1 text-[11px] text-zinc-700">Live preview</p></div>
        <div className="flex items-center gap-1">
          <button type="button" title="Desktop preview" onClick={() => setViewport("desktop")}
                  className={`flex size-8 items-center justify-center rounded-md ${viewport === "desktop" ? "bg-zinc-800 text-white" : "text-zinc-600"}`}>
            <Monitor size={14}/></button>
          <button type="button" title="Mobile preview" onClick={() => setViewport("mobile")}
                  className={`flex size-8 items-center justify-center rounded-md ${viewport === "mobile" ? "bg-zinc-800 text-white" : "text-zinc-600"}`}>
            <Smartphone size={14}/></button>
          <button type="button" title="Toggle source" onClick={() => setSource(!source)}
                  className={`flex size-8 items-center justify-center rounded-md ${source ? "bg-zinc-800 text-white" : "text-zinc-600"}`}>
            <Code2 size={14}/></button>
        </div>
      </div>
      <div className="subtle-grid flex min-h-[720px] justify-center bg-[#111] p-4 sm:p-8">{source ?
        <pre className="w-full overflow-auto whitespace-pre-wrap text-xs leading-5 text-zinc-400">{rendered}</pre> :
        <iframe title="Email template preview" srcDoc={rendered} sandbox=""
                className={`min-h-[680px] border-0 bg-white transition-[width] ${viewport === "desktop" ? "w-full max-w-[660px]" : "w-full max-w-[375px]"}`}/>}</div>
    </section>
  </form>
}
