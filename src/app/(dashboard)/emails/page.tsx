import type { Metadata } from "next";
import { Download, FileCode2 } from "lucide-react";
import Link from "next/link";
import { EmailTable } from "@/components/email-table";
import { PageHeader } from "@/components/page-header";
import { listEmails } from "@/modules/admin/queries";

export const metadata:Metadata={title:"Messages"};
export default async function MessagesPage(){const emails=await listEmails();return <div className="space-y-6"><PageHeader title="Messages" description="Inspect every recipient-level delivery, routing attempt, and canonical event." actions={<><Link href="/api/admin/export/messages" className="flex h-9 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-400 hover:text-zinc-200"><Download size={14}/>Export CSV</Link><Link href="/templates" className="flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950"><FileCode2 size={14}/>Send a test</Link></>}/><EmailTable records={emails}/></div>}
