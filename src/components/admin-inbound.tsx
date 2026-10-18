"use client";

import styles from "@/components/admin-views.module.css";

import { Alert, Button, Collapse, Card, Descriptions, Grid, Select, Space, Typography } from "@arco-design/web-react";

import { useState } from "react";

import { ActionForm, type Data, rows, record, value, date, StatusTag, useAction, Field, Panel, Submit, Notice, ActionButton, EmptyState, Prerequisite, DataTable, TableCard, CopyableValue } from "@/components/admin-console-shared";
import { ResourceDetail } from "@/components/admin-resource-detail";

export function Inbound({ data }: { data: Data }) {
  const action = useAction();
  const items = rows(data.inbound);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inboundRoutes = rows(data.inboundRoutes);
  const endpoints = rows(data.webhooks).filter(endpoint => endpoint.status === "active" && endpoint.security_configured);
  const products = rows(data.products).filter(product => product.status === "active");
  const availableDomains = rows(data.domains).filter(domain => domain.status === "active");
  const [webhookEndpointId, setWebhookEndpointId] = useState(value(endpoints[0] ?? {}, "id"));
  const [productId, setProductId] = useState(value(products[0] ?? {}, "id"));
  const [serviceId, setServiceId] = useState("");
  const domains = availableDomains;
  const [domainId, setDomainId] = useState(value(domains[0] ?? {}, "id"));
  const selectedDomainId = domains.some(domain => value(domain, "id") === domainId) ? domainId : value(domains[0] ?? {}, "id");
  const services = rows(data.services).filter(service => service.product_status === "active" && service.product_id === productId);


  function selectEndpoint(next: string | number) {
    const nextId = String(next);
    setWebhookEndpointId(nextId);

  }

  function selectProduct(next: string | number) {
    setProductId(String(next));
    setServiceId("");
  }

  function selectService(next: string | number) {
    setServiceId(String(next));
  }

  async function submit() {
    try {
      await action.run({
        action: "inbound_route.create",
        webhookEndpointId,
        domainId: selectedDomainId,
        productId,
        serviceId,
      });
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  if (!endpoints.length || !products.length || !availableDomains.length) {
    return <Prerequisite title="Create inbound route prerequisites" description={!endpoints.length ? "Configure event verification on an active provider account before accepting inbound mail." : !availableDomains.length ? "Register an active domain for inbound routing; outbound verification is separate." : "Create an active product before routing inbound mail."} href={!endpoints.length ? "/providers" : !availableDomains.length ? "/domains" : "/api-keys"} action={!endpoints.length ? "Configure provider webhooks" : !availableDomains.length ? "Manage domains" : "Create a product"} />;
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Alert type="info" content="Inbound routes use authenticated envelope recipients and require domain receiving permission. Each business service receives one private copy and uses its unified callback. Domain verification does not prove receiving works; providers without a trustworthy envelope remain unavailable." />
      <Panel
        title="Create inbound route"
        description="Route the entire authorized domain to a business service; its unified callback is used automatically"
        defaultExpanded={inboundRoutes.length === 0}
      >
        <ActionForm fieldErrors={action.fields} layout="vertical" onSubmit={() => void submit()}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field label="Provider endpoint" required><Select value={webhookEndpointId} options={endpoints.map(endpoint => ({ value: value(endpoint, "id"), label: `${value(endpoint, "account")} / ${value(endpoint, "type")}` }))} onChange={selectEndpoint} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Inbound domain" required><Select value={selectedDomainId} options={domains.map(domain => ({ value: value(domain, "id"), label: value(domain, "domain") }))} onChange={next => setDomainId(String(next))} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Product" required><Select value={productId} options={products.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} onChange={selectProduct} /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Service"><Select value={serviceId} options={services.map(service => ({ value: value(service, "id"), label: value(service, "name") }))} onChange={selectService} /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} labelText="Create route" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={action.notice} />
      </Panel>
      <TableCard title="Inbound routes">
        <DataTable
          data={inboundRoutes}
          columns={[
            { title: "Domain", render: (_, route) => value(route, "domain") },
            { title: "Product", render: (_, route) => value(route, "product") },
            { title: "Service", render: (_, route) => value(route, "service") || "None" },
            { title: "Provider", render: (_, route) => value(route, "provider_type") },
            { title: "Notification", render: (_, route) => <Space direction="vertical"><Typography.Text>{value(route,"notification_state")}</Typography.Text><Typography.Text type="secondary">{value(route,"callback")}</Typography.Text></Space> },
            { title: "Status", render: (_, route) => <StatusTag>{value(route, "status")}</StatusTag> },
            { title: "Action", render: (_, route) => <ActionButton body={{ action: "inbound_route.toggle", id: route.id, enabled: route.status !== "active" }}>{route.status === "active" ? "Disable" : "Enable"}</ActionButton> },
          ]}
        />
      </TableCard>
      {items.length ? (
        <TableCard title="Inbound messages">
          <DataTable
            data={items}
            columns={[
              { title: "From", render: (_, item) => value(item, "from_email") },
              { title: "To", render: (_, item) => Array.isArray(item.to_emails) ? item.to_emails.join(", ") : "" },
              { title: "Subject", render: (_, item) => <Button type="text" onClick={() => setSelectedId(value(item, "id"))}>{value(item, "subject") || "(No subject)"}</Button> },
              { title: "Product / visibility", render: (_, item) => <Space direction="vertical" size="mini"><Typography.Text>{value(item, "product") || "Unrouted"}</Typography.Text>{!item.service_id && <Typography.Text type="secondary">Administrator only</Typography.Text>}</Space> },
              { title: "Attachments", render: (_, item) => value(item, "attachment_count") },
              { title: "Status", render: (_, item) => <StatusTag>{value(item, "status")}</StatusTag> },
              { title: "Stored", render: (_, item) => date(item.received_at) },
            ]}
          />
        </TableCard>
      ) : (
        <Card className={styles.card} title="Inbound messages">
          <EmptyState text="No inbound messages have been received." />
        </Card>
      )}
      {selectedId && <ResourceDetail key={selectedId} title="Inbound message" path={`/api/admin/inbound/${encodeURIComponent(selectedId)}`} onClose={() => setSelectedId(null)}>{item => <>
        <div className={styles.section}>
        <Typography.Text bold>{value(item, "subject") || "(No subject)"}</Typography.Text>
        <Descriptions column={1} labelStyle={{ width: 112 }} data={[
          { label: "Status", value: <StatusTag>{value(item, "status")}</StatusTag> },
          { label: "Stored", value: date(item.received_at) },
          { label: "Author Date", value: item.author_date ? date(item.author_date) : "Not supplied / invalid" },
          { label: "Trusted ingress", value: item.ingress_received_at ? date(item.ingress_received_at) : "Unknown" },
          { label: "Readable since", value: item.ready_at ? date(item.ready_at) : "Unknown / not ready" },
          { label: "Envoy ID", value: <CopyableValue text={value(item, "id")} label="inbound message ID" /> },
          { label: "RFC Message-ID", value: value(item, "message_id") || "Not supplied" },
          { label: "SMTP recipients", value: Array.isArray(item.envelope_recipients) && item.envelope_recipients.length ? item.envelope_recipients.join(", ") : "Unknown / unverified" },
          { label: "Reply-To", value: Array.isArray(item.reply_to) ? item.reply_to.join(", ") : "" },
          { label: "In-Reply-To", value: value(item, "in_reply_to") || "Not supplied" },
          { label: "References", value: Array.isArray(item.references_ids) ? item.references_ids.join(" ") : "" },
          { label: "From", value: value(item, "from_email") },
          { label: "To", value: Array.isArray(item.to_emails) ? item.to_emails.join(", ") : "" },
          { label: "Product", value: value(item, "product") || "Unrouted" },
          { label: "Service", value: value(item, "service") || "Administrator only" },
          { label: "Representative route", value: value(item, "route") ? `${value(item, "route")}@${value(item, "domain")}` : "No route matched" },
        ]} />
        </div>
        {item.rejection_reason ? <Alert type="error" content={value(item, "rejection_reason")} showIcon /> : null}
        {item.content_purged_at ? <Alert type="info" content="Message content was removed under the retention policy." /> : <>
          <Collapse defaultActiveKey={["text"]}>
            <Collapse.Item name="text" header="Plain-text content"><pre className={styles.code}>{value(item, "text_body") || "No plain-text content."}</pre></Collapse.Item>
            {item.sanitized_html ? <Collapse.Item name="html" header="Isolated HTML preview"><iframe title="Inbound HTML preview" className={styles.preview} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${value(item, "sanitized_html")}`} /></Collapse.Item> : null}
          </Collapse>
        </>}
        <div className={styles.section}><Typography.Text bold>Attachments</Typography.Text>
        <DataTable searchable={false} minWidth="640px" data={rows(item.attachments)} columns={[
          { title: "File", render: (_, file) => value(file, "file_name") },
          { title: "Size / type", render: (_, file) => `${Number(file.size_bytes).toLocaleString("en-US")} B · ${value(file, "content_type")}` },
          { title: "Scan", render: (_, file) => <StatusTag>{value(record(file.usage), "state")}</StatusTag> },
          { title: "Download", render: (_, file) => file.content_purged_at ? "Removed" : item.status === "ready" && file.downloadable !== false ? <Button href={`/api/admin/inbound/${encodeURIComponent(value(item, "id"))}/attachments/${encodeURIComponent(value(file, "id"))}`} size="small">Download</Button> : "Unavailable" },
        ]} emptyText="No attachments." />
        </div>
      </>}</ResourceDetail>}
    </Space>
  );
}
