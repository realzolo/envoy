import { adminMutation,text } from '@/server/admin-mutation';
import { createRoutingPolicy } from '@/modules/outbound/public';
export async function POST(request:Request){return adminMutation(request,async(body,actor)=>{
    const result = { id: await createRoutingPolicy({
      name:text(body,"name"),
      services: body.services as {mode:"all"|"selected";serviceIds:string[]}|undefined,
      domainId:text(body,"domainId"),
      category:typeof body.category==="string"?body.category:undefined,
      priority:Number(body.priority??100),
      targets:Array.isArray(body.targets)?body.targets as Array<{accountId:string;identityId:string;priority:number;weight:number;rateLimit:number}>:[],
    },actor,undefined) };
    return {result,status:201};
});}
