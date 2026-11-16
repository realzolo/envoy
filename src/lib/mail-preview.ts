import { DomUtils, parseDocument } from "htmlparser2";

// The frame can display only bytes already fetched and checked by Envoy.
export const MAIL_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const emptyImage = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const reference = /mail-resource:([A-Za-z0-9_-]+)/g;

/** Rewrite resource positions only. Literal sender text, alt text and links are never substitutions. */
export function renderMailPreview(html: string, images: ReadonlyMap<string, string>) {
  const document = parseDocument(html);
  const replace = (value: string) => value.replace(reference, (_match, id: string) => {
    const url = images.get(id);
    return url && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url) ? url : emptyImage;
  });
  for (const element of DomUtils.getElementsByTagName("*", document.children)) {
    for (const attribute of ["src", "srcset", "style"]) {
      if (element.attribs[attribute]) element.attribs[attribute] = replace(element.attribs[attribute]);
    }
    if (element.name === "style") for (const child of element.children) {
      if (child.type === "text") child.data = replace(child.data);
    }
  }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_PREVIEW_CSP}">${DomUtils.getOuterHTML(document)}`;
}
