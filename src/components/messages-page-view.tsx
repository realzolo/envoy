"use client";

import { Button, Card } from "@arco-design/web-react";
import { IconDownload, IconSend } from "@arco-design/web-react/icon";
import { EmailTable } from "@/components/email-table";
import { PageHeader } from "@/components/page-header";
import type { EmailRecord } from "@/lib/types";

export function MessagesPageView({ records }: { records: EmailRecord[] }) {
  return (
    <section className="messages-page page-stack">
      <PageHeader
        actions={(
          <>
          <Button
            href="/api/admin/export/messages"
            icon={<IconDownload aria-hidden="true" />}
            type="secondary"
          >
            Export CSV
          </Button>
          <Button href="/emails/compose" icon={<IconSend aria-hidden="true" />} type="primary">
            Send a test
          </Button>
          </>
        )}
        description="Inspect every recipient-level delivery, routing attempt, and canonical event."
        title="Messages"
      />
      <Card className="workspace-card" bordered={false}>
        <EmailTable records={records} variant="embedded" />
      </Card>
    </section>
  );
}
