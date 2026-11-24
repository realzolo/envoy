import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it, vi } from "vitest";
import { compileReader } from "@/modules/mail-reader/domain/document";
import type { ReaderSource } from "@/modules/mail-reader/contracts";

const source = (text: string, html: string | null = null): ReaderSource => ({
  kind: "INBOUND", id: "inb_plain_text", serviceId: "svc_text", html, text, attachments: []
});

function textPreview(text: string, html: string | null = null) {
  const result = compileReader(source(text, html));
  const document = parseDocument(result.html);
  return { result, document, pre: DomUtils.getElementsByTagName("pre", document.children)[0] };
}

describe("authored plain-text mail presentation", () => {
  it("keeps a long Chinese message, literal email, paragraphs and author characters intact", () => {
    const text = `你好，${"这是一段需要在窄面板完整阅读的中文内容。".repeat(25)}\n\n` +
      "请联系 test.envoy@sonaops.space & 保留 <原文>。\n" +
      "https://example.test/" + "very-long-address-".repeat(50);
    const { result, document, pre } = textPreview(text);
    expect(DomUtils.textContent(pre)).toBe(text);
    expect(result.resources).toEqual([]);
    expect(result.html).not.toContain("[email protected]");
    const css = DomUtils.getElementsByTagName("style", document.children).map(DomUtils.textContent).join("\n");
    expect(css).toContain("white-space:pre-wrap");
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("font:16px/1.7");
    expect(css).toContain("max-width:72ch");
  });

  it("uses the text representation for an empty HTML part without inventing HTML or image content", () => {
    const text = "第一行\n\n第二行 <img src=\"https://example.test/a.png\">";
    const { result, pre } = textPreview(text, " \n\t ");
    expect(DomUtils.textContent(pre)).toBe(text);
    expect(result.resources).toEqual([]);
    expect(DomUtils.getElementsByTagName("img", parseDocument(result.html).children)).toEqual([]);
  });

  it("does not apply fallback typography or wrap rules to a real HTML email", () => {
    const html = '<html><head><style>body{font:12px Georgia;color:#f00}pre{white-space:pre}</style></head><body><pre>Original HTML</pre></body></html>';
    const result = compileReader(source("Different plain text", html));
    expect(result.html).toContain("font:12px Georgia");
    expect(result.html).toContain("white-space:pre");
    expect(result.html).not.toContain("data-envoy-reader-text");
    expect(result.html).not.toContain("overflow-wrap:anywhere");
    expect(result.html).not.toContain("Different plain text");
  });
});

