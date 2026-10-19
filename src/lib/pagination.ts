export function encodeCursor(row: { accepted_at: Date; id: string; cursor_at?: string }) {
  return Buffer.from(JSON.stringify({ at: row.cursor_at ?? row.accepted_at.toISOString(), id: row.id })).toString("base64url");
}
export function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: string; id?: string };
    if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(parsed.at) || Number.isNaN(Date.parse(parsed.at))) return null;
    return { at: parsed.at, id: parsed.id };
  } catch { return null; }
}

