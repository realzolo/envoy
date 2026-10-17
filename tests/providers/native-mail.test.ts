import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { simpleParser } from "mailparser";
import { providerRegistry } from "@/modules/providers/registry";
import { assertMessageCapabilities, buildMimeMessage, safeDiagnostic } from "@/modules/providers/shared";
import type { CanonicalMessage, ProviderSendContext, ProviderType } from "@/modules/providers/contracts";

const message: CanonicalMessage = {
  submissionId: "sub_native",
  from: { name: "业务服务", email: "mail@example.com" },
  to: [{ name: "Doe, Jane", email: "jane@example.net" }, { email: "other@example.net" }],
  cc: [{ email: "manager@example.net" }],
  bcc: [{ email: "private@example.net" }],
  replyTo: [{ name: "Support", email: "support@example.com" }, { email: "help@example.com" }],
  subject: "业务邮件：订单确认",
  html: '<p>确认<img src="cid:logo"/></p>',
  text: "订单确认",
  headers: { "X-Reference-ID": "order-123" },
  inReplyTo: "<original@example.com>",
  references: ["<first@example.com>", "<original@example.com>"],
  attachments: [
    { fileName: "订单.txt", contentType: "text/plain", content: Buffer.from("订单数据"), disposition: "attachment" },
    { fileName: "logo.png", contentType: "image/png", content: new Uint8Array([1, 2, 3]), contentId: "logo", disposition: "inline" }
  ],
  tags: { source: "order" }
};
const contexts: Record<ProviderType, ProviderSendContext> = {
  resend: { accountId: "pa", config: { type: "resend", schemaVersion: 1 }, secret: { type: "resend", apiKey: "re_test_key" } },
  ses: { accountId: "pa", config: { type: "ses", schemaVersion: 1, region: "us-east-1" }, secret: { type: "ses" } },
  sendgrid: { accountId: "pa", config: { type: "sendgrid", schemaVersion: 1, region: "global" }, secret: { type: "sendgrid", apiKey: "SG.test_key" } },
  mailgun: { accountId: "pa", config: { type: "mailgun", schemaVersion: 1, region: "us", sendingDomain: "mail.example.com" }, secret: { type: "mailgun", apiKey: "key-test-mailgun" } },
  postmark: { accountId: "pa", config: { type: "postmark", schemaVersion: 1, messageStream: "outbound" }, secret: { type: "postmark", serverToken: "postmark-key" } },
  mock: { accountId: "pa", config: { type: "mock", schemaVersion: 1, behavior: "deliver" }, secret: { type: "mock", token: "mock" } }
};
afterEach(() => vi.unstubAllGlobals());