function runtimeFixture(mode?: "positioned" | "clipped" | "static-clipped" | "fixed" | "root-positioned") {
  let bodyBottom = mode === "positioned" ? 0 : mode ? 120 : 900, contentBottom = 876;
  const layout = vi.fn();
  const handlers = new Map<string, () => void>();
  let observedResize: () => void = () => {};
  const observer = { observe: vi.fn(), disconnect: vi.fn() };
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 600, height: bottom - top });
  const root = { scrollHeight: 1800, clientHeight: 1800 };
  const body = { scrollHeight: 1800, parentElement: null, childNodes: mode ? [] : [{ nodeType: 3, textContent: "Long wrapped text" }],
    getBoundingClientRect: () => rect(0, bodyBottom), querySelectorAll: () => mode ? [container, positioned] : [] };
  const container = { parentElement: body, childNodes: [], getBoundingClientRect: () => rect(0, mode === "positioned" ? 0 : 120) };
  const positioned = { parentElement: container, offsetParent: mode === "root-positioned" ? root : mode === "static-clipped" ? body : mode === "fixed" ? null : container, childNodes: mode === "clipped" ? [{ nodeType: 3, textContent: "Text overflowing the clipped card" }] : [], getBoundingClientRect: () => rect(500, 700) };
  const runtime = readFileSync(new URL("../../public/mail-reader/runtime.v2.js", import.meta.url), "utf8");
  runInNewContext(runtime, {
    parent: { postMessage: layout },
    document: {
      currentScript: { getAttribute: () => JSON.stringify({ base: "https://envoy.test/mail-reader/opaque", origin: "https://envoy.test", channelId: "test-channel", revision: "a".repeat(64), expiresAt: Date.now() + 120_000 }) },
      body, documentElement: root,
      createRange: () => ({ selectNodeContents: vi.fn(), getBoundingClientRect: () => rect(mode === "clipped" ? 500 : 0, contentBottom) }),
      querySelectorAll: () => [], addEventListener: vi.fn()
    },
    innerHeight: 1800, scrollY: 0,
    getComputedStyle: (element: unknown) => ({ paddingBottom: element === body && !mode ? "24px" : "0px", borderBottomWidth: "0px", marginBottom: "0px",
      overflowY: element === body ? "auto" : element === container && mode !== "positioned" ? "hidden" : "visible", overflowX: "visible",
      position: element === body ? mode === "root-positioned" ? "static" : "relative" : element === positioned ? mode === "fixed" ? "fixed" : "absolute" : mode === "static-clipped" || mode === "root-positioned" ? "static" : "relative" }),
    ResizeObserver: class {
      constructor(callback: () => void) { observedResize = callback; }
      observe = observer.observe;
      disconnect = observer.disconnect;
    },
    fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ resources: [] }) })),
    addEventListener: (name: string, callback: () => void) => handlers.set(name, callback),
    setTimeout: vi.fn(), clearTimeout: vi.fn(), URL
  });
  return { layout, handlers, body, root, observer, resize: () => observedResize(), shrink: () => { bodyBottom = 220; contentBottom = 196; }, overflow: () => { contentBottom = 1200; } };
}

describe("reader content height without viewport feedback", () => {
  it("can shrink after a long wrapped message becomes shorter even while the iframe viewport remains tall", async () => {
    const fixture = runtimeFixture();
    expect(fixture.layout).toHaveBeenCalledWith(expect.objectContaining({ type: "envoy:mail-reader:layout", height: 900 }), "*");
    fixture.shrink();
    fixture.resize();
    expect(fixture.root.scrollHeight).toBe(1800);
    expect(fixture.body.scrollHeight).toBe(1800);
    expect(fixture.layout).toHaveBeenLastCalledWith(expect.objectContaining({ type: "envoy:mail-reader:layout", height: 220 }), "*");
    await Promise.resolve();
  });

  it("includes an empty positioned descendant that has no enclosing range or parent height", () => {
    const fixture = runtimeFixture("positioned");
    expect(fixture.layout).toHaveBeenCalledWith(expect.objectContaining({ height: 700 }), "*");
  });

  it("keeps an overflow-hidden card at its own height when positioned boxes and text are entirely clipped", () => {
    const fixture = runtimeFixture("clipped");
    expect(fixture.layout).toHaveBeenCalledWith(expect.objectContaining({ height: 120 }), "*");
  });

  it("does not clip an absolutely positioned box by a static overflow ancestor outside its containing block", () => {
    const fixture = runtimeFixture("static-clipped");
    expect(fixture.layout).toHaveBeenCalledWith(expect.objectContaining({ height: 700 }), "*");
  });

  it("treats a document-element containing block as the root instead of a missing descendant clip", () => {
    const fixture = runtimeFixture("root-positioned");
    expect(fixture.layout).toHaveBeenCalledWith(expect.objectContaining({ height: 700 }), "*");
  });

  it("uses viewport positioning for a fixed box without an offset parent instead of a static overflow ancestor", () => {
    const fixture = runtimeFixture("fixed");
    expect(fixture.layout).toHaveBeenCalledWith(expect.objectContaining({ height: 700 }), "*");
  });

  it("includes content overflow and bottom padding and observes body changes", () => {
    const fixture = runtimeFixture();
    fixture.overflow();
    fixture.resize();
    expect(fixture.layout).toHaveBeenLastCalledWith(expect.objectContaining({ height: 1224 }), "*");
    expect(fixture.observer.observe).toHaveBeenCalledWith(fixture.body);
    fixture.handlers.get("pagehide")?.();
    expect(fixture.observer.disconnect).toHaveBeenCalledOnce();
  });
});
