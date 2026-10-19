import { authenticateServiceKey } from '@/modules/identity/public';
export type { ServiceIdentity } from '@/modules/identity/contracts';
/** HTTP adapter: service credential verification belongs to the identity use case. */
export async function authenticateService(request:Request){
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer '))return null;
  return authenticateServiceKey(authorization.slice('Bearer '.length));
}
