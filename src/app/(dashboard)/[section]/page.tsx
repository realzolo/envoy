import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AdminConsole } from "@/features/admin-console";
import { PageHeader } from "@/components/page-header";
import { adminData, type AdminSection } from "@/server/admin-queries";

const sections = {
  attachments: ["Attachment Safety", "Inspect private attachment processing, bounded retries and observed scanner results."],
  providers: ["Provider Accounts", "Connect sending providers, verify credentials, and secure delivery event webhooks."],
  domains: ["Domains", "Register domains, connect sending providers, and review DNS verification."],
  routing: ["Routing Policies", "Match sending domains and verified provider identities to delivery scope."],
  "api-keys": ["Services", "Configure service permissions and event callbacks, and manage API keys."],
  webhooks: ["Callbacks", "Manage event callbacks, delivery retries, and dead letters."],
  events: ["Provider Events", "Inspect immutable raw ingress and normalized canonical events."],
  suppressions: ["Suppressions", "Protect recipients with scoped bounce, complaint, and unsubscribe policies."],
  inbound: ["Inbound", "Inspect sanitized inbound messages and scanned attachments."],
  logs: ["Audit Log", "Review administrator actions across the control plane."]
} as const;
type Section = keyof typeof sections;

function valid(value: string): value is Section {
  return value in sections
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const key = (await params).section;
  return { title: valid(key) ? sections[key][0] : "Envoy" }
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  await connection();
  const section = (await params).section;
  if (!valid(section)) notFound();
  const data = await adminData(section as AdminSection);
  return (
    <div className="page-stack">
      <PageHeader title={sections[section][0]} description={sections[section][1]} />
      <AdminConsole section={section} data={data} />
    </div>
  );
}
