import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderSendContext, ProviderType } from "@/modules/providers/contracts";

const contexts = {
  sendgrid: { accountId: "pa",config: { type: "sendgrid",schemaVersion: 1,region: "global" },secret: { type: "sendgrid",apiKey: "test-key" } },
  mailgun: { accountId: "pa",config: { type: "mailgun",schemaVersion: 1,region: "us",sendingDomain: "example.test" },secret: { type: "mailgun",apiKey: "test-key" } },
  postmark: { accountId: "pa",config: { type: "postmark",schemaVersion: 1,messageStream: "outbound" },secret: { type: "postmark",serverToken: "test-key" } },
  ses: { accountId: "pa",config: { type: "ses",schemaVersion: 1,region: "us-east-1" },secret: { type: "ses" } },
  resend: { accountId: "pa",config: { type: "resend",schemaVersion: 1 },secret: { type: "resend",apiKey: "re_test_key" } },
} satisfies Partial<Record<ProviderType,ProviderSendContext>>;
const headers = { "Message-ID": "<original@example.net>","Reply-To": '"Doe, Jane" <reply@example.net>, other@example.net',"In-Reply-To": "<parent@example.net>",References: "<root@example.net> <parent@example.net>" };
const expected = { messageId: "<original@example.net>",replyTo: ["reply@example.net","other@example.net"],inReplyTo: "<parent@example.net>",references: ["<root@example.net>","<parent@example.net>"] };
const rawHeaders = Object.entries(headers).map(([key,value]) => `${key}: ${value}`).join("\r\n");
const receipt = (parsed: unknown,nativeType = "inbound") => ({ valid: true,replaySafe: true,nativeType,providerEventId: "receipt-id",parsed });
afterEach(() => vi.unstubAllGlobals());

