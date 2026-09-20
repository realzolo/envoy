import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminConsole } from "@/components/admin-console";
import { PageHeader } from "@/components/page-header";
import { adminData } from "@/modules/admin/queries";

const sections = {
  providers: ["Provider Accounts", "Configure credentials, capabilities, health, quotas, and connectivity."],
  domains: ["Domain Matrix", "Track every logical sending domain across provider identities and DNS verification."],
  senders: ["Sender Profiles", "Resolve product and message categories to stable visible From identities."],
  routing: ["Routing Policies", "Control deterministic priority, weighted targets, limits, and failover eligibility."],
  "api-keys": ["Service Credentials", "Issue isolated, revocable credentials for internal services."],
  webhooks: ["Callbacks", "Manage canonical business callbacks, delivery retries, and dead letters."],
  events: ["Provider Events", "Inspect immutable raw ingress and normalized canonical events."],
  suppressions: ["Suppressions", "Protect recipients with scoped bounce, complaint, and unsubscribe policies."],
  inbound: ["Inbound", "Inspect sanitized inbound messages and scanned attachments."],
  logs: ["Audit & Revisions", "Review operator actions and immutable configuration history."],
  settings: ["Settings", "Manage workspace retention and operational defaults."]
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
  const section = (await params).section;
  if (!valid(section)) notFound();
  const data = await adminData();
  return <div className="space-y-6"><PageHeader title={sections[section][0]}
                                                description={sections[section][1]}/><AdminConsole section={section}
                                                                                                  data={data}/></div>
}
