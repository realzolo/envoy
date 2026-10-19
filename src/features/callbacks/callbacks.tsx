"use client";

import styles from "@/components/admin-views.module.css";

import { Alert,Button,Checkbox,Collapse,Descriptions,Form,Input,Modal,Space,Typography } from "@arco-design/web-react";
import { IconRotateLeft,IconSend } from "@arco-design/web-react/icon";
import Link from "next/link";

import { useState } from "react";

import { ActionButton,ActionForm,CopyableValue,type Data,DataTable,Field,Notice,Prerequisite,type Row,Secret,StatusTag,TableCard,date,record,rows,useAction,value } from "@/components/admin-console-shared";
import { ResourceDetail } from "@/components/admin-resource-detail";

function ReplaceCallback({ callback }: { callback: Row }) {
  const action = useAction();
  const [secret, setSecret] = useState("");
  const [requestedSecret, setRequestedSecret] = useState("");
  const canReplace = callback.status === "disabled" && Number(callback.in_flight ?? 0) === 0;
  return (
    <Collapse bordered={false}>
      <Collapse.Item name="replace" header="Replace callback secret">
        <Space direction="vertical" size="small" className={styles.stack}>
          <Typography.Text type="secondary">Pause delivery and wait for all in-flight requests to finish. Replace the single secret here and in the consumer, then resume and replay failed callbacks. Each Service has one current secret.</Typography.Text>
          {!canReplace && <Alert type="info" content={`Pause this endpoint and wait for in-flight requests to reach zero before replacing its secret. Current in-flight requests: ${Number(callback.in_flight ?? 0)}.`} />}
          <Input.Password value={requestedSecret} onChange={setRequestedSecret} autoComplete="new-password" placeholder="New secret, or leave blank to generate one" disabled={!canReplace} />
          <Button
            size="small"
            disabled={!canReplace}
            loading={action.pending}
            onClick={async () => {
              try {
                const result = await action.run({method:"PUT",path:`/api/admin/callback-endpoints/${encodeURIComponent(String(callback.id))}/signing-secret`,payload:{id: callback.id, secret: requestedSecret}}) as { secret?: string };
                setSecret(result.secret ?? "");
                setRequestedSecret("");
                action.setNotice("Secret replaced. Update the consumer with this same secret before resuming delivery.");
              } catch {
                // Inline notice owns failures from this request.
              }
            }}
          >
            Replace secret while paused
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
  if (!services.length) {
    return <Prerequisite title="Create an active service first" description="Callbacks are owned by a service so recipients can identify the product that emitted each event." href="/api-keys" action="Create a service" />;
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Alert type="info" content={<span>Configure the Event callback URL in <Link href="/api-keys">Services</Link>. Manage subscriptions, signing secrets, and delivery recovery here.</span>} />
      <Collapse bordered={false}><Collapse.Item name="advanced" header="Advanced recovery"><Alert type="warning" content={`Recorded dead letters: ${callbacks.reduce((total, row) => total + Number(row.dead_letters ?? 0), 0)}. Only records with active endpoints and retained payloads are eligible. Prefer the endpoint or individual controls below.`} showIcon /><Space wrap>
        <ActionButton
          body={{method:"POST",path:`/api/admin/callback-replays`,payload:{}}}
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
            { title: "Event callback URL", width: 260, render: (_, callback) => <Typography.Text ellipsis={{ showTooltip: true }}>{value(callback, "url")}</Typography.Text> },
            { title: "Events", width: 240, render: (_, callback) => Array.isArray(callback.subscribed_events) ? callback.subscribed_events.join(", ") : "" },
            { title: "DLQ", width: 72, render: (_, callback) => value(callback, "dead_letters") },
            { title: "In flight", width: 80, render: (_, callback) => value(callback, "in_flight") },
            {
              title: "Actions",
              width: 260,
              render: (_, callback) => (
                <div className={styles.actions}>
                  {callback.status === "active" && <Button size="small" loading={action.pending} onClick={async () => { try { const result = record(await action.run({method:"POST",path:`/api/admin/callback-endpoints/${encodeURIComponent(String(callback.id))}/tests`,payload:{id: callback.id}})); if (typeof result.deliveryId === "string") setSelectedDeliveryId(result.deliveryId); } catch { /* Inline notice handles the error. */ } }}><IconSend />Test</Button>}
                  <Button size="small" disabled={!callback.url} onClick={() => setEditing(callback)}>Subscriptions and secret</Button>
                  {Number(callback.dead_letters ?? 0) > 0 && <ActionButton body={{method:"POST",path:`/api/admin/callback-replays`,payload:{endpointId: callback.id}}} confirmTitle="Replay endpoint dead letters?" confirmText={`Queue ${value(callback, "dead_letters")} failed callbacks for ${value(callback, "name")}?`}><IconRotateLeft />Replay endpoint</ActionButton>}
                  {Boolean(callback.url) && <ActionButton body={{method:"PATCH",path:`/api/admin/callback-endpoints/${encodeURIComponent(String(callback.id))}`,payload:{id: callback.id, enabled: callback.status !== "active"}}}>{callback.status === "active" ? "Pause" : "Resume"}</ActionButton>}
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
          { title: "Action", render: (_, item) => item.status === "dead_letter" && !item.payload_purged_at ? <ActionButton body={{method:"POST",path:`/api/admin/callback-replays`,payload:{deliveryId: item.id}}} confirmText="Queue this callback delivery again?">Replay</ActionButton> : <Button size="small" onClick={() => setSelectedDeliveryId(value(item, "id"))}>Details</Button> },
        ]} />
      </TableCard>
      {editing && <EditCallback key={value(editing, "id")} callback={callbacks.find(item => item.id === editing.id) ?? editing} onClose={() => setEditing(null)} />}
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
        {item.status === "dead_letter" ? <ActionButton danger body={{method:"POST",path:`/api/admin/callback-deliveries/${encodeURIComponent(String(item.id))}/termination`,payload:{id:item.id}}} confirmText="Permanently stop recovery? Retention can then clear the payload. This does not mark delivery successful.">Terminate recovery</ActionButton> : null}
        {item.status === "dead_letter" && !item.payload_purged_at ? <ActionButton body={{method:"POST",path:`/api/admin/callback-replays`,payload:{deliveryId: item.id}}} confirmText="Queue this callback delivery again?">Replay this delivery</ActionButton> : null}
      </>}</ResourceDetail>}
    </Space>
  );
}

