"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const defaultOptions: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
};

export function useLocalTime(value: string | Date, options: Intl.DateTimeFormatOptions = defaultOptions) {
  const date = new Date(value);
  const valid = Number.isFinite(date.getTime());
  const canonical = valid ? date.toISOString() : String(value);
  return useSyncExternalStore(subscribe,
    () => valid ? new Intl.DateTimeFormat("en-US", options).format(date) : canonical,
    () => canonical,
  );
}

export function LocalTime({ value }: { value: string | Date }) {
  const label = useLocalTime(value);
  const date = new Date(value);
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
  return <time dateTime={iso} title={label}>{label}</time>;
}
