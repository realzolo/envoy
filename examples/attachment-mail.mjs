// Node.js 22+. Only ENVOY_URL, ENVOY_SERVICE_KEY and ENVOY_MAILBOX are business connection settings.
import { readFile,stat } from "node:fs/promises";
import { basename } from "node:path";
import { api } from "./service-mail.mjs";

const [command,id,operation,recipient]=process.argv.slice(2);
if(command==="upload") {
  if(!id) throw new Error("Usage: upload <path>; save its returned file ID");
  const info=await stat(id);
  if(info.size<1 || info.size>10_000_000) throw new Error("Business input must fit Envoy's 10 MB limit");
  if(!process.env.ENVOY_URL || !process.env.ENVOY_SERVICE_KEY) throw new Error("Envoy connection is required");
  const response=await fetch(`${process.env.ENVOY_URL.replace(/\/$/,"")}/api/v1/files`,{method:"POST",headers:{
    authorization:`Bearer ${process.env.ENVOY_SERVICE_KEY}`,"x-sending-domain":process.env.ENVOY_SENDING_DOMAIN??"","content-type":"application/octet-stream","x-file-name":encodeURIComponent(basename(id))
  },body:await readFile(id)});
  const result=await response.json();if(!response.ok) throw new Error(result.code);
  console.log(result); // 201 confirms durable receipt. It does not approve sending.
} else if(command==="status") {
  console.log(await api(`/files/${encodeURIComponent(id)}`));
} else if(command==="reprocess") {
  console.log(await api(`/files/${encodeURIComponent(id)}/reprocess`,{method:"POST"}));
} else if(command==="send") {
  if(!id || !operation || !recipient || !process.env.ENVOY_MAILBOX) throw new Error("Usage: send <saved-file-id> <stable-operation-id> <recipient>; configure ENVOY_MAILBOX");
  const file=await api(`/files/${encodeURIComponent(id)}`);
  if(!file.usage.canSend) throw new Error(`${file.usage.reasonCode}; recovery=${file.usage.recovery}`);
  console.log(await api("/messages",{idempotencyKey:operation,body:{from:{email:process.env.ENVOY_MAILBOX},to:[{email:recipient}],
    subject:"Your attachment",text:"Please see the attachment.",attachments:[{fileId:id,disposition:"attachment"}]}}));
} else throw new Error("Commands: upload <path>, status <file-id>, reprocess <file-id>, send <file-id> <operation-id> <recipient>");
