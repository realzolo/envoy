import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomain, refreshIdentity, verifyIdentity, deleteDomain, deleteIdentity, archiveDomain, archiveIdentity, toggleDomain, toggleIdentity } from "@/modules/channels/public";
import { loadProviderAccount } from "@/modules/channels/infrastructure/provider-account";
import { resendModule } from "@/integrations/providers/resend";
import { query } from "@/platform/database";

vi.mock("@/modules/channels/infrastructure/provider-account", () => ({ loadProviderAccount: vi.fn() }));

const records = [{ type: "TXT", name: "resend._domainkey", value: "dkim-public-key", status: "verified" }];
const domains: string[] = [];

beforeEach(() => {
  vi.spyOn(resendModule.identity!, "findIdentity").mockImplementation((domain, context) => resendModule.identity!.createIdentity(domain, context));
  vi.mocked(loadProviderAccount).mockResolvedValue({
    module: resendModule,
    context: { accountId: "pa_mock", config: { type: "resend", schemaVersion: 1 }, secret: { type: "resend", apiKey: "test-key" } },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of domains.splice(0)) await query("DELETE FROM sending_domains WHERE id=$1", [id]);
});

async function associate(domain: string) {
  const result = await createDomain({ domain, accountIds: ["pa_mock"] }, "test");
  domains.push(result.domainId);
  return result;
}

async function identity(domainId: string) {
  return (await query<{ id: string; external_identity_id: string | null; status: string; dns_records: unknown }>(
    "SELECT id,external_identity_id,status,dns_records FROM provider_identities WHERE sending_domain_id=$1", [domainId],
  )).rows[0];
}

describe("managed domain DNS persistence", () => {
  it("persists provider DNS records as a JSON array when associating a domain", async () => {
    vi.spyOn(resendModule.identity!, "createIdentity").mockResolvedValue({ externalIdentityId: "resend-domain", status: "verified", dnsRecords: records });
    const result = await associate("resend-created.example.com");
    expect(result.identities).toEqual([{ accountId: "pa_mock", status: "verified" }]);
    expect(await identity(result.domainId)).toMatchObject({ external_identity_id: "resend-domain", status: "verified", dns_records: records });
  });

  it("returns the actual provider error when domain association fails", async () => {
    vi.spyOn(resendModule.identity!, "createIdentity").mockRejectedValue(new Error("API key is restricted"));
    const result = await associate("resend-failed.example.com");
    expect(result.identities).toEqual([{ accountId: "pa_mock", status: "failed", error: "API key is restricted" }]);
    expect(await identity(result.domainId)).toMatchObject({ status: "failed", dns_records: [] });
  });

  it("recovers a failed association with no provider ID and preserves DNS records", async () => {
    const create = vi.spyOn(resendModule.identity!, "createIdentity").mockRejectedValueOnce(new Error("Temporary failure"));
    const result = await associate("resend-recovered.example.com");
    const failed = await identity(result.domainId);
    create.mockResolvedValue({ externalIdentityId: "recovered-domain", status: "verified", dnsRecords: records });
    await refreshIdentity(failed.id, "test");
    expect(await identity(result.domainId)).toMatchObject({ external_identity_id: "recovered-domain", status: "verified", dns_records: records });
  });

  it("refreshes an associated domain using its provider ID without creating it again", async () => {
    const create = vi.spyOn(resendModule.identity!, "createIdentity").mockResolvedValue({ externalIdentityId: "resend-domain", status: "pending", dnsRecords: [] });
    const result = await associate("resend-refreshed.example.com");
    const pending = await identity(result.domainId);
    const check = vi.spyOn(resendModule.identity!, "checkIdentity").mockResolvedValue({ status: "verified", dnsRecords: records });
    await refreshIdentity(pending.id, "test");
    expect(check).toHaveBeenCalledWith("resend-domain", expect.any(Object), "resend-refreshed.example.com");
    expect(create).toHaveBeenCalledTimes(1);
    expect(await identity(result.domainId)).toMatchObject({ status: "verified", dns_records: records });
  });

  it("never re-enables an identity disabled during a provider refresh", async () => {
    vi.spyOn(resendModule.identity!, "createIdentity").mockResolvedValue({ externalIdentityId: "resend-domain", status: "pending", dnsRecords: [] });
    const result = await associate("resend-disabled-refresh.example.com");
    const pending = await identity(result.domainId);
    vi.spyOn(resendModule.identity!, "checkIdentity").mockImplementation(async () => {
      await query("UPDATE provider_identities SET status='disabled' WHERE id=$1", [pending.id]);
      return { status: "verified", dnsRecords: records };
    });
    await expect(refreshIdentity(pending.id, "test")).rejects.toThrow("disabled during refresh");
    expect(await identity(result.domainId)).toMatchObject({ status: "disabled" });
    await expect(refreshIdentity(pending.id, "test")).rejects.toThrow("Enable this provider identity");
  });

  it("does not overwrite a disabled identity during its first sync", async () => {
    vi.spyOn(resendModule.identity!, "createIdentity").mockRejectedValueOnce(new Error("Temporary failure"));
    const result = await associate("resend-disabled-create.example.com");
    const failed = await identity(result.domainId);
    vi.spyOn(resendModule.identity!, "createIdentity").mockImplementation(async () => {
      await query("UPDATE provider_identities SET status='disabled' WHERE id=$1", [failed.id]);
      return { externalIdentityId: "created-while-disabled", status: "verified", dnsRecords: records };
    });
    await expect(refreshIdentity(failed.id, "test")).rejects.toThrow("disabled during refresh");
    expect(await identity(result.domainId)).toMatchObject({ status: "disabled", external_identity_id: null });
  });
});


describe("domain recovery and local removal",()=>{
  it("syncs an identity created later in the provider without provisioning a remote domain",async()=>{
    const create=vi.spyOn(resendModule.identity!,"createIdentity").mockRejectedValueOnce(new Error("Unavailable"));
    const result=await associate("later-domain.example.com");const row=await identity(result.domainId);
    vi.mocked(resendModule.identity!.findIdentity!).mockResolvedValue({externalIdentityId:"later",status:"verified",dnsRecords:records});
    await refreshIdentity(row.id,"test");
    expect(create).toHaveBeenCalledTimes(1);
    expect(await identity(result.domainId)).toMatchObject({id:row.id,external_identity_id:"later",dns_records:records});
  });
  it("repairs a bound ID while preserving the local identity",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"old",status:"pending",dnsRecords:[]});
    const result=await associate("repair-domain.example.com");const row=await identity(result.domainId);
    vi.mocked(resendModule.identity!.findIdentity!).mockResolvedValue({externalIdentityId:"new",status:"verified",dnsRecords:records});
    await refreshIdentity(row.id,"test",true);
    expect(await identity(result.domainId)).toMatchObject({id:row.id,external_identity_id:"new",dns_records:records});
  });
  it("replaces old DNS records completely and preserves them when subsequent sync fails",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"verified",dnsRecords:records});
    const result=await associate("changed-dns.example.com");const row=await identity(result.domainId);
    const changed=[{type:"CNAME",name:"send",value:"new-provider.example",status:"verified"}];
    const check=vi.spyOn(resendModule.identity!,"checkIdentity").mockResolvedValueOnce({status:"verified",dnsRecords:changed}).mockRejectedValueOnce(new Error("Rate limited"));
    await refreshIdentity(row.id,"test");expect((await identity(result.domainId)).dns_records).toEqual(changed);
    const before=(await query("SELECT last_checked_at FROM provider_identities WHERE id=$1",[row.id])).rows[0];
    await expect(refreshIdentity(row.id,"test")).rejects.toThrow("Rate limited");
    expect((await identity(result.domainId)).dns_records).toEqual(changed);
    expect((await query("SELECT last_checked_at FROM provider_identities WHERE id=$1",[row.id])).rows[0]).toEqual(before);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("rejects an old response after a more recent local change",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"pending",dnsRecords:[]});
    const result=await associate("stale-sync.example.com");const row=await identity(result.domainId);
    vi.spyOn(resendModule.identity!,"checkIdentity").mockImplementation(async()=>{
      await query("UPDATE provider_identities SET updated_at=clock_timestamp(),dns_records=$2 WHERE id=$1",[row.id,JSON.stringify(records)]);
      return {status:"pending",dnsRecords:[]};
    });
    await expect(refreshIdentity(row.id,"test")).rejects.toThrow("changed");
    expect((await identity(result.domainId)).dns_records).toEqual(records);
  });
  it("reports submitted verification without granting sending eligibility",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"pending",dnsRecords:[]});
    const result=await associate("verify-domain.example.com");const row=await identity(result.domainId);
    vi.spyOn(resendModule.identity!,"checkIdentity").mockResolvedValue({status:"pending",dnsRecords:[]});
    const verify=vi.spyOn(resendModule.identity!,"verifyIdentity").mockResolvedValue();
    await expect(verifyIdentity(row.id,"test")).resolves.toMatchObject({verificationRequested:true});
    expect(verify).toHaveBeenCalledWith("remote",expect.any(Object));
    expect((await identity(result.domainId)).status).toBe("pending");
  });
  it("removes an unused local domain and its identity",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"pending",dnsRecords:[]});
    const result=await associate("delete-domain.example.com");
    await deleteDomain(result.domainId,"test");
    expect(await identity(result.domainId)).toBeUndefined();
  });
  it("removes an unused association and allows adding it again",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"pending",dnsRecords:[]});
    const result=await associate("delete-identity.example.com");const row=await identity(result.domainId);
    await deleteIdentity(row.id,"test");expect(await identity(result.domainId)).toBeUndefined();
    await createDomain({domain:"delete-identity.example.com",accountIds:["pa_mock"]},"test");
    expect(await identity(result.domainId)).toMatchObject({external_identity_id:"remote"});
  });
  it("blocks deleting a domain or identity used by a Service",async()=>{
    await expect(deleteDomain("sd_atlas","test")).rejects.toThrow("referenced");
    await expect(deleteIdentity("pi_atlas_mock","test")).rejects.toThrow("referenced");
    expect((await query("SELECT id FROM sending_domains WHERE id='sd_atlas'")).rowCount).toBe(1);
  });
});


