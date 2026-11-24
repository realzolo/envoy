import { adminMutation, text } from '@/server/admin-mutation';
import { deleteIdentity, toggleIdentity } from '@/modules/channels/public';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const parameters = await context.params;
  return adminMutation(request, async (body, actor) => {
    const result: unknown = null;
    const status = 200;
    await toggleIdentity(text(body, "id"), body.enabled === true, actor);

    return { result, status };
  }, parameters);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const parameters = await context.params;
  return adminMutation(request, async (body, actor) => ({
    result: await deleteIdentity(text(body, "id"), actor),
    status: 200
  }), parameters);
}