function EditCallback({ callback, onClose }: { callback: Row; onClose: () => void }) {
  const action = useAction();
  const [form] = Form.useForm();
  const initialEvents = Array.isArray(callback.subscribed_events) ? callback.subscribed_events.map(String) : [];
  const [events, setEvents] = useState(initialEvents);
  return <Modal title="Callback subscriptions and secret" style={{ width: 640, maxWidth: "calc(100vw - 32px)" }} visible onCancel={onClose} confirmLoading={action.pending} onOk={async () => {
    await form.validate();
    try { await action.run({method:"PUT",path:`/api/admin/callback-endpoints/${encodeURIComponent(String(callback.id))}/subscriptions`,payload:{id: callback.id, events}}); onClose(); } catch { /* Preserve the form for correction. */ }
  }} okButtonProps={{ disabled: !events.length }}>
    <ActionForm fieldErrors={action.fields} form={form} layout="vertical" initialValues={{ name: callback.name, url: callback.url }}>
      <Typography.Text>Event callback URL: {value(callback, "url")}</Typography.Text>
      <Field label="Subscribed events" required><Checkbox.Group value={events} onChange={next => setEvents(next.map(String))} options={["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received", "service.permissions_changed"]} /></Field>
    </ActionForm><Notice notice={action.notice} />
    <ReplaceCallback callback={callback} />
  </Modal>;
}
