import type { Metadata } from "next";
import { ComposeMessageView } from "@/components/compose-message-view";
import { messageComposerData } from "@/modules/admin/queries";

export const metadata: Metadata = { title: "Send a test" };

export default async function ComposeMessagePage() {
  const data = await messageComposerData();
  return <ComposeMessageView services={data.services} senders={data.senders} />;
}
