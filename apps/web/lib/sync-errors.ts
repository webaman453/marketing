export type SyncErrorKind = "auth" | "permission" | "rate" | "network" | "other";

export interface FriendlySyncError {
  kind: SyncErrorKind;
  /** One plain sentence about what happened and what to do. */
  message: string;
  /** Reconnecting the login is the fix. */
  reconnect: boolean;
}

/** Turns a platform's raw sync error into something a person can act on. The raw text stays available as a tooltip. */
export function friendlySyncError(raw: string | null | undefined, status?: string): FriendlySyncError {
  const text = (raw ?? "").trim();
  if (status === "EXPIRED" || /expired|revoked|invalid[^.]*token|token[^.]*invalid|unauthori[sz]ed|\b401\b|reauth|log in again|session has ended/i.test(text)) {
    return { kind: "auth", message: "Access expired or was removed. Reconnect this login to resume syncing.", reconnect: true };
  }
  if (/permission|scope|not granted|forbidden|\b403\b|not authori[sz]ed|access denied|developer token/i.test(text)) {
    return { kind: "permission", message: "A permission is missing. Reconnect and allow everything it asks for.", reconnect: true };
  }
  if (/rate.?limit|too many|quota|throttl|\b429\b/i.test(text)) {
    return { kind: "rate", message: "The platform's rate limit was hit. Syncing will retry on its own.", reconnect: false };
  }
  if (/timed? ?out|timeout|econn|enotfound|network|temporar|unavailable|\b5\d\d\b|bad gateway/i.test(text)) {
    return { kind: "network", message: "The platform didn't answer. Syncing will retry on its own.", reconnect: false };
  }
  return { kind: "other", message: text ? (text.length > 140 ? `${text.slice(0, 137)}…` : text) : "The sync failed for an unknown reason.", reconnect: false };
}
