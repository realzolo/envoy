import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./document";
import type { InboundResourceReason } from "../contracts";
export class DocumentResourceError extends Error { constructor(readonly reason: InboundResourceReason) { super(reason); } }
export function bitmapInfo(input: Uint8Array): { contentType: string; width: number; height: number } {
  const b = Buffer.from(input); let width = 0, height = 0, contentType = "";
  if (b.length > MAX_IMAGE_BYTES) throw new DocumentResourceError("SIZE_LIMIT");
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString("ascii",12,16) === "IHDR") { contentType="image/png";width=b.readUInt32BE(16);height=b.readUInt32BE(20); }
  else if (b.length >= 10 && ["GIF87a","GIF89a"].includes(b.toString("ascii",0,6))) { contentType="image/gif";width=b.readUInt16LE(6);height=b.readUInt16LE(8); }
  else if (b.length >= 30 && b.toString("ascii",0,4)==="RIFF" && b.toString("ascii",8,12)==="WEBP") {
    contentType="image/webp";const type=b.toString("ascii",12,16);
    if(type==="VP8X") {width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(type==="VP8 " && b[23]===0x9d&&b[24]===1&&b[25]===0x2a) {width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    else if(type==="VP8L" && b[20]===0x2f) {width=1+(((b[22]&0x3f)<<8)|b[21]);height=1+(((b[24]&0x0f)<<10)|(b[23]<<2)|(b[22]>>6));}
  } else if (b.length > 4 && b[0]===0xff && b[1]===0xd8) {
    contentType="image/jpeg";let offset=2;
    while(offset+4<=b.length) {if(b[offset]!==0xff)break;const marker=b[offset+1];if(marker===0xd9||marker===0xda)break;if(marker===0x00||marker===0xff){offset++;continue;}const length=b.readUInt16BE(offset+2);if(length<2||offset+2+length>b.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7){height=b.readUInt16BE(offset+5);width=b.readUInt16BE(offset+7);break;}offset+=2+length;}
  }
  if(!contentType||!width||!height)throw new DocumentResourceError("UNSUPPORTED_TYPE");
  if(width>MAX_IMAGE_DIMENSION||height>MAX_IMAGE_DIMENSION||width*height>MAX_IMAGE_PIXELS)throw new DocumentResourceError("PIXEL_LIMIT");
  return {contentType,width,height};
}
