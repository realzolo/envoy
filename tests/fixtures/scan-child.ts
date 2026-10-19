import { processAttachmentScan } from "../../src/modules/attachments/public";
import { db } from "../../src/platform/database";
void (async()=>{await processAttachmentScan(process.argv[2]);await db().end();})().catch(error=>{console.error(error.message);process.exitCode=1;});
