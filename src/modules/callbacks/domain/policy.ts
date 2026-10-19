export class CallbackUrlPolicyError extends Error {}

export function callbackFailure(attempt: number, terminal: boolean) {
  return { dead: terminal || attempt >= 10, delaySeconds: Math.min(3600, 60 * 2 ** (attempt - 1)) };
}
