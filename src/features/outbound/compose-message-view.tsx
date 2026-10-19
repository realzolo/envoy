"use client";

import styles from "@/components/mail-views.module.css";
import { PageHeader } from "@/components/page-header";
import { MessageComposer } from "@/features/outbound/message-composer";
import { Button,Card,Result } from "@arco-design/web-react";
import { IconArrowRight } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";

type Service = { id: string; name: string };

export function ComposeMessageView({ services }: { services: Service[] }) {
  const router = useRouter();
  return (
    <section className={styles.page}>
      <PageHeader backIcon description="Send a test message and follow its delivery results." onBack={() => router.push("/emails")} title="Send a test" />
      {services.length ? <MessageComposer services={services} /> : <Card className={styles.card} bordered={false}>
        <Result
          extra={<Button href="/api-keys" icon={<IconArrowRight />} type="primary">Configure services</Button>}
          status="warning"
          subTitle="Create a service and issue an API key before sending a test message."
          title="No active services"
        />
      </Card>}
    </section>
  );
}
