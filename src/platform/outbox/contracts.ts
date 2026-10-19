export type OutboxEvent = {
    id: string;
    event_type: string;
    payload: Record<string, string>;
};
export type RecoveryCursor = {
    type: string;
    id: string;
};
export type RecoverableWork = {
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: Record<string, string>;
    expired_submission: boolean;
    reset_raw: boolean;
};
export type PreviousOutboxWork = {
    id: string;
    status: string;
    recent: boolean;
};
