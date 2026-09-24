"use client";

import { Code2, LoaderCircle, Monitor, Send, Smartphone } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

type Service = { id: string; name: string; product: string; product_id: string };
type Sender = { name: string; product_id: string; category: string; from_address: string };

const field = "mt-1.5 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300 outline-none focus:border-zinc-600";

export function MessageComposer({ services, senders }: { services: Service[]; senders: Sender[] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [senderProfile, setSenderProfile] = useState("");
  const initialProductId = services[0]?.product_id;
  const [category, setCategory] = useState(senders.find(item => item.product_id === initialProductId)?.category ?? "transactional");
  const [subject, setSubject] = useState("Test message from Envoy");
  const [html, setHtml] = useState("<main style=\"font-family:Arial,sans-serif;padding:32px\"><h1>Envoy test</h1><p>This rendered message was submitted directly to the delivery service.</p></main>");
  const [textBody, setTextBody] = useState("Envoy test\n\nThis rendered message was submitted directly to the delivery service.");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [source, setSource] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const service = services.find(item => item.id === serviceId);
  const availableSenders = useMemo(() => senders.filter(item => item.product_id === service?.product_id), [senders, service?.product_id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setNotice("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "message.test",
          serviceId,
          senderProfile: senderProfile || undefined,
          recipient: data.get("recipient"),
          category: data.get("category"),
          subject,
          html: html || undefined,
          text: textBody || undefined
        })
      });
      const payload = await response.json() as { error?: string; result?: { id?: string } };
      if (!response.ok) throw new Error(payload.error ?? "Unable to queue message");
      setNotice(`Queued message ${payload.result?.id ?? "successfully"}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to queue message")
    } finally {
      setPending(false)
    }
  }

  return <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
    <aside className="space-y-4">
      <label className="block text-xs text-zinc-500">Service<select required value={serviceId}
                                                                    onChange={event => {
                                                                      const nextServiceId = event.target.value;
                                                                      const nextProductId = services.find(item => item.id === nextServiceId)?.product_id;
                                                                      setServiceId(nextServiceId);
                                                                      setSenderProfile("");
                                                                      setCategory(senders.find(item => item.product_id === nextProductId)?.category ?? "transactional")
                                                                    }} className={`${field} h-9`}>
        {services.map(item => <option key={item.id} value={item.id}>{item.product} / {item.name}</option>)}
      </select></label>
      <label className="block text-xs text-zinc-500">Sender profile<select value={senderProfile}
                                                                           onChange={event => {
                                                                             const profile = event.target.value;
                                                                             setSenderProfile(profile);
                                                                             if (profile) setCategory(availableSenders.find(item => item.name === profile)?.category ?? category)
                                                                           }} className={`${field} h-9`}>
        <option value="">Automatic by category</option>
        {availableSenders.map(item => <option key={item.name}
                                              value={item.name}>{item.name} / {item.from_address}</option>)}
      </select></label>
      <label className="block text-xs text-zinc-500">Recipient<input name="recipient" type="email" required
                                                                     placeholder="recipient@company.com"
                                                                     className={`${field} h-9`}/></label>
      <label className="block text-xs text-zinc-500">Category<input name="category" required value={category}
                                                                    onChange={event => setCategory(event.target.value)}
                                                                    className={`${field} h-9`}/></label>
      <label className="block text-xs text-zinc-500">Subject<input value={subject}
                                                                   onChange={event => setSubject(event.target.value)}
                                                                   required className={`${field} h-9`}/></label>
      <label className="block text-xs text-zinc-500">Plain text<textarea value={textBody}
                                                                         onChange={event => setTextBody(event.target.value)}
                                                                         rows={6}
                                                                         className={`${field} py-2 font-mono text-xs`}/></label>
      <label className="block text-xs text-zinc-500">HTML<textarea value={html}
                                                                   onChange={event => setHtml(event.target.value)}
                                                                   rows={14} spellCheck={false}
                                                                   className={`${field} py-2 font-mono text-xs`}/></label>
      <button disabled={pending || !services.length}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 disabled:opacity-50">
        {pending ? <LoaderCircle size={14} className="animate-spin"/> : <Send size={14}/>}Queue test message
      </button>
      {notice && <p role="status"
                    className={`break-words text-xs ${notice.startsWith("Queued") ? "text-emerald-400" : "text-red-400"}`}>{notice}</p>}
    </aside>
    <section className="overflow-hidden rounded-lg border border-zinc-800 bg-[#090909]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0"><p className="truncate text-sm text-zinc-200">{subject}</p><p
          className="mt-1 text-[11px] text-zinc-700">Transient preview</p></div>
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
      <div className="subtle-grid flex min-h-[720px] justify-center bg-[#111] p-4 sm:p-8">
        {source ?
          <pre className="w-full overflow-auto whitespace-pre-wrap text-xs leading-5 text-zinc-400">{html}</pre> :
          <iframe title="Message preview" srcDoc={html} sandbox=""
                  className={`min-h-[680px] border-0 bg-white transition-[width] ${viewport === "desktop" ? "w-full max-w-[660px]" : "w-full max-w-[375px]"}`}/>}</div>
    </section>
  </form>
}