describe("archive and restore",()=>{
  it("archives a domain with references, retaining history and revoking Service grants on restore",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"verified",dnsRecords:records});
    const result=await associate("archive-domain.example.com");const row=await identity(result.domainId);
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled,outbound_provider_identity_id) VALUES('archive_test','svc_atlas_auth',$1,true,$2)",[result.domainId,row.id]);
    try {
      await archiveDomain(result.domainId,"test");
      expect((await query("SELECT status,archived_at FROM sending_domains WHERE id=$1",[result.domainId])).rows[0]).toMatchObject({status:"disabled",archived_at:expect.any(Date)});
      expect((await query("SELECT receive_enabled,outbound_provider_identity_id FROM service_domain_bindings WHERE id='archive_test'")).rows[0]).toEqual({receive_enabled:false,outbound_provider_identity_id:null});
      await toggleDomain(result.domainId,true,"test");
      expect((await query("SELECT status,archived_at FROM sending_domains WHERE id=$1",[result.domainId])).rows[0]).toEqual({status:"active",archived_at:null});
      expect((await query("SELECT receive_enabled FROM service_domain_bindings WHERE id='archive_test'")).rows[0].receive_enabled).toBe(false);
    } finally {await query("DELETE FROM service_domain_bindings WHERE id='archive_test'");}
  });
  it("restores an archived identity as pending without restoring outbound grants",async()=>{
    vi.spyOn(resendModule.identity!,"createIdentity").mockResolvedValue({externalIdentityId:"remote",status:"verified",dnsRecords:records});
    const result=await associate("archive-identity.example.com");const row=await identity(result.domainId);
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled,outbound_provider_identity_id) VALUES('archive_identity_test','svc_atlas_auth',$1,true,$2)",[result.domainId,row.id]);
    try {
      await archiveIdentity(row.id,"test");
      await expect(refreshIdentity(row.id,"test")).rejects.toThrow("Enable");
      await toggleIdentity(row.id,true,"test");
      expect((await identity(result.domainId)).status).toBe("pending");
      expect((await query("SELECT receive_enabled,outbound_provider_identity_id FROM service_domain_bindings WHERE id='archive_identity_test'")).rows[0]).toEqual({receive_enabled:true,outbound_provider_identity_id:null});
    } finally {await query("DELETE FROM service_domain_bindings WHERE id='archive_identity_test'");}
  });
});
