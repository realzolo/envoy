import { describe, expect, it } from "vitest";
import { createMessageSchema, retryMessageSchema } from "@/lib/contracts";
import { GET as openapi } from "@/app/api/v1/openapi.json/route";
const base = { from: { email: "sender@company.com", name: "订单服务" }, text: "Hello" };

describe("native mail contract", () => {
  it("allows Bcc-only email, empty subject and preserves caller text", () => {
    const parsed = createMessageSchema.parse({ ...base, bcc: [{ email: "archive@company.com" }], subject: "  Subject  ", replyTo: [{ email: "reply@company.com", name: "回复" }] });
    expect(parsed.subject).toBe("  Subject  ");
    expect(parsed.to).toEqual([]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.replyTo[0].name).toBe("回复");
    expect(createMessageSchema.parse({ ...base, bcc: parsed.bcc }).subject).toBe("");
  });
  it("requires a caller-supplied sender and recipient independently of presets", () => {
    expect(createMessageSchema.safeParse({ ...base, senderProfile: "preset", to: [{ email: "a@example.com" }] }).success).toBe(false);
    expect(createMessageSchema.safeParse(base).success).toBe(false);
    expect(createMessageSchema.safeParse({ text: "Hi", to: [{ email: "a@example.com" }] }).success).toBe(false);
  });
  it("enforces a total recipient limit and prevents duplicates across visible and hidden roles", () => {
    expect(createMessageSchema.safeParse({ ...base, to: [{ email: "A@example.com" }], cc: [{ email: "a@example.com" }] }).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...base, to: Array.from({ length: 30 }, (_, n) => ({ email: `to${n}@example.com` })), bcc: Array.from({ length: 21 }, (_, n) => ({ email: `bcc${n}@example.com` })) }).success).toBe(false);
  });
  it.each(["From", "Bcc", "Return-Path", "DKIM-Signature", "X-Envoy-Tracking", "Content-Type", "References", "X-SES-CONFIGURATION-SET"])("rejects reserved %s headers", name => {
    expect(createMessageSchema.safeParse({ ...base, to: [{ email: "a@example.com" }], headers: { [name]: "spoofed" } }).success).toBe(false);
  });
  it("rejects header injection and duplicate case-insensitive headers", () => {
    const input = { ...base, to: [{ email: "a@example.com" }] };
    expect(createMessageSchema.safeParse({ ...input, subject: "hi\r\nBcc: evil@example.net" }).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...input, from: { ...base.from, name: "hello\nBcc: evil" } }).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...input, headers: { "X-Custom": "one", "x-custom": "two" } }).success).toBe(false);
  });
  it("supports attachment references and conversation headers with explicit validation", () => {
    const input = { ...base, to: [{ email: "a@example.com" }], attachments: [{ fileId: "file_1", disposition: "inline", contentId: "logo" }], inReplyTo: "<old@company.com>", references: ["<root@company.com>"] };
    expect(createMessageSchema.parse(input).attachments[0].contentId).toBe("logo");
    expect(createMessageSchema.safeParse({ ...input, attachments: [{ fileId: "file_1", disposition: "inline" }] }).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...input, attachments: [{ fileId: "file_1", fileName: "../secret" }] }).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...input, attachments: [{ fileId: "file_1", disposition: "attachment", contentId: "logo" }] }).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...input, inReplyTo: "<old@company.com>\nInjected: x" }).success).toBe(false);
  });
  it("allows targeted retry selection while requiring unique delivery IDs", () => {
    expect(retryMessageSchema.parse({ deliveryIds: ["dlv_failed"] }).acknowledgeDuplicateRisk).toBe(false);
    expect(retryMessageSchema.safeParse({ deliveryIds: ["d", "d"] }).success).toBe(false);
  });
  it("publishes only the final native contract and diagnostics API", async () => {
    const document = await openapi(new Request("https://envoy.test/api/v1/openapi.json")).json();
    const create = document.components.schemas.CreateMessage;
    expect(create.required).toContain("from");
    expect(create.properties.senderProfile).toBeUndefined();
    for (const key of ["from", "to", "cc", "bcc", "replyTo", "attachments", "headers", "inReplyTo", "references"]) expect(create.properties[key]).toBeDefined();
    for (const key of ["/files", "/files/{id}", "/requests/{requestId}", "/messages/{id}/attempts", "/messages/{id}/events"]) expect(document.paths[key]).toBeDefined();
    expect(document.paths["/senders"]).toBeUndefined();
    expect(document.paths["/messages/{id}/retry"].post.parameters.some((p: {name:string;required?:boolean}) => p.name === "Idempotency-Key" && p.required)).toBe(true);
  });
});
