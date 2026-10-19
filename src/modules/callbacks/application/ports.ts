import type { UnitOfWork } from "@/platform/transactions";
import type { CallbackClaim, CallbackInput, CallbackSecret } from "../contracts";

export interface CallbackRepository {
  claim(id: string): Promise<CallbackClaim | null>;
  recoverPausedClaim(id: string): Promise<void>;
  currentDispatch(id: string, attempt: number): Promise<{ eligible: boolean; url: string; secretCiphertext: string } | null>;
  markDelivered(id: string, attempt: number, status: number): Promise<void>;
  recordFailure(id: string, attempt: number, failure: { dead: boolean; delaySeconds: number; message: string; responseCode: number | null }): Promise<Date | null>;
  enqueue(id: string, outboxId: string, availableAt?: Date): Promise<void>;
  deadLetter(id: string, message: string): Promise<void>;
  terminate(id: string): Promise<boolean>;
  activeService(id: string): Promise<boolean>;
  createEndpoint(id: string, input: CallbackInput, secret: CallbackSecret): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  stopPending(id: string, events?: string[]): Promise<void>;
  lockEndpoint(id: string): Promise<{ status: string } | null>;
  hasInFlight(id: string): Promise<boolean>;
  replaceSecret(id: string, secret: CallbackSecret): Promise<void>;
  resetDeadLetters(scope: { endpointId?: string; deliveryId?: string }): Promise<string[]>;
  isActive(id: string): Promise<boolean>;
  createTest(id: string, endpointId: string, payload: Record<string, unknown>): Promise<void>;
  updateEvents(id: string, events: string[]): Promise<boolean>;
  audit(actor: string, action: string, resourceType: string, id: string | null, details?: Record<string, unknown>): Promise<void>;
}
export interface CallbackDependencies {
  repository: CallbackRepository;
  unitOfWork: UnitOfWork<CallbackRepository>;
  transport: {
    validate(url: string): Promise<string>;
    send(url: string, body: string, headers: Record<string, string>, beforeSend: () => Promise<void>): Promise<{ status: number; statusText: string; body: string }>;
  };
  secrets: {
    generate(): string;
    seal(secret: string, id: string): CallbackSecret;
    sign(claim: CallbackClaim, timestamp: string, body: string): string;
  };
  id(prefix: string): string;
  now(): Date;
}
