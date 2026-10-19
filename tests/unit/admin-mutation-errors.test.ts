import {describe,expect,it} from 'vitest';
import {z} from 'zod';
import {adminMutationFailure} from '@/server/admin-mutation-errors';

function wrappedDatabaseError(code?:string){
  const cause=code?Object.assign(new Error('duplicate key includes secret=ev_live_private'),{code}):undefined;
  return Object.assign(new Error('Failed query: INSERT credentials; params: ev_live_private'),{name:'DrizzleQueryError',query:'INSERT credentials',params:['ev_live_private'],cause});
}
describe('admin database error boundary',()=>{
  it.each([['23505',409],['08006',503],['53300',503],['57014',503],['23503',500]])('classifies nested SQLSTATE %s without exposing query or parameters',(code,status)=>{
    const failure=adminMutationFailure(new Error('transaction failed',{cause:wrappedDatabaseError(code)}));
    expect(failure.status).toBe(status);
    expect(JSON.stringify(failure)).not.toMatch(/INSERT|credentials|params|ev_live_private|secret=/);
  });
  it('fails closed for a Drizzle failure without SQLSTATE, including circular causes',()=>{
    const error=wrappedDatabaseError();Object.assign(error,{cause:error});
    expect(adminMutationFailure(error)).toEqual({status:500,message:'The operation could not be completed. Check the server logs.'});
  });
  it('preserves business validation messages and field errors',()=>{
    expect(adminMutationFailure(new Error('Disable callback delivery before replacing its secret'))).toEqual({status:422,message:'Disable callback delivery before replacing its secret'});
    const parsed=z.object({name:z.string().min(2)}).safeParse({name:''});
    expect(parsed.success).toBe(false);
    if(!parsed.success)expect(adminMutationFailure(parsed.error)).toMatchObject({status:422,fields:{name:expect.any(String)}});
  });
});
