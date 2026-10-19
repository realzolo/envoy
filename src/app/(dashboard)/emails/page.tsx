import type { Metadata } from "next";
import { MessagesPageView } from "@/features/outbound/messages-page-view";
import { messageFilters } from "@/modules/admin/contracts";
import { listEmailPage } from "@/server/admin-queries";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(await searchParams)) if (typeof value === "string") params.set(key,value);
  const filters = messageFilters(params);
  const page = await listEmailPage(filters);
  return <MessagesPageView {...page} filters={filters} />;
}
