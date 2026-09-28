import type { Metadata } from "next";
import { MessagesPageView } from "@/components/messages-page-view";
import { listEmails } from "@/modules/admin/queries";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage() {
  const emails = await listEmails();
  return <MessagesPageView records={emails} />;
}
