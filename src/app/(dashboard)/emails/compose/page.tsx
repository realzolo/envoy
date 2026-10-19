import type { Metadata } from "next";
import { ComposeMessageView } from "@/features/outbound/compose-message-view";
import { messageComposerData } from "@/server/admin-queries";

export const metadata: Metadata = { title: "Send a test" };

export default async function ComposeMessagePage() {
  const data = await messageComposerData();
  return <ComposeMessageView services={data.services} />;
}
