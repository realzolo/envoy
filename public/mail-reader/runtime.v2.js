/* Native browser runtime. Served unchanged; never serialize a compiled function into HTML. */
"use strict";
function readerRuntime(initial) {
    let session = initial, stopped = false, timer;
    const heights = new Set();
    const send = (type, extra = {}) => parent.postMessage({ type, channelId: session.channelId, ...extra }, "*");
    const height = () => {
        const value = Math.ceil(Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight));
        if (!heights.has(value)) {
            heights.clear();
            heights.add(value);
            send("envoy:mail-reader:layout", { height: value });
        }
    };
    const update = (oldBase, newBase, version) => {
        for (const element of Array.from(document.querySelectorAll("[src],[srcset],[background],[style],style"))) {
            for (const attribute of ["src", "srcset", "background", "style"]) {
                const value = element.getAttribute(attribute);
                if (!value?.includes(oldBase))
                    continue;
                let next = value.replaceAll(oldBase, newBase);
                if (version)
                    next = next.replace(/(\/resources\/resource_[1-9][0-9]*)(?:\?v=[a-zA-Z0-9_-]+)?/g, `$1?v=${version}`);
                if (next !== value)
                    element.setAttribute(attribute, next);
            }
            if (element.tagName === "STYLE" && element.textContent?.includes(oldBase))
                element.textContent = element.textContent.replaceAll(oldBase, newBase);
        }
    };
    const check = async () => {
        if (stopped)
            return;
        if (Date.now() >= session.expiresAt) {
            send("envoy:mail-reader:expired");
            return;
        }
        try {
            const response = await fetch(session.base + "/status", { credentials: "omit", cache: "no-store" });
            if (response.status === 410) {
                send("envoy:mail-reader:expired");
                return;
            }
            if (response.status === 404) {
                send("envoy:mail-reader:unavailable");
                return;
            }
            if (response.ok) {
                const value = await response.json();
                for (const resource of value.resources)
                    if (resource.state === "READY") {
                        const version = resource.sha256?.slice(0, 16) ?? "ready";
                        const marker = `/resources/${resource.id}`;
                        for (const element of Array.from(document.querySelectorAll("[src],[srcset],[background],[style],style"))) {
                            const replace = (value) => value.replace(new RegExp(`(${marker})(?:\\?v=[a-zA-Z0-9_-]+)?(?=[\\s)"',]|$)`, "g"), `$1?v=${version}`);
                            for (const attribute of ["src", "srcset", "background", "style"]) {
                                const old = element.getAttribute(attribute);
                                if (old?.includes(marker)) {
                                    const next = replace(old);
                                    if (next !== old)
                                        element.setAttribute(attribute, next);
                                }
                            }
                            if (element.tagName === "STYLE" && element.textContent?.includes(marker)) {
                                const next = replace(element.textContent);
                                if (next !== element.textContent)
                                    element.textContent = next;
                            }
                        }
                    }
                send("envoy:mail-reader:ready", { total: value.total, ready: value.ready, active: value.active, failed: value.failed, nextCheckAt: value.nextCheckAt, statusRevision: value.statusRevision, resources: value.resources.map(item => ({ id: item.id, state: item.state })) });
                height();
                if (value.resources.every(item => ["READY", "UNAVAILABLE"].includes(item.state)))
                    return;
                const delay = value.nextCheckAt ? Date.parse(value.nextCheckAt) - Date.now() : 5000;
                timer = setTimeout(() => void check(), Math.max(1000, Math.min(30_000, delay)));
                return;
            }
        }
        catch { /* A dropped status read keeps the original document and retries within the session lifetime. */ }
        timer = setTimeout(() => void check(), 5000);
    };
    addEventListener("message", event => {
        if (event.source !== parent || !["envoy:mail-reader:renew", "envoy:mail-reader:retry"].includes(event.data?.type) || event.data.channelId !== session.channelId)
            return;
        if (event.data.type === "envoy:mail-reader:retry") {
            const operationId = event.data.operationId;
            if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId))
                return;
            void fetch(session.base + "/retry", { method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId }) }).then(() => { if (timer)
                clearTimeout(timer); void check(); }).catch(() => send("envoy:mail-reader:unavailable"));
            return;
        }
        const next = event.data.session;
        if (typeof next?.url !== "string" || typeof next.expiresAt !== "string" || typeof next.channelId !== "string" || next.documentRevision !== session.revision)
            return;
        let url;
        try {
            url = new URL(next.url);
        }
        catch {
            return;
        }
        if (url.origin !== session.origin || !/^\/mail-reader\/[A-Za-z0-9_-]+$/.test(url.pathname))
            return;
        const old = session.base;
        session = { ...session, base: next.url, channelId: next.channelId, expiresAt: Date.parse(next.expiresAt) };
        update(old, session.base);
        if (timer)
            clearTimeout(timer);
        void check();
    });
    addEventListener("pagehide", () => { stopped = true; if (timer)
        clearTimeout(timer); });
    document.addEventListener("load", height, true);
    new ResizeObserver(height).observe(document.documentElement);
    height();
    void check();
}

readerRuntime(JSON.parse(document.currentScript.getAttribute("data-envoy-reader-config")));
