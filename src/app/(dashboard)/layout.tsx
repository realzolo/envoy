import { AppShell } from "@/components/app-shell";
import { getAdminSession } from "@/server/admin-auth";
import { query } from "@/server/database";
import { redirect } from "next/navigation";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session=await getAdminSession();if(!session)redirect("/login");
  const settings=await query<{key:string;value:unknown}>("SELECT key,value FROM workspace_settings WHERE key=ANY($1::text[])",[["workspace_name","default_environment"]]);const values=Object.fromEntries(settings.rows.map(row=>[row.key,String(row.value)]));
  return <AppShell email={session.email} workspaceName={values.workspace_name??"Envoy"} environment={values.default_environment??"Production"}>{children}</AppShell>;
}
