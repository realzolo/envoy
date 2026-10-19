import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { initializeV1 } from "../src/platform/database/initialization";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://envoy:envoy@localhost:5432/postgres";
const databaseName = `envoy_test_${randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = new URL(adminUrl);
testDatabaseUrl.pathname = `/${databaseName}`;
const testUrl = testDatabaseUrl.toString();

async function dropTestDatabase() {
  const cleanup = new Client({ connectionString: adminUrl });
  await cleanup.connect();
  try { await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
  finally { await cleanup.end(); }
}

export default async function setup() {
  process.env.DATABASE_URL = testUrl;
  process.env.ENVOY_TEST_DATABASE_URL = testUrl;
  process.env.ENVOY_KEK_BASE64 = "xNKUJulg5w3Uf+hmV9yWMPa6BxUJbUVvJFBquKimvnc=";

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${databaseName}"`); }
  finally { await admin.end(); }

  const testPool = new Pool({ connectionString: testUrl });
  let database: PoolClient | undefined;
  try {
  database = await testPool.connect();
  await initializeV1(database);

  const [{ hashApiKey }, { sealSecret }] = await Promise.all([
    import("../src/platform/crypto/hash"),
    import("../src/platform/crypto/envelope")
  ]);
  const providerSecret = sealSecret({ type: "mock", token: "test-provider-token" }, "pa_mock", 1);
  const webhookSecret = sealSecret({ token: "test-webhook-token" }, "pwe_mock", 1);
  const callbackSecret = sealSecret({ secret: "test-callback-secret" }, "cb_atlas_local", 1);

  await database.query("INSERT INTO products(id,name) VALUES ('prd_atlas','Atlas')");
  await database.query("INSERT INTO services(id,product_id,name) VALUES ('svc_atlas_auth','prd_atlas','Atlas Auth')");
  await database.query("UPDATE services SET suppression_management_allowed=true WHERE id='svc_atlas_auth'");
  await database.query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES ('cred_atlas','svc_atlas_auth','envoy_test_k',$1)", [hashApiKey("envoy_test_key")]);
  await database.query("INSERT INTO provider_accounts(id,type,name,status,public_config,health,quota) VALUES ('pa_mock','mock','Test Provider','active',$1,$2,$3)", [{ behavior: "deliver" }, { status: "healthy" }, { monthlyLimit: 100000 }]);
  await database.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ('pc_mock','pa_mock',1,$1,$2,$3,'test')", [providerSecret.secretCiphertext, providerSecret.encryptedDek, providerSecret.keyVersion]);
  await database.query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token,security_config_ciphertext,security_encrypted_dek,key_version,security_version,security_configured) VALUES ('pwe_mock','pa_mock','test-endpoint',$1,$2,$3,1,true)", [webhookSecret.secretCiphertext, webhookSecret.encryptedDek, webhookSecret.keyVersion]);
  await database.query("INSERT INTO sending_domains(id,domain) VALUES ('sd_atlas','mail.atlas.test')");
  await database.query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status) VALUES ('pi_atlas_mock','sd_atlas','pa_mock','test_identity','verified')");
  await database.query("INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed,receive_allowed) VALUES ('sg_atlas','svc_atlas_auth','sd_atlas',true,true)");
  await database.query("INSERT INTO routing_policies(id,name,product_id,sending_domain_id,message_category,priority) VALUES ('rp_atlas_security','Test routing','prd_atlas','sd_atlas','security',10)");
  await database.query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight) VALUES ('rt_atlas_security','rp_atlas_security','pa_mock','pi_atlas_mock',10,100)");
  await database.query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ('cb_atlas_local','svc_atlas_auth','Test callback','https://callback.test/events',$1,$2,$3,$4)", [callbackSecret.secretCiphertext, callbackSecret.encryptedDek, callbackSecret.keyVersion, ["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received"]]);
  await database.query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,product_id,service_id) VALUES ('ir_atlas','pwe_mock','sd_atlas','prd_atlas','svc_atlas_auth')");
  } catch (error) {
    database?.release();
    database = undefined;
    await testPool.end();
    await dropTestDatabase();
    throw error;
  }
  database?.release();
  await testPool.end();
  return dropTestDatabase;
}
