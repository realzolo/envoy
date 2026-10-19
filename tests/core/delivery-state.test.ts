import { shouldProjectLifecycle } from "@/modules/outbound/domain/delivery-state";
import { describe, expect, it } from "vitest";
const timestamp = new Date("2026-10-19T00:00:00Z");
describe("delivery lifecycle projection", () => {
    it("uses deterministic precedence for contradictory facts at the same timestamp", () => {
        expect(shouldProjectLifecycle("delivered", { type: "bounced", occurredAt: timestamp }, { event_type: "delivered", occurred_at: timestamp })).toBe(true);
        expect(shouldProjectLifecycle("bounced", { type: "delivered", occurredAt: timestamp }, { event_type: "bounced", occurred_at: timestamp })).toBe(false);
    });
    it("never regresses a terminal result to a newer transient event", () => {
        expect(shouldProjectLifecycle("delivered", { type: "deferred", occurredAt: new Date(timestamp.getTime() + 1000) }, { event_type: "delivered", occurred_at: timestamp })).toBe(false);
    });
    it("accepts verified acceptance after an uncertain transport result", () => {
        expect(shouldProjectLifecycle("unknown", { type: "accepted", occurredAt: timestamp }, { event_type: "unknown", occurred_at: new Date(timestamp.getTime() + 1000) })).toBe(true);
    });
    it("allows an explicitly authorized manual retry to restart the lifecycle", () => {
        expect(shouldProjectLifecycle("bounced", { type: "queued", occurredAt: timestamp }, undefined, true)).toBe(true);
    });
});
