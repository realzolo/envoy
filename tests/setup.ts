import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);
const databaseUrl = process.env.ENVOY_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Run tests through the isolated database global setup");
process.env.DATABASE_URL = databaseUrl;
process.env.ENVOY_KEK_BASE64 = "xNKUJulg5w3Uf+hmV9yWMPa6BxUJbUVvJFBquKimvnc=";
process.env.OBJECT_STORAGE_DRIVER = "local";
process.env.OBJECT_STORAGE_PREFIX = "envoy-test";

// Tests use only explicitly bound local scanner fixtures, never deployment scanners.
process.env.CLAMAV_HOST = "127.0.0.1";
process.env.CLAMAV_PORT = "1";
process.env.ATTACHMENT_POLICY_VERSION = "1";
