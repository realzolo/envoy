import {
  providerConfigSchema,
  providerSecretSchema,
  type ProviderSendContext,
  type ProviderType
} from "@/modules/providers/contracts";
import { providerRegistry } from "@/modules/providers/registry";
import { openSecret } from "@/modules/config/envelope";
import { query } from "@/server/database";

type AccountRow = {
  id: string;
  type: ProviderType;
  status: string;
  public_config: unknown;
  config_schema_version: number;
  secret_ciphertext: string;
  encrypted_dek: string;
  key_version: string;
  credential_version: number
};

export async function loadProviderAccount(accountId: string, options: { allowNonActive?: boolean } = {}): Promise<{
  module: ReturnType<typeof providerRegistry>;
  context: ProviderSendContext
}> {
  const result = await query<AccountRow>(`SELECT a.id,a.type,a.status,a.public_config,a.config_schema_version,c.secret_ciphertext,c.encrypted_dek,c.key_version,c.credential_version
    FROM provider_accounts a JOIN provider_credentials c ON c.provider_account_id=a.id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())
    WHERE a.id=$1`, [accountId]);
  const row = result.rows[0];
  if (!row || (!options.allowNonActive && row.status !== "active")) throw new Error("Provider account is unavailable");
  const configResult = providerConfigSchema.safeParse({
    type: row.type,
    schemaVersion: row.config_schema_version, ...(row.public_config as Record<string, unknown>)
  });
  if (!configResult.success) throw new Error(`Provider configuration rejected: ${configResult.error.message}`);
  const raw = openSecret<unknown>({
    secretCiphertext: row.secret_ciphertext,
    encryptedDek: row.encrypted_dek,
    keyVersion: row.key_version
  }, row.id, row.credential_version);
  const secretResult = providerSecretSchema.safeParse(raw);
  if (!secretResult.success || secretResult.data.type !== row.type) throw new Error("Provider credential rejected");
  return {
    module: providerRegistry(row.type),
    context: { accountId: row.id, config: configResult.data, secret: secretResult.data }
  };
}