describe("native outbound mail semantics", () => {
  it("round trips MIME Unicode, headers, roles, threading, attachments and inline content without exposing Bcc", async () => {
    const mime = buildMimeMessage(message);
    expect(Buffer.from(mime).toString()).not.toContain("private@example.net");
    const parsed = await simpleParser(Buffer.from(mime));
    expect(parsed.from?.value[0]).toEqual({ address: message.from.email, name: message.from.name });
    expect(parsed.to && !Array.isArray(parsed.to) ? parsed.to.value : []).toEqual(message.to.map(a => ({ address: a.email, name: a.name ?? "" })));
    expect(parsed.cc && !Array.isArray(parsed.cc) ? parsed.cc.value.map(a => a.address) : []).toEqual(["manager@example.net"]);
    expect(parsed.replyTo?.value.map(a => a.address)).toEqual(message.replyTo.map(a => a.email));
    expect(parsed.subject).toBe(message.subject);
    expect(parsed.text?.trim()).toBe(message.text);
    expect(parsed.inReplyTo).toBe(message.inReplyTo);
    expect(parsed.references).toEqual(message.references);
    expect(parsed.headers.get("x-reference-id")).toBe("order-123");
    expect(parsed.attachments.map(a => a.filename)).toEqual(["logo.png", "订单.txt"]);
    expect(parsed.attachments[0]).toMatchObject({ contentId: "<logo>", contentDisposition: "inline" });
    expect(parsed.attachments[1].content.toString()).toBe("订单数据");
  });
  it("folds long threading references and Unicode filenames without exceeding MIME line limits", async () => {
    const fileName = `${"业务".repeat(40)}.pdf`;
    const source = { ...message, references: Array.from({ length: 40 }, (_, index) => `<${index}-${"x".repeat(100)}@example.net>`), attachments: [{ ...message.attachments[0], fileName }] };
    const mime = Buffer.from(buildMimeMessage(source));
    expect(Math.max(...mime.toString().split("\r\n").map(line => Buffer.byteLength(line)))).toBeLessThanOrEqual(998);
    const parsed = await simpleParser(mime);
    expect(parsed.references).toEqual(source.references);
    expect(parsed.attachments[0].filename).toBe(fileName);
  });

  it.each(["resend", "sendgrid", "postmark"] as const)("maps all native fields into %s JSON protocol", async provider => {
    const fetchMock = vi.fn().mockResolvedValue(provider === "sendgrid" ? new Response(null, { status: 202, headers: { "x-message-id": "external" } }) : Response.json(provider === "postmark" ? { MessageID: "external", ErrorCode: 0 } : { id: "external" }));
    vi.stubGlobal("fetch", fetchMock);
    await providerRegistry(provider).sender.send(message, contexts[provider]);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    if (provider === "resend") {
      expect(payload.to).toEqual(['"Doe, Jane" <jane@example.net>', "other@example.net"]);
      expect(payload.cc).toEqual(["manager@example.net"]);
      expect(payload.bcc).toEqual(["private@example.net"]);
      expect(payload.reply_to).toHaveLength(2);
      expect(payload.headers).toMatchObject({ "In-Reply-To": message.inReplyTo, References: message.references.join(" ") });
      expect(payload.attachments[0]).toMatchObject({ filename: "订单.txt", content_type: "text/plain", content: Buffer.from("订单数据").toString("base64") });
      expect(payload.attachments[1].content_id).toBe("logo");
    } else if (provider === "sendgrid") {
      expect(payload.personalizations).toEqual([{ to: message.to, cc: message.cc, bcc: message.bcc, custom_args: message.tags }]);
      expect(payload.reply_to_list).toEqual(message.replyTo);
      expect(payload.content).toEqual([{ type: "text/plain", value: message.text }, { type: "text/html", value: message.html }]);
      expect(payload.headers["In-Reply-To"]).toBe(message.inReplyTo);
      expect(payload.attachments[1]).toMatchObject({ disposition: "inline", content_id: "logo" });
    } else {
      expect(payload.To).toBe('"Doe, Jane" <jane@example.net>, other@example.net');
      expect(payload.Cc).toBe("manager@example.net");
      expect(payload.Bcc).toBe("private@example.net");
      expect(payload.ReplyTo).toBe('"Support" <support@example.com>, help@example.com');
      expect(payload.Headers).toContainEqual({ Name: "In-Reply-To", Value: message.inReplyTo });
      expect(payload.Attachments[1]).toMatchObject({ ContentID: "cid:logo", Name: "logo.png" });
    }
  });

  it.each(["resend", "sendgrid", "postmark"] as const)("rejects %s subset retries before contacting upstream", async provider => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(providerRegistry(provider).sender.send({ ...message, envelopeRecipients: [message.cc[0]] }, contexts[provider])).rejects.toMatchObject({ code: "UNSUPPORTED_MAIL_FEATURE", outcome: "not_accepted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends a single text alternative in SendGrid without fabricating an HTML body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202, headers: { "x-message-id": "external" } }));
    vi.stubGlobal("fetch", fetchMock);
    await providerRegistry("sendgrid").sender.send({ ...message, html: undefined }, contexts.sendgrid);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content).toEqual([{ type: "text/plain", value: message.text }]);
  });
  it("rejects Resend-incompatible native tags during capability preflight", () => {
    expect(() => assertMessageCapabilities({ ...message, tags: { source: "业务系统" } }, providerRegistry("resend").descriptor.capabilities)).toThrow("native tag characters");
  });

  it("SES sends only the retry envelope while retaining original To/Cc and suppressing Bcc headers", async () => {
    const client = mockClient(SESv2Client);
    client.on(SendEmailCommand).resolves({ MessageId: "external" });
    try {
      await providerRegistry("ses").sender.send({ ...message, envelopeRecipients: [message.bcc[0]] }, contexts.ses);
      const payload = client.commandCalls(SendEmailCommand)[0].args[0].input;
      expect(payload.Destination).toEqual({ ToAddresses: ["private@example.net"] });
      const mime = Buffer.from(payload.Content!.Raw!.Data!);
      expect(mime.toString()).not.toContain("private@example.net");
      const parsed = await simpleParser(mime);
      expect(parsed.headers.get("to")).toBeDefined();
      expect(parsed.headers.get("cc")).toBeDefined();
      expect(parsed.headers.get("bcc")).toBeUndefined();
    } finally { client.restore(); }
  });

  it("Mailgun MIME sends only the retry envelope and retains full native MIME content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "external" }));
    vi.stubGlobal("fetch", fetchMock);
    await providerRegistry("mailgun").sender.send({ ...message, envelopeRecipients: [message.cc[0]] }, contexts.mailgun);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/messages\.mime$/);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.getAll("to")).toEqual(["manager@example.net"]);
    const parsed = await simpleParser(Buffer.from(await (form.get("message") as File).arrayBuffer()));
    expect(parsed.subject).toBe(message.subject);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.headers.has("bcc")).toBe(false);
  });

  it.each(["ses", "mailgun", "mock"] as const)("supports Bcc-only mail through %s without inventing a visible recipient", provider => {
    expect(() => assertMessageCapabilities({ ...message, to: [], cc: [] }, providerRegistry(provider).descriptor.capabilities)).not.toThrow();
  });

  it.each(["resend", "sendgrid", "postmark"] as const)("does not silently change Bcc-only semantics for %s", provider => {
    expect(() => assertMessageCapabilities({ ...message, to: [], cc: [] }, providerRegistry(provider).descriptor.capabilities)).toThrow("without a To recipient");
  });

  it("rejects reserved headers and CRLF attachment injection before transport", () => {
    const capabilities = providerRegistry("mock").descriptor.capabilities;
    expect(() => assertMessageCapabilities({ ...message, headers: { Bcc: "leak@example.net" } }, capabilities)).toThrow();
    expect(() => assertMessageCapabilities({ ...message, attachments: [{ ...message.attachments[0], fileName: "file\r\nBcc: victim@example.net" }] }, capabilities)).toThrow();
  });

  it("redacts credential fragments from safe diagnostics", () => {
    const value = safeDiagnostic('Rejected Bearer re_super_secret_key; apiKey="topsecret"; SG.more_secret_credentials');
    expect(value).not.toContain("super_secret");
    expect(value).not.toContain("topsecret");
    expect(value).not.toContain("more_secret");
  });
});

