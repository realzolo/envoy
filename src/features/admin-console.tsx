"use client";
import { type Data,EmptyState } from "@/components/admin-console-shared";
import { AttachmentSafety } from '@/features/attachments/safety';
import { Callbacks } from "@/features/callbacks/callbacks";
import { Domains } from '@/features/channels/domains';
import { ProviderAccounts } from "@/features/channels/provider-accounts";
import { Services } from "@/features/identity/service-management";
import { Inbound } from "@/features/inbound/inbound";
import { Logs } from '@/features/operations/audit-log';
import { Events } from '@/features/operations/provider-events';
import { Routing } from '@/features/outbound/routing';
import { Suppressions } from '@/features/suppressions/suppressions';

function Providers({ data }: { data: Data }) {
  return <ProviderAccounts data={data} />;
}

export function AdminConsole({ section, data }: { section: string; data: Data }) {
  if (section === "attachments") return <AttachmentSafety data={data} />;
  if (section === "providers") return <Providers data={data} />;
  if (section === "domains") return <Domains data={data} />;
  if (section === "routing") return <Routing data={data} />;
  if (section === "api-keys") return <Services data={data} />;
  if (section === "webhooks") return <Callbacks data={data} />;
  if (section === "events") return <Events data={data} />;
  if (section === "suppressions") return <Suppressions data={data} />;
  if (section === "inbound") return <Inbound data={data} />;
  if (section === "logs") return <Logs data={data} />;
  return <EmptyState text="Unknown section." />;
}
