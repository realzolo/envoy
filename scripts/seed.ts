import { loadEnvConfig } from "@next/env";
import { hashApiKey } from "../src/server/crypto";
import { sealSecret } from "../src/modules/config/envelope";
import { db, transaction } from "../src/server/database";

loadEnvConfig(process.cwd());
const templates = [
  {
    id: "tpl_atlas_login",
    productId: "prd_atlas",
    key: "auth.login-code",
    name: "Login code",
    description: "One-time code for sign-in and sensitive actions.",
    category: "security",
    subject: "{{code}} is your login code",
    html: `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b"><div style="max-width:600px;margin:auto;background:#fff"><div style="border-bottom:1px solid #e4e4e7;padding:24px 40px;font-weight:700">{{productName}}</div><div style="padding:40px"><p style="color:#71717a">Hello {{userName}},</p><h1>Confirm your sign-in</h1><p>Use the code below. It expires in {{expiresInMinutes}} minutes.</p><div style="border-block:1px solid #e4e4e7;margin:32px 0;padding:28px;text-align:center;font:700 34px monospace;letter-spacing:10px">{{code}}</div><p style="color:#71717a;font-size:12px">Ignore this email if you did not request this action.</p></div></div></body></html>`,
    text: "Hello {{userName}}. Your login code is {{code}} and expires in {{expiresInMinutes}} minutes.",
    schema: { code: "string", expiresInMinutes: "number", userName: "string", productName: "string" },
    sample: { code: "482901", expiresInMinutes: 10, userName: "Alex", productName: "Atlas" },
    profileId: "sp_atlas_security",
    identityId: "pi_atlas_mock"
  },
  {
    id: "tpl_nova_welcome",
    productId: "prd_nova",
    key: "onboarding.welcome",
    name: "Welcome email",
    description: "Introduces the product after account creation.",
    category: "transactional",
    subject: "Welcome to {{productName}}",
    html: `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b"><div style="max-width:600px;margin:auto;background:#fff;padding:48px"><p style="color:#71717a">Hello {{userName}},</p><h1>Welcome to {{productName}}</h1><p>Your workspace is ready.</p><p><a href="{{dashboardUrl}}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 18px;text-decoration:none">Open dashboard</a></p></div></body></html>`,
    text: "Hello {{userName}}. Welcome to {{productName}}: {{dashboardUrl}}",
    schema: { userName: "string", productName: "string", dashboardUrl: "string" },
    sample: { userName: "Morgan", productName: "Nova", dashboardUrl: "https://nova.example/dashboard" },
    profileId: "sp_nova_transactional",
    identityId: "pi_nova_mock"
  },
  {
    id: "tpl_orbit_alert",
    productId: "prd_orbit",
    key: "alerts.error-rate",
    name: "Error-rate alert",
    description: "Notifies the on-call team when an error threshold is exceeded.",
    category: "alert",
    subject: "{{environment}} error rate is above threshold",
    html: `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif"><div style="max-width:600px;margin:auto;background:#fff;padding:48px"><p style="font-size:12px;color:#dc2626;font-weight:700">SERVICE ALERT</p><h1>{{service}} error rate is {{errorRate}}%</h1><p>The {{environment}} environment requires attention.</p><a href="{{traceUrl}}">View trace</a></div></body></html>`,
    text: "{{service}} error rate is {{errorRate}}%. Review: {{traceUrl}}",
    schema: { environment: "string", service: "string", errorRate: "number", traceUrl: "string" },
    sample: {
      environment: "Production",
      service: "payments-api",
      errorRate: 8.4,
      traceUrl: "https://orbit.example/traces"
    },
    profileId: "sp_orbit_alert",
    identityId: "pi_orbit_mock"
  },
] as const;

