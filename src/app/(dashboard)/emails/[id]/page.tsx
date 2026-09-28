import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeliveryDetailView } from "@/components/delivery-detail-view";
import { getDeliveryDetail } from "@/modules/admin/queries";

export const metadata: Metadata = { title: "Delivery details" };

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const detail = await getDeliveryDetail((await params).id);
  if (!detail) notFound();

  return <DeliveryDetailView detail={detail} />;
}