describe("inbound provider ownership and RFC fields", () => {
  it("uses SendGrid envelope.to, preserves header lists, and supports raw MIME mode", async () => {
    const adapter = providerRegistry("sendgrid");
    const parsed = { from: "sender@example.net",to: '"Doe, Jane" <visible@example.net>, other@example.net',headers: rawHeaders,envelope: JSON.stringify({ to: ["hidden@example.test","alias@example.test"] }),subject: "Hello" };
    expect(await adapter.inbound!.receive(receipt(parsed),contexts.sendgrid)).toMatchObject({ ...expected,envelopeRecipients: ["hidden@example.test","alias@example.test"],to: ["visible@example.net","other@example.net"] });
    expect((await adapter.inbound!.receive(receipt({ ...parsed,envelope: "invalid" }),contexts.sendgrid))!.envelopeRecipients).toBeUndefined();
    expect((await adapter.inbound!.receive(receipt({ ...parsed,envelope: JSON.stringify({ to: ["valid@example.test",123] }) }),contexts.sendgrid))!.envelopeRecipients).toBeUndefined();
    const mime = `${rawHeaders}\r\nFrom: sender@example.net\r\nTo: visible@example.net\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRaw content`;
    expect(await adapter.inbound!.receive(receipt({ envelope: parsed.envelope,email: mime }),contexts.sendgrid)).toMatchObject({ ...expected,to: ["visible@example.net"],text: "Raw content",envelopeRecipients: ["hidden@example.test","alias@example.test"] });
  });
  it("uses Mailgun recipient without falling back to To, and deduplicates transport receipts separately from RFC Message-ID", async () => {
    const adapter = providerRegistry("mailgun");
    const parsed = { from: "author@example.net",sender: "bounce@example.net",recipient: "hidden@example.test",To: "forged@example.test","message-headers": JSON.stringify([...Object.entries(headers),["To","visible@example.net"]]) };
    const mail = await adapter.inbound!.receive(receipt(parsed),contexts.mailgun);
    expect(mail).toMatchObject({ ...expected,externalMessageId: "receipt-id",from: "author@example.net",envelopeRecipients: ["hidden@example.test"],to: ["visible@example.net"] });
    expect((await adapter.inbound!.receive(receipt({ ...parsed,recipient: "" }),contexts.mailgun))!.envelopeRecipients).toBeUndefined();
  });
  it("uses Postmark OriginalRecipient and keeps its provider ID separate from RFC Message-ID", async () => {
    const adapter = providerRegistry("postmark");
    const parsed = { RecordType: "Inbound",MessageID: "provider-uuid",OriginalRecipient: "alias@example.test",To: "visible@example.net",ReplyTo: headers["Reply-To"],Headers: Object.entries(headers).map(([Name,Value]) => ({ Name,Value })) };
    expect(await adapter.inbound!.receive(receipt(parsed),contexts.postmark)).toMatchObject({ ...expected,externalMessageId: "provider-uuid",envelopeRecipients: ["alias@example.test"] });
    expect(await adapter.inbound!.receive(receipt({ ...parsed,ReplyTo: undefined }),contexts.postmark)).toMatchObject(expected);
    const missing = await adapter.inbound!.receive(receipt({ ...parsed,OriginalRecipient: undefined,Headers: [] }),contexts.postmark);
    expect(missing!.messageId).toBeUndefined();
    expect(missing!.envelopeRecipients).toBeUndefined();
  });
  it("uses SES receipt recipients rather than mail.destination or MIME To/Cc", async () => {
    const s3 = mockClient(S3Client);
    const mime = `${rawHeaders}\r\nFrom: sender@example.net\r\nTo: visible@example.net, other@example.net\r\n\r\nHello`;
    s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => Buffer.from(mime) } as never });
    try {
      const parsed = { Message: JSON.stringify({ mail: { messageId: "ses-provider-id",destination: ["forged@example.test"] },receipt: { recipients: ["hidden@example.test"],action: { type: "S3",bucketName: "test-bucket",objectKey: "test-key" } } }) };
      expect(await providerRegistry("ses").inbound!.receive(receipt(parsed),contexts.ses)).toMatchObject({ ...expected,externalMessageId: "ses-provider-id",envelopeRecipients: ["hidden@example.test"],to: ["visible@example.net","other@example.net"] });
    } finally { s3.restore(); }
  });
  it.each(["Mon, 01 Jan 1900 00:00:00 +0000","Tue, 01 Jan 2200 00:00:00 +0000","definitely invalid",null])("keeps SES author Date separate from receipt time (%s)",async date=>{
    const s3=mockClient(S3Client);
    const mime=`From: sender@example.net\r\nTo: visible@example.net\r\n${date ? `Date: ${date}\r\n` : ""}\r\nbody`;
    s3.on(GetObjectCommand).resolves({Body:{transformToByteArray:async()=>Buffer.from(mime)} as never});
    try {
      const parsed={Message:JSON.stringify({mail:{messageId:"ses-date"},receipt:{recipients:["trusted@example.test"],action:{type:"S3",bucketName:"test",objectKey:"test"}}})};
      const mail=(await providerRegistry("ses").inbound!.receive(receipt(parsed),contexts.ses))!;
      expect(Number.isFinite(mail.receivedAt.getTime())).toBe(true);
      expect(mail.receivedAt.getUTCFullYear()).not.toBe(1900);expect(mail.receivedAt.getUTCFullYear()).not.toBe(2200);
      if(date && date!=="definitely invalid") expect(mail.authorDate?.toISOString()).toBe(new Date(date).toISOString());
      else expect(mail.authorDate).toBeNull();
    } finally{s3.restore();}
  });
  it("retains Resend standard fields but does not infer SMTP ownership from its To/Bcc/headers", async () => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({ id: "received-id",message_id: headers["Message-ID"],from: "sender@example.net",to: ["visible@example.test"],cc: [],bcc: ["hidden@example.test"],headers: { ...headers,"Delivered-To": "forged@example.test" },subject: "Hello",created_at: new Date().toISOString(),attachments: [] })));
    const mail = await providerRegistry("resend").inbound!.receive(receipt({ data: { email_id: "received-id" } }),contexts.resend);
    expect(mail).toMatchObject(expected);
    expect(mail!.envelopeRecipients).toBeUndefined();
  });
});
