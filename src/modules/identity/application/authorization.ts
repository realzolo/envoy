import type { TransactionContext } from '@/platform/transactions';
export interface AuthorizationRepository {
  authorizedSendingDomain(serviceId:string,domain:string):Promise<string|null>;
  canAccessInbound(id:string,serviceId:string):Promise<boolean>;
}
export function createAuthorizationService(repositoryFor:(context?:TransactionContext)=>AuthorizationRepository){
  return {
    authorizedSendingDomain(serviceId:string,domain:string,context?:TransactionContext){return repositoryFor(context).authorizedSendingDomain(serviceId,domain);},
    canAccessInbound(id:string,serviceId:string,context?:TransactionContext){return repositoryFor(context).canAccessInbound(id,serviceId);},
  };
}
