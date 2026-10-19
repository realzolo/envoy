import { adminMutation,text } from '@/server/admin-mutation';
import { createRoutingPolicy,toggleRoutingPolicy } from '@/modules/outbound/public';


export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{
    const result = { id: await createRoutingPolicy({
      name:text(body,"name"),
      productId:typeof body.productId==="string"?body.productId:undefined,
      serviceId:typeof body.serviceId==="string"?body.serviceId:undefined,
      domainId:text(body,"domainId"),
      category:typeof body.category==="string"?body.category:undefined,
      priority:Number(body.priority??100),
      targets:Array.isArray(body.targets)?body.targets as Array<{accountId:string;identityId:string;priority:number;weight:number;rateLimit:number}>:[],
    },actor,text(body,"id")) };
    return {result,status:200};
},parameters);
}

export async function PATCH(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await toggleRoutingPolicy(text(body, "id"), body.enabled === true, actor);
        
return {result,status};},parameters);
}
