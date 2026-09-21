import { providerTypeSchema } from "@/modules/providers/contracts";
import { getAdminSession } from "@/server/admin-auth";
import { recordRequest } from "@/server/request-log";
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
  const body = await request.json().catch(() => ({})) as Body;
  let result: unknown = null;
  let status = 200;
  try {
    switch (body.action) {
      case"product.create":
        result = {
          id: await actions.createProduct({
            name: text(body, "name"),
            slug: text(body, "slug")
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
          region: text(body, "region"),
          publicConfig: object(body, "publicConfig"),
          secret: object(body, "secret"),
          webhookSecurity: object(body, "webhookSecurity"),
          expectedTopicArn: typeof body.expectedTopicArn === "string" ? body.expectedTopicArn : undefined,
          ipAllowlist: strings(body.ipAllowlist)
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
        result = await actions.rotateWebhookSecurity(text(body, "id"), object(body, "security"), typeof body.expectedTopicArn === "string" ? body.expectedTopicArn : undefined, Array.isArray(body.ipAllowlist) ? strings(body.ipAllowlist) : undefined, session.email);
        break;
      case"webhook.toggle":
        await actions.toggleWebhookEndpoint(text(body, "id"), body.enabled === true, session.email);
        break;
      case"domain.create":
        result = await actions.createDomain({
          domain: text(body, "domain"),
          region: text(body, "region"),
          inboundEnabled: body.inboundEnabled === true,
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
      case"sender.create":
        result = {
          id: await actions.createSenderProfile({
            productId: text(body, "productId"),
            domainId: text(body, "domainId"),
            name: text(body, "name"),
            fromName: text(body, "fromName"),
            fromLocalPart: text(body, "fromLocalPart"),
            replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
            category: text(body, "category")
          }, session.email)
        };
        status = 201;
        break;
      case"sender.toggle":
        await actions.toggleSenderProfile(text(body, "id"), body.enabled === true, session.email);
        break;
      case"routing.create":
        result = {
          id: await actions.createRoutingPolicy({
            name: text(body, "name"),
            productId: typeof body.productId === "string" ? body.productId : undefined,
            serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
            category: typeof body.category === "string" ? body.category : undefined,
            region: typeof body.region === "string" ? body.region : undefined,
            priority: Number(body.priority ?? 100),
            targets: Array.isArray(body.targets) ? body.targets as Array<{
              accountId: string;
              identityId: string;
              priority: number;
              weight: number;
              rateLimit: number
            }> : []
          }, session.email)
        };
        status = 201;
        break;
      case"routing.simulate":
        result = await actions.simulateRouting({
          productId: typeof body.productId === "string" ? body.productId : undefined,
          serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
          category: typeof body.category === "string" ? body.category : undefined,
          region: typeof body.region === "string" ? body.region : undefined
        });
        break;
      case"routing.toggle":
        await actions.toggleRoutingPolicy(text(body, "id"), body.enabled === true, session.email);
        break;
      case"delivery.retry":
        await actions.manualRetryDelivery(text(body, "id"), body.acknowledgeDuplicateRisk === true, session.email);
        status = 202;
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
          serviceId: text(body, "serviceId"),
          recipient: text(body, "recipient"),
          category: text(body, "category"),
          senderProfile: typeof body.senderProfile === "string" && body.senderProfile ? body.senderProfile : undefined,
          subject: text(body, "subject"),
          html: typeof body.html === "string" && body.html ? body.html : undefined,
          text: typeof body.text === "string" && body.text ? body.text : undefined
        }, session.email);
        status = 202;
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
        result = {
          id: await actions.createCallback({
            serviceId: text(body, "serviceId"),
            name: text(body, "name"),
            url: text(body, "url"),
            secret: text(body, "secret"),
            events: strings(body.events)
          }, session.email)
        };
        status = 201;
        break;
      case"callback.toggle":
        await actions.toggleCallback(text(body, "id"), body.enabled === true, session.email);
        break;
      case"callback.rotate_secret":
        result = await actions.rotateCallbackSecret(text(body, "id"), text(body, "secret"), session.email);
        break;
      case"callback.test":
        result = { deliveryId: await actions.testCallback(text(body, "id"), session.email) };
        status = 202;
        break;
      case"callback.replay_dlq":
        result = { count: await actions.replayDeadLetters(session.email) };
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
      case"settings.update":
        await actions.updateSettings(object(body, "settings"), session.email);
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
    await recordRequest({
      method: "POST",
      path: "/api/admin/actions",
      statusCode: 422,
      durationMs: Date.now() - started,
      actor: session.email,
      details: { action: body.action, error: error instanceof Error ? error.message : "Action failed" }
    });
    return Response.json({ error: error instanceof Error ? error.message : "Action failed" }, { status: 422 })
  }
}
