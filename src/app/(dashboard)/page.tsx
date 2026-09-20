import Link from "next/link";
import { ArrowRight, CheckCircle2, Clock3, MailCheck, ShieldCheck, TriangleAlert } from "lucide-react";
import { DeliveryChart } from "@/components/delivery-chart";
import { EmailTable } from "@/components/email-table";
import { PageHeader } from "@/components/page-header";
import { dashboardData } from "@/modules/admin/queries";

export default async function OverviewPage() {
  const data = await dashboardData();
  const stats = [{
    label: "Accepted",
    value: data.stats.accepted.toLocaleString(),
    context: "Last 7 days",
    icon: MailCheck
  }, {
    label: "Delivery rate",
    value: `${data.stats.deliveryRate.toFixed(1)}%`,
    context: `${data.stats.delivered.toLocaleString()} delivered`,
    icon: CheckCircle2
  }, {
    label: "Bounce rate",
    value: `${data.stats.bounceRate.toFixed(2)}%`,
    context: `${data.stats.bounced.toLocaleString()} bounced`,
    icon: TriangleAlert
  }, {
    label: "Unknown outcomes",
    value: data.health.unknown.toLocaleString(),
    context: "Awaiting reconciliation",
    icon: Clock3
  }];
  return <div className="space-y-8"><PageHeader title="Overview"
                                                description="Monitor delivery, routing, callbacks, and provider health across every product."/>
    <section
      className="grid gap-px overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800 sm:grid-cols-2 xl:grid-cols-4">{stats.map(stat => {
      const Icon = stat.icon;
      return <div key={stat.label} className="bg-[#090909] px-5 py-4">
        <div className="flex items-center justify-between text-xs text-zinc-600"><span>{stat.label}</span><Icon
          size={14}/></div>
        <p className="mt-3 text-2xl font-medium tabular-nums text-zinc-100">{stat.value}</p><p
        className="mt-1 text-xs text-zinc-600">{stat.context}</p></div>
    })}</section>
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_310px]">
      <div className="min-w-0 rounded-lg border border-zinc-800 bg-[#090909] p-5"><DeliveryChart data={data.trend}/>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-[#090909] p-5">
        <div className="flex items-center justify-between">
          <div><h2 className="text-sm font-medium text-zinc-100">System health</h2><p
            className="mt-1 text-xs text-zinc-600">Live durable pipeline state</p></div>
          <ShieldCheck size={17} className="text-emerald-400"/></div>
        <div
          className="mt-5 divide-y divide-zinc-900">{[["Message API", "Healthy", "PostgreSQL"], ["Outbox backlog", data.health.outbox ? "Attention" : "Healthy", String(data.health.outbox)], ["Unknown outcomes", data.health.unknown ? "Reconciling" : "Healthy", String(data.health.unknown)], ["Callback dead letters", data.health.deadLetters ? "Attention" : "Healthy", String(data.health.deadLetters)]].map(([name, status, detail]) =>
          <div key={String(name)} className="flex items-center gap-3 py-3"><span
            className={`size-1.5 rounded-full ${status === "Healthy" ? "bg-emerald-400" : "bg-amber-400"}`}/><span
            className="flex-1 text-xs text-zinc-400">{name}</span><span
            className="text-[11px] text-zinc-700">{detail}</span><span
            className="text-[11px] text-zinc-500">{status}</span></div>)}</div>
      </div>
    </section>
    <section>
      <div className="mb-4 flex items-end justify-between">
        <div><h2 className="text-sm font-medium text-zinc-100">Recent messages</h2><p
          className="mt-1 text-xs text-zinc-600">Latest accepted deliveries across products</p></div>
        <Link href="/emails" className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200">View
          all <ArrowRight size={13}/></Link></div>
      <EmailTable records={data.recent} compact/></section>
  </div>
}
