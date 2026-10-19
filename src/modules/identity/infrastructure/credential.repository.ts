import { database } from '@/platform/database';
import { products,serviceCredentials,services } from '@/platform/database/schema/identity';
import { and,eq,gt,isNull,lte,or,sql } from 'drizzle-orm';
import type { CredentialRepository } from '../application/authentication';

export const credentialRepository:CredentialRepository={
  async findActiveCredential(keyHash){
    const rows=await database().select({credentialId:serviceCredentials.id,serviceId:services.id,serviceName:services.name,productId:services.productId,productName:products.name,suppressionManagement:services.suppressionManagementAllowed})
      .from(serviceCredentials).innerJoin(services,eq(services.id,serviceCredentials.serviceId)).innerJoin(products,eq(products.id,services.productId))
      .where(and(eq(serviceCredentials.keyHash,keyHash),eq(serviceCredentials.status,'active'),lte(serviceCredentials.validFrom,sql`now()`),or(isNull(serviceCredentials.validTo),gt(serviceCredentials.validTo,sql`now()`)),eq(products.status,'active'))).limit(1);
    return rows[0]??null;
  },
  async recordUsage(credentialId){
    await database().update(serviceCredentials).set({lastUsedAt:sql`now()`}).where(and(eq(serviceCredentials.id,credentialId),or(isNull(serviceCredentials.lastUsedAt),sql`${serviceCredentials.lastUsedAt}<now()-interval '5 minutes'`)));
  },
};
