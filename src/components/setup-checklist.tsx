"use client";

import { Button, Card, Space, Steps, Typography } from "@arco-design/web-react";
import { IconArrowRight } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";

export type SetupState = {
  providers: number;
  identities: number;
  products: number;
  senders: number;
  routes: number;
  credentials: number;
  messages: number;
};

const steps = [
  {
    key: "providers",
    href: "/providers",
    title: "Connect a provider",
    description: "Add the sending account you already use."
  },
  {
    key: "identities",
    href: "/domains",
    title: "Verify a sending domain",
    description: "Publish the provider DNS records, then refresh verification."
  },
  {
    key: "productAndCredential",
    href: "/api-keys",
    title: "Create a product and service",
    description: "Issue the credential used by your application."
  },
  {
    key: "senders",
    href: "/senders",
    title: "Add a sender profile",
    description: "Choose the visible From address for a message category."
  },
  {
    key: "routes",
    href: "/routing",
    title: "Set a delivery route",
    description: "Attach the verified identity to the provider account."
  },
  {
    key: "messages",
    href: "/emails/compose",
    title: "Send a test message",
    description: "Use the same acceptance path as your application."
  }
] as const;

export function SetupChecklist({ state }: { state: SetupState }) {
  const router = useRouter();
  const complete = (key: typeof steps[number]["key"]) => {
    if (key === "productAndCredential") return state.products > 0 && state.credentials > 0;
    return state[key] > 0;
  };
  const firstIncompleteIndex = steps.findIndex((step) => !complete(step.key));
  if (firstIncompleteIndex === -1) return null;
  const firstIncomplete = steps[firstIncompleteIndex];

  return (
    <Card
      extra={
        <Button
          href={firstIncomplete.href}
          icon={<IconArrowRight aria-hidden="true" />}
          type="text"
        >
          Continue setup
        </Button>
      }
      title="Finish delivery setup"
    >
      <Space direction="vertical" size="medium" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Complete the remaining prerequisites before live sending.
        </Typography.Text>
        <Steps current={firstIncompleteIndex + 1} direction="vertical">
          {steps.map((step, index) => {
            const done = complete(step.key);
            const active = index === firstIncompleteIndex;
            return (
              <Steps.Step
                description={step.description}
                key={step.key}
                onClick={() => router.push(step.href)}
                status={done ? "finish" : active ? "process" : "wait"}
                title={step.title}
              />
            );
          })}
        </Steps>
      </Space>
    </Card>
  );
}
