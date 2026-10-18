import { AsyncLocalStorage } from "node:async_hooks";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { CanonicalProviderError } from "./contracts";
import { assertSendDeadline, SendDeadlineError } from "@/modules/core/message/policy";

type SubmissionPolicy = { sendBefore: Date | null; sensitive: boolean; beforeSend: () => Promise<void> };
const policies = new AsyncLocalStorage<SubmissionPolicy>();
export const submissionPolicy = () => policies.getStore();
export function runWithSubmissionPolicy<T>(policy: SubmissionPolicy, operation: () => Promise<T>) {
  return policies.run(policy, operation);
}

/** Establish DNS/TLS first; do not write HTTP headers/body until the final authorization/deadline check. */
export async function boundedProviderRequest(url: URL, options: { method: string; headers: Record<string, string>; body: Uint8Array | string }): Promise<IncomingMessage> {
  const policy = submissionPolicy();
  assertSendDeadline(policy?.sendBefore);
  return new Promise((resolve, reject) => {
    let writing = false;
    const transport = httpsRequest(url, { method: options.method, headers: options.headers, agent: false }, resolve);
    const remaining = policy?.sendBefore ? policy.sendBefore.getTime() - Date.now() : 30_000;
    const timer = setTimeout(() => {
      const expired = Boolean(policy?.sendBefore && policy.sendBefore.getTime() <= Date.now());
      transport.destroy(writing ? new Error("Provider response deadline exceeded") : expired ? new SendDeadlineError()
        : new CanonicalProviderError("Provider connection timed out before HTTP submission.", "network", "PROVIDER_CONNECTION_UNAVAILABLE", "not_accepted", true));
    }, Math.max(1, Math.min(30_000, remaining)));
    const cleanup = () => clearTimeout(timer);
    transport.once("error", error => {
      cleanup();
      reject(!writing && !(error instanceof SendDeadlineError) && !(error instanceof CanonicalProviderError)
        ? new CanonicalProviderError("Provider connection failed before HTTP submission.", "network", "PROVIDER_CONNECTION_UNAVAILABLE", "not_accepted", true) : error);
    });
    transport.once("response", response => { response.once("end", cleanup); response.once("error", cleanup); });
    transport.once("socket", socket => {
      socket.once("secureConnect", () => {
        void (async () => {
          await policy?.beforeSend();
          assertSendDeadline(policy?.sendBefore);
          writing = true;
          transport.end(options.body);
        })().catch(error => transport.destroy(error instanceof SendDeadlineError ? error
          : new CanonicalProviderError("The final submission authorization/lease guard rejected the message.", "policy", "SUBMISSION_GUARD_REJECTED", "not_accepted", false, { stage: "authorization" })));
      });
    });
  });
}
export function responseHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(", ") : value);
  return result;
}
