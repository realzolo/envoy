import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { listTemplates } from "@/modules/admin/queries";

export const metadata: Metadata = { title: "Templates" };
const accents = {
  blue: "from-sky-500/20 to-zinc-950",
  green: "from-emerald-500/20 to-zinc-950",
  violet: "from-violet-500/20 to-zinc-950",
  amber: "from-amber-500/20 to-zinc-950"
};
export default async function TemplatesPage() {
  const templates = await listTemplates();
  return <div className="space-y-6"><PageHeader title="Templates"
                                                description="Own rendering, variables, previews, and immutable published versions inside Envoy."
                                                actions={<Link href="/templates/new"
                                                               className="flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950"><Plus
                                                  size={14}/>New template</Link>}/>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{templates.map(template => <Link key={template.id}
                                                                                               href={`/templates/${template.id}`}
                                                                                               className="group overflow-hidden rounded-lg border border-zinc-800 bg-[#090909] hover:border-zinc-700">
      <div
        className={`subtle-grid flex h-32 items-center justify-center bg-gradient-to-br ${accents[template.accent]}`}>
        <div className="w-[72%] bg-white px-4 py-3 shadow-2xl">
          <div className="h-1.5 w-12 rounded-full bg-zinc-900"/>
          <div className="mt-3 h-1 w-4/5 rounded-full bg-zinc-300"/>
          <div className="mt-1.5 h-1 w-3/5 rounded-full bg-zinc-200"/>
          <div className="mt-4 h-5 w-20 rounded bg-zinc-900"/>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div><h2 className="text-sm font-medium text-zinc-200">{template.name}</h2><p
            className="mt-1 font-mono text-[11px] text-zinc-700">{template.key}</p></div>
          <ArrowUpRight size={15} className="text-zinc-700"/></div>
        <p className="mt-3 line-clamp-2 text-xs leading-5 text-zinc-600">{template.description}</p>
        <div className="mt-4 flex justify-between border-t border-zinc-900 pt-3 text-[11px] text-zinc-700">
          <span>{template.product} / {template.category} / v{template.version}</span><span>{template.updatedAt}</span>
        </div>
      </div>
    </Link>)}</div>
  </div>
}
