"use client";

import { Alert, Button, Form, Input, Space } from "@arco-design/web-react";
import { IconUser } from "@arco-design/web-react/icon";
import { useState } from "react";

type LoginValues = {
  email: string;
  password: string;
};

export function localRedirect(next?: string, origin = window.location.origin) {
  if (!next) return "/";
  try {
    const current = new URL(origin);
    const destination = new URL(next, current);
    return destination.origin === current.origin
      ? `${destination.pathname}${destination.search}${destination.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function LoginForm({ next }: { next?: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(values: LoginValues) {
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: values.email, password: values.password }),
      });

      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many sign-in attempts. Try again in a few minutes."
            : "The email or password is incorrect.",
        );
        return;
      }

      window.location.href = localRedirect(next);
    } catch {
      setError("Unable to sign in right now. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Form<LoginValues>
      layout="vertical"
      onSubmit={submit}
      requiredSymbol={false}
      validateTrigger="onBlur"
    >
      <Form.Item
        field="email"
        label="Email"
        rules={[
          { required: true, message: "Enter your administrator email." },
          { type: "email", message: "Enter a valid email address." },
        ]}
      >
        <Input autoComplete="username" placeholder="name@company.com" type="email" />
      </Form.Item>
      <Form.Item
        field="password"
        label="Password"
        rules={[{ required: true, message: "Enter your password." }]}
      >
        <Input.Password autoComplete="current-password" placeholder="Enter your password" />
      </Form.Item>
      <Space direction="vertical" size="medium" style={{ width: "100%" }}>
        {error && <Alert content={error} showIcon type="error" />}
        <Button
          htmlType="submit"
          icon={<IconUser aria-hidden="true" />}
          loading={pending}
          long
          type="primary"
        >
          Sign in
        </Button>
      </Space>
    </Form>
  );
}
