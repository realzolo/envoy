import { retryAttachmentScan } from "@/modules/attachments/tasks";
import { createMessageSchema, MAX_REQUEST_BYTES } from "@/lib/contracts";
import { BodyTooLargeError, readRequestBytes } from "@/server/request-body";
import { z } from "zod";
import { MessageValidationError, IdempotencyConflictError, DuplicateRiskError } from "@/modules/core/message/service";
import { providerTypeSchema } from "@/modules/providers/contracts";
import { getAdminSession } from "@/server/admin-auth";
import { recordRequest } from "@/server/request-log";
import { terminateCallback } from "@/modules/callbacks/service";
import * as actions from "@/modules/admin/actions";

type Body = { action?: string; [key: string]: unknown };

function text(body: Body, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim()
}

function object(body: Body, key: string) {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export async function POST(request: Request) {
  const started = Date.now();
  const session = await getAdminSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body:Body={};
  let result: unknown = null;
  let status = 200;
  try {
    body = z.object({action:z.string().min(1)}).passthrough().parse(JSON.parse(Buffer.from(await readRequestBytes(request,MAX_REQUEST_BYTES)).toString("utf8"))) as Body;
    switch (body.action) {
      case "attachment.reprocess":
        result=await retryAttachmentScan(text(body,"id"),z.enum(["outbound","inbound"]).parse(body.kind),null,session.email);
        break;
      case"product.create":
        result = {
          id: await actions.createProduct({
            name: text(body, "name")
          }, session.email)
        };
        status = 201;
        break;
      case"product.toggle":
        await actions.toggleProduct(text(body, "id"), body.enabled === true, session.email);
        break;
      case"provider.create": {
        const type = providerTypeSchema.parse(body.type);
        result = await actions.createProviderAccount({
          type,
          name: text(body, "name"),
          configuration: object(body, "configuration"),
          credentials: object(body, "credentials")
        }, session.email);
        status = 201;
        break
      }
      case"provider.test":
        result = await actions.testProviderAccount(text(body, "id"), session.email);
        break;
      case"provider.toggle":
        await actions.toggleProvider(text(body, "id"), body.enabled === true, session.email);
        break;
      case"provider.update_quota":
        await actions.updateProviderQuota(text(body, "id"), object(body, "quota"), session.email);
        break;
      case"provider.rotate":
        result = await actions.rotateProviderCredential(text(body, "id"), object(body, "secret"), session.email);
        break;
      case"webhook.rotate_security":
        result = await actions.configureProviderWebhook(text(body, "id"), object(body, "settings"), session.email);
        break;
      case"webhook.toggle":
        await actions.toggleWebhookEndpoint(text(body, "id"), body.enabled === true, session.email);
        break;
      case"domain.create":
        result = await actions.createDomain({
          domain: text(body, "domain"),
          accountIds: strings(body.accountIds)
        }, session.email);
        status = 201;
        break;
      case"domain.toggle":
        await actions.toggleDomain(text(body, "id"), body.enabled === true, session.email);
        break;
      case"identity.refresh":
        result = await actions.refreshIdentity(text(body, "id"), session.email);
        break;
      case"identity.toggle":
        await actions.toggleIdentity(text(body, "id"), body.enabled === true, session.email);
        break;
      case"routing.update":
      case"routing.create":
        result = {
          id: await actions.createRoutingPolicy({
            name: text(body, "name"),
            productId: typeof body.productId === "string" ? body.productId : undefined,
            serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
            domainId: text(body, "domainId"),
            category: typeof body.category === "string" ? body.category : undefined,
            priority: Number(body.priority ?? 100),
            targets: Array.isArray(body.targets) ? body.targets as Array<{
              accountId: string;
              identityId: string;
              priority: number;
              weight: number;
              rateLimit: number
            }> : []
          }, session.email, body.action === "routing.update" ? text(body,"id") : undefined)
        };
        status = body.action === "routing.update" ? 200 : 201;
        break;
      case"routing.simulate":
        result = await actions.simulateRouting({
          domainId: text(body, "domainId"),
          productId: typeof body.productId === "string" ? body.productId : undefined,
          serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
          category: typeof body.category === "string" ? body.category : undefined
        });
        break;
      case"routing.toggle":
        await actions.toggleRoutingPolicy(text(body, "id"), body.enabled === true, session.email);
        break;
      case"delivery.retry":
        result = await actions.manualRetryDelivery(text(body, "id"), body.acknowledgeDuplicateRisk === true, session.email);
        status = 202;
        break;
      case"outbox.retry":
        result = await actions.retryOutbox(text(body,"id"),session.email);
        status=202;
        break;
      case "event.terminate":
        await actions.terminateRawEvent(text(body,"id"),session.email);
        break;
      case"event.replay":
        await actions.replayRawEvent(text(body, "id"), session.email);
        status = 202;
        break;
      case"suppression.create":
        result = {
          id: await actions.addSuppression({
            email: text(body, "email"),
            scope: text(body, "scope") as "global" | "product" | "list",
            productId: typeof body.productId === "string" ? body.productId : undefined,
            listId: typeof body.listId === "string" ? body.listId : undefined,
            reason: text(body, "reason"),
            expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined
          }, session.email)
        };
        status = 201;
        break;
      case"suppression.remove":
        await actions.removeSuppression(text(body, "id"), session.email);
        break;
      case"message.test":
        result = await actions.sendTestMessage({
          idempotencyKey: text(body, "idempotencyKey"),
          serviceId: text(body, "serviceId"),
          message: createMessageSchema.parse(body.message),
        }, session.email);
        status = 202;
        break;
      case"grant.create":
        result = { id: await actions.createSenderGrant({
          productId: text(body, "productId"),
          serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
          domainId: text(body, "domainId"),
          fromLocalPart: typeof body.fromLocalPart === "string" ? body.fromLocalPart : undefined,
        }, session.email) };
        status = 201;
        break;
      case"grant.toggle":
        await actions.toggleSenderGrant(text(body, "id"), body.enabled === true, session.email);
        break;
      case"credential.create":
        result = await actions.createServiceCredential({
          productId: text(body, "productId"),
          serviceName: text(body, "serviceName")
        }, session.email);
        status = 201;
        break;
      case"credential.rotate":
        result = await actions.rotateServiceCredential(text(body, "id"), session.email);
        break;
      case"credential.revoke":
        await actions.revokeServiceCredential(text(body, "id"), session.email);
        break;
      case"callback.create":
        result = await actions.createCallback({
          serviceId: text(body, "serviceId"),
          name: text(body, "name"),
          url: text(body, "url"),
          secret: typeof body.secret === "string" && body.secret.trim() ? body.secret : undefined,
          events: strings(body.events)
        }, session.email);
        status = 201;
        break;
      case"callback.update":
        await actions.updateCallback(text(body,"id"), { name:text(body,"name"), url:text(body,"url"), events:strings(body.events) },session.email);
        break;
      case"callback.toggle":
        await actions.toggleCallback(text(body, "id"), body.enabled === true, session.email);
        break;
      case"callback.rotate_secret":
        result = await actions.rotateCallbackSecret(text(body, "id"), typeof body.secret === "string" && body.secret.trim() ? body.secret : undefined, session.email);
        break;
      case"callback.test":
        result = { deliveryId: await actions.testCallback(text(body, "id"), session.email) };
        status = 202;
        break;
      case "callback.terminate":
        result = await terminateCallback(text(body,"id"),session.email);
        break;
      case"callback.replay_dlq":
        result = { count: await actions.replayDeadLetters(session.email, { endpointId: typeof body.endpointId === "string" ? body.endpointId : undefined, deliveryId: typeof body.deliveryId === "string" ? body.deliveryId : undefined }) };
        status = 202;
        break;
      case"inbound_route.create":
        result = {
          id: await actions.createInboundRoute({
            webhookEndpointId: text(body, "webhookEndpointId"),
            domainId: text(body, "domainId"),
            productId: text(body, "productId"),
            serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
            callbackId: typeof body.callbackId === "string" ? body.callbackId : undefined,
            localPartPattern: text(body, "localPartPattern")
          }, session.email)
        };
        status = 201;
        break;
      case"inbound_route.toggle":
        await actions.toggleInboundRoute(text(body, "id"), body.enabled === true, session.email);
        break;
      default:
        throw new Error("Unknown admin action");
    }
    await recordRequest({
      method: "POST",
      path: "/api/admin/actions",
      statusCode: status,
      durationMs: Date.now() - started,
      actor: session.email,
      details: { action: body.action }
    });
    return Response.json({ ok: true, result }, { status })
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    status = error instanceof IdempotencyConflictError || error instanceof DuplicateRiskError || code === "23505" ? 409
      : error instanceof BodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : /^(08|53|57)/.test(code) ? 503 : code ? 500 : 422;
    const message = code ? code === "23505" ? "This configuration already exists." : status === 503 ? "The database is temporarily unavailable." : "The operation could not be completed. Check the server logs."
      : error instanceof MessageValidationError ? error.issues.join("; ") : error instanceof z.ZodError ? "Check the highlighted fields."
      : error instanceof IdempotencyConflictError ? "This submission key has already been used with different content."
      : error instanceof Error ? error.message : "Action failed";
    const fields = error instanceof z.ZodError ? Object.fromEntries(error.issues.map(issue => [issue.path.join("."), issue.message])) : undefined;
    await recordRequest({method:"POST",path:"/api/admin/actions",statusCode:status,durationMs:Date.now()-started,actor:session.email,details:{action:body.action,error:message}});
    return Response.json({ error: message, fields }, { status })
  }
}
