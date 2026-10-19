import { connection } from "next/server";
import { DashboardOverview } from "@/features/outbound/delivery-chart";
import { dashboardData } from "@/server/admin-queries";

export default async function OverviewPage() {
  await connection();
  const data = await dashboardData();

  return (
    <DashboardOverview
      health={data.health}
      recent={data.recent}
      setup={data.setup}
      stats={data.stats}
      trend={data.trend}
    />
  );
}
