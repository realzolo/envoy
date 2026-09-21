import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);
process.env.DATABASE_URL = "postgresql://envoy:envoy@localhost:5432/envoy_test";
process.env.ENVOY_KEK_BASE64 = "xNKUJulg5w3Uf+hmV9yWMPa6BxUJbUVvJFBquKimvnc=";
