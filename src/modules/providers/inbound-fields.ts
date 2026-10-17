import { simpleParser, type AddressObject } from "mailparser";

export function smtpRecipients(input: unknown): string[] | undefined {
  return Array.isArray(input) && input.every(item => typeof item === "string") ? input : undefined;
}

export function mailAddresses(value: AddressObject | AddressObject[] | undefined) {
  return (value ? (Array.isArray(value) ? value : [value]) : []).flatMap(group => group.value.flatMap(item => item.address ? [item.address] : []));
}

/** mailparser replaces invalid Date values with now(); validate the original header instead. */
export function declaredAuthorDate(parsed: { headerLines: readonly {key:string;line:string}[] }) {
  const dates=parsed.headerLines.filter(header=>header.key.toLowerCase()==="date");
  if(dates.length!==1) return null;
  const raw=dates[0].line.replace(/^date:/i,"").replace(/\r?\n[ \t]+/g," ").trim();
  const value=new Date(raw);
  return raw && Number.isFinite(value.getTime()) ? value : null;
}

/** Parse standard content headers only. They are never evidence of SMTP ownership. */
export async function inboundHeaders(input: unknown) {
  const raw = typeof input === "string" ? input : (Array.isArray(input) ? input.map(item =>
    Array.isArray(item) ? item : [item?.Name, item?.Value]) : Object.entries((input ?? {}) as object))
    .filter(([name, value]) => typeof name === "string" && typeof value === "string")
    .map(([name, value]) => `${name}: ${String(value).replace(/\r?\n(?![ \t])/g, " ")}`).join("\r\n");
  const parsed = await simpleParser(`${raw}\r\n\r\n`);
  return {
    authorDate: declaredAuthorDate(parsed),
    messageId: parsed.messageId,
    replyTo: mailAddresses(parsed.replyTo),
    inReplyTo: parsed.inReplyTo,
    references: typeof parsed.references === "string" ? [parsed.references] : parsed.references ?? [],
    to: mailAddresses(parsed.to), cc: mailAddresses(parsed.cc),
  };
}
