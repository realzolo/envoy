"use client";

import { Badge, Card, Empty, Grid, Link as ArcoLink, List, Space, Statistic } from "@arco-design/web-react";
import { IconArrowRight } from "@arco-design/web-react/icon";
import { EmailTable } from "@/components/email-table";
import { PageHeader } from "@/components/page-header";
import { SetupChecklist, type SetupState } from "@/components/setup-checklist";
import type { EmailRecord } from "@/lib/types";

export type DeliveryTrendPoint = {
  label: string;
  sent: number;
  delivered: number;
};

type DashboardStats = {
  accepted: number;
  delivered: number;
  bounced: number;
  deliveryRate: number;
  bounceRate: number;
};

type DashboardHealth = {
  outbox: number;
  outboxFailed: number;
  deadLetters: number;
  unknown: number;
  workerAlive: boolean;
};

type DashboardOverviewProps = {
  stats: DashboardStats;
  health: DashboardHealth;
  trend: DeliveryTrendPoint[];
  recent: EmailRecord[];
  setup: SetupState;
};

export function DeliveryChart({ data }: { data: DeliveryTrendPoint[] }) {
  const maximum = Math.max(1, ...data.flatMap((item) => [item.sent, item.delivered]));
  const width = Math.max(640, data.length * 108 + 64);
  const plot = { top: 28, right: width - 32, bottom: 184, left: 32 };
  const chartHeight = plot.bottom - plot.top;
  const chartWidth = plot.right - plot.left;
  const xAt = (index: number) => (
    data.length <= 1 ? width / 2 : plot.left + (index * chartWidth) / (data.length - 1)
  );
  const yAt = (value: number) => plot.bottom - Math.round((value / maximum) * chartHeight);
  const points = (key: "sent" | "delivered") => (
    data.map((item, index) => `${xAt(index)},${yAt(item[key])}`).join(" ")
  );

  return (
    <section aria-label="Accepted and delivered messages over seven days">
      {data.length ? (
        <div className="delivery-chart__viewport">
          <svg
            aria-label="Accepted and delivered messages over seven days"
            className="delivery-chart__svg"
            height="230"
            preserveAspectRatio="xMinYMin meet"
            role="img"
            viewBox={`0 0 ${width} 230`}
            width="100%"
          >
            {[0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = plot.bottom - chartHeight * ratio;
              return (
                <line
                  key={ratio}
                  stroke="var(--color-border-1)"
                  strokeWidth="1"
                  x1={plot.left}
                  x2={plot.right}
                  y1={y}
                  y2={y}
                />
              );
            })}
            <polyline
              className="delivery-chart__accepted-line"
              fill="none"
              points={points("sent")}
              stroke="var(--color-text-3)"
              strokeWidth="1.5"
            />
            <polyline
              fill="none"
              points={points("delivered")}
              stroke="rgb(var(--green-6))"
              strokeWidth="2"
            />
            {data.map((item, index) => (
              <g className="delivery-chart__point" key={item.label}>
                <circle
                  cx={xAt(index)}
                  cy={yAt(item.delivered)}
                  fill="var(--color-bg-1)"
                  r="3"
                  stroke="rgb(var(--green-6))"
                  strokeWidth="1.5"
                />
                <text
                  className="delivery-chart__label"
                  fill="var(--color-text-4)"
                  fontSize="11"
                  textAnchor="middle"
                  x={xAt(index)}
                  y="216"
                >
                  {item.label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <Empty description="No delivery data is available yet." />
      )}
    </section>
  );
}

export function DashboardOverview({ stats, health, trend, recent, setup }: DashboardOverviewProps) {
  const metrics = [
    {
      label: "Accepted",
      value: stats.accepted,
      extra: "Last 7 days",
      groupSeparator: true,
    },
    {
      label: "Delivery rate",
      value: stats.deliveryRate,
      extra: `${stats.delivered.toLocaleString()} delivered`,
      precision: 1,
      suffix: "%",
    },
    {
      label: "Bounce rate",
      value: stats.bounceRate,
      extra: `${stats.bounced.toLocaleString()} bounced`,
      precision: 2,
      suffix: "%",
    },
    {
      label: "Unknown outcomes",
      value: health.unknown,
      extra: "Awaiting reconciliation",
      groupSeparator: true,
    },
  ];

  const healthItems = [
    {
      name: "Delivery worker",
      status: health.workerAlive ? "Healthy" : "Attention",
      detail: health.workerAlive ? "Online" : "No recent heartbeat",
      healthy: health.workerAlive,
    },
    {
      name: "Outbox backlog",
      status: health.outbox ? "Attention" : "Healthy",
      detail: health.outbox.toLocaleString(),
      healthy: health.outbox === 0,
    },
    {
      name: "Outbox failures",
      status: health.outboxFailed ? "Attention" : "Healthy",
      detail: health.outboxFailed.toLocaleString(),
      healthy: health.outboxFailed === 0,
    },
    {
      name: "Unknown outcomes",
      status: health.unknown ? "Reconciling" : "Healthy",
      detail: health.unknown.toLocaleString(),
      healthy: health.unknown === 0,
    },
    {
      name: "Callback dead letters",
      status: health.deadLetters ? "Attention" : "Healthy",
      detail: health.deadLetters.toLocaleString(),
      healthy: health.deadLetters === 0,
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        description="Monitor delivery, routing, callbacks, and provider health across every product."
        title="Delivery pipeline"
      />
      <SetupChecklist state={setup} />
      <Grid.Row gutter={[16, 16]}>
        {metrics.map((metric) => (
          <Grid.Col key={metric.label} lg={6} sm={12} xs={24}>
            <Card>
              <Statistic
                extra={metric.extra}
                groupSeparator={metric.groupSeparator}
                precision={metric.precision}
                suffix={metric.suffix}
                title={metric.label}
                value={metric.value}
              />
            </Card>
          </Grid.Col>
        ))}
      </Grid.Row>
      <Grid.Row gutter={[16, 16]}>
        <Grid.Col lg={16} xs={24}>
          <Card
            extra={
              <Space aria-label="Chart legend" size="medium">
                <Badge color="gray" text="Accepted" />
                <Badge color="green" text="Delivered" />
              </Space>
            }
            title="Delivery trend"
          >
            <DeliveryChart data={trend} />
          </Card>
        </Grid.Col>
        <Grid.Col lg={8} xs={24}>
          <Card
            extra={<Badge color={health.workerAlive ? "green" : "gold"} text={health.workerAlive ? "Healthy" : "Attention"} />}
            title="Pipeline health"
          >
            <List bordered={false} size="small">
              {healthItems.map((item) => (
                <List.Item
                  extra={<Badge status={item.healthy ? "success" : "warning"} text={item.status} />}
                  key={item.name}
                >
                  <List.Item.Meta description={item.detail} title={item.name} />
                </List.Item>
              ))}
            </List>
          </Card>
        </Grid.Col>
      </Grid.Row>
      <Card
        extra={<ArcoLink href="/emails" icon={<IconArrowRight aria-hidden="true" />}>View all</ArcoLink>}
        title="Recent messages"
      >
        <EmailTable compact records={recent} variant="embedded" />
      </Card>
    </div>
  );
}
