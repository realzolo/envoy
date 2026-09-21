export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    name: "Envoy Service API",
    version: "v1",
    authentication: "Bearer service credential",
    contentOwnership: "Callers submit rendered subject, HTML, and/or plain text. Envoy does not manage business templates.",
    openapi: `${origin}/api/v1/openapi.json`,
    resources: {
      messages: `${origin}/api/v1/messages`,
      deliveries: `${origin}/api/v1/deliveries`,
      events: `${origin}/api/v1/events`,
      inboundMessages: `${origin}/api/v1/inbound-messages`,
      suppressions: `${origin}/api/v1/suppressions`,
      senders: `${origin}/api/v1/senders`,
      capabilities: `${origin}/api/v1/capabilities`,
    },
  });
}
