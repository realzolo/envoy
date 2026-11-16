import { afterEach, describe, expect, it, vi } from "vitest";
import { resendIdentityStatus, resendModule } from "@/integrations/providers/resend";
import type { ProviderSendContext } from "@/integrations/providers/contracts";

const context: ProviderSendContext = {
  accountId: "pa_resend",
  config: { type: "resend", schemaVersion: 1 },
  secret: { type: "resend", apiKey: "test-resend-key" },
};
afterEach(() => vi.unstubAllGlobals());

describe("Resend identity status mapping", () => {
  it("keeps incomplete Resend domain states ineligible for routing", () => {
    expect(resendIdentityStatus("verified")).toBe("verified");
    expect(resendIdentityStatus("failed")).toBe("failed");
    expect(resendIdentityStatus("not_started")).toBe("pending");
    expect(resendIdentityStatus("partially_verified")).toBe("pending");
    expect(resendIdentityStatus("partially_failed")).toBe("pending");
  });
});

describe("Resend domain association", () => {
  it("reuses an existing domain on a later page and retrieves its current verification and DNS records", async () => {
    const records = [{ type: "TXT", name: "resend._domainkey", value: "dkim", status: "verified" }];
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "first", name: "other.example" }], has_more: true }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "existing", name: "Mail.Example.com", status: "pending" }], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "existing", name: "mail.example.com", status: "verified", records }));
    vi.stubGlobal("fetch", transport);

    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).resolves.toEqual({
      externalIdentityId: "existing", status: "verified", dnsRecords: records,
    });
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.resend.com/domains?limit=100",
      "https://api.resend.com/domains?limit=100&after=first",
      "https://api.resend.com/domains/existing",
    ]);
    expect(transport.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });

  it("does not treat a previously verified domain as verified when its current state is incomplete", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "existing", name: "mail.example.com", status: "verified" }], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "existing", name: "mail.example.com", status: "partially_verified", records: [] }));
    vi.stubGlobal("fetch", transport);
    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).resolves.toMatchObject({ status: "pending" });
  });

  it("creates a new domain only after the account's domains have been exhausted", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "created", status: "not_started", records: [] }));
    vi.stubGlobal("fetch", transport);
    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).resolves.toEqual({
      externalIdentityId: "created", status: "pending", dnsRecords: [],
    });
    expect(transport.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(transport.mock.calls[1][1].body)).toMatchObject({ name: "mail.example.com", region: "us-east-1" });
  });

  it("preserves lookup errors instead of trying to create a domain after an unsuccessful lookup", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ name: "restricted_api_key", message: "API key is restricted", statusCode: 403 }, { status: 403 }));
    vi.stubGlobal("fetch", transport);
    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).rejects.toThrow("API key is restricted");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});


describe("Resend DNS recovery", () => {
  it("finds a recreated domain after the saved ID is missing without creating anything", async () => {
    const records = [{record:"SPF",type:"CNAME",name:"send",value:"new.resend.example",status:"verified",ttl:"Auto"}];
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({name:"not_found",statusCode:404,message:"Not found"},{status:404}))
      .mockResolvedValueOnce(Response.json({data:[{id:"new",name:"mail.example.com"}],has_more:false}))
      .mockResolvedValueOnce(Response.json({id:"new",name:"mail.example.com",status:"verified",records}));
    vi.stubGlobal("fetch",transport);
    await expect(resendModule.identity!.checkIdentity("old",context,"mail.example.com")).resolves.toEqual({externalIdentityId:"new",status:"verified",dnsRecords:records});
    expect(transport.mock.calls.every(([,options])=>options.method === "GET")).toBe(true);
  });
  it.each([401,403,429,500])("does not rediscover or create after HTTP %s", async statusCode => {
    const transport=vi.fn().mockResolvedValue(Response.json({name:"provider_error",statusCode,message:"Unavailable"},{status:statusCode}));
    vi.stubGlobal("fetch",transport);
    await expect(resendModule.identity!.checkIdentity("old",context,"mail.example.com")).rejects.toMatchObject({statusCode});
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not fabricate a domain when it is absent from this account",async()=>{
    const transport=vi.fn().mockResolvedValueOnce(Response.json({name:"not_found",statusCode:404,message:"Not found"},{status:404}))
      .mockResolvedValueOnce(Response.json({data:[],has_more:false}));
    vi.stubGlobal("fetch",transport);
    await expect(resendModule.identity!.checkIdentity("old",context,"mail.example.com")).rejects.toThrow("Domain not found in this Resend account");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects an ID that resolves to a different domain",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({id:"wrong",name:"other.example.com",status:"verified",records:[]})));
    await expect(resendModule.identity!.checkIdentity("wrong",context,"mail.example.com")).rejects.toThrow("different domain");
  });
  it("starts verification with POST rather than treating retrieval as verification",async()=>{
    const transport=vi.fn().mockResolvedValue(Response.json({id:"domain",object:"domain"}));vi.stubGlobal("fetch",transport);
    await expect(resendModule.identity!.verifyIdentity!("domain",context)).resolves.toBeUndefined();
    expect(transport.mock.calls[0][0]).toBe("https://api.resend.com/domains/domain/verify");
    expect(transport.mock.calls[0][1].method).toBe("POST");
  });
});

it("preserves provider Retry-After for the background scheduler",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({name:"rate_limit_exceeded",statusCode:429,message:"Slow down"},{status:429,headers:{"retry-after":"7200"}})));
  await expect(resendModule.identity!.checkIdentity("domain",context,"mail.example.com")).rejects.toMatchObject({statusCode:429,retryAfterSeconds:7200});
});
