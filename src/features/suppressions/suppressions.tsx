"use client";
import { ActionButton,ActionForm,type Data,DataTable,date,Field,formValue,type FormValues,Notice,optionalValue,Panel,requiredRule,rows,Submit,TableCard,useAction,value } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";
import { Grid,Input,Select,Space } from "@arco-design/web-react";
import { IconDelete } from "@arco-design/web-react/icon";
import { useState } from "react";
export function Suppressions({ data }: { data: Data }) {
  const action = useAction();
  const [scope, setScope] = useState<"global" | "product" | "list">("global");
  const products = rows(data.products).filter(product => product.status === "active");
  const suppressions = rows(data.suppressions);

  async function submit(values: FormValues) {
    try {
      const expiresAt = optionalValue(values, "expiresAt");
      await action.run({method:"POST",path:`/api/admin/suppressions`,payload:{email: formValue(values, "email"), scope, productId: scope === "global" ? undefined : formValue(values, "productId"), listId: scope === "list" ? formValue(values, "listId") : undefined, reason: formValue(values, "reason"), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined}});
    } catch {
      // Inline notice owns failures from this request.
    }
  }

  return (
    <Space direction="vertical" size="large" className={styles.stack}>
      <Panel
        title="Add suppression"
        description="Global, product, or list scope"
        defaultExpanded={suppressions.length === 0}
      >
        <ActionForm fieldErrors={action.fields} layout="vertical" onSubmit={values => void submit(values as FormValues)}>
          <Grid.Row gutter={[16, 0]}>
            <Grid.Col md={8} xs={24}><Field field="email" label="Email" required rules={[{ required: true, type: "email" }]}><Input type="email" /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field label="Scope" required><Select value={scope} options={[{ value: "global", label: "Global" }, { value: "product", label: "Product" }, { value: "list", label: "List" }]} onChange={next => setScope(next as typeof scope)} /></Field></Grid.Col>
            {scope !== "global" && <Grid.Col md={8} xs={24}><Field field="productId" label="Product" required rules={requiredRule}><Select placeholder="Choose a product" options={products.map(product => ({ value: value(product, "id"), label: value(product, "name") }))} /></Field></Grid.Col>}
            {scope === "list" && <Grid.Col md={8} xs={24}><Field field="listId" label="List ID" required rules={requiredRule}><Input placeholder="marketing-newsletter" /></Field></Grid.Col>}
            <Grid.Col md={8} xs={24}><Field field="reason" label="Reason" initialValue="manual" required rules={requiredRule}><Input /></Field></Grid.Col>
            <Grid.Col md={8} xs={24}><Field field="expiresAt" label="Expires at" hint="Optional"><Input type="datetime-local" /></Field></Grid.Col>
            <Grid.Col xs={24}><Space><Submit pending={action.pending} disabled={scope !== "global" && !products.length} labelText="Add suppression" /></Space></Grid.Col>
          </Grid.Row>
        </ActionForm>
        <Notice notice={action.notice} />
      </Panel>
      <TableCard title="Suppressions">
        <DataTable
          data={suppressions}
          columns={[
            { title: "Email", render: (_, suppression) => value(suppression, "email_normalized") },
            { title: "Scope", render: (_, suppression) => `${value(suppression, "scope_type")} ${value(suppression, "product")}${value(suppression, "list_id") ? ` / ${value(suppression, "list_id")}` : ""}` },
            { title: "Reason", render: (_, suppression) => value(suppression, "reason") },
            { title: "Source", render: (_, suppression) => value(suppression, "source") },
            { title: "Expires", render: (_, suppression) => suppression.expires_at ? date(suppression.expires_at) : "Permanent" },
            {
              title: "Action",
              render: (_, suppression) => (
                <ActionButton
                  danger
                  body={{method:"DELETE",path:`/api/admin/suppressions/${encodeURIComponent(String(suppression.id))}`,payload:{id: suppression.id}}}
                  confirmOkText="Remove"
                  confirmText="This recipient will become eligible for delivery again immediately."
                  confirmTitle="Remove suppression?"
                >
                  <IconDelete />Remove
                </ActionButton>
              ),
            },
          ]}
        />
      </TableCard>
    </Space>
  );
}