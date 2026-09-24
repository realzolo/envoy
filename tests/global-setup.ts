import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://envoy:envoy@localhost:5432/postgres";
const testUrl = "postgresql://envoy:envoy@localhost:5432/envoy_test";

export default async function setup() {
  process.env.DATABASE_URL = testUrl;
  process.env.ENVOY_KEK_BASE64 = "xNKUJulg5w3Uf+hmV9yWMPa6BxUJbUVvJFBquKimvnc=";

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS envoy_test WITH (FORCE)");
  await admin.query("CREATE DATABASE envoy_test");
  await admin.end();

  const database = new Client({ connectionString: testUrl });
  await database.connect();
  const migrationsDirectory = join(process.cwd(), "db", "migrations");
  for (const file of (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql")).sort()) {
    await database.query(await readFile(join(migrationsDirectory, file), "utf8"));
  }

  const [{ hashApiKey }, { sealSecret }] = await Promise.all([
    import("../src/server/crypto"),
    import("../src/modules/config/envelope")
  ]);
  const providerSecret = sealSecret({ type: "mock", token: "test-provider-token" }, "pa_mock", 1);
  const webhookSecret = sealSecret({ token: "test-webhook-token" }, "pwe_mock", 1);
  const callbackSecret = sealSecret({ secret: "test-callback-secret" }, "cb_atlas_local", 1);

  await database.query("INSERT INTO products(id,slug,name) VALUES ('prd_atlas','atlas','Atlas')");
  await database.query("INSERT INTO services(id,product_id,name) VALUES ('svc_atlas_auth','prd_atlas','Atlas Auth')");
  await database.query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES ('cred_atlas','svc_atlas_auth','envoy_test_k',$1)", [hashApiKey("envoy_test_key")]);
  await database.query("INSERT INTO provider_accounts(id,type,name,region,public_config,health,quota) VALUES ('pa_mock','mock','Test Provider','local',$1,$2,$3)", [{ behavior: "deliver" }, { status: "healthy" }, { monthlyLimit: 100000 }]);
  await database.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ('pc_mock','pa_mock',1,$1,$2,$3,'test')", [providerSecret.secretCiphertext, providerSecret.encryptedDek, providerSecret.keyVersion]);
  await database.query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token,security_config_ciphertext,security_encrypted_dek,key_version) VALUES ('pwe_mock','pa_mock','test-endpoint',$1,$2,$3)", [webhookSecret.secretCiphertext, webhookSecret.encryptedDek, webhookSecret.keyVersion]);
  await database.query("INSERT INTO sending_domains(id,domain,region,inbound_enabled) VALUES ('sd_atlas','mail.atlas.test','local',true)");
  await database.query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,capabilities) VALUES ('pi_atlas_mock','sd_atlas','pa_mock','test_identity','verified',$1)", [{
    outbound: true,
    inbound: true
  }]);
  await database.query("INSERT INTO sender_profiles(id,product_id,sending_domain_id,name,from_name,from_local_part,message_category) VALUES ('sp_atlas_security','prd_atlas','sd_atlas','Atlas Security','Atlas','security','security')");
  await database.query("INSERT INTO routing_policies(id,name,product_id,message_category,priority) VALUES ('rp_atlas_security','Test routing','prd_atlas','security',10)");
  await database.query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight) VALUES ('rt_atlas_security','rp_atlas_security','pa_mock','pi_atlas_mock',10,100)");
  await database.query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ('cb_atlas_local','svc_atlas_auth','Test callback','https://callback.test/events',$1,$2,$3,$4)", [callbackSecret.secretCiphertext, callbackSecret.encryptedDek, callbackSecret.keyVersion, ["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received"]]);
  await database.query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,product_id,service_id,callback_endpoint_id) VALUES ('ir_atlas','pwe_mock','sd_atlas','prd_atlas','svc_atlas_auth','cb_atlas_local')");
  await database.end();

  return async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query("DROP DATABASE IF EXISTS envoy_test WITH (FORCE)");
    await cleanup.end()
  }
}
