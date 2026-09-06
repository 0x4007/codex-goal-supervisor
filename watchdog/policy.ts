export type Snapshot = {
  id: string;
  turn: string;
  runtime: string;
  flags: string[];
  goal: string | null;
  terminal: string | null;
  label: string;
  updated: number;
  parent: string | null;
};
export type Evidence = {
  id: string;
  at: number;
  kind: string;
  text: string;
};
export type Packet = {
  snapshot: Snapshot;
  records: Evidence[];
  complete: boolean;
  silenceMs: number;
  repeatedFailures: number;
  logVersion?: string;
};
export type Verdict = {
  classification:
    | "expected_wait"
    | "needs_agent_correction"
    | "needs_user"
    | "unknown";
  confidence: "low" | "medium" | "high";
  evidence_ids: string[];
  blocker: string;
  requested_action: string;
};
export function redact(value: string, max = 400): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(
      /(?:Bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "[credential]",
    )
    .replace(/[A-Za-z0-9_+/=-]{48,}/g, "[opaque value]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .slice(0, max);
}
export function retired(s: Snapshot): boolean {
  return s.goal === "paused" || s.goal === "complete" ||
    s.goal === "completed" ||
    s.terminal === "interrupted" ||
    (s.runtime !== "active" && !["active", "blocked"].includes(s.goal ?? "") &&
      s.terminal !== "failed" && s.flags.length === 0);
}
export function directBlocker(s: Snapshot): string | null {
  if (retired(s)) return null;
  if (s.flags.includes("waitingOnApproval")) return "approval";
  if (s.flags.includes("waitingOnUserInput")) return "user-input";
  return null;
}
export function suspected(p: Packet): boolean {
  if (retired(p.snapshot)) return false;
  if (p.snapshot.goal === "blocked") return true;
  if (!p.complete) return false;
  return p.silenceMs >= 600_000 || p.repeatedFailures >= 3 ||
    (p.snapshot.terminal === "failed" && p.silenceMs >= 300_000) ||
    p.records.some((r) =>
      r.kind === "assistant" &&
      /(?:need your|please (?:approve|sign|log|open|select)|blocked on|requires your|may I)/i
        .test(r.text)
    );
}
export function validateVerdict(v: unknown, p: Packet): Verdict {
  if (!v || typeof v !== "object") throw new Error("Invalid verdict");
  const x = v as Record<string, unknown>;
  const keys = [
    "classification",
    "confidence",
    "evidence_ids",
    "blocker",
    "requested_action",
  ];
  if (Object.keys(x).length !== keys.length || keys.some((k) => !(k in x))) {
    throw new Error("Invalid verdict fields");
  }
  if (
    !["expected_wait", "needs_agent_correction", "needs_user", "unknown"]
      .includes(String(x.classification)) ||
    !["low", "medium", "high"].includes(String(x.confidence)) ||
    typeof x.blocker !== "string" || x.blocker.length > 240 ||
    typeof x.requested_action !== "string" || x.requested_action.length > 240 ||
    !Array.isArray(x.evidence_ids) || x.evidence_ids.length > 4 ||
    !x.evidence_ids.every((id) =>
      typeof id === "string" && p.records.some((r) => r.id === id)
    )
  ) {
    throw new Error("Invalid verdict values");
  }
  return x as Verdict;
}
export function eligible(v: Verdict, p: Packet): boolean {
  if (
    retired(p.snapshot) || v.confidence !== "high" || !v.evidence_ids.length
  ) return false;
  const cited = p.records.filter((r) => v.evidence_ids.includes(r.id));
  // A model judgement cannot turn silence into a verified need for user action.
  return v.classification === "needs_user" &&
    Boolean(v.requested_action.trim()) &&
    (p.snapshot.goal === "blocked" ||
      cited.some((r) =>
        r.kind === "assistant" &&
        /(?:need|please|blocked|cannot|can't|permission|approv|access|sign.in|log.in|missing|select|choose|provide)/i
          .test(r.text)
      ));
}
export function sameEpoch(a: Snapshot, b: Snapshot): boolean {
  return a.id === b.id && a.turn === b.turn && a.updated === b.updated &&
    a.goal === b.goal && a.runtime === b.runtime && !retired(b);
}
export async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(bytes),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("").slice(0, 24);
}
