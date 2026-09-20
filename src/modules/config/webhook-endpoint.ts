import { openSecret } from "@/modules/config/envelope";
import { loadProviderAccount } from "@/modules/config/provider-account";
import type { ProviderType } from "@/modules/providers/contracts";
import { query } from "@/server/database";

type EndpointRow = {
  id: string;
  provider_account_id: string;
  provider_type: ProviderType;
  status: string;
  security_config_ciphertext: string | null;
  security_encrypted_dek: string | null;
  key_version: string | null;
  security_version: number;
  expected_topic_arn: string | null;
  ip_allowlist: string[]
};

export async function loadWebhookEndpoint(provider: ProviderType, opaqueToken: string) {
  const row = (await query<EndpointRow>(`SELECT e.id,e.provider_account_id,a.type AS provider_type,e.status,e.security_config_ciphertext,e.security_encrypted_dek,e.key_version,e.security_version,e.expected_topic_arn,e.ip_allowlist
  FROM provider_webhook_endpoints e JOIN provider_accounts a ON a.id=e.provider_account_id WHERE e.opaque_token=$1 AND a.type=$2`, [opaqueToken, provider])).rows[0];
  if (!row || row.status !== "active") return null;
  const security = row.security_config_ciphertext && row.security_encrypted_dek && row.key_version ? openSecret<Record<string, unknown>>({
    secretCiphertext: row.security_config_ciphertext,
    encryptedDek: row.security_encrypted_dek,
    keyVersion: row.key_version
  }, row.id, row.security_version) : {};
  if (row.expected_topic_arn) security.expectedTopicArn = row.expected_topic_arn;
  if (row.ip_allowlist.length) security.ipAllowlist = row.ip_allowlist;
  const account = await loadProviderAccount(row.provider_account_id, { allowNonActive: true });
  return { ...row, security, ...account }
}
