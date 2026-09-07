import { capture, type Event } from "./policy.ts";
import { join } from "node:path";
export async function enqueue(directory: string, event: Event): Promise<void> {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const first = crypto.getRandomValues(new Uint32Array(1))[0] % 4096;
  // Claims remain occupied after a writer crash. Never delete a possibly live
  // writer's claim; the collector exposes abandoned capacity for repair.
  for (let i = 0; i < 64; i++) {
    const slot = join(directory, String((first + i) % 4096));
    try {
      await Deno.mkdir(slot, { mode: 0o700 });
    } catch (e) {
      if (e instanceof Deno.errors.AlreadyExists) continue;
      throw e;
    }
    await Deno.writeTextFile(
      join(slot, "owner.json"),
      JSON.stringify({ pid: Deno.pid, at: Date.now(), event: event.id }),
      { mode: 0o600, createNew: true },
    );
    const raw = JSON.stringify(event);
    if (new TextEncoder().encode(raw).length > 8192) {
      throw new Error("Event too large");
    }
    await Deno.writeTextFile(join(slot, "pending"), raw, {
      mode: 0o600,
      createNew: true,
    });
    await Deno.rename(join(slot, "pending"), join(slot, "event.json"));
    return;
  }
  throw new Error("Capture capacity unavailable");
}
if (import.meta.main) {
  const home = Deno.env.get("CODEX_HOME") ??
    join(Deno.env.get("HOME")!, ".codex");
  const directory = join(home, "attention-watchdog", "spool");
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of Deno.stdin.readable) {
      size += chunk.length;
      if (size > 1_048_576) throw new Error("Hook input too large");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    await enqueue(
      directory,
      capture(JSON.parse(new TextDecoder().decode(bytes))),
    );
  } catch {
    try {
      await Deno.writeTextFile(
        join(home, "attention-watchdog", "capture-loss.json"),
        JSON.stringify({ at: Date.now(), version: 1 }),
        { mode: 0o600 },
      );
    } catch { /* disk may be unavailable */ }
    console.error(
      "Codex attention event could not be captured; coverage is incomplete.",
    );
    // Exit 1 reports a hook failure. Never use exit 2 or a control decision.
    Deno.exitCode = 1;
  }
  console.log("{}");
}
