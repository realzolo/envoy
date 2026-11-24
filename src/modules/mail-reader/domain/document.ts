import { DomUtils, parseDocument } from "htmlparser2";
import valueParser from "postcss-value-parser";
import parseSrcset from "parse-srcset";
import type { ReaderResource, ReaderSource } from "../contracts";
export const READER_POLICY = "mail-reader-v2";
const MAX_READER_RESOURCES = 256;

/** One passive document compiler for every reader. Author CSS and layout never inherit the admin theme. */
export function compileReader(source: ReaderSource) {
  const document = parseDocument(source.html ?? `<html><body><pre></pre></body></html>`);
  if (!source.html) {
    const pre = DomUtils.getElementsByTagName("pre", document.children)[0];
    if (pre) pre.children = parseDocument((source.text ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")).children;
  }
  const rawBase=DomUtils.getElementsByTagName("base",document.children).map(item=>item.attribs.href).find(Boolean);
  let documentBase:string|undefined;
  try{if(rawBase){const parsed=new URL(rawBase);if(["http:","https:"].includes(parsed.protocol))documentBase=parsed.href;}}catch{/* No implicit sender-origin guess. */}
  const resources: ReaderResource[] = [], seen = new Map<string,string>();
  const resource = (raw: string) => {
    const value = raw.trim();
    if (!value || value.startsWith("#")) return value;
    if (seen.has(value)) return seen.get(value)!;
    if (resources.length >= MAX_READER_RESOURCES) return "";
    let item: Omit<ReaderResource,"id">;
    if (/^cid:/i.test(value)) {
      let cid = value.slice(4); try { cid = decodeURIComponent(cid); } catch { /* Exact missing ID remains unavailable. */ }
      item = { kind: "CID", source: cid.replace(/^<|>$/g,"") };
    } else if (/^data:image\//i.test(value)) item = { kind: "EMBEDDED", source: value };
    else {
      try { const url = new URL(value.startsWith("//") ? `https:${value}` : value,documentBase); if (!["http:","https:"].includes(url.protocol)) return ""; item = { kind:"REMOTE", source:url.href }; }
      catch { return ""; }
    }
    const id = `resource_${resources.length+1}`; resources.push({id,...item});
    const reference = `mail-reader-resource:${id}`; seen.set(value,reference); return reference;
  };
  const css = (value: string) => {
    const parsed=valueParser(value); parsed.walk(node=>{
      if(node.type!=="function" || node.value.toLowerCase()!=="url")return;
      const value=valueParser.stringify(node.nodes).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/,"$1$2");
      if(/\.(?:woff2?|ttf|otf|css)(?:[?#]|$)/i.test(value)) {
       try{const next=new URL(value,documentBase).href;node.nodes=[{type:"string",quote:'"',value:next,sourceIndex:0,sourceEndIndex:next.length}];}catch{/* Keep authored CSS when no original base exists. */}return false;
      }
      const next=resource(value); node.nodes=[{type:"string",quote:'"',value:next,sourceIndex:0,sourceEndIndex:next.length}]; return false;
    }); return parsed.toString();
  };
  const elements=DomUtils.getElementsByTagName("*",document.children);
  for(const element of elements) {
    if(["script","iframe","object","embed","base"].includes(element.name) || (element.name==="meta" && /refresh|content-security-policy/i.test(element.attribs["http-equiv"]??""))) {DomUtils.removeElement(element);continue;}
    for(const key of Object.keys(element.attribs)) if(/^on/i.test(key))delete element.attribs[key];
    if(element.name==="img" && element.attribs.src)element.attribs.src=resource(element.attribs.src);
    if(["img","source"].includes(element.name) && element.attribs.srcset)element.attribs.srcset=parseSrcset(element.attribs.srcset).map(entry=>`${resource(entry.url)}${entry.w?` ${entry.w}w`:entry.d?` ${entry.d}x`:""}`).join(", ");
    if(element.attribs.background)element.attribs.background=resource(element.attribs.background);
    if(element.attribs.style)element.attribs.style=css(element.attribs.style);
    if(element.name==="style")for(const child of element.children)if(child.type==="text")child.data=css(child.data);
    if(element.name==="link"&&element.attribs.href&&documentBase){try{element.attribs.href=new URL(element.attribs.href,documentBase).href;}catch{/* Preserve invalid reference without inventing a source. */}}
    if(element.name==="a") {element.attribs.target="_blank";element.attribs.rel="noopener noreferrer"; if(/^javascript:/i.test(element.attribs.href??""))delete element.attribs.href;}
  }
  return { html: DomUtils.getOuterHTML(document), resources };
}

/** Canonical property/attachment order makes ingress registration and later reads share exactly one identity. */
export function readerSourceFingerprint(source:ReaderSource) {
 return JSON.stringify({policy:READER_POLICY,source:{kind:source.kind,id:source.id,serviceId:source.serviceId,html:source.html,text:source.text,
  attachments:[...source.attachments].sort((a,b)=>a.id.localeCompare(b.id)).map(file=>({id:file.id,contentId:file.contentId,contentType:file.contentType,size:file.size,sha256:file.sha256}))}});
}
