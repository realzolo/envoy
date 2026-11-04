import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMessageSchema } from "@/lib/contracts";
import { validationDiagnostic } from "@/server/validation-diagnostic";
const base={from:{email:"sender@example.net"},to:[{email:"recipient@example.net"}],text:"private verification 624918"};
describe("typed request validation diagnostic",()=>{
 it.each(["to","cc","bcc"])("classifies only a typed %s email format issue",role=>{
  const parsed=createMessageSchema.safeParse({...base,[role]:[{email:"alice@gmail..com"}]});
  if(parsed.success) throw new Error("invalid fixture accepted");
  const diagnostic=validationDiagnostic(parsed.error);
  expect(diagnostic).toMatchObject({source:"ENVOY",code:"INVALID_RECIPIENT",reasonCode:"INVALID_RECIPIENT",stage:"PREPARATION",detailAvailability:"SPECIFIC",evidence:{}});
  expect(JSON.stringify(diagnostic)).not.toMatch(/alice|gmail|624918/);
 });
 it.each([{...base,from:{email:"bad@gmail..com"}},{...base,replyTo:[{email:"bad@gmail..com"}]},{...base,subject:42},{...base,to:[{email:42}]}])("keeps unrelated validation generic",input=>{
  const parsed=createMessageSchema.safeParse(input);if(parsed.success) throw new Error("invalid fixture accepted");
  expect(validationDiagnostic(parsed.error)).toMatchObject({code:"VALIDATION_FAILED",reasonCode:null,detailAvailability:"CATEGORY_ONLY"});
 });
 it("never classifies issue prose as a recipient fact",()=>{
  const error=new z.ZodError([{code:"custom",path:["to",0,"email"],message:"Invalid email format, secret 624918"}]);
  expect(validationDiagnostic(error).code).toBe("VALIDATION_FAILED");
 });
});
