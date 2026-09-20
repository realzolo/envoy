import { getAdminSession } from "@/server/admin-auth";
import { listEmails } from "@/modules/admin/queries";

function cell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`
}

export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const records = await listEmails(10_000);
  const lines = [["Delivery ID", "Recipient", "Subject", "Product", "Template", "From", "Status", "Accepted at", "Provider message ID", "Reference ID"].map(cell).join(","), ...records.map(item => [item.id, item.recipient, item.subject, item.product, item.template, item.from, item.status, item.createdAt, item.providerId, item.referenceId].map(cell).join(","))];
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=envoy-messages.csv"
    }
  })
}
