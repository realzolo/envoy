import { getAdminSession } from "@/server/admin-auth";
import { query } from "@/server/database";

export async function GET(_request: Request, context: { params: Promise<{id:string}> }) {
  if (!await getAdminSession()) return Response.json({error:"Unauthorized"},{status:401});
  const {id}=await context.params;
  const row=(await query(`SELECT d.id,d.endpoint_id,e.name AS endpoint,e.url,d.event_type,d.payload->>'id' AS event_id,d.payload,d.status,d.attempt_count,d.next_attempt_at,d.response_code,d.last_error,d.delivered_at,d.created_at,d.updated_at,d.payload_purged_at
    FROM callback_deliveries d JOIN callback_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`,[id])).rows[0];
  return row ? Response.json(row,{headers:{"cache-control":"no-store"}}) : Response.json({error:"Callback delivery not found"},{status:404})
}
