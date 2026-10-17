"use client";

import { Button, Card, Result } from "@arco-design/web-react";
import { IconArrowRight } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { MessageComposer } from "@/components/message-composer";
import { PageHeader } from "@/components/page-header";
import styles from "./mail-views.module.css";

type Service = { id: string; name: string; product: string; product_id: string };
type Sender = { name: string; product_id: string; category: string; from_address: string; from_name: string; from_email: string; reply_to: string | null };

export function ComposeMessageView({ services, senders }: { services: Service[]; senders: Sender[] }) {
  const router = useRouter();
  return (
    <section className={styles.page}>
      <PageHeader backIcon description="Send a test message and follow its delivery results." onBack={() => router.push("/emails")} title="Send a test" />
      {services.length ? <MessageComposer services={services} senders={senders} /> : <Card className={styles.card} bordered={false}>
        <Result
          extra={<Button href="/api-keys" icon={<IconArrowRight />} type="primary">Configure services</Button>}
          status="warning"
          subTitle="Create a product and issue a service credential before sending a test message."
          title="No active services"
        />
      </Card>}
    </section>
  );
}
