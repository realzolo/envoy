import { describe, expect, it } from "vitest";
import { mailDiagnosticSchema, retryDispositionSchema } from "@/contracts/mail-diagnostics";
import { resendBounceFacts, smtpFacts, submissionReason } from "@/integrations/providers/diagnostic-facts";
import { contentFreeOutboundEvents } from "@/integrations/providers/event-facts";
import { providerRegistry } from "@/integrations/providers/registry";
import { diagnosticPresentation } from "@/features/outbound/diagnostic-presentation";

const context = {accountId:"pa",config:{type:"resend" as const,schemaVersion:1 as const},secret:{type:"resend" as const,apiKey:"test-key"}};
describe("content-free canonical mail diagnostics", () => {
 it.each([["Permanent","HARD"],["Transient","SOFT"],["Temporary","SOFT"],["Undetermined","UNKNOWN"],["future-type","UNKNOWN"]])("preserves %s bounce certainty",(type,bounceClass)=>{
  expect(resendBounceFacts({type}).evidence.bounceClass).toBe(bounceClass);
 });
 it("extracts official array diagnostics without retaining SMTP prose or sensitive content",async()=>{
  const secret="Verification code 624918 private-body@example.net";
  const events=await providerRegistry("resend").webhook.normalize({valid:true,replaySafe:true,nativeType:"email.bounced",parsed:{type:"email.bounced",created_at:"2026-11-04T00:00:00Z",data:{email_id:"message",to:["recipient@example.net"],bounce:{type:"Permanent",diagnosticCode:[`smtp; 550 5.1.1 ${secret}`],message:secret}}}},context);
  const frozen=contentFreeOutboundEvents(events)!;
  expect(frozen[0].metadata).toMatchObject({reasonCode:"MAILBOX_NOT_FOUND",evidence:{smtpStatus:"5.1.1",smtpReplyCode:550,bounceClass:"HARD"}});
  expect(JSON.stringify(frozen)).not.toContain(secret);
  expect(JSON.stringify(frozen)).not.toContain("624918");
 });
 it("does not promote arbitrary three-digit content to an SMTP response",()=>{
  expect(smtpFacts(["Verification code 550", "private 450"]).evidence).toEqual({});
 });
 it("does not infer a nonexistent mailbox from a hard class, NoEmail or a bare 550",()=>{
  expect(resendBounceFacts({type:"Permanent",subType:"NoEmail",message:"550 rejected"}).reasonCode).toBeNull();
  expect(resendBounceFacts({type:"Permanent"}).reasonCode).toBeNull();
 });
 it("declines conflicting or malformed detailed facts",()=>{
  expect(resendBounceFacts({subType:"MailboxFull",diagnosticCode:["550 5.1.1 mailbox rejected"]}).reasonCode).toBeNull();
  expect(smtpFacts(["550 5.01.1 bad", "550 5.1.1x bad", "5.1.1", "5.2.2"]).reasonCode).toBeNull();
  expect(mailDiagnosticSchema.safeParse({source:"PROVIDER",code:"DELIVERY_FAILED",reasonCode:null,stage:"RECIPIENT_DELIVERY",detailAvailability:"PROVIDER_NOT_SUPPLIED",evidence:{smtpStatus:"5.01.1"},occurredAt:null}).success).toBe(false);
 });
 it("maps asynchronous exact provider quota reasons without interpreting free text",async()=>{
  expect(submissionReason("reached_daily_quota")).toBe("PROVIDER_QUOTA_EXCEEDED");
  expect(submissionReason("reached_daily_quota secret624918")).toBeNull();
  const [event]=await providerRegistry("resend").webhook.normalize({valid:true,replaySafe:true,nativeType:"email.failed",parsed:{type:"email.failed",created_at:"2026-11-04T00:00:00Z",data:{email_id:"message",failed:{reason:"reached_daily_quota"}}}},context);
  expect(contentFreeOutboundEvents([event])?.[0].metadata.reasonCode).toBe("PROVIDER_QUOTA_EXCEEDED");
 });
 it("explains absent historical detail without guessing and separates provider retry responsibility",()=>{
  const value=mailDiagnosticSchema.parse({source:"PROVIDER",code:"MAILBOX_PERMANENTLY_REJECTED",reasonCode:null,stage:"RECIPIENT_DELIVERY",detailAvailability:"NOT_RECORDED",evidence:{},occurredAt:null});
  expect(diagnosticPresentation(value)).toMatchObject({title:"Recipient permanently rejected delivery",detail:"The historical record did not retain a more specific cause."});
  expect(retryDispositionSchema.parse({owner:"PROVIDER",action:"WAITING_PROVIDER",nextAttemptAt:null})).toMatchObject({owner:"PROVIDER"});
 });
});
