const MAX_RFC_MESSAGE_ID_CHARACTERS = 998;

/** A provider's actual RFC header is distinct from its opaque email/external ID. */
export function confirmedRfcMessageId(value: unknown): string | null {
    return typeof value === "string" && value.length <= MAX_RFC_MESSAGE_ID_CHARACTERS
        && /^<[^<>\s@\x00-\x1f\x7f-\x9f]+@[^<>\s@\x00-\x1f\x7f-\x9f]+>$/u.test(value) ? value : null;
}
