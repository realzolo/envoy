"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Space, Spin, Typography } from "@arco-design/web-react";
import type { MailPreview } from "@/lib/mail-document-contracts";
import { renderMailPreview } from "@/lib/mail-preview";
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, MAX_DOCUMENT_IMAGE_BYTES, MAX_PREVIEW_IMAGE_CONCURRENCY } from "@/lib/mail-image-policy";
import styles from "@/components/mail-views.module.css";

function imageDataUrl(blob: Blob, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Image unavailable"));
    reader.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

export function MessageHtmlPreview({ deliveryId }: { deliveryId: string }) {
  // A new delivery gets a fresh consent state, including when the component is reused by navigation.
  return <Preview key={deliveryId} deliveryId={deliveryId} />;
}

function Preview({ deliveryId }: { deliveryId: string }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{html:string;remote:number;failed:number;loading:boolean;error:boolean} | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const base = `/api/admin/deliveries/${encodeURIComponent(deliveryId)}/preview`;
    const options = { signal: controller.signal, credentials: "same-origin" as const, cache: "no-store" as const };
    async function load() {
      setResult(null);
      try {
        const response = await fetch(base, options);
        if (!response.ok) throw new Error("Preview unavailable");
        const preview = await response.json() as MailPreview;
        const images = new Map<string, string>();
        const remote = preview.resources.filter(resource => resource.kind === "REMOTE" && resource.available).length;
        setResult({ html: renderMailPreview(preview.html, images), remote, failed: 0, loading: true, error: false });
        const pending = preview.resources.filter(resource => resource.available && (resource.kind !== "REMOTE" || allowRemote));
        let next = 0, totalBytes = 0;
        let failed = preview.resources.filter(resource => !resource.available).length;
        async function worker() {
          while (next < pending.length && !controller.signal.aborted) {
            const resource = pending[next++];
            try {
              if (totalBytes >= MAX_DOCUMENT_IMAGE_BYTES) throw new Error("Image budget exceeded");
              const url = `${base}/${encodeURIComponent(resource.id)}?revision=${encodeURIComponent(preview.revision)}`;
              const response = await fetch(url, { ...options, headers: allowRemote ? { "x-envoy-load-remote": "true" } : {} });
              if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(response.headers.get("content-type") ?? "")) throw new Error("Image unavailable");
              if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("Image too large");
              const blob = await response.blob();
              if (controller.signal.aborted) return;
              if (blob.size > MAX_IMAGE_BYTES || totalBytes + blob.size > MAX_DOCUMENT_IMAGE_BYTES) throw new Error("Image budget exceeded");
              const bitmap = await createImageBitmap(blob);
              const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= MAX_IMAGE_DIMENSION && bitmap.height <= MAX_IMAGE_DIMENSION && bitmap.width * bitmap.height <= MAX_IMAGE_PIXELS;
              bitmap.close();
              if (!valid) throw new Error("Image dimensions exceeded");
              if (controller.signal.aborted) return;
              if (totalBytes + blob.size > MAX_DOCUMENT_IMAGE_BYTES) throw new Error("Image budget exceeded");
              totalBytes += blob.size;
              images.set(resource.id, await imageDataUrl(blob, controller.signal));
            } catch {
              if (controller.signal.aborted) return;
              failed++;
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(MAX_PREVIEW_IMAGE_CONCURRENCY, pending.length) }, worker));
        if (!controller.signal.aborted) setResult({ html: renderMailPreview(preview.html, images), remote, failed, loading: false, error: false });
      } catch {
        if (!controller.signal.aborted) setResult({ html: "", remote: 0, failed: 0, loading: false, error: true });
      }
    }
    void load();
    return () => { controller.abort(); };
  }, [deliveryId, allowRemote, attempt]);

  return <div className={styles.previewContent}>
    {result?.remote && !allowRemote ? <Alert type="info" content={<Space wrap>
      <span>Remote images are hidden to protect your privacy. Loading them may notify the sender.</span>
      <Button size="small" onClick={() => setAllowRemote(true)}>Load remote images</Button>
    </Space>} /> : null}
    {result?.error ? <Alert type="warning" content={<Space wrap><span>Message preview is unavailable.</span><Button size="small" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Space>} /> : <>
      {(!result || result.loading) && <Space><Spin size={16} /><Typography.Text type="secondary">Loading message images…</Typography.Text></Space>}
      {result && !result.loading && result.failed > 0 && <Alert type="warning" content={<Space wrap><span>{result.failed} image{result.failed === 1 ? " is" : "s are"} unavailable.</span><Button size="small" onClick={() => setAttempt(value => value + 1)}>Retry images</Button></Space>} />}
      {result && <iframe className={styles.previewFrame} title="Accepted HTML content" sandbox="" referrerPolicy="no-referrer" srcDoc={result.html} />}
    </>}
  </div>;
}
