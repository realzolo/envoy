"use client";

import {
  Button,
  Card,
  Link as ArcoLink,
  Progress,
  Space,
  Steps,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconArrowRight, IconDown, IconUp } from "@arco-design/web-react/icon";
import { useState } from "react";

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
  const [expanded, setExpanded] = useState(false);
  const complete = (key: typeof steps[number]["key"]) => {
    if (key === "productAndCredential") return state.products > 0 && state.credentials > 0;
    return state[key] > 0;
  };
  const firstIncompleteIndex = steps.findIndex((step) => !complete(step.key));
  if (firstIncompleteIndex === -1) return null;
  const firstIncomplete = steps[firstIncompleteIndex];
  const completedCount = steps.filter((step) => complete(step.key)).length;
  const progress = Math.round((completedCount / steps.length) * 100);

  return (
    <Card
      extra={
        <Space size="mini">
          <Tooltip content={expanded ? "Hide setup steps" : "Show all setup steps"}>
            <Button
              aria-label={expanded ? "Hide setup steps" : "Show all setup steps"}
              icon={expanded ? <IconUp aria-hidden="true" /> : <IconDown aria-hidden="true" />}
              onClick={() => setExpanded((current) => !current)}
              shape="circle"
              type="text"
            />
          </Tooltip>
          <Button
            href={firstIncomplete.href}
            icon={<IconArrowRight aria-hidden="true" />}
            type="text"
          >
            Continue setup
          </Button>
        </Space>
      }
      title="Finish delivery setup"
    >
      <Space direction="vertical" size="medium" className="setup-checklist">
        <div className="setup-summary">
          <div className="setup-summary__copy">
            <Typography.Text bold>Next: {firstIncomplete.title}</Typography.Text>
            <Typography.Text type="secondary">{firstIncomplete.description}</Typography.Text>
          </div>
          <Typography.Text type="secondary">{completedCount} of {steps.length} complete</Typography.Text>
        </div>
        <Progress percent={progress} showText={false} size="small" steps={steps.length} />
        {expanded && (
          <div className="setup-steps">
            <Steps current={firstIncompleteIndex + 1} direction="vertical">
              {steps.map((step, index) => {
                const done = complete(step.key);
                const active = index === firstIncompleteIndex;
                return (
                  <Steps.Step
                    description={step.description}
                    key={step.key}
                    status={done ? "finish" : active ? "process" : "wait"}
                    title={<ArcoLink href={step.href}>{step.title}</ArcoLink>}
                  />
                );
              })}
            </Steps>
          </div>
        )}
      </Space>
    </Card>
  );
}
