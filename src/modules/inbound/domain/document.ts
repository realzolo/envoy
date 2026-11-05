import parseSrcset from "parse-srcset";
import { Parser } from "htmlparser2";
import sanitizeHtml from "sanitize-html";
import postcss, { type Container, type Declaration } from "postcss";
import valueParser from "postcss-value-parser";
import type { InboundDocument, InboundDocumentResource } from "../contracts";

export const DOCUMENT_POLICY_VERSION = "mail-passive-v1";
export const DOCUMENT_PROJECTION_VERSION = 1;
export const MAX_DOCUMENT_TEXT_BYTES = 2_000_000;
export const MAX_DOCUMENT_RESOURCES = 64;
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_DOCUMENT_IMAGE_BYTES = 20_000_000;
export type DocumentSource = { html: string | null; text: string | null; textProvenance: InboundDocument["textProvenance"]; attachments: { id: string; contentId: string | null }[] };
export type ResourceSource = { url?: string; base64?: string };
export type ProjectedResource = InboundDocumentResource & { source: ResourceSource | null };
export type DocumentProjection = { html: string | null; text: string | null; document: InboundDocument; resources: ProjectedResource[] };

/** CID is an opaque, case-sensitive MIME identifier, never a filename or URL. */
export function canonicalContentId(value: string | null | undefined): string | null {
  if (!value) return null;
  let result = value.trim();
  if (result.startsWith("<") && result.endsWith(">")) result = result.slice(1, -1);
  return result.length > 0 && result.length <= 998 && !/[\s<>\x00-\x1f\x7f-\x9f]/u.test(result) ? result : null;
}

function boundedText(value: string | null): string | null {
  if (value === null) return null;
  if (Buffer.byteLength(value, "utf8") <= MAX_DOCUMENT_TEXT_BYTES) return value;
  // Truncate only at a Unicode code point boundary; source remains encrypted for later policies.
  let bytes = 0, result = "";
  for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > MAX_DOCUMENT_TEXT_BYTES) break; bytes += size; result += character; }
  return result;
}

