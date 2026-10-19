import { MAX_REQUEST_BYTES } from "@/lib/contracts";
import { getAdminSession } from "@/server/admin-auth";
import { readRequestBytes } from "@/server/request-body";
import { recordRequest } from "@/server/request-log";
import "server-only";
import { z } from "zod";
import { adminMutationFailure } from './admin-mutation-errors';
export type Body = { [key: string]: unknown };

export function text(body: Body, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim()
}

export function object(body: Body, key: string) {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>
}

export function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}


/** HTTP-only boundary: authentication, bounded JSON, validation errors and audit telemetry. */
export async function adminMutation(request:Request,execute:(body:Body,actor:string)=>Promise<{result:unknown;status:number}>,parameters:Record<string,string>={}) {
  const started=Date.now();
  const session=await getAdminSession();
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  let status=200;
  try {
    const bytes=await readRequestBytes(request,MAX_REQUEST_BYTES);
    const input=bytes.length ? JSON.parse(Buffer.from(bytes).toString("utf8")) : {};
    const body={...z.record(z.string(),z.unknown()).parse(input),...parameters};
    const outcome=await execute(body,session.email);status=outcome.status;
    await recordRequest({method:request.method,path:new URL(request.url).pathname,statusCode:status,durationMs:Date.now()-started,actor:session.email});
    return Response.json({ok:true,result:outcome.result},{status});
  } catch (error) {
    const failure=adminMutationFailure(error);
    status=failure.status;
    const {message,fields}=failure;
    await recordRequest({method:request.method,path:new URL(request.url).pathname,statusCode:status,durationMs:Date.now()-started,actor:session.email,details:{error:message}});
    return Response.json({ error: message, fields }, { status })
  }
}
