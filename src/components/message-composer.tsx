"use client";

import { Alert, Button, Card, Divider, Form, Input, Select, Space, Tabs, Tooltip, Typography } from "@arco-design/web-react";
import { IconCode, IconDesktop, IconMobile, IconSend } from "@arco-design/web-react/icon";
import { useState, useRef } from "react";
import styles from "./mail-views.module.css";

type Service = { id: string; name: string; product: string; product_id: string };
type MessageFormValues = {
  serviceId: string;
  fromEmail: string;
  fromName: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  category: string;
  subject: string;
  html: string;
  text: string;
};

const defaultSubject = "Test message from Envoy";
const defaultHtml = '<main style="font-family:Arial,sans-serif;padding:32px"><h1>Envoy test</h1><p>This rendered message was submitted directly to the delivery service.</p></main>';
const defaultText = "Envoy test\n\nThis rendered message was submitted directly to the delivery service.";

export function MessageComposer({ services }: { services: Service[] }) {
  const [form] = Form.useForm<MessageFormValues>();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [subject, setSubject] = useState(defaultSubject);
  const [html, setHtml] = useState(defaultHtml);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [source, setSource] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [attachments, setAttachments] = useState<Array<{ fileId: string; fileName: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [messageId, setMessageId] = useState<string>();
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);

  function handleServiceChange(nextServiceId: string | number) {
    const serviceIdValue = String(nextServiceId);
    setServiceId(serviceIdValue);
    setAttachments([]);
    form.setFieldsValue({ serviceId: serviceIdValue });
    setNotice(null);
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
      const addresses = (value: string | undefined) => (value ?? "").split(/[,;\n]/).map(email => email.trim()).filter(Boolean).map(email => ({ email }));
      const message = {
        from: { email: values.fromEmail, ...(values.fromName ? { name: values.fromName } : {}) },
        to: addresses(values.to), cc: addresses(values.cc), bcc: addresses(values.bcc), replyTo: addresses(values.replyTo),
        category: values.category || "transactional", subject: values.subject,
        html: values.html || undefined, text: values.text || undefined,
        attachments: attachments.map(file => ({ ...file, disposition: "attachment" })),
        metadata: { source: "admin_test" },
      };
      const fingerprint = JSON.stringify({ serviceId: values.serviceId, message });
      if (!submission.current || submission.current.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
      const response = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "message.test", idempotencyKey: submission.current.key,
          serviceId: values.serviceId, message,
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

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setNotice(null);
    try {
      const uploaded: Array<{ fileId: string; fileName: string }> = [];
      for (const file of Array.from(files)) {
        const response = await fetch(`/api/admin/files?serviceId=${encodeURIComponent(serviceId)}`, {
          method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" }, body: file,
        });
        const payload = await response.json() as { id: string; fileName: string; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Unable to upload attachment");
        uploaded.push({ fileId: payload.id, fileName: payload.fileName });
      }
      setAttachments(current => [...current, ...uploaded]);
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to upload attachment" });
    } finally { setUploading(false); }
  }

  return (
    <div className={styles.composerGrid}>
      <Card className={styles.card} bordered={false} title="Test message">
        <Form<MessageFormValues>
          form={form}
          initialValues={{ serviceId, fromEmail: "", fromName: "", to: "", cc: "", bcc: "", replyTo: "", category: "transactional", subject: defaultSubject, html: defaultHtml, text: defaultText }}
          layout="vertical" onSubmit={submit} onValuesChange={handleValuesChange} disabled={pending || uploading} requiredSymbol
        >
          <div className={styles.formFields}>
            <Form.Item field="serviceId" label="Service" rules={[{ required: true, message: "Select a service." }]}>
              <Select options={services.map((item) => ({ label: `${item.product} / ${item.name}`, value: item.id }))} onChange={handleServiceChange} />
            </Form.Item>
            <Form.Item field="fromEmail" label="From address" rules={[{ required: true, type: "email", message: "Enter an authorized sender address." }]}><Input type="email" placeholder="orders@mail.company.com" /></Form.Item>
            <Form.Item field="fromName" label="From name"><Input placeholder="Order service" /></Form.Item>
            <Form.Item field="to" label="To"><Input placeholder="customer@example.com, colleague@example.com" /></Form.Item>
            <Form.Item field="cc" label="Cc"><Input placeholder="manager@company.com" /></Form.Item>
            <Form.Item field="bcc" label="Bcc"><Input placeholder="archive@company.com" /></Form.Item>
            <Form.Item field="replyTo" label="Reply-To"><Input placeholder="support@company.com" /></Form.Item>
            <Form.Item field="category" label="Category" rules={[{ required: true, message: "Enter a message category." }]}>
              <Input />
            </Form.Item>
            <Form.Item className={styles.fullField} field="subject" label="Subject">
              <Input />
            </Form.Item>
          </div>
          <Form.Item label="Attachments" extra="Up to 20 files, 10 MB each, 20 MB combined. Files belong to the selected service.">
            <input aria-label="Upload attachments" type="file" multiple disabled={pending || uploading || !serviceId} onChange={event => { void upload(event.target.files); event.target.value = ""; }} />
            {attachments.map(file => <Space key={file.fileId}><Typography.Text>{file.fileName}</Typography.Text><Button type="text" size="small" onClick={() => setAttachments(current => current.filter(item => item.fileId !== file.fileId))}>Remove</Button></Space>)}
          </Form.Item>
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
            <Typography.Text type="secondary">This sends a real email. Separate addresses with commas; at least one To, Cc, or Bcc is required.</Typography.Text>
            <Button disabled={!services.length || uploading} htmlType="submit" icon={<IconSend />} loading={pending} type="primary">Queue test message</Button>
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
