import { getAdminSession } from "@/server/admin-auth";
import { listEmails } from "@/modules/admin/queries";

export function csvCell(value: unknown) {
  const text = String(value ?? "");
  const escaped = /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${escaped.replaceAll('"', '""')}"`
}

export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const records = await listEmails(10_000);
  const lines = [["Delivery ID", "Recipient", "Subject", "Product", "Category", "From", "Status", "Accepted at", "Provider message ID", "Reference ID"].map(csvCell).join(","), ...records.map(item => [item.id, item.recipient, item.subject, item.product, item.category, item.from, item.status, item.createdAt, item.providerId, item.referenceId].map(csvCell).join(","))];
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=envoy-messages.csv"
    }
  })
}
