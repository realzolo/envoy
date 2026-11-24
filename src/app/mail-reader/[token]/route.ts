import { randomBytes } from "node:crypto";
import { mailReader, renderReader } from "@/modules/mail-reader/public";
import { READER_HEADERS, readerOrigin, readerProblem } from "@/server/mail-reader";

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const { document, grant } = await mailReader.document(token);
    return new Response(renderReader(document, token, grant, readerOrigin(request), randomBytes(16).toString("hex")), {
      headers: {
        ...READER_HEADERS,
        "content-type": "text/html; charset=utf-8"
      }
    });
  } catch (error) {
    return readerProblem(error);
  }
}
