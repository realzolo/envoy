import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, KeyRound } from "lucide-react";
import { MessageComposer } from "@/components/message-composer";
import { messageComposerData } from "@/modules/admin/queries";

export const metadata: Metadata = { title: "Send a test" };

export default async function ComposeMessagePage() {
  const data = await messageComposerData();
  return <div className="space-y-6">
    <div><Link href="/emails" className="mb-5 inline-flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-300">
      <ArrowLeft size={13}/>Back to messages
    </Link>
      <div className="border-b border-zinc-800 pb-6"><h1 className="text-xl font-medium text-zinc-50">Send a test</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-zinc-500">Submit final rendered content through the same asynchronous delivery path used by service clients.</p>
      </div>
    </div>
    {data.services.length ? <MessageComposer services={data.services} senders={data.senders}/> :
      <section className="flex min-h-72 flex-col items-center justify-center border-y border-zinc-800 px-6 text-center">
        <KeyRound size={22} className="text-zinc-600"/>
        <h2 className="mt-4 text-sm font-medium text-zinc-200">No active services</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">Create a product and issue a service credential before submitting a test message.</p>
        <Link href="/api-keys" className="mt-5 inline-flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950">
          Configure services<ArrowRight size={14}/>
        </Link>
      </section>}
  </div>
}
