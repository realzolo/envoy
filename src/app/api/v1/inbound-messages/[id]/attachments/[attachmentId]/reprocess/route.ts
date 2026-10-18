import { retryAttachmentScan } from "@/modules/attachments/tasks";
import { query } from "@/server/database";
import { apiProblem, serviceRoute } from "@/server/service-api";
export const POST = serviceRoute(async (_request,identity,context:{params:Promise<{id:string;attachmentId:string}>}) => {
  const {id,attachmentId}=await context.params;
  const own=await query("SELECT a.id FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE i.id=$1 AND a.id=$2 AND i.service_id=$3",[id,attachmentId,identity.serviceId]);
  if(!own.rowCount) return apiProblem("Not found",404);
  const result=await retryAttachmentScan(attachmentId,"inbound",identity.serviceId,`service:${identity.serviceId}`);
  return result ? Response.json(result,{status:202}) : apiProblem("Not found",404);
});
