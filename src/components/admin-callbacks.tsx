"use client";

import styles from "@/components/admin-views.module.css";

import { Alert, Modal, Button, Checkbox, Collapse, Descriptions, Form, Grid, Input, Select, Space, Typography } from "@arco-design/web-react";
import { IconRotateLeft, IconSend } from "@arco-design/web-react/icon";

import { useState } from "react";

import { ActionForm, type Row, type Data, type FormValues, requiredRule, rows, value, formValue, StatusTag, useAction, Field, Panel, Submit, Notice, ActionButton, Prerequisite, DataTable, TableCard, Secret, date, record, CopyableValue } from "@/components/admin-console-shared";
import { ResourceDetail } from "@/components/admin-resource-detail";

function RotateCallback({ id }: { id: string }) {
  const action = useAction();
  const [secret, setSecret] = useState("");
  return (
    <Collapse bordered={false}>
      <Collapse.Item name="rotate" header="Rotate secret">
        <Space direction="vertical" size="small" className={styles.stack}>
          <Typography.Text type="secondary">Rotating invalidates the previous signing secret immediately.</Typography.Text>
          <Button
            size="small"
            icon={<IconRotateLeft />}
            loading={action.pending}
            onClick={async () => {
              try {
                const result = await action.run({ action: "callback.rotate_secret", id }) as { secret?: string };
                setSecret(result.secret ?? "");
                action.setNotice("A new signing secret was generated.");
              } catch {
                // Inline notice owns failures from this request.
              }
            }}
          >
            Rotate secret
          </Button>
          {secret && <Secret value={secret} />}
          <Notice notice={action.notice} />
        </Space>
      </Collapse.Item>
    </Collapse>
  );
}

