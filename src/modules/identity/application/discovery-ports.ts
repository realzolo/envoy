import type { ProviderType } from '@/integrations/providers/contracts';
import type { RepositoryResult } from './ports';
export interface DiscoveryRepository {
listDomainCapabilities(serviceId:string):Promise<RepositoryResult<{
    id:string;domain:string;status:string;domain_status:string;send_allowed:boolean;receive_allowed:boolean;revision:number;
    sending_configured:boolean;last_accepted_at:Date|null;last_delivered_at:Date|null;last_received_at:Date|null;
  }>>;
listInboundRoutes(serviceId:string):Promise<RepositoryResult<{domain_id:string;status:string;endpoint_status:string;security_configured:boolean;provider_type:ProviderType}>>;
findServiceCallback(serviceId:string):Promise<RepositoryResult<{id:string;status:string;subscribed_events:string[];last_delivered_at:Date|null;latest:{status:string;attemptCount:number;deliveredAt:string|null}|null}>>;
}
