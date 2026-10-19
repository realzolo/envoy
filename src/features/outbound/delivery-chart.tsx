"use client";

import styles from "@/components/dashboard.module.css";
import { LocalTime,useLocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { SetupChecklist,type SetupState } from "@/features/operations/setup-checklist";
import { EmailTable } from "@/features/outbound/email-table";
import type { EmailRecord } from "@/lib/types";
import { Link as ArcoLink,Badge,Card,Empty,List,Space,Statistic,Tooltip,Typography } from "@arco-design/web-react";
import { IconArrowRight } from "@arco-design/web-react/icon";
import { useEffect, useRef, useState } from "react";

export type DeliveryTrendPoint = {
  label: string;
  sent: number;
  delivered: number;
};

type DashboardStats = {
  windowStart:string;
  windowEnd:string;
  accepted: number;
  delivered: number;
  bounced: number;
  deliveryRate: number;
  bounceRate: number;
  pending: number;
};

type DashboardHealth = {
  outbox: number;
  outboxFailed: number;
  deadLetters: number;
  unknown: number;
  workerAlive: boolean;
  rawErrors: number;
  oldestDueSeconds: number;
};

type DashboardOverviewProps = {
  stats: DashboardStats;
  health: DashboardHealth;
  trend: DeliveryTrendPoint[];
  recent: EmailRecord[];
  setup: SetupState;
};

function ChartTimeLabel({value}:{value:string}) {
  return useLocalTime(value,{month:"short",day:"numeric"})
}

export function DeliveryChart({ data }: { data: DeliveryTrendPoint[] }) {
  const containerRef = useRef<HTMLElement>(null);
  const [{ width, height }, setSize] = useState({ width: 640, height: 240 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (!width || !height) return;
      setSize((size) => size.width === width && size.height === height ? size : { width, height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const maximum = Math.max(4, ...data.flatMap((item) => [item.sent, item.delivered]));
  const plot = { top: 16, right: width - 28, bottom: height - 32, left: 48 };
  const chartHeight = plot.bottom - plot.top;
  const chartWidth = plot.right - plot.left;
  const labelInterval = Math.max(1, Math.ceil(((data.length - 1) * 56) / chartWidth));
  const xAt = (index: number) => (
    data.length <= 1 ? width / 2 : plot.left + (index * chartWidth) / (data.length - 1)
  );
  const yAt = (value: number) => plot.bottom - Math.round((value / maximum) * chartHeight);
  const points = (key: "sent" | "delivered") => (
    data.map((item, index) => `${xAt(index)},${yAt(item[key])}`).join(" ")
  );

  return (
    <section ref={containerRef} className={styles.chart} aria-label="Accepted and delivered messages over seven days">
      {data.length ? (
        <svg
          aria-label="Accepted and delivered messages over seven days"
          height="100%"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = plot.bottom - chartHeight * ratio;
            return (
              <g key={ratio}>
                <text x={plot.left - 12} y={y + 4} textAnchor="end" fill="var(--color-text-3)" fontSize="11">{Math.round(maximum * ratio)}</text>
                <line
                  stroke="var(--color-border-1)"
                  strokeWidth="1"
                  x1={plot.left}
                  x2={plot.right}
                  y1={y}
                  y2={y}
                />
              </g>
            );
          })}
          <polyline
            fill="none"
            points={points("sent")}
            stroke="rgb(var(--arcoblue-6))"
            strokeWidth="1.5"
          />
          <polyline
            fill="none"
            points={points("delivered")}
            stroke="rgb(var(--green-6))"
            strokeWidth="2"
          />
          {data.map((item, index) => (
            <g key={item.label}>
              <title>{`${item.sent} queued · ${item.delivered} delivered`}</title>
              <circle
                cx={xAt(index)}
                cy={yAt(item.delivered)}
                fill="var(--color-bg-1)"
                r="3"
                stroke="rgb(var(--green-6))"
                strokeWidth="1.5"
              />
              {(index === data.length - 1 || (index % labelInterval === 0 && data.length - 1 - index >= labelInterval)) && (
                <text
                  fill="var(--color-text-3)"
                  fontSize="12"
                  textAnchor="middle"
                  x={xAt(index)}
                  y={height - 8}
                >
                  <ChartTimeLabel value={item.label}/>
                </text>
              )}
            </g>
          ))}
        </svg>
      ) : (
        <Empty description="No delivery data is available yet." />
      )}
    </section>
  );
}

export function DashboardOverview({ stats, health, trend, recent, setup }: DashboardOverviewProps) {
  const metrics = [
    {
      label: "Messages accepted",
      value: stats.accepted,
      extra: "Accepted during the reporting window",
      groupSeparator: true,
    },
    {
      label: "Completed delivery rate",
      value: stats.deliveryRate,
      extra: `${stats.delivered.toLocaleString("en-US")} delivered · ${stats.pending.toLocaleString("en-US")} still processing`,
      precision: 1,
      suffix: "%",
    },
    {
      label: "Bounce rate",
      value: stats.bounceRate,
      extra: `${stats.bounced.toLocaleString("en-US")} / delivered + bounced + failed`,
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
      name: "Overdue work (>1 minute)",
      status: health.outbox ? "Attention" : "Healthy",
      detail: `${health.outbox.toLocaleString("en-US")} · oldest due ${Math.floor(health.oldestDueSeconds)}s`,
      healthy: health.outbox === 0,
    },
    {
      name: "Outbox failures",
      status: health.outboxFailed ? "Attention" : "Healthy",
      detail: health.outboxFailed.toLocaleString("en-US"),
      healthy: health.outboxFailed === 0,
    },
    {
      name: "Unknown outcomes",
      status: health.unknown ? "Reconciling" : "Healthy",
      detail: health.unknown.toLocaleString("en-US"),
      healthy: health.unknown === 0,
    },
    {
      name: "Raw event processing errors",
      status: health.rawErrors ? "Attention":"Healthy",
      detail: health.rawErrors.toLocaleString("en-US"),
      healthy: health.rawErrors===0,
    },
    {
      name: "Callback dead letters",
      status: health.deadLetters ? "Attention" : "Healthy",
      detail: health.deadLetters.toLocaleString("en-US"),
      healthy: health.deadLetters === 0,
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        description="A clear view of your messages and the work that needs attention."
        title="Overview"
      />
      <div className={styles.metrics}>
        {metrics.map((metric) => (
          <Card key={metric.label} className={styles.metric}>
            <Statistic groupSeparator={metric.groupSeparator} precision={metric.precision} suffix={metric.suffix} title={metric.label} value={metric.value} />
            <div className={styles.metricFoot}>{metric.extra}</div>
          </Card>
        ))}
      </div>
      <div className={styles.window}>
        <Tooltip content="Daily cohorts start at 00:00 UTC. All timestamps are displayed in your browser’s timezone.">
          <span>Reporting window: <LocalTime value={stats.windowStart}/> — <LocalTime value={stats.windowEnd}/></span>
        </Tooltip>
      </div>
      <div className={styles.overview}>
        <Card className={styles.trendCard} title="Delivery trend" extra={<Space wrap size="medium"><Badge color="arcoblue" text="Queued"/><Badge color="green" text="Delivered"/></Space>}>
          <Typography.Paragraph className={styles.trendDescription} type="secondary">Daily queued cohorts · delivered counts update as events arrive</Typography.Paragraph>
          <DeliveryChart data={trend} />
        </Card>
        <Card title="Pipeline health" extra={<Badge status={healthItems.every(item=>item.healthy) ? "success" : "warning"} text={healthItems.every(item=>item.healthy) ? "Healthy" : "Attention"}/> }>
          <List bordered={false} size="small">
            {healthItems.map(item => <List.Item key={item.name}>
              <div className={styles.healthRow}>
                <div><ArcoLink href={item.name.includes("Raw") ? "/events" : item.name.includes("Callback") ? "/webhooks" : item.name.includes("Unknown") ? "/emails?status=unknown" : "/logs"}>{item.name}</ArcoLink><div className={styles.healthDetail}>{item.detail}</div></div>
                <Badge status={item.healthy ? "success" : "warning"} text={item.status}/>
              </div>
            </List.Item>)}
          </List>
        </Card>
      </div>
      <Card title="Recent messages" extra={<ArcoLink href="/emails" icon={<IconArrowRight aria-hidden="true" />}>View all</ArcoLink>}>
        <EmailTable compact records={recent} variant="embedded" />
      </Card>
      <SetupChecklist state={setup} />
    </div>
  );
}
