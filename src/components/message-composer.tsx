"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  Grid,
  Input,
  Select,
  Space,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconCode, IconDesktop, IconMobile, IconSend } from "@arco-design/web-react/icon";
import { useMemo, useState } from "react";

type Service = { id: string; name: string; product: string; product_id: string };
type Sender = { name: string; product_id: string; category: string; from_address: string };

type MessageFormValues = {
  serviceId: string;
  senderProfile: string;
  recipient: string;
  category: string;
  subject: string;
  html: string;
  text: string;
};

const defaultSubject = "Test message from Envoy";
const defaultHtml =
  '<main style="font-family:Arial,sans-serif;padding:32px"><h1>Envoy test</h1><p>This rendered message was submitted directly to the delivery service.</p></main>';
const defaultText =
  "Envoy test\n\nThis rendered message was submitted directly to the delivery service.";

export function MessageComposer({ services, senders }: { services: Service[]; senders: Sender[] }) {
  const [form] = Form.useForm<MessageFormValues>();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [subject, setSubject] = useState(defaultSubject);
  const [html, setHtml] = useState(defaultHtml);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [source, setSource] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");

  const service = services.find((item) => item.id === serviceId);
  const availableSenders = useMemo(
    () => senders.filter((item) => item.product_id === service?.product_id),
    [senders, service?.product_id],
  );
  const initialCategory =
    senders.find((item) => item.product_id === services[0]?.product_id)?.category ?? "transactional";

  function handleServiceChange(nextServiceId: string | number) {
    const serviceIdValue = String(nextServiceId);
    const productId = services.find((item) => item.id === serviceIdValue)?.product_id;
    const category = senders.find((item) => item.product_id === productId)?.category ?? "transactional";

    setServiceId(serviceIdValue);
    form.setFieldsValue({
      serviceId: serviceIdValue,
      senderProfile: "",
      category,
    });
  }

  function handleSenderChange(profile: string | number) {
    const senderProfile = String(profile);
    const sender = availableSenders.find((item) => item.name === senderProfile);

    if (sender) {
      form.setFieldValue("category", sender.category);
    }
  }

  function handleValuesChange(changedValues: Partial<MessageFormValues>) {
    if (typeof changedValues.subject === "string") {
      setSubject(changedValues.subject);
    }
    if (typeof changedValues.html === "string") {
      setHtml(changedValues.html);
    }
  }

  async function submit(values: MessageFormValues) {
    setPending(true);
    setNotice("");

    try {
      const response = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "message.test",
          serviceId: values.serviceId,
          senderProfile: values.senderProfile || undefined,
          recipient: values.recipient,
          category: values.category,
          subject: values.subject,
          html: values.html || undefined,
          text: values.text || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string; result?: { id?: string } };
      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to queue message");
      }
      setNotice(`Queued message ${payload.result?.id ?? "successfully"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to queue message");
    } finally {
      setPending(false);
    }
  }

  return (
    <Grid.Row gutter={[16, 16]}>
      <Grid.Col lg={10} xs={24}>
        <Card title="Message details">
        <Form<MessageFormValues>
          form={form}
          initialValues={{
            serviceId,
            senderProfile: "",
            category: initialCategory,
            subject: defaultSubject,
            html: defaultHtml,
            text: defaultText,
          }}
          layout="vertical"
          onSubmit={submit}
          onValuesChange={handleValuesChange}
          requiredSymbol
        >
          <Form.Item field="serviceId" label="Service" rules={[{ required: true }]}>
            <Select
              options={services.map((item) => ({
                label: `${item.product} / ${item.name}`,
                value: item.id,
              }))}
              onChange={handleServiceChange}
            />
          </Form.Item>
          <Form.Item field="senderProfile" label="Sender profile">
            <Select
              options={[
                { label: "Automatic by category", value: "" },
                ...availableSenders.map((item) => ({
                  label: `${item.name} / ${item.from_address}`,
                  value: item.name,
                })),
              ]}
              onChange={handleSenderChange}
            />
          </Form.Item>
          <Form.Item
            field="recipient"
            label="Recipient"
            rules={[
              { required: true, message: "Enter a recipient email address." },
              { type: "email", message: "Enter a valid email address." },
            ]}
          >
            <Input placeholder="recipient@company.com" type="email" />
          </Form.Item>
          <Form.Item field="category" label="Category" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item field="subject" label="Subject" rules={[{ required: true }]}>
            <Input value={subject} onChange={setSubject} />
          </Form.Item>
          <Form.Item field="text" label="Plain text">
            <Input.TextArea autoSize={{ minRows: 6, maxRows: 12 }} />
          </Form.Item>
          <Form.Item field="html" label="HTML">
            <Input.TextArea
              autoSize={{ minRows: 12, maxRows: 24 }}
              spellCheck={false}
              value={html}
              onChange={setHtml}
            />
          </Form.Item>
          <Space size="medium" wrap>
            <Button
              disabled={!services.length}
              htmlType="submit"
              icon={<IconSend aria-hidden="true" />}
              loading={pending}
              type="primary"
            >
              Queue test message
            </Button>
          </Space>
          {notice && (
            <Alert
              content={notice}
              showIcon
              type={notice.startsWith("Queued") ? "success" : "error"}
            />
          )}
        </Form>
        </Card>
      </Grid.Col>

      <Grid.Col lg={14} xs={24}>
        <Card
          extra={
            <Space size="mini">
              <Tooltip content="Desktop preview">
                <Button
                  aria-label="Desktop preview"
                  icon={<IconDesktop aria-hidden="true" />}
                  onClick={() => setViewport("desktop")}
                  shape="circle"
                  type={viewport === "desktop" ? "primary" : "secondary"}
                />
              </Tooltip>
              <Tooltip content="Mobile preview">
                <Button
                  aria-label="Mobile preview"
                  icon={<IconMobile aria-hidden="true" />}
                  onClick={() => setViewport("mobile")}
                  shape="circle"
                  type={viewport === "mobile" ? "primary" : "secondary"}
                />
              </Tooltip>
              <Tooltip content="Toggle HTML source">
                <Button
                  aria-label="Toggle HTML source"
                  aria-pressed={source}
                  icon={<IconCode aria-hidden="true" />}
                  onClick={() => setSource((current) => !current)}
                  shape="circle"
                  type={source ? "primary" : "secondary"}
                />
              </Tooltip>
            </Space>
          }
          title="Message preview"
        >
          <Space direction="vertical" size="medium" style={{ width: "100%" }}>
            <Space direction="vertical" size="mini" style={{ width: "100%" }}>
              <Typography.Ellipsis rows={1} showTooltip style={{ width: "100%" }}>
                <Typography.Text bold>{subject || "Untitled message"}</Typography.Text>
              </Typography.Ellipsis>
              <Typography.Text type="secondary">Transient preview</Typography.Text>
            </Space>
            {source ? (
              <Input.TextArea
                autoSize={{ minRows: 20, maxRows: 32 }}
                readOnly
                spellCheck={false}
                value={html}
              />
            ) : (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <iframe
                  sandbox=""
                  srcDoc={html}
                  style={{
                    border: "1px solid var(--color-border-2)",
                    display: "block",
                    height: 650,
                    maxWidth: viewport === "mobile" ? 375 : 680,
                    width: "100%",
                  }}
                  title="Message preview"
                />
              </div>
            )}
          </Space>
        </Card>
      </Grid.Col>
    </Grid.Row>
  );
}
