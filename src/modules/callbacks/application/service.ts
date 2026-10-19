import { callbackInputSchema, type CallbackInput, type CallbackClaim } from "../contracts";
import { CallbackUrlPolicyError, callbackFailure } from "../domain/policy";
import type { CallbackDependencies } from "./ports";

export function createCallbackService(deps: CallbackDependencies) {
  const { unitOfWork, transport, secrets, id, now } = deps;
  const scheduleFailure = (row: CallbackClaim, message: string, responseCode: number | null = null, terminal = false) => unitOfWork.run(async repo => {
    const failure = callbackFailure(row.attempt, terminal);
    const availableAt = await repo.recordFailure(row.id, row.attempt, { ...failure, message: message.slice(0, 2000), responseCode });
    if (!failure.dead && availableAt) await repo.enqueue(row.id, id("out"), availableAt);
  });
  return {
    async deliverCallback(deliveryId: string) {
      const row = await deps.repository.claim(deliveryId);
      if (!row) { await deps.repository.recoverPausedClaim(deliveryId); return; }
      try {
        if (!row.eligible) throw new CallbackUrlPolicyError("CALLBACK_BINDING_OR_SUBSCRIPTION_INVALID");
        const body = JSON.stringify(row.payload), timestamp = Math.floor(now().getTime() / 1000).toString();
        const response = await transport.send(row.url, body, {
          "content-type": "application/json", "x-envoy-id": String(row.payload.id),
          "x-envoy-timestamp": timestamp, "x-envoy-signature": `v1=${secrets.sign(row, timestamp, body)}`,
        }, async () => {
          const current = await deps.repository.currentDispatch(row.id, row.attempt);
          if (!current?.eligible) throw new CallbackUrlPolicyError("CALLBACK_BINDING_OR_SUBSCRIPTION_INVALID");
          if (current.url !== row.url || current.secretCiphertext !== row.secretCiphertext) throw new Error("Callback configuration changed before dispatch");
        });
        if (response.status < 200 || response.status >= 300) await scheduleFailure(row, response.body || response.statusText, response.status);
        else await deps.repository.markDelivered(row.id, row.attempt, response.status);
      } catch (error) {
        await scheduleFailure(row, error instanceof Error ? error.message : "Callback delivery failed", null, error instanceof CallbackUrlPolicyError);
      }
    },
    deadLetterCallback: (deliveryId: string, message: string) => deps.repository.deadLetter(deliveryId, message),
    terminateCallback: (deliveryId: string, actor: string) => unitOfWork.run(async repo => {
      if (!await repo.terminate(deliveryId)) throw new Error("Only dead-letter callbacks can be terminated");
      await repo.audit(actor, "callback_delivery.terminate", "callback_delivery", deliveryId);
      return { id: deliveryId, status: "terminated" };
    }),
    async createCallback(input: CallbackInput, actor: string) {
      const validated = callbackInputSchema.parse(input);
      validated.url = await transport.validate(validated.url);
      const endpointId = id("cb"), secret = secrets.generate(), envelope = secrets.seal(secret, endpointId);
      await unitOfWork.run(async repo => {
        if (!await repo.activeService(validated.serviceId)) throw new Error("An active service is required for a callback endpoint");
        await repo.createEndpoint(endpointId, validated, envelope);
        await repo.audit(actor, "callback_endpoint.create", "callback_endpoint", endpointId, { events: validated.events });
      });
      return { id: endpointId, secret };
    },
    toggleCallback: (endpointId: string, enabled: boolean, actor: string) => unitOfWork.run(async repo => {
      if (!await repo.setEnabled(endpointId, enabled)) throw new Error("Configure an Event callback URL before enabling callback delivery");
      if (!enabled) await repo.stopPending(endpointId);
      await repo.audit(actor, "callback_endpoint.toggle", "callback_endpoint", endpointId, { enabled });
    }),
    replaceCallbackSecret: (endpointId: string, actor: string) => unitOfWork.run(async repo => {
      const current = await repo.lockEndpoint(endpointId);
      if (!current) throw new Error("Callback endpoint not found");
      if (current.status !== "disabled") throw new Error("Disable callback delivery before replacing its secret");
      if (await repo.hasInFlight(endpointId)) throw new Error("Wait for in-flight callback deliveries to finish or recover before replacing the secret");
      const secret = secrets.generate();
      await repo.replaceSecret(endpointId, secrets.seal(secret, endpointId));
      await repo.audit(actor, "callback_endpoint.replace_secret", "callback_endpoint", endpointId);
      return { secret };
    }),
    replayDeadLetters: (actor: string, scope: { endpointId?: string; deliveryId?: string } = {}) => unitOfWork.run(async repo => {
      const deliveries = await repo.resetDeadLetters(scope);
      for (const deliveryId of deliveries) await repo.enqueue(deliveryId, id("out"));
      await repo.audit(actor, "callback_delivery.replay_dead_letters", "callback_delivery", null, { count: deliveries.length, ...scope });
      return deliveries.length;
    }),
    async testCallback(endpointId: string, actor: string) {
      const deliveryId = id("cbx"), payload = { id: id("event"), apiVersion: "2026-09-01", type: "endpoint.test", occurredAt: now().toISOString(), data: { message: "Envoy callback endpoint test" } };
      await unitOfWork.run(async repo => {
        if (!await repo.isActive(endpointId)) throw new Error("An active callback endpoint is required for a test delivery");
        await repo.createTest(deliveryId, endpointId, payload);
        await repo.enqueue(deliveryId, id("out"));
        await repo.audit(actor, "callback_endpoint.test", "callback_endpoint", endpointId);
      });
      return deliveryId;
    },
    updateCallback: (endpointId: string, input: { events: string[] }, actor: string) => unitOfWork.run(async repo => {
      const validated = callbackInputSchema.pick({ events: true }).strict().parse(input);
      if (!await repo.updateEvents(endpointId, validated.events)) throw new Error("Callback endpoint not found");
      await repo.stopPending(endpointId, validated.events);
      await repo.audit(actor, "callback_endpoint.update", "callback_endpoint", endpointId, { events: validated.events });
    }),
  };
}