describe("actual RFC Message-ID confirmation",()=>{
 it("uses and confirms an explicit Postmark RFC header independently of the provider UUID",async()=>{
  const fetchMock=vi.fn().mockResolvedValue(Response.json({MessageID:"provider-uuid",ErrorCode:0}));vi.stubGlobal("fetch",fetchMock);
  const id="<attempt-123@example.com>";
  const result=await providerRegistry("postmark").sender.send({...message,rfcMessageId:id},contexts.postmark);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).Headers).toContainEqual({Name:"Message-ID",Value:id});
  expect(result).toMatchObject({externalMessageId:"provider-uuid",rfcMessageId:id});
 });
 it("confirms Mailgun's returned RFC ID but never guesses from an opaque provider identifier",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json({id:"<accepted@mail.example.com>"})).mockResolvedValueOnce(Response.json({id:"opaque"})));
  expect(await providerRegistry("mailgun").sender.send(message,contexts.mailgun)).toMatchObject({rfcMessageId:"<accepted@mail.example.com>"});
  expect(await providerRegistry("mailgun").sender.send(message,contexts.mailgun)).toMatchObject({rfcMessageId:null});
 });
 it("leaves SES's rewritten RFC ID unknown even when the generated MIME ID is known",async()=>{
  const ses=mockClient(SESv2Client);ses.on(SendEmailCommand).resolves({MessageId:"ses-external-id"});
  try {expect(await providerRegistry("ses").sender.send({...message,rfcMessageId:"<candidate@example.com>"},contexts.ses)).toMatchObject({externalMessageId:"ses-external-id",rfcMessageId:null});}finally{ses.restore();}
 });
 it.each(["sendgrid","resend"] as const)("does not substitute the %s external ID for an RFC ID",async provider=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(provider==="sendgrid" ? new Response(null,{status:202,headers:{"x-message-id":"external"}}) : Response.json({id:"external"})));
  const result=await providerRegistry(provider).sender.send({...message,rfcMessageId:"<candidate@example.com>"},contexts[provider]);
  expect(result).toMatchObject({externalMessageId:"external",rfcMessageId:null});
 });
});
