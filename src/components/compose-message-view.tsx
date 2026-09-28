"use client";

import { Button, Result, Space } from "@arco-design/web-react";
import { IconArrowRight, IconLock } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";
import { MessageComposer } from "@/components/message-composer";
import { PageHeader } from "@/components/page-header";

type Service = { id: string; name: string; product: string; product_id: string };
type Sender = { name: string; product_id: string; category: string; from_address: string };

export function ComposeMessageView({
  services,
  senders,
}: {
  services: Service[];
  senders: Sender[];
}) {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PageHeader
        backIcon
        description="Submit final rendered content through the same asynchronous delivery path used by service clients."
        onBack={() => router.push("/emails")}
        title="Send a test"
      />
      {services.length ? (
        <MessageComposer services={services} senders={senders} />
      ) : (
        <Result
          extra={
            <Button href="/api-keys" icon={<IconArrowRight aria-hidden="true" />} type="primary">
              Configure services
            </Button>
          }
          icon={<IconLock aria-hidden="true" style={{ fontSize: 32 }} />}
          status="warning"
          subTitle="Create a product and issue a service credential before submitting a test message."
          title="No active services"
        />
      )}
    </Space>
  );
}
