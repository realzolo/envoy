import { POST as receiveProviderEvent } from "../../../[provider]/[endpointId]/route";

export const runtime = "nodejs";

export function POST(request: Request, { params }: { params: Promise<{ endpointId: string }> }) {
  return receiveProviderEvent(request, { params: params.then(({ endpointId }) => ({ provider: "mailgun", endpointId })) });
}
