import type { ProviderModule, ProviderType } from "./contracts";
import { resendModule } from "./resend";
import { sesModule } from "./ses";
import { sendgridModule } from "./sendgrid";
import { mailgunModule } from "./mailgun";
import { postmarkModule } from "./postmark";
import { mockModule } from "./mock";

const modules = new Map<ProviderType, ProviderModule>([
  ["resend", resendModule], ["ses", sesModule], ["sendgrid", sendgridModule],
  ["mailgun", mailgunModule], ["postmark", postmarkModule], ["mock", mockModule],
]);

export function providerRegistry(type: ProviderType) {
  const providerModule = modules.get(type);
  if (!providerModule) throw new Error(`Unsupported provider type: ${type}`);
  return providerModule
}

export function providerDescriptors() {
  return [...modules.values()]
    .filter(providerModule => providerModule.descriptor.type !== "mock")
    .map(providerModule => providerModule.descriptor)
}
