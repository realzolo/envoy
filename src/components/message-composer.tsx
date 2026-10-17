"use client";

import { Alert, Button, Card, Divider, Form, Input, Select, Space, Tabs, Tooltip, Typography } from "@arco-design/web-react";
import { IconCode, IconDesktop, IconMobile, IconSend } from "@arco-design/web-react/icon";
import { useMemo, useState, useRef } from "react";
import styles from "./mail-views.module.css";

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
const defaultHtml = '<main style="font-family:Arial,sans-serif;padding:32px"><h1>Envoy test</h1><p>This rendered message was submitted directly to the delivery service.</p></main>';
const defaultText = "Envoy test\n\nThis rendered message was submitted directly to the delivery service.";

export function MessageComposer({ services, senders }: { services: Service[]; senders: Sender[] }) {
  const [form] = Form.useForm<MessageFormValues>();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [subject, setSubject] = useState(defaultSubject);
  const [html, setHtml] = useState(defaultHtml);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [source, setSource] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [messageId, setMessageId] = useState<string>();
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const service = services.find((item) => item.id === serviceId);
  const availableSenders = useMemo(() => senders.filter((item) => item.product_id === service?.product_id), [senders, service?.product_id]);
  const initialCategory = senders.find((item) => item.product_id === services[0]?.product_id)?.category ?? "transactional";

  function handleServiceChange(nextServiceId: string | number) {
    const serviceIdValue = String(nextServiceId);
    const productId = services.find((item) => item.id === serviceIdValue)?.product_id;
    const category = senders.find((item) => item.product_id === productId)?.category ?? "transactional";
    setServiceId(serviceIdValue);
    form.setFieldsValue({ serviceId: serviceIdValue, senderProfile: "", category });
    setNotice(null);
  }

  function handleSenderChange(profile: string | number) {
    const sender = availableSenders.find((item) => item.name === String(profile));
    if (sender) form.setFieldValue("category", sender.category);
  }

  function handleValuesChange(changedValues: Partial<MessageFormValues>) {
    if (typeof changedValues.subject === "string") setSubject(changedValues.subject);
    if (typeof changedValues.html === "string") setHtml(changedValues.html);
    setNotice(null);
  }

  async function submit(values: MessageFormValues) {
    setPending(true);
    setNotice(null);
    setMessageId(undefined);
    try {
      const fingerprint = JSON.stringify(values);
      if (!submission.current || submission.current.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
      const response = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "message.test", idempotencyKey: submission.current.key,
          serviceId: values.serviceId, senderProfile: values.senderProfile || undefined,
          recipient: values.recipient, category: values.category, subject: values.subject,
          html: values.html || undefined, text: values.text || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string; result?: { id?: string } };
      if (!response.ok) throw new Error(payload.error ?? "Unable to queue message");
      setMessageId(payload.result?.id);
      setNotice({ type: "success", message: "Your test message is queued. Check its delivery results for the final outcome." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to queue message" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.composerGrid}>
      <Card className={styles.card} bordered={false} title="Test message">
        <Form<MessageFormValues>
          form={form}
          initialValues={{ serviceId, senderProfile: "", category: initialCategory, subject: defaultSubject, html: defaultHtml, text: defaultText }}
          layout="vertical" onSubmit={submit} onValuesChange={handleValuesChange} disabled={pending} requiredSymbol
        >
          <div className={styles.formFields}>
            <Form.Item field="serviceId" label="Service" rules={[{ required: true, message: "Select a service." }]}>
              <Select options={services.map((item) => ({ label: `${item.product} / ${item.name}`, value: item.id }))} onChange={handleServiceChange} />
            </Form.Item>
            <Form.Item field="senderProfile" label="Sender profile">
              <Select options={[{ label: "Automatic by category", value: "" }, ...availableSenders.map((item) => ({ label: `${item.name} / ${item.from_address}`, value: item.name }))]} onChange={handleSenderChange} />
            </Form.Item>
            <Form.Item field="recipient" label="Recipient" rules={[{ required: true, message: "Enter a recipient email address." }, { type: "email", message: "Enter a valid email address." }]}>
              <Input placeholder="recipient@company.com" type="email" />
            </Form.Item>
            <Form.Item field="category" label="Category" rules={[{ required: true, message: "Enter a message category." }]}>
              <Input />
            </Form.Item>
            <Form.Item className={styles.fullField} field="subject" label="Subject" rules={[{ required: true, message: "Enter a subject." }]}>
              <Input />
            </Form.Item>
          </div>
          <Divider />
          <Tabs defaultActiveTab="html" headerPadding={false} lazyload={false}>
            <Tabs.TabPane key="html" title="HTML content">
              <Form.Item field="html" label="HTML">
                <Input.TextArea autoSize={{ minRows: 10, maxRows: 20 }} spellCheck={false} />
              </Form.Item>
            </Tabs.TabPane>
            <Tabs.TabPane key="text" title="Plain text">
              <Form.Item field="text" label="Plain text">
                <Input.TextArea autoSize={{ minRows: 10, maxRows: 20 }} />
              </Form.Item>
            </Tabs.TabPane>
          </Tabs>
          <div className={styles.formFooter}>
            <Typography.Text type="secondary">This sends a real message to the recipient above.</Typography.Text>
            <Button disabled={!services.length} htmlType="submit" icon={<IconSend />} loading={pending} type="primary">Queue test message</Button>
            {notice && <Alert showIcon type={notice.type} title={notice.type === "success" ? "Message queued" : "Unable to queue message"} content={
              <Space direction="vertical">
                {notice.message}
                {messageId && notice.type === "success" && <Button href={`/emails?q=${encodeURIComponent(messageId)}`} type="text">View delivery results</Button>}
              </Space>
            } />}
          </div>
        </Form>
      </Card>
      <Card className={styles.card} bordered={false} title="Message preview" extra={
        <Space size="mini">
          <Tooltip content="Desktop preview"><Button aria-label="Desktop preview" aria-pressed={viewport === "desktop"} icon={<IconDesktop />} onClick={() => setViewport("desktop")} type={viewport === "desktop" ? "primary" : "secondary"} /></Tooltip>
          <Tooltip content="Mobile preview"><Button aria-label="Mobile preview" aria-pressed={viewport === "mobile"} icon={<IconMobile />} onClick={() => setViewport("mobile")} type={viewport === "mobile" ? "primary" : "secondary"} /></Tooltip>
          <Tooltip content={source ? "Show rendered HTML" : "Show HTML source"}><Button aria-label={source ? "Show rendered HTML" : "Show HTML source"} aria-pressed={source} icon={<IconCode />} onClick={() => setSource((current) => !current)} type={source ? "primary" : "secondary"} /></Tooltip>
        </Space>
      }>
        <div className={styles.previewContent}>
          <Typography.Text bold>{subject || "(No subject)"}</Typography.Text>
          {source ? <Input.TextArea autoSize={{ minRows: 20, maxRows: 32 }} readOnly spellCheck={false} value={html} /> : <div className={styles.previewCanvas}>
            <iframe sandbox="" srcDoc={html} className={`${styles.previewFrame} ${styles.composerPreview} ${viewport === "mobile" ? styles.previewMobile : styles.previewDesktop}`} title="Message preview" />
          </div>}
        </div>
      </Card>
    </div>
  );
}
