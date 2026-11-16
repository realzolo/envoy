import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomain, createProviderAccount, refreshIdentity } from "@/modules/channels/public";
import { query } from "@/platform/database";

// Exercise the actual encrypted credential loader, Resend adapter and SQL repository.
// Only the external HTTP transport is replaced.
let accountId: string;
let domainId: string;
let identityId: string;
let domain: string;
const records = [{ record: "DKIM", type: "TXT", name: "resend._domainkey", value: "original", status: "verified", ttl: "Auto" }];

beforeEach(async () => {
  const nonce = randomUUID().replaceAll("-", "");
  domain = `review-${nonce}.example.com`;
  accountId = (await createProviderAccount({type:"resend",name:`Review ${nonce}`,configuration:{},credentials:{apiKey:"review-test-resend-key"}},"test")).accountId;
  await query("UPDATE provider_accounts SET status='active' WHERE id=$1", [accountId]);
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({data:[{id:"original-domain",name:domain}],has_more:false}))
    .mockResolvedValueOnce(Response.json({id:"original-domain",name:domain,status:"verified",records})));
  domainId = (await createDomain({domain,accountIds:[accountId]},"test")).domainId;
  identityId = (await query<{id:string}>("SELECT id FROM provider_identities WHERE sending_domain_id=$1",[domainId])).rows[0].id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await query("DELETE FROM service_domain_bindings WHERE sending_domain_id=$1",[domainId]);
  await query("DELETE FROM sending_domains WHERE id=$1",[domainId]);
  await query("DELETE FROM provider_accounts WHERE id=$1",[accountId]);
});

async function snapshot() {
  return (await query<{status:string;dns_records:unknown;external_identity_id:string;last_checked_at:Date}>(
    "SELECT status,dns_records,external_identity_id,last_checked_at FROM provider_identities WHERE id=$1",[identityId])).rows[0];
}
function missing() { return Response.json({name:"not_found",statusCode:404,message:"Domain not found"},{status:404}); }

describe("independent domain recovery regression review", () => {
  it("revokes routing eligibility after definitive remote deletion while retaining last successful DNS", async () => {
    const before = await snapshot();
    const transport=vi.fn().mockResolvedValueOnce(missing()).mockResolvedValueOnce(Response.json({data:[],has_more:false}));
    vi.stubGlobal("fetch",transport);
    await expect(refreshIdentity(identityId,"test")).rejects.toThrow(/not found/i);
    const after=await snapshot();
    expect(after.status).toBe("failed");
    expect(after.dns_records).toEqual(before.dns_records);
    expect(after.last_checked_at).toEqual(before.last_checked_at);
    expect(transport.mock.calls.every(([,options]) => options.method === "GET")).toBe(true);
  });

  it("recovers an externally recreated domain and keeps the Service identity reference stable", async () => {
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,outbound_provider_identity_id) VALUES($1,'svc_atlas_auth',$2,$3)",[`binding_${identityId}`,domainId,identityId]);
    const updated=[{record:"SPF",type:"CNAME",name:"send",value:"send.resend.example",status:"verified",ttl:"Auto"}];
    const transport=vi.fn().mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(Response.json({data:[{id:"replacement-domain",name:domain}],has_more:false}))
      .mockResolvedValueOnce(Response.json({id:"replacement-domain",name:domain,status:"verified",records:updated}));
    vi.stubGlobal("fetch",transport);
    await refreshIdentity(identityId,"test");
    expect(await snapshot()).toMatchObject({external_identity_id:"replacement-domain",status:"verified",dns_records:updated});
    expect((await query("SELECT outbound_provider_identity_id FROM service_domain_bindings WHERE id=$1",[`binding_${identityId}`])).rows[0].outbound_provider_identity_id).toBe(identityId);
    expect(transport.mock.calls.every(([,options]) => options.method === "GET")).toBe(true);
  });

  it.each([401,403,429,503])("preserves the successful snapshot for transient/auth HTTP %s errors", async statusCode => {
    const before=await snapshot();
    const transport=vi.fn().mockResolvedValue(Response.json({name:"error",statusCode,message:"Temporarily unavailable"},{status:statusCode}));
    vi.stubGlobal("fetch",transport);
    await expect(refreshIdentity(identityId,"test")).rejects.toThrow("Temporarily unavailable");
    expect(await snapshot()).toEqual(before);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a response fetched with a credential revoked during the HTTP request", async () => {
    const before=await snapshot();
    vi.stubGlobal("fetch",vi.fn().mockImplementation(async()=>{
      await query("UPDATE provider_credentials SET status='revoked' WHERE provider_account_id=$1",[accountId]);
      return Response.json({id:"original-domain",name:domain,status:"pending",records:[]});
    }));
    await expect(refreshIdentity(identityId,"test")).rejects.toThrow(/changed|disabled/i);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects malformed successful responses instead of accepting another domain's verified state", async () => {
    const before=await snapshot();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({id:"original-domain",status:"verified",records:[]})));
    await expect(refreshIdentity(identityId,"test")).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
