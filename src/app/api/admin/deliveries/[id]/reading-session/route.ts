import { mailReader } from "@/modules/mail-reader/public";
import { getAdminSession } from "@/server/admin-auth";
import { READER_HEADERS, readerOrigin, readerProblem } from "@/server/mail-reader";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return Response.json({ error: "Unauthorized" }, {
    status: 401,
    headers: READER_HEADERS
  });
  try {
    return Response.json(await mailReader.issue({
      kind: "OUTBOUND",
      id: (await context.params).id,
      serviceId: null
    }, readerOrigin(request)), { headers: READER_HEADERS });
  } catch (error) {
    return readerProblem(error);
  }
}
