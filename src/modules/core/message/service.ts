import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { CreateMessageInput } from "@/lib/contracts";
import type { ServiceIdentity } from "@/server/auth";
import { createId } from "@/server/ids";
import { transaction, query } from "@/server/database";
import { validateTemplateVariables } from "@/server/template-renderer";

export class MessageValidationError extends Error { constructor(public readonly issues:string[]){super("Message validation failed")} }
export class IdempotencyConflictError extends Error {}

function stable(value:unknown):unknown{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]));return value}
function hashPayload(input:CreateMessageInput){return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex")}
async function suppression(client:PoolClient,productId:string,email:string,listId?:string){return Boolean((await client.query(`SELECT 1 FROM suppressions WHERE active=true AND email_normalized=$1 AND (expires_at IS NULL OR expires_at>now()) AND (scope_type='global' OR (scope_type='product' AND product_id=$2) OR (scope_type='list' AND product_id=$2 AND list_id=$3)) LIMIT 1`,[email.toLowerCase(),productId,listId??null])).rowCount)}

export async function acceptMessage(args:{identity:ServiceIdentity;idempotencyKey:string;input:CreateMessageInput}){
  const payloadHash=hashPayload(args.input);
  return transaction(async client=>{
    const existing=await client.query<{id:string;payload_hash:string;accepted_at:Date}>("SELECT id,payload_hash,accepted_at FROM messages WHERE service_id=$1 AND idempotency_key=$2 FOR UPDATE",[args.identity.serviceId,args.idempotencyKey]);
    if(existing.rows[0]){if(existing.rows[0].payload_hash!==payloadHash)throw new IdempotencyConflictError();return{duplicate:true,message:{id:existing.rows[0].id,status:"queued" as const,product:args.identity.product,template:args.input.template,recipientCount:args.input.to.length,acceptedAt:existing.rows[0].accepted_at.toISOString(),referenceId:args.input.referenceId}}}
    const template=await client.query<{template_id:string;version_id:string;schema:Record<string,"string"|"number"|"boolean">;category:string;sender_profile_id:string}>(`SELECT t.id AS template_id,tv.id AS version_id,tv.variables_schema AS schema,t.category,sp.id AS sender_profile_id
      FROM templates t JOIN template_versions tv ON tv.template_id=t.id AND tv.status='published'
      JOIN sender_profiles sp ON sp.product_id=t.product_id AND sp.message_category=t.category AND sp.status='active'
      JOIN sending_domains sd ON sd.id=sp.sending_domain_id AND sd.status='active'
      WHERE t.product_id=$1 AND t.key=$2 ORDER BY sp.created_at LIMIT 1`,[args.identity.productId,args.input.template]);
    const selected=template.rows[0];if(!selected)throw new MessageValidationError(["The template, published version, or sender profile is unavailable."]);
    const issues=validateTemplateVariables(selected.schema,args.input.variables);if(issues.length)throw new MessageValidationError(issues);
    const id=createId("msg");
    await client.query(`INSERT INTO messages(id,product_id,service_id,sender_profile_id,template_id,template_version_id,idempotency_key,payload_hash,reference_id,locale,variables,metadata,recipient_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,args.identity.productId,args.identity.serviceId,selected.sender_profile_id,selected.template_id,selected.version_id,args.idempotencyKey,payloadHash,args.input.referenceId??null,args.input.locale,args.input.variables,args.input.metadata??{},args.input.to.length]);
    for(const recipient of args.input.to){const deliveryId=createId("dlv");const blocked=await suppression(client,args.identity.productId,recipient.email,args.input.metadata?.listId);await client.query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_name,lifecycle_status,compliance_status) VALUES ($1,$2,$3,$4,$5,$6)`,[deliveryId,id,recipient.email.toLowerCase(),recipient.name??null,blocked?"failed":"queued",blocked?"suppressed":"clean"]);await client.query(`INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'delivery',$2,$3,$4)`,[createId("out"),deliveryId,blocked?"delivery.suppressed":"delivery.requested",{deliveryId}]);}
    return{duplicate:false,message:{id,status:"queued" as const,product:args.identity.product,template:args.input.template,recipientCount:args.input.to.length,acceptedAt:new Date().toISOString(),referenceId:args.input.referenceId}};
  });
}

export async function getMessage(id:string,serviceId:string){const result=await query<{id:string;product:string;template:string;recipient_count:number;accepted_at:Date;reference_id:string|null}>(`SELECT m.id,p.name AS product,t.key AS template,m.recipient_count,m.accepted_at,m.reference_id FROM messages m JOIN products p ON p.id=m.product_id JOIN templates t ON t.id=m.template_id WHERE m.id=$1 AND m.service_id=$2`,[id,serviceId]);const message=result.rows[0];if(!message)return null;const deliveries=(await query<{id:string;recipient_email:string;lifecycle_status:string;engagement_status:string;compliance_status:string;updated_at:Date}>("SELECT id,recipient_email,lifecycle_status,engagement_status,compliance_status,updated_at FROM deliveries WHERE message_id=$1 ORDER BY queued_at",[id])).rows;return{...message,status:deliveries.every(d=>d.lifecycle_status==="delivered")?"delivered":deliveries.some(d=>["queued","submitting","accepted","deferred","unknown"].includes(d.lifecycle_status))?"in_progress":"completed",deliveries}};
