/* Native browser runtime. Served unchanged; never serialize a compiled function into HTML. */
"use strict";
function readerRuntime(initial) {
    let session = initial, stopped = false, timer;
    let previousHeight = -1;
    const send = (type, extra = {}) => parent.postMessage({ type, channelId: session.channelId, ...extra }, "*");
    const height = () => {
        const body = document.body;
        if (!body)
            return;
        const scrollTop = globalThis.scrollY || 0;
        const bodyRectangle = body.getBoundingClientRect?.();
        const computed = (element) => typeof getComputedStyle === "function" ? getComputedStyle(element) : {};
        const length = (style, property) => Math.max(0, Number.parseFloat(style[property] || "0") || 0);
        const bodyStyle = computed(body);
        let bottom = bodyRectangle ? bodyRectangle.bottom : body.scrollHeight || 0;
        const clips = new Map();
        const unbounded = { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity };
        const include = (rectangle, clip) => {
            if (!rectangle || !clip || rectangle.bottom <= rectangle.top || rectangle.right <= rectangle.left)
                return;
            const visible = { top: Math.max(rectangle.top, clip.top), bottom: Math.min(rectangle.bottom, clip.bottom),
                left: Math.max(rectangle.left, clip.left), right: Math.min(rectangle.right, clip.right) };
            if (visible.bottom > visible.top && visible.right > visible.left)
                bottom = Math.max(bottom, visible.bottom + length(bodyStyle, "paddingBottom") + length(bodyStyle, "borderBottomWidth"));
        };
        // Preorder traversal lets each descendant inherit the actual overflow clips of its ancestors.
        // Empty positioned elements can paint outside their parent while an enclosing Range has no box there.
        for (const element of [body, ...Array.from(body.querySelectorAll?.("*") || [])]) {
            const style = computed(element);
            let ancestorClip = element === body ? unbounded : clips.get(element.parentElement);
            if (element !== body && (style.position === "absolute" || style.position === "fixed")) {
                // Positioned boxes escape overflow ancestors between themselves and their containing block.
                // The browser also reports transformed/contained blocks through offsetParent.
                const containingBlock = element.offsetParent;
                ancestorClip = containingBlock && containingBlock !== body && containingBlock !== document.documentElement ? clips.get(containingBlock) : unbounded;
            }
            if (!ancestorClip) {
                clips.set(element, null);
                continue;
            }
            if (style.display === "none") {
                clips.set(element, null);
                continue;
            }
            const rectangle = element.getBoundingClientRect?.();
            if (element !== body && style.visibility !== "hidden" && style.visibility !== "collapse")
                include(rectangle, ancestorClip);
            const clip = { ...ancestorClip };
            // Body/root overflow may propagate to the viewport; only descendant boxes clip intrinsic content.
            if (rectangle && element !== body && style.display !== "contents") {
                if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY || style.overflow || "")) {
                    clip.top = Math.max(clip.top, rectangle.top + length(style, "borderTopWidth"));
                    clip.bottom = Math.min(clip.bottom, rectangle.bottom - length(style, "borderBottomWidth"));
                }
                if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX || style.overflow || "")) {
                    clip.left = Math.max(clip.left, rectangle.left + length(style, "borderLeftWidth"));
                    clip.right = Math.min(clip.right, rectangle.right - length(style, "borderRightWidth"));
                }
            }
            clips.set(element, clip);
            if (typeof document.createRange === "function" && style.visibility !== "hidden" && style.visibility !== "collapse") {
                for (const child of Array.from(element.childNodes || [])) {
                    if (child.nodeType !== 3 || !child.textContent)
                        continue;
                    const range = document.createRange();
                    range.selectNodeContents(child);
                    include(range.getBoundingClientRect(), clip);
                }
            }
        }
        // Root scrollHeight is floored by the iframe viewport; never feed it back into intrinsic content size.
        const scrollbar = Math.max(0, (globalThis.innerHeight || 0) - (document.documentElement.clientHeight || globalThis.innerHeight || 0));
        const value = Math.ceil(Math.max(0, bottom + scrollTop) + length(bodyStyle, "marginBottom") + scrollbar);
        if (value !== previousHeight) {
            previousHeight = value;
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
    addEventListener("pagehide", () => { stopped = true; observer.disconnect(); if (timer)
        clearTimeout(timer); });
    document.addEventListener("load", height, true);
    const observer = new ResizeObserver(height);
    observer.observe(document.documentElement);
    if (document.body)
        observer.observe(document.body);
    addEventListener("resize", height);
    height();
    void check();
}

readerRuntime(JSON.parse(document.currentScript.getAttribute("data-envoy-reader-config")));
