import { DomUtils, parseDocument } from "htmlparser2";
import valueParser from "postcss-value-parser";
import parseSrcset from "parse-srcset";
import type { ReaderGrant } from "../application/service";
import type { compileReader } from "./document";

/** Only this renderer creates iframe HTML. Hosts receive an opaque URL and never sanitize or rebuild it. */
export function renderReader(document: ReturnType<typeof compileReader>, token: string, grant: ReaderGrant, origin: string, nonce: string) {
  const base = `${origin}/mail-reader/${token}`;
  const tree = parseDocument(document.html);
  const bind = (value: string) => {
    const match = /^mail-reader-resource:(resource_[1-9][0-9]*)$/.exec(value.trim());
    return match ? `${base}/resources/${match[1]}` : value;
  };
  const bindCss = (value: string) => {
    const parsed = valueParser(value);
    parsed.walk(node => {
      if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
      const raw = valueParser.stringify(node.nodes).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"),
        next = bind(raw);
      if (next !== raw) node.nodes = [{
        type: "string",
        quote: '"',
        value: next,
        sourceIndex: 0,
        sourceEndIndex: next.length
      }];
      return false;
    });
    return parsed.toString();
  };
  for (const element of DomUtils.getElementsByTagName("*", tree.children)) {
    if (element.name === "img" && element.attribs.src) element.attribs.src = bind(element.attribs.src);
    if (["img", "source"].includes(element.name) && element.attribs.srcset) element.attribs.srcset = parseSrcset(element.attribs.srcset).map(item => `${bind(item.url)}${item.w ? ` ${item.w}w` : item.d ? ` ${item.d}x` : ""}`).join(", ");
    if (element.attribs.background) element.attribs.background = bind(element.attribs.background);
    if (element.attribs.style) element.attribs.style = bindCss(element.attribs.style);
    if (element.name === "style") for (const child of element.children) if (child.type === "text") child.data = bindCss(child.data);
  }
  const html = DomUtils.getOuterHTML(tree);
  const config = JSON.stringify({
    base,
    origin,
    channelId: grant.channelId,
    revision: grant.revision,
    expiresAt: grant.expiresAt
  }).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https: http:; img-src data: ${origin}; font-src data: https: http:; connect-src ${origin}; base-uri 'none'; form-action 'none'`;
  const metadata = `<meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const script = `<script nonce="${nonce}" data-envoy-reader-config="${config}" src="${origin}/mail-reader/runtime.v2.js"></script>`;
  let output = html;
  if (/<head(?:\s[^>]*)?>/i.test(output)) output = output.replace(/<head(?:\s[^>]*)?>/i, match => match + metadata);
  else output = metadata + output;
  if (/<\/body\s*>/i.test(output)) output = output.replace(/<\/body\s*>/i, script + "</body>"); else output += script;
  // Reader content is a mail artifact, not a web page for edge email-address rewriting.
  return "<!doctype html><!--email_off-->" + output.replace(/<!doctype[^>]*>/ig, "") + "<!--/email_off-->";
}
