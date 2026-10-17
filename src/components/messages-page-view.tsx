"use client";

import { Button, Card } from "@arco-design/web-react";
import { IconDownload, IconSend } from "@arco-design/web-react/icon";
import { EmailTable } from "@/components/email-table";
import { PageHeader } from "@/components/page-header";
import { messageFilterQuery, type MessageFilters } from "@/modules/admin/message-filters";
import type { EmailRecord } from "@/lib/types";
import styles from "./mail-views.module.css";

export function MessagesPageView({ records, filters, nextCursor }: { records: EmailRecord[]; filters: MessageFilters; nextCursor: string | null }) {
  return (
    <section className={styles.page}>
      <PageHeader
        actions={<Button href="/emails/compose" icon={<IconSend />} type="primary">Send a test</Button>}
        description="Find a message and inspect its delivery history."
        title="Messages"
      />
      <Card className={styles.card} bordered={false} title="Delivery search" extra={
          <Button href={`/api/admin/export/messages?${messageFilterQuery(filters)}`} title="Export up to 10,000 matching deliveries" icon={<IconDownload />}>
            Export CSV
          </Button>
        }>
        <EmailTable key={`${filters.q}:${filters.status}`} records={records} filters={filters} nextCursor={nextCursor} variant="embedded" />
      </Card>
    </section>
  );
}
