export class BodyTooLargeError extends Error {}

export async function readRequestBytes(request: Request, maximum: number) {
  if (Number(request.headers.get("content-length") ?? 0) > maximum) throw new BodyTooLargeError("Request body exceeds the byte limit.");
  const reader=request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks:Uint8Array[]=[];
  let size=0;
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>maximum) {await reader.cancel();throw new BodyTooLargeError("Request body exceeds the byte limit.")}
      chunks.push(value);
    }
  } finally {reader.releaseLock()}
  return new Uint8Array(Buffer.concat(chunks,size))
}
