import { AppShell } from "@/components/app-shell";
import { getAdminSession } from "@/server/admin-auth";
import { redirect } from "next/navigation";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) redirect("/login");
  return <AppShell email={session.email}>{children}</AppShell>;
}
