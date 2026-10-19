import { ServiceConfigurationConflictError } from '@/modules/identity/contracts';
import { DuplicateRiskError,IdempotencyConflictError,MessageValidationError } from '@/modules/outbound/public';
import { z } from 'zod';
import { BodyTooLargeError } from './request-body';

type Failure={status:number;message:string;fields?:Record<string,string>};
/** PostgreSQL errors can be wrapped by Drizzle and by business transaction adapters. */
function databaseFailure(error:unknown){
  const seen=new Set<object>();let current=error;let wrapped=false;
  while(current&&typeof current==='object'&&!seen.has(current)){
    seen.add(current);
    const candidate=current as {code?:unknown;name?:unknown;constructor?:{name?:unknown};query?:unknown;params?:unknown;cause?:unknown};
    if(typeof candidate.code==='string'&&/^[0-9A-Z]{5}$/.test(candidate.code))return {code:candidate.code,wrapped:true};
    if(candidate.name==='DrizzleQueryError'||candidate.constructor?.name==='DrizzleQueryError'||('query' in candidate&&'params' in candidate))wrapped=true;
    current=candidate.cause;
  }
  return wrapped?{code:null,wrapped:true}:null;
}
export function adminMutationFailure(error:unknown):Failure{
  const database=databaseFailure(error);
  if(database){
    const status=database.code==='23505'?409:database.code&&/^(08|53|57)/.test(database.code)?503:500;
    return {status,message:status===409?'This configuration already exists.':status===503?'The database is temporarily unavailable.':'The operation could not be completed. Check the server logs.'};
  }
  if(error instanceof ServiceConfigurationConflictError||error instanceof IdempotencyConflictError||error instanceof DuplicateRiskError)return {status:409,message:error instanceof IdempotencyConflictError?'This submission key has already been used with different content.':error.message};
  if(error instanceof BodyTooLargeError)return {status:413,message:error.message};
  if(error instanceof SyntaxError)return {status:400,message:'Invalid JSON request body.'};
  if(error instanceof z.ZodError)return {status:422,message:'Check the highlighted fields.',fields:Object.fromEntries(error.issues.map(issue=>[issue.path.join('.'),issue.message]))};
  return {status:422,message:error instanceof MessageValidationError?error.issues.join('; '):error instanceof Error?error.message:'Action failed'};
}