async function main() {
  await transaction(async client => {
    for (const [id, slug, name] of [["prd_atlas", "atlas", "Atlas"], ["prd_nova", "nova", "Nova"], ["prd_orbit", "orbit", "Orbit"]]) await client.query("INSERT INTO products(id,slug,name) VALUES ($1,$2,$3)", [id, slug, name]);
    const services = [["svc_atlas_auth", "prd_atlas", "Atlas Auth", "envoy_dev_key"], ["svc_nova_app", "prd_nova", "Nova App", "envoy_nova_dev_key"], ["svc_orbit_alerts", "prd_orbit", "Orbit Alerts", "envoy_orbit_dev_key"]];
    for (const [id, productId, name, key] of services) {
      await client.query("INSERT INTO services(id,product_id,name) VALUES ($1,$2,$3)", [id, productId, name]);
      await client.query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES ($1,$2,$3,$4)", [`cred_${id}`, id, key.slice(0, 12), hashApiKey(key)])
    }
    await client.query("INSERT INTO provider_accounts(id,type,name,region,public_config,health,quota) VALUES ('pa_mock','mock','Local Mock','local',$1,$2,$3)", [{ behavior: "deliver" }, {
      status: "healthy",
      checkedAt: new Date().toISOString()
    }, { monthlyLimit: 100000 }]);
    const providerSecret = sealSecret({ type: "mock", token: "local-mock-token" }, "pa_mock", 1);
    await client.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ('pc_mock','pa_mock',1,$1,$2,$3,'seed')", [providerSecret.secretCiphertext, providerSecret.encryptedDek, providerSecret.keyVersion]);
    const webhookSecret = sealSecret({ token: "local-mock-webhook" }, "pwe_mock", 1);
    await client.query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token,security_config_ciphertext,security_encrypted_dek,key_version) VALUES ('pwe_mock','pa_mock','mock-local-endpoint',$1,$2,$3)", [webhookSecret.secretCiphertext, webhookSecret.encryptedDek, webhookSecret.keyVersion]);
    const domains = [["sd_atlas", "mail.atlas.example", "us-east-1", true], ["sd_nova", "mail.nova.example", "eu-west-1", false], ["sd_orbit", "notify.orbit.example", "us-east-1", false]] as const;
    for (const [id, domain, region, inbound] of domains) {
      await client.query("INSERT INTO sending_domains(id,domain,region,inbound_enabled) VALUES ($1,$2,$3,$4)", [id, domain, region, inbound]);
      await client.query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,last_checked_at,capabilities) VALUES ($1,$2,'pa_mock',$3,'verified',now(),$4)", [`pi_${id.slice(3)}_mock`, id, `mock_identity_${domain}`, {
        outbound: true,
        inbound
      }])
    }
    const profiles = [["sp_atlas_security", "prd_atlas", "sd_atlas", "Atlas Security", "Atlas", "security", "security"], ["sp_nova_transactional", "prd_nova", "sd_nova", "Nova Product", "Nova", "hello", "transactional"], ["sp_orbit_alert", "prd_orbit", "sd_orbit", "Orbit Alerts", "Orbit Alerts", "alerts", "alert"]];
    for (const [id, productId, domainId, name, fromName, localPart, category] of profiles) await client.query("INSERT INTO sender_profiles(id,product_id,sending_domain_id,name,from_name,from_local_part,message_category) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, productId, domainId, name, fromName, localPart, category]);
    for (const template of templates) {
      await client.query("INSERT INTO templates(id,product_id,key,name,description,category) VALUES ($1,$2,$3,$4,$5,$6)", [template.id, template.productId, template.key, template.name, template.description, template.category]);
      await client.query("INSERT INTO template_versions(id,template_id,version,status,subject_template,html_template,text_template,variables_schema,sample_data,created_by,published_at) VALUES ($1,$2,1,'published',$3,$4,$5,$6,$7,'seed',now())", [`tv_${template.id}`, template.id, template.subject, template.html, template.text, template.schema, template.sample]);
      const policyId = `rp_${template.id}`;
      await client.query("INSERT INTO routing_policies(id,name,product_id,template_id,message_category,priority) VALUES ($1,$2,$3,$4,$5,10)", [policyId, `${template.name} routing`, template.productId, template.id, template.category]);
      await client.query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight) VALUES ($1,$2,'pa_mock',$3,10,100)", [`rt_${template.id}`, policyId, template.identityId])
    }
    const callbackSecret = sealSecret({ secret: "envoy_local_callback_secret" }, "cb_atlas_local", 1);
    await client.query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ('cb_atlas_local','svc_atlas_auth','Local callback sink','http://localhost:3000/api/dev/callback-sink',$1,$2,$3,$4)", [callbackSecret.secretCiphertext, callbackSecret.encryptedDek, callbackSecret.keyVersion, ["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received"]]);
    await client.query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,product_id,service_id,callback_endpoint_id) VALUES ('ir_atlas','pwe_mock','sd_atlas','prd_atlas','svc_atlas_auth','cb_atlas_local')");
    for (const [key, value] of [["workspace_name", "Envoy"], ["default_environment", "Production"], ["event_retention_days", 90], ["content_retention_days", 30]]) await client.query("INSERT INTO workspace_settings(key,value) VALUES ($1,$2)", [key, JSON.stringify(value)]);
  });
  console.log("Seeded Envoy with a provider-neutral mock account and sample data.");
  console.log("Development service credentials: envoy_dev_key, envoy_nova_dev_key, envoy_orbit_dev_key");
  await db().end()
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1
});
