export const VERSION = "hooks-1";
export const KINDS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
] as const;
export type Kind = typeof KINDS[number];
export type Event = {
  version: typeof VERSION;
  id: string;
  at: number;
  kind: Kind;
  session: string;
  turn: string | null;
  child: string | null;
  request: string | null;
  tool: string | null;
};
export type Snapshot = {
  id: string;
  title?: string;
  turn: string | null;
  runtime: string;
  flags: string[];
  terminal: string | null;
  goal: string | null;
  parent: string | null;
  at: number;
  complete: boolean;
};
export type Category =
  | "approval"
  | "input"
  | "failed"
  | "blocked"
  | "stop"
  | "unverified";
export const templates: Record<Category, string> = {
  approval: "Approval is pending.",
  input: "Input requested; work may continue.",
  failed: "Turn failed; review session.",
  blocked: "Goal reports blocked; agent is not running.",
  stop: "Turn stopped; completion was not established. Review session.",
  unverified: "Attention signal observed; current state could not be verified.",
};
export const identifier = (x: unknown): x is string =>
  typeof x === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
export function capture(x: Record<string, unknown>, now = Date.now()): Event {
  if (!identifier(x.session_id) || !KINDS.includes(x.hook_event_name as Kind)) {
    throw new Error("Invalid hook identity");
  }
  return {
    version: VERSION,
    id: crypto.randomUUID(),
    at: now,
    kind: x.hook_event_name as Kind,
    session: x.session_id,
    turn: identifier(x.turn_id) ? x.turn_id : null,
    child: identifier(x.agent_id) ? x.agent_id : null,
    request: identifier(x.tool_use_id) ? x.tool_use_id : null,
    tool: identifier(x.tool_name) ? x.tool_name : null,
  };
}
export function validEvent(x: Event): boolean {
  return x?.version === VERSION && identifier(x.id) && identifier(x.session) &&
    Number.isFinite(x.at) && KINDS.includes(x.kind) &&
    [x.turn, x.child, x.request, x.tool].every((v) =>
      v === null || identifier(v)
    );
}
