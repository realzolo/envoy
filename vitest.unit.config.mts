import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';

/** Pure application/adapter policies run without provisioned infrastructure. */
export default defineConfig({
  test:{environment:'node',include:['tests/unit/**/*.test.ts','tests/core/**/*.test.ts','tests/inbound/service.test.ts','tests/server/outbound-files.test.ts']},
  resolve:{alias:{'@':resolve(import.meta.dirname,'src'),'server-only':resolve(import.meta.dirname,'tests/helpers/server-only.ts')}},
});
