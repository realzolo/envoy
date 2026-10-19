import { providerDescriptors } from '@/integrations/providers/public';
import type { AdminData,AdminSection,MessageFilters } from '@/modules/admin/contracts';
import { dashboardData as readDashboardData,reportingReads } from '@/modules/admin/public';
import { attachmentAdminReads,scanPolicy } from '@/modules/attachments/public';
import { callbackAdminReads } from '@/modules/callbacks/public';
import { channelsAdminReads } from '@/modules/channels/public';
import { identityAdminReads } from '@/modules/identity/public';
import { inboundAdminReads } from '@/modules/inbound/public';
import { outboundAdminReads,getDeliveryDetail as readDeliveryDetail,listEmailPage as readEmailPage,listEmails as readEmails } from '@/modules/outbound/public';
import { suppressionAdminReads } from '@/modules/suppressions/public';
import { getAdminSession } from '@/server/admin-auth';
import 'server-only';
export type { AdminSection } from '@/modules/admin/contracts';
async function requireAdmin(){if(!await getAdminSession())throw new Error('Unauthorized');}
async function readRows<Row>(read:()=>Promise<{rows:Row[]}>){return (await read()).rows;}
export async function listEmailPage(filters:MessageFilters,limit=20){await requireAdmin();return readEmailPage(filters,limit);}
export async function listEmails(limit=200){await requireAdmin();return readEmails(limit);}
export async function getDeliveryDetail(id:string){await requireAdmin();return readDeliveryDetail(id);}
export async function dashboardData(){await requireAdmin();return readDashboardData();}
export async function messageComposerData(){await requireAdmin();return {services:(await identityAdminReads.services()).rows.filter(s=>s.status==='active')};}
export async function adminData(section: AdminSection):Promise<AdminData> {
  await requireAdmin();
  switch (section) {
    case "attachments": {
      const [tasks,observations]=await Promise.all([attachmentAdminReads.tasks(),attachmentAdminReads.observations()]);
      return { tasks:tasks.rows,observations:observations.rows,configuration:scanPolicy() };
    }
    case "providers": {
      const providers = await readRows(channelsAdminReads.providers);
      return { providers, descriptors: providerDescriptors() };
    }
    case "domains": {
      const [providers, domains] = await Promise.all([readRows(channelsAdminReads.providers), readRows(channelsAdminReads.domains)]);
      return { providers, domains, descriptors: providerDescriptors() };
    }
    case "api-keys": {
      const [services, domains, credentials] = await Promise.all([readRows(identityAdminReads.services), readRows(channelsAdminReads.domains), readRows(identityAdminReads.credentials)]);
      return { services, domains, credentials };
    }
    case "webhooks": {
      const [services, callbacks, callbackDeliveries] = await Promise.all([readRows(identityAdminReads.services), readRows(callbackAdminReads.callbacks), readRows(callbackAdminReads.callbackDeliveries)]);
      return { services, callbacks, callbackDeliveries };
    }
    case "events": {
      const [rawEvents, canonicalEvents] = await Promise.all([readRows(inboundAdminReads.rawEvents), readRows(outboundAdminReads.canonicalEvents)]);
      return { rawEvents, canonicalEvents };
    }
    case "suppressions": {
      const [services, suppressions] = await Promise.all([readRows(identityAdminReads.services), readRows(suppressionAdminReads.suppressions)]);
      return { services, suppressions };
    }
    case "inbound": {
      return { inbound: await readRows(inboundAdminReads.inbound) };
    }
    case "logs": {
      const [audit,failedWork]=await Promise.all([readRows(reportingReads.audit),readRows(reportingReads.failedWork)]);
      return { audit, failedWork };
    }
  }
}
