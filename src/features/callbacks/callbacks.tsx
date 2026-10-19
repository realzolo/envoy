"use client";

import styles from "@/components/admin-views.module.css";

import { Alert,Button,Checkbox,Collapse,Descriptions,Form,Modal,Space,Typography } from "@arco-design/web-react";
import { IconRefresh,IconRotateLeft,IconSend } from "@arco-design/web-react/icon";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useEffect,useState } from "react";

import { ActionButton,ActionForm,CopyableValue,type Data,DataTable,Field,Notice,Prerequisite,type Row,Secret,StatusTag,TableCard,date,record,rows,useAction,value } from "@/components/admin-console-shared";
import { ResourceDetail } from "@/components/admin-resource-detail";

export function Callbacks({ data }: { data: Data }) {
  const action = useAction();
  const services = rows(data.services).filter(service => service.status === "active");
  const callbacks = rows(data.callbacks);
  const deliveries = rows(data.callbackDeliveries);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  if (!services.length) {
    return <Prerequisite title="Create an active service first" description="Callbacks are owned by a service and deliver events to its configured endpoint." href="/api-keys" action="Create a service" />;
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
            { title: "Service", render: (_, callback) => value(callback,"service") },
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
                  <Button size="small" disabled={!callback.url} onClick={() => setEditing(callback)}>Manage callback</Button>
                  {Number(callback.dead_letters ?? 0) > 0 && <ActionButton body={{method:"POST",path:`/api/admin/callback-replays`,payload:{endpointId: callback.id}}} confirmTitle="Replay endpoint dead letters?" confirmText={`Queue ${value(callback, "dead_letters")} failed callbacks for ${value(callback, "name")}?`}><IconRotateLeft />Replay endpoint</ActionButton>}
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
        <Descriptions column={1} layout="vertical" tableLayout="fixed" data={[
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
  const rotation = useAction();
  const router = useRouter();
  const [form] = Form.useForm();
  const initialEvents = Array.isArray(callback.subscribed_events) ? callback.subscribed_events.map(String) : [];
  const [events, setEvents] = useState(initialEvents);
  const [secret, setSecret] = useState("");
  const endpointPath = `/api/admin/callback-endpoints/${encodeURIComponent(String(callback.id))}`;
  const paused = callback.status === "disabled";
  const inFlight = Number(callback.in_flight ?? 0);

  useEffect(() => {
    if (!paused || inFlight === 0) return;
    const timer = window.setInterval(() => router.refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [paused, inFlight, router]);

  async function toggle(enabled: boolean) {
    try {
      await rotation.run({method:"PATCH",path:endpointPath,payload:{id:callback.id,enabled}});
      rotation.setNotice(enabled ? "Delivery resumed. Replay failed callbacks if needed." : "Delivery paused. Waiting for active requests to finish.");
    } catch { /* Inline notice owns the failure. */ }
  }

  function generateSecret() {
    Modal.confirm({
      title: "Generate a new callback secret?",
      content: "The current secret will stop working immediately. Update the consumer before resuming delivery.",
      okText: "Generate secret",
      onOk: async () => {
        const result = await rotation.run({method:"PUT",path:`${endpointPath}/signing-secret`,payload:{}}) as {secret:string};
        setSecret(result.secret);
        rotation.setNotice("New secret generated. Update the consumer before resuming delivery.");
      },
    });
  }

  function resume() {
    if (!secret) { void toggle(true); return; }
    Modal.confirm({
      title: "Resume callback delivery?",
      content: "Confirm that the consumer now uses the new secret.",
      okText: "Resume delivery",
      onOk: () => toggle(true),
    });
  }

  return <Modal title="Manage callback" style={{ width: 640, maxWidth: "calc(100vw - 32px)" }} visible footer={null} onCancel={() => {
    if (!secret) { onClose(); return; }
    Modal.confirm({
      title: "Close secret view?",
      content: "This secret cannot be shown again. Save it in the consumer before closing.",
      okText: "Close view",
      onOk: onClose,
    });
  }}>
    <Space direction="vertical" size="large" className={styles.stack}>
      <Space direction="vertical" size="small" className={styles.stack}>
        <Typography.Text bold>Subscriptions</Typography.Text>
        <Typography.Text type="secondary">{value(callback, "url")}</Typography.Text>
        <ActionForm fieldErrors={action.fields} form={form} layout="vertical">
          <Field label="Events" required><Checkbox.Group className={styles.eventChoices} value={events} onChange={next => setEvents(next.map(String))} options={["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received", "service.permissions_changed"]} /></Field>
        </ActionForm>
        <Button size="small" loading={action.pending} disabled={!events.length} onClick={async () => {
          await form.validate();
          try { await action.run({method:"PUT",path:`${endpointPath}/subscriptions`,payload:{id:callback.id,events}}); } catch { /* Preserve the form for correction. */ }
        }}>Save subscriptions</Button>
        <Notice notice={action.notice} />
      </Space>
      <Space direction="vertical" size="small" className={styles.stack}>
        <Typography.Text bold>Signing secret</Typography.Text>
        {paused && inFlight > 0 && <Alert type="info" content={`Waiting for ${inFlight} in-flight ${inFlight === 1 ? "request" : "requests"} to finish.`} />}
        <Space wrap>
          {!paused && <Button size="small" loading={rotation.pending} onClick={() => void toggle(false)}>Pause delivery</Button>}
          {paused && inFlight > 0 && <Button size="small" icon={<IconRefresh />} onClick={() => router.refresh()}>Refresh status</Button>}
          {paused && inFlight === 0 && !secret && <Button size="small" type="primary" loading={rotation.pending} onClick={generateSecret}>Generate new secret</Button>}
          {paused && <Button size="small" disabled={inFlight > 0 || rotation.pending} onClick={resume}>Resume delivery</Button>}
        </Space>
        {secret && <Secret value={secret} />}
        <Notice notice={rotation.notice} />
      </Space>
    </Space>
  </Modal>;
}
