import { providerRegistry } from "@/integrations/providers/public";
import type { ServiceIdentity } from "../contracts";
import type { DiscoveryRepository } from './discovery-ports';



const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Discovery separates permission, configured transport and historical evidence. */
export function createDiscoveryService(repository:DiscoveryRepository){return async function discoverMail(identity: ServiceIdentity) {
  const grants = (await repository.listDomainCapabilities(identity.productId,identity.serviceId)).rows;
  const routes = (await repository.listInboundRoutes(identity.productId,identity.serviceId)).rows;
  const callback = (await repository.findServiceCallback(identity.productId,identity.serviceId)).rows[0];
  return {
    kind:"domain_permissions" as const,
    domains:grants.map(row=>{
      const active=row.status==='active';
      const sendingReasons=[...(!active||!row.send_allowed?['DOMAIN_SEND_NOT_AUTHORIZED']:[]),...(row.domain_status!=='active'?['SENDING_DOMAIN_DISABLED']:[]),...(!row.sending_configured?['NO_ELIGIBLE_ROUTE']:[])];
      const ownRoutes=routes.filter(route=>route.domain_id===row.id);
      const ingress=ownRoutes.some(route=>route.status==='active'&&route.endpoint_status==='active'&&route.security_configured&&providerRegistry(route.provider_type).descriptor.capabilities.inboundEnvelopeRecipients);
      const receivingReasons=[...(!active||!row.receive_allowed?['DOMAIN_RECEIVE_NOT_AUTHORIZED']:[]),...(row.domain_status!=='active'?['INBOUND_DOMAIN_DISABLED']:[]),...(!ingress?['INBOUND_INGRESS_UNAVAILABLE']:[])];
      const notificationReasons=callback?[...(callback.status!=='active'?['CALLBACK_DISABLED']:[]),...(!callback.subscribed_events.includes('inbound.received')?['CALLBACK_EVENT_NOT_SUBSCRIBED']:[])]:[];
      return {id:row.id,domain:row.domain,authorization:active?'granted' as const:'revoked' as const,revision:row.revision,
        permissions:{send:active&&row.send_allowed,receive:active&&row.receive_allowed},
        sending:{state:sendingReasons.length?'unavailable' as const:'configured' as const,reasonCodes:sendingReasons},
        receiving:{state:receivingReasons.length?'unavailable' as const:'configured' as const,reasonCodes:receivingReasons},
        notification:{mode:callback?'callback_and_polling' as const:'polling' as const,state:notificationReasons.length?'unavailable' as const:'configured' as const,reasonCodes:notificationReasons},
        evidence:{lastAcceptedAt:iso(row.last_accepted_at),lastDeliveredAt:iso(row.last_delivered_at),lastReceivedAt:iso(row.last_received_at)}};
    }),
    callbacks:{configuration:callback?.status==='active'?'configured' as const:'unavailable' as const,latest:callback?.latest??null,lastDeliveredAt:iso(callback?.last_delivered_at??null),businessProcessing:'unknown' as const},
  };
}

}
