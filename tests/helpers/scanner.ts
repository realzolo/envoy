import { createServer, type Socket } from "node:net";
import { processAttachmentScan } from "@/modules/attachments/public";

/** Controlled wire fixture, not a real ClamAV installation or engine acceptance test. */
export async function scannerFixture(reply: string | null = "stream: OK\0", handler?: (socket:Socket)=>void) {
  const sockets=new Set<Socket>();
  const server=createServer(socket=>{
    sockets.add(socket);socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));
    if(handler) {handler(socket);return;}
    let data=Buffer.alloc(0),command=false,complete=false;
    socket.on("data",chunk=>{
      data=Buffer.concat([data,chunk]);
      if(!command) {
        if(data.length<10) return;
        if(!data.subarray(0,10).equals(Buffer.from("zINSTREAM\0"))) {socket.destroy();return;}
        command=true;data=data.subarray(10);
      }
      while(!complete && data.length>=4) {
        const size=data.readUInt32BE(0);
        if(size>10_000_000) {socket.destroy();return;}
        if(data.length<4+size) return;
        data=data.subarray(4+size);
        if(size===0) {complete=true;if(data.length) {socket.destroy();return;}if(reply!==null) socket.end(reply);}
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address || typeof address==="string") throw new Error("No fixture port");
  const previous=[process.env.CLAMAV_HOST,process.env.CLAMAV_PORT,process.env.CLAMAV_TIMEOUT_MS];
  process.env.CLAMAV_HOST="127.0.0.1";process.env.CLAMAV_PORT=String(address.port);process.env.CLAMAV_TIMEOUT_MS="500";
  return {close:async()=>{
    ["CLAMAV_HOST","CLAMAV_PORT","CLAMAV_TIMEOUT_MS"].forEach((key,index)=>{if(previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];});
    for(const socket of sockets) socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }};
}
export async function scanClean(id:string) {
  const fixture=await scannerFixture();try {await processAttachmentScan(id);}finally{await fixture.close();}
}