const cssProperties = new Set(`color background background-color background-image background-position background-repeat background-size background-clip background-origin border border-top border-bottom border-left border-right border-color border-style border-width border-radius border-collapse border-spacing box-shadow box-sizing caption-side clear display empty-cells float font font-family font-size font-style font-variant font-weight height width min-width max-width min-height max-height letter-spacing line-height list-style list-style-type list-style-position margin margin-top margin-right margin-bottom margin-left opacity outline outline-color outline-style outline-width overflow overflow-wrap padding padding-top padding-right padding-bottom padding-left table-layout text-align text-decoration text-indent text-overflow text-transform vertical-align white-space word-break word-spacing word-wrap direction unicode-bidi object-fit object-position flex flex-basis flex-direction flex-grow flex-shrink flex-wrap align-items align-content align-self justify-content gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row`.split(" "));
const cssFunctions = new Set(["rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp", "linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "cubic-bezier"]);

/** Passive markup and parsed CSS retain authored layouts without an automatic network exit. */
export function projectDocument(source: DocumentSource, options: { revision: string; digest: string | null; id(): string; sourceAvailable?: boolean }): DocumentProjection {
  const resources: ProjectedResource[] = [], references = new Map<string, string>();
  // PostgreSQL text/JSONB cannot represent NUL or lone surrogates. Preserve the original only in
  // the encrypted source and publish explicit replacement characters, never a failed/guessed body.
  const htmlSource=source.html?.toWellFormed().replaceAll("\u0000","\ufffd") ?? null;
  const textSource=source.text?.toWellFormed().replaceAll("\u0000","\ufffd") ?? null;
  let partial = htmlSource!==source.html || textSource!==source.text || (textSource !== null && Buffer.byteLength(textSource, "utf8") > MAX_DOCUMENT_TEXT_BYTES);
  const cidAttachments = new Map<string, string[]>();
  for (const attachment of source.attachments) { const cid = canonicalContentId(attachment.contentId); if (cid) cidAttachments.set(cid, [...(cidAttachments.get(cid) ?? []), attachment.id]); }
  const resource = (raw: string, tracking = false): string | null => {
    let value = raw.trim();
    if (/^cid:/i.test(value)) { try { const cid=canonicalContentId(decodeURIComponent(value.slice(4))); if(cid)value=`cid:${cid}`; } catch { /* Keep invalid references unavailable. */ } }
    if (references.has(value)) {
      const existing = resources.find(item => `mail-resource:${item.id}` === references.get(value));
      if (tracking && existing?.kind === "REMOTE" && existing.source) {
        existing.state = "BLOCKED"; existing.reasonCode = "TRACKING_RISK"; existing.downloadEligible = false; partial = true;
      }
      return references.get(value)!;
    }
    if (resources.length >= MAX_DOCUMENT_RESOURCES) { partial = true; return null; }
    let kind: InboundDocumentResource["kind"], contentId: string | null = null, attachmentId: string | null = null, input: ResourceSource | null = null;
    let state: InboundDocumentResource["state"] = "PREPARING", reasonCode: InboundDocumentResource["reasonCode"] = "NOT_READY";
    if (/^cid:/i.test(value)) {
      kind = "CID";
      try { contentId = canonicalContentId(decodeURIComponent(value.slice(4))); } catch { contentId = null; }
      const matches = contentId ? cidAttachments.get(contentId) ?? [] : [];
      attachmentId = matches.length === 1 ? matches[0] : null;
      if (!attachmentId) { state = "UNAVAILABLE"; reasonCode = "SOURCE_UNAVAILABLE"; partial = true; }
    } else if (/^data:/i.test(value)) {
      kind = "EMBEDDED";
      const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
      if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || match[2].length % 4 !== 0) { state = "BLOCKED"; reasonCode = match ? "SIZE_LIMIT" : "UNSUPPORTED_TYPE"; partial = true; }
      else input = { base64: match[2] };
    } else {
      kind = "REMOTE";
      try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new Error(); url.hash = ""; input = { url: url.href }; }
      catch { state = "BLOCKED"; reasonCode = "NETWORK_BLOCKED"; partial = true; }
    }
    if (tracking && kind === "REMOTE" && input) { state = "BLOCKED"; reasonCode = "TRACKING_RISK"; partial = true; }
    const id = options.id(), reference = `mail-resource:${id}`;
    resources.push({ id, kind, contentId, attachmentId, contentType: null, size: null, state, reasonCode, downloadEligible: !!input || !!attachmentId, source: input });
    if (state === "BLOCKED") resources[resources.length - 1].downloadEligible = false;
    references.set(value, reference); return reference;
  };
  const cssValue = (value: string): string | null => {
    let valid = true;
    const parsed = valueParser(value);
    parsed.walk(node => {
      if (node.type !== "function") return;
      const name = node.value.toLowerCase();
      if (name === "url") {
        const raw = valueParser.stringify(node.nodes).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
        // Escape decoding is deliberately not guessed: reject this URL, keep sibling declarations.
        const next = raw.includes("\\") ? null : resource(raw);
        if (!next) valid = false; else node.nodes = [{ type: "string", quote: '"', value: next, sourceIndex: 0, sourceEndIndex: next.length }];
        return false;
      }
      if (!cssFunctions.has(name)) { valid = false; return false; }
    });
    if (/[<>\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) valid = false;
    return valid ? parsed.toString() : null;
  };
  const cleanDeclarations = (container: Container) => {
    container.walkDecls((decl: Declaration) => {
      if (!cssProperties.has(decl.prop.toLowerCase()) || decl.prop.includes("\\")) { decl.remove(); return; }
      const next = cssValue(decl.value); if (next === null) decl.remove(); else decl.value = next;
    });
    container.walkComments(comment => { comment.remove(); });
  };
  const css = (value: string, inline = false): string => {
    try {
      const root = postcss.parse(inline ? `x{${value}}` : value);
      root.walkAtRules(rule => { if (rule.name.toLowerCase() !== "media" || !/^[\w\s():.,/+-]+$/u.test(rule.params)) rule.remove(); });
      root.walkRules(rule => { if (rule.selector.length > 2048 || /[{}<@\x00-\x1f]/u.test(rule.selector)) rule.remove(); });
      cleanDeclarations(root);
      if (inline) { const rule = root.first; return rule?.type === "rule" ? rule.nodes.map(node => node.toString()).join(";") : ""; }
      return root.toString();
    } catch { partial = true; return ""; }
  };
  const markup = htmlSource?.trim() ? sanitizeHtml(htmlSource, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "html", "head", "body", "style", "img", "center", "font", "picture", "source"],
    allowedAttributes: { "*": ["class", "id", "style", "dir", "lang", "title", "align", "valign", "width", "height", "bgcolor"], a: ["href", "name", "target", "rel"], blockquote: [{ name: "type", values: ["cite"] }], img: ["src", "srcset", "alt", "width", "height"], source: ["srcset", "media", "type"], table: ["border", "cellpadding", "cellspacing", "width", "height", "role"], td: ["colspan", "rowspan", "width", "height"], th: ["colspan", "rowspan", "scope"], font: ["color", "face", "size"] },
    allowedSchemes: ["https", "http", "mailto", "tel", "mail-resource"], allowedSchemesByTag: { img: ["mail-resource"], source: ["mail-resource"] }, allowProtocolRelative: false,
    allowVulnerableTags: true, parseStyleAttributes: false,
    transformTags: { "*": (tagName, attributes) => {
      const attrs = { ...attributes };
      if (attrs.style) attrs.style = css(attrs.style, true);
      if (attrs.background) { const ref = resource(attrs.background); if (ref) attrs.style = `${attrs.style ?? ""};background-image:url("${ref}")`; delete attrs.background; }
      if (tagName === "img") { const ref = attrs.src ? resource(attrs.src, Number(attrs.width) <= 1 && Number(attrs.height) <= 1 && !!attrs.width && !!attrs.height) : null; if (ref) attrs.src = ref; else delete attrs.src; }
      if ((tagName === "img" || tagName === "source") && attrs.srcset) {
        const candidates = parseSrcset(attrs.srcset).flatMap(item => {
          const ref = resource(item.url, tagName === "img" && Number(attrs.width) <= 1 && Number(attrs.height) <= 1 && !!attrs.width && !!attrs.height); if (!ref) return [];
          const descriptor = item.w ? `${item.w}w` : item.d ? `${item.d}x` : "";
          return [{ ref, value: `${ref}${descriptor ? ` ${descriptor}` : ""}` }];
        });
        if (candidates.length) { attrs.srcset = candidates.map(item => item.value).join(", "); if (tagName === "img" && !attrs.src) attrs.src = candidates[0].ref; }
        else delete attrs.srcset;
      }
      if (tagName === "a") { attrs.target = "_blank"; attrs.rel = "noopener noreferrer"; }
      return { tagName, attribs: attrs };
    } },

  }) : null;
  // sanitize-html intentionally emits style text verbatim; process every real style node with the
  // CSS parser before publication. Parser positions avoid regex matching tags inside authored text.
  let html = markup;
  if (markup) {
    const edits: { start: number; end: number; value: string }[] = []; let start: number | null = null;
    const parser = new Parser({ onopentag(name) { if (name === "style") start = parser.endIndex + 1; },
      onclosetag(name) { if (name === "style" && start !== null) { edits.push({ start, end: parser.startIndex, value: css(markup.slice(start, parser.startIndex)) }); start = null; } } }, { decodeEntities: false });
    parser.end(markup);
    for (const edit of edits.reverse()) html = html!.slice(0, edit.start) + edit.value + html!.slice(edit.end);
  }
  const text = boundedText(textSource);
  if (html && Buffer.byteLength(html, "utf8") > MAX_DOCUMENT_TEXT_BYTES) { partial = true; }
  let visible = resources.length > 0, hiddenDepth = 0;
  if (html) { const reader = new Parser({ onopentag(name,attrs) { if (["style","head"].includes(name)) hiddenDepth++; if (name==="img" && attrs.alt?.trim()) visible=true; }, onclosetag(name) { if (["style","head"].includes(name)) hiddenDepth=Math.max(0,hiddenDepth-1); }, ontext(text) { if(!hiddenDepth && text.trim()) visible=true; } }); reader.end(html); }
  const safeHtml = html && visible && Buffer.byteLength(html, "utf8") <= MAX_DOCUMENT_TEXT_BYTES ? html : null;
  const state = options.sourceAvailable === false ? "SOURCE_UNAVAILABLE" : partial ? "PARTIAL" : "CURRENT";
  const publicResources = resources.map(({id,kind,contentId,attachmentId,contentType,size,state,reasonCode,downloadEligible}) => ({id,kind,contentId,attachmentId,contentType,size,state,reasonCode,downloadEligible}));
  return { html: safeHtml, text, resources, document: { revision: options.revision, projectionVersion: DOCUMENT_PROJECTION_VERSION, policyVersion: DOCUMENT_POLICY_VERSION, sourceDigest: options.digest, primaryRepresentation: safeHtml ? "HTML" : text?.trim() ? "TEXT" : "NONE", textProvenance: source.textProvenance, state, resources: safeHtml ? publicResources : [] } };
}
