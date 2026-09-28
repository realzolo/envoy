"use client";

import { Card, Space, Typography } from "@arco-design/web-react";
import { EnvoyLogo } from "@/components/envoy-logo";
import { LoginForm } from "@/components/login-form";

export function LoginPageView({ next }: { next?: string }) {
  return (
    <main className="login-page">
      <Card style={{ maxWidth: 420, width: "100%" }}>
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <EnvoyLogo />
          <Space direction="vertical" size="mini" style={{ width: "100%" }}>
            <Typography.Title heading={4} id="login-title" style={{ margin: 0 }}>
              Admin console
            </Typography.Title>
            <Typography.Paragraph style={{ margin: 0 }} type="secondary">
              Sign in with your administrator credentials.
            </Typography.Paragraph>
          </Space>
          <LoginForm next={next} />
        </Space>
      </Card>
    </main>
  );
}
