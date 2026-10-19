import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeliveryDetailView } from "@/features/outbound/delivery-detail-view";
import { getDeliveryDetail } from "@/server/admin-queries";

export const metadata: Metadata = { title: "Delivery details" };

export default async function DeliveryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams:Promise<{back?:string}> }) {
  const detail = await getDeliveryDetail((await params).id);
  if (!detail) notFound();

  const requestedBack=(await searchParams).back;
  const back=requestedBack && /^\/emails(?:\?|$)/.test(requestedBack) ? requestedBack : "/emails";
  return <DeliveryDetailView detail={detail} back={back} />;
}
