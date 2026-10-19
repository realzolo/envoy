import type { ServiceIdentity } from '../contracts';

export type AuthenticatedCredential = {credentialId:string;serviceId:string;serviceName:string;productId:string;productName:string;suppressionManagement:boolean};
export interface CredentialRepository {
  findActiveCredential(keyHash:string):Promise<AuthenticatedCredential|null>;
  recordUsage(credentialId:string):Promise<void>;
}
export function createServiceAuthenticator(repository:CredentialRepository,dependencies:{hashKey:(key:string)=>string;requestsPerMinute:number;reportUsageFailure:(error:unknown)=>void}) {
  return async function authenticateServiceKey(key:string):Promise<ServiceIdentity|null>{
    if(key.length<12||key.length>256)return null;
    const credential=await repository.findActiveCredential(dependencies.hashKey(key));
    if(!credential)return null;
    void repository.recordUsage(credential.credentialId).catch(dependencies.reportUsageFailure);
    return {serviceId:credential.serviceId,serviceName:credential.serviceName,productId:credential.productId,product:credential.productName,suppressionManagement:credential.suppressionManagement,rateLimitPerMinute:dependencies.requestsPerMinute};
  };
}
