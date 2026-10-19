import { setDomainInboundSources } from '@/modules/channels/public';
import { adminMutation,text } from '@/server/admin-mutation';

export async function PUT(request: Request, context: {params: Promise<{id:string}>}) {
  const parameters = await context.params;
  return adminMutation(request, async (body, actor) => {
    await setDomainInboundSources(text(body, "id"), body.accountIds, actor);
    return {result: null, status: 200};
  }, parameters);
}
