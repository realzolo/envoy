"use client";

import { Card, Grid, Skeleton, Space } from "@arco-design/web-react";

export default function DashboardLoading() {
  return (
    <Space direction="vertical" size="large" className="dashboard-loading" aria-label="Loading page">
      <Skeleton
        animation
        text={{ rows: 2, width: [220, "48%"] }}
      />
      <Grid.Row gutter={[16, 16]}>
        {[0, 1, 2, 3].map((item) => (
          <Grid.Col key={item} lg={6} sm={12} xs={24}>
            <Card>
              <Skeleton animation text={{ rows: 2, width: [96, 140] }} />
            </Card>
          </Grid.Col>
        ))}
      </Grid.Row>
      <Card>
        <Skeleton animation text={{ rows: 5, width: ["32%", "100%", "86%", "92%", "70%"] }} />
      </Card>
    </Space>
  );
}
