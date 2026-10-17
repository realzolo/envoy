"use client";

import { Alert, Button, Drawer, Spin } from "@arco-design/web-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Row } from "@/components/admin-console-shared";
import styles from "@/components/admin-views.module.css";

/** A detail stays on its list page so filters and scroll position are retained. */
export function ResourceDetail({ title, path, onClose, children }: { title: string; path: string; onClose: () => void; children: (resource: Row) => ReactNode }) {
  const [resource, setResource] = useState<Row | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(path, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load this record.");
      setResource(payload);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load this record."); });
    return () => controller.abort();
  }, [path]);
  return <Drawer title={title} visible width="min(760px, 100vw)" footer={<Button onClick={onClose}>Close</Button>} onCancel={onClose} autoFocus focusLock>
    <div className={styles.detail}>{error ? <Alert type="error" content={error} showIcon /> : resource ? children(resource) : <div className={styles.loading}><Spin tip="Loading details" /></div>}</div>
  </Drawer>;
}
