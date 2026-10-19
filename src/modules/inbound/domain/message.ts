export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** Permanent message or domain binding failures should not consume worker retries. */
export class InboundTerminalError extends Error {
  constructor(message: string, public code = "INBOUND_REJECTED") {
    super(message);
    this.name = "InboundTerminalError";
  }
}


export function address(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase()
}

export function authorDate(value:Date|null|undefined) {
  // RFC content dates outside PostgreSQL's portable four-digit ISO range stay unknown.
  return value && Number.isFinite(value.getTime()) && value.getUTCFullYear()>=1 && value.getUTCFullYear()<=9999 ? value.toISOString() : null;
}

