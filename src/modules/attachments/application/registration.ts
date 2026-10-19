
import type { AttachmentRepositories } from "./ports";


export function createRegistrationService() {
async function registerAttachment(client: AttachmentRepositories, id: string, kind: "outbound" | "inbound", serviceId: string | null, sha256: string) {
  const scope = serviceId ?? "administrator";
  await client.registration.ensureScanScope({ scope: scope });
  await client.registration.registerSafety({ id: id, kind: kind, serviceId: serviceId, scope: scope, sha256: sha256 });
}
return { registerAttachment };
}
