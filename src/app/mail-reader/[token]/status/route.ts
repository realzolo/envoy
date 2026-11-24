import { mailReader } from "@/modules/mail-reader/public";
import { READER_HEADERS, readerProblem } from "@/server/mail-reader";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    return Response.json(await mailReader.status((await context.params).token), { headers: READER_HEADERS });
  } catch (error) {
    return readerProblem(error);
  }
}