export function Callbacks({ data }: { data: Data }) {
  const action = useAction();
  const services = rows(data.services).filter(service => service.product_status === "active");
  const callbacks = rows(data.callbacks);
  const deliveries = rows(data.callbackDeliveries);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [events, setEvents] = useState(["email.delivered", "email.bounced", "email.failed"]);
  const [secret, setSecret] = useState("");
  const eventOptions = [
    ["email.accepted", "Accepted"],
    ["email.delivered", "Delivered"],
    ["email.bounced", "Bounced"],
    ["email.failed", "Failed"],
    ["email.suppressed", "Suppressed"],
    ["inbound.received", "Inbound received"],
  ] as const;

  async function submit(values: FormValues) {
    try {
      const result = await action.run({ action: "callback.create", serviceId: formValue(values, "serviceId"), name: formValue(values, "name"), url: formValue(values, "url"), events }) as { secret?: string };
      setSecret(result.secret ?? "");
      action.setNotice("Callback endpoint created. Copy the generated signing secret below.");
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  if (!services.length) {
    return <Prerequisite title="Create an active service first" description="Callbacks are owned by a service so recipients can identify the product that emitted each event." href="/api-keys" action="Create a service credential" />;
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Add callback endpoint"
        description="Canonical events with HMAC signatures"
        defaultExpanded={callbacks.length === 0}
      >
        <ActionForm fieldErrors={action.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={12} xs={24}><Field field="serviceId" label="Service" initialValue={value(services[0], "id")} required rules={requiredRule}><Select options={services.map(service => ({ value: value(service, "id"), label: `${value(service, "product")} / ${value(service, "name")}` }))} /></Field></Grid.Col>
            <Grid.Col md={12} xs={24}><Field field="name" label="Name" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={12} xs={24}><Field field="url" label="URL" required rules={requiredRule}><Input type="url" placeholder="https://api.example.com/envoy/events" /></Field></Grid.Col>
            <Grid.Col md={12} xs={24}><Field label="Events" required><Checkbox.Group value={events} options={eventOptions.map(([event, title]) => ({ value: event, label: title }))} onChange={next => setEvents(next.map(String))} /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} disabled={!events.length} labelText="Add endpoint" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={action.notice} />
        {secret && <Secret value={secret} label="Generated signing secret. Store it in the callback consumer now." />}
      </Panel>
      <Collapse bordered={false}><Collapse.Item name="advanced" header="Advanced recovery"><Alert type="warning" content={`Recorded dead letters: ${callbacks.reduce((total, row) => total + Number(row.dead_letters ?? 0), 0)}. Only records with active endpoints and retained payloads are eligible. Prefer the endpoint or individual controls below.`} showIcon /><Space wrap>
        <ActionButton
          body={{ action: "callback.replay_dlq" }}
          confirmOkText="Replay"
          confirmText="Replay every dead letter belonging to an active callback endpoint?"
          confirmTitle="Replay eligible dead letters?"
        >
          <IconRotateLeft />Replay eligible dead letters
        </ActionButton>
      </Space></Collapse.Item></Collapse>
      <TableCard title="Callback endpoints">
        <DataTable
          data={callbacks}
          minWidth="980px"
          columns={[
            { title: "Endpoint", render: (_, callback) => <Space direction="vertical" size="mini"><Typography.Text>{value(callback, "name")}</Typography.Text><StatusTag>{value(callback, "status")}</StatusTag></Space> },
            { title: "Service", render: (_, callback) => `${value(callback, "product")} / ${value(callback, "service")}` },
            { title: "URL", width: 260, render: (_, callback) => <Typography.Text ellipsis={{ showTooltip: true }}>{value(callback, "url")}</Typography.Text> },
            { title: "Events", width: 240, render: (_, callback) => Array.isArray(callback.subscribed_events) ? callback.subscribed_events.join(", ") : "" },
            { title: "DLQ", width: 72, render: (_, callback) => value(callback, "dead_letters") },
            {
              title: "Actions",
              width: 260,
              render: (_, callback) => (
                <div className={styles.actions}>
                  {callback.status === "active" && <Button size="small" loading={action.pending} onClick={async () => { try { const result = record(await action.run({ action: "callback.test", id: callback.id })); if (typeof result.deliveryId === "string") setSelectedDeliveryId(result.deliveryId); } catch { /* Inline notice handles the error. */ } }}><IconSend />Test</Button>}
                  <Button size="small" onClick={() => setEditing(callback)}>Edit</Button>
                  {Number(callback.dead_letters ?? 0) > 0 && <ActionButton body={{ action: "callback.replay_dlq", endpointId: callback.id }} confirmTitle="Replay endpoint dead letters?" confirmText={`Queue ${value(callback, "dead_letters")} failed callbacks for ${value(callback, "name")}?`}><IconRotateLeft />Replay endpoint</ActionButton>}
                  <ActionButton body={{ action: "callback.toggle", id: callback.id, enabled: callback.status !== "active" }}>{callback.status === "active" ? "Disable" : "Enable"}</ActionButton>
                </div>
              ),
            },
          ]}
        />
      </TableCard>
      <Notice notice={action.notice} />
      <TableCard title="Callback delivery history (latest 200)">
        <DataTable data={deliveries} minWidth="1080px" columns={[
          { title: "Event / delivery", width: 260, render: (_, item) => <Space direction="vertical" size="mini"><Button type="text" size="small" onClick={() => setSelectedDeliveryId(value(item, "id"))}>{value(item, "event_type")}</Button><Typography.Text type="secondary" ellipsis={{ showTooltip: true }}>{value(item, "id")}</Typography.Text></Space> },
          { title: "Endpoint", render: (_, item) => value(item, "endpoint") },
          { title: "Status", render: (_, item) => <StatusTag>{value(item, "status")}</StatusTag> },
          { title: "Attempts / HTTP", render: (_, item) => `${value(item, "attempt_count")} / ${value(item, "response_code") || "No response"}` },
          { title: "Next attempt", render: (_, item) => ["pending", "retrying", "delivering"].includes(value(item, "status")) ? date(item.next_attempt_at) : "Not scheduled" },
          { title: "Last error", render: (_, item) => <Typography.Text ellipsis={{ showTooltip: true }}>{value(item, "last_error") || "—"}</Typography.Text> },
          { title: "Action", render: (_, item) => item.status === "dead_letter" && !item.payload_purged_at ? <ActionButton body={{ action: "callback.replay_dlq", deliveryId: item.id }} confirmText="Queue this callback delivery again?">Replay</ActionButton> : <Button size="small" onClick={() => setSelectedDeliveryId(value(item, "id"))}>Details</Button> },
        ]} />
      </TableCard>
      {editing && <EditCallback key={value(editing, "id")} callback={editing} onClose={() => setEditing(null)} />}
      {selectedDeliveryId && <ResourceDetail key={selectedDeliveryId} title="Callback delivery" path={`/api/admin/callback-deliveries/${encodeURIComponent(selectedDeliveryId)}`} onClose={() => setSelectedDeliveryId(null)}>{item => <>
        <Descriptions column={1} labelStyle={{ width: 112 }} data={[
          { label: "Status", value: <StatusTag>{value(item, "status")}</StatusTag> },
          { label: "Endpoint", value: value(item, "endpoint") },
          { label: "URL", value: value(item, "url") },
          { label: "Delivery ID", value: <CopyableValue text={value(item, "id")} label="callback delivery ID" /> },
          { label: "Event ID", value: <CopyableValue text={value(item, "event_id")} label="event ID" /> },
          { label: "Attempts", value: value(item, "attempt_count") },
          { label: "HTTP response", value: value(item, "response_code") || "No response" },
          { label: "Created", value: date(item.created_at) },
          { label: "Next attempt", value: ["pending", "retrying", "delivering"].includes(value(item, "status")) ? date(item.next_attempt_at) : "Not scheduled" },
        ]} />
        {item.last_error ? <Alert type="error" content={value(item, "last_error")} showIcon /> : null}
        {item.payload_purged_at ? <Alert type="info" content="Payload removed under the retention policy. This callback cannot be replayed." /> : <Collapse><Collapse.Item name="payload" header="Signed event payload"><pre className={styles.code}>{JSON.stringify(item.payload, null, 2)}</pre></Collapse.Item></Collapse>}
        {item.status === "dead_letter" ? <ActionButton danger body={{ action:"callback.terminate",id:item.id }} confirmText="Permanently stop recovery? Retention can then clear the payload. This does not mark delivery successful.">Terminate recovery</ActionButton> : null}
        {item.status === "dead_letter" && !item.payload_purged_at ? <ActionButton body={{ action: "callback.replay_dlq", deliveryId: item.id }} confirmText="Queue this callback delivery again?">Replay this delivery</ActionButton> : null}
      </>}</ResourceDetail>}
    </Space>
  );
}

function EditCallback({ callback, onClose }: { callback: Row; onClose: () => void }) {
  const action = useAction();
  const [form] = Form.useForm();
  const initialEvents = Array.isArray(callback.subscribed_events) ? callback.subscribed_events.map(String) : [];
  const [events, setEvents] = useState(initialEvents);
  return <Modal title="Edit callback endpoint" style={{ width: 640, maxWidth: "calc(100vw - 32px)" }} visible onCancel={onClose} confirmLoading={action.pending} onOk={async () => {
    const values = await form.validate();
    try { await action.run({ action: "callback.update", id: callback.id, name: formValue(values, "name"), url: formValue(values, "url"), events }); onClose(); } catch { /* Preserve the form for correction. */ }
  }} okButtonProps={{ disabled: !events.length }}>
    <ActionForm fieldErrors={action.fields} form={form} layout="vertical" initialValues={{ name: callback.name, url: callback.url }}>
      <Field field="name" label="Name" required rules={requiredRule}><Input /></Field>
      <Field field="url" label="URL" required rules={requiredRule}><Input type="url" /></Field>
      <Field label="Subscribed events" required><Checkbox.Group value={events} onChange={next => setEvents(next.map(String))} options={["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received"]} /></Field>
    </ActionForm><Notice notice={action.notice} />
    <RotateCallback id={value(callback, "id")} />
  </Modal>;
}
