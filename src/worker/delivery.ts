import type { Job } from "bullmq";
import { CanonicalProviderError, type ProviderSendResult } from "@/modules/providers/contracts";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { applyCanonicalEvent } from "@/modules/core/event/service";
import { markAccepted, markDeterminateFailure, markUnknown, prepareSubmission } from "@/modules/core/routing/engine";
import { renderTemplate } from "@/server/template-renderer";

export async function processDelivery(job:Job<{deliveryId:string}>){
  const submission=await prepareSubmission(job.data.deliveryId);
  if(!submission||"reconcileAttemptId" in submission)return;
  let account:Awaited<ReturnType<typeof loadProviderAccount>>;let rendered:ReturnType<typeof renderTemplate>;
  try{account=await loadProviderAccount(submission.providerAccountId);account.context.idempotencyKey=submission.providerIdempotencyKey??undefined;rendered=renderTemplate({subjectTemplate:submission.subjectTemplate,htmlTemplate:submission.htmlTemplate,textTemplate:submission.textTemplate},submission.variables)}catch(error){await markDeterminateFailure(submission.attemptId,{category:"policy",code:"local_preparation_failed",message:error instanceof Error?error.message:"Local message preparation failed"},false);return}
  let result:ProviderSendResult;
  try{
    result=await account.module.sender.send({deliveryId:submission.deliveryId,from:{name:submission.fromName,email:submission.fromEmail},to:{name:submission.recipientName??undefined,email:submission.recipientEmail},replyTo:submission.replyTo??undefined,subject:rendered.subject,html:rendered.html,text:rendered.text,attachments:[],tags:{product:submission.product,template:submission.templateKey}},account.context);
  }catch(error){
    if(error instanceof CanonicalProviderError){
      if(error.outcome!=="not_accepted"){await markUnknown(submission.attemptId,error.message);return}
      await markDeterminateFailure(submission.attemptId,{category:error.category,code:error.code,message:error.message},error.retryable);
      return;
    }
    if(error instanceof TypeError){await markUnknown(submission.attemptId,error.message);return}
    await markDeterminateFailure(submission.attemptId,{category:"provider",code:"provider_rejected",message:error instanceof Error?error.message:"Provider rejected the request"},false);
    return;
  }
  if(result.outcome==="unknown"){await markUnknown(submission.attemptId,result.reason);return}
  await markAccepted(submission.attemptId,result.externalMessageId,result.response);

  // Provider acceptance is a point of no return. Downstream event failures must never trigger failover.
  if(account.module.descriptor.type==="mock"){
    await applyCanonicalEvent(submission.providerAccountId,null,{id:crypto.randomUUID(),externalMessageId:result.externalMessageId,type:"accepted",occurredAt:new Date(),recipient:submission.recipientEmail,metadata:{}});
    await applyCanonicalEvent(submission.providerAccountId,null,{id:crypto.randomUUID(),externalMessageId:result.externalMessageId,type:submission.recipientEmail.includes("bounce")?"bounced":submission.recipientEmail.includes("complaint")?"complained":"delivered",occurredAt:new Date(Date.now()+100),recipient:submission.recipientEmail,bounce:submission.recipientEmail.includes("bounce")?{classification:"hard",message:"Simulated hard bounce"}:undefined,metadata:{}});
  }
}
