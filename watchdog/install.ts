import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./policy.ts";
const user = Deno.env.get("HOME");
if (!user) throw new Error("HOME missing");
if (Deno.build.os !== "darwin") {
  throw new Error("This installer is for the Mac acceptance host");
}
const home = Deno.env.get("CODEX_HOME") ?? join(user, ".codex");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
  "deno.json",
  "deno.lock",
  ...Array.from(Deno.readDirSync(join(root, "watchdog"))).filter((e) =>
    e.isFile && e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") &&
    e.name !== "install.ts"
  ).map((e) => `watchdog/${e.name}`),
].sort();
const contents = await Promise.all(
  files.map((f) => Deno.readTextFile(join(root, f))),
);
const hash = Array.from(
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        files.map((f, i) => f + "\0" + contents[i]).join("\0"),
      ),
    ),
  ),
).map((b) => b.toString(16).padStart(2, "0")).join("");
const directory = join(home, "attention-watchdog"),
  release = join(directory, "releases", hash);
await Deno.mkdir(join(release, "watchdog"), { recursive: true, mode: 0o700 });
for (let i = 0; i < files.length; i++) {
  const path = join(release, files[i]);
  try {
    await Deno.writeTextFile(path, contents[i], {
      mode: 0o600,
      createNew: true,
    });
  } catch (e) {
    if (
      !(e instanceof Deno.errors.AlreadyExists) ||
      await Deno.readTextFile(path) !== contents[i]
    ) throw e;
  }
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const command = [
  Deno.execPath(),
  "run",
  "--no-config",
  "--no-prompt",
  `--allow-env=HOME,CODEX_HOME`,
  `--allow-write=${directory}`,
  `--allow-read=${directory}`,
  join(release, "watchdog/hook.ts"),
].map(quote).join(" ");
const path = join(home, "hooks.json");
let config: any = { hooks: {} };
try {
  config = JSON.parse(await Deno.readTextFile(path));
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
config.hooks ??= {};
// Remove only this monitor's probe or a prior installed enqueuer. All unrelated
// hook groups and config trust entries remain owned by their original writer.
for (
  const [kind, groups] of Object.entries(config.hooks) as [string, any[]][]
) {
  config.hooks[kind] = groups.map((g) => ({
    ...g,
    hooks: g.hooks.filter((h: any) =>
      !h.command?.includes(join(directory, "hook-probe/record.ts")) &&
      !h.command?.includes(join(directory, "releases"))
    ),
  })).filter((g) => g.hooks.length);
  if (!config.hooks[kind].length) delete config.hooks[kind];
}
for (
  const kind of [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "Interrupt",
    "SubagentStart",
    "SubagentStop",
  ]
) {
  (config.hooks[kind] ??= []).push({
    hooks: [{ type: "command", command, timeout: 1 }],
  });
}
config.description =
  "Codex event-driven attention notifications; read-only local event capture.";
await Deno.writeTextFile(
  join(directory, "hooks.prepared.json"),
  JSON.stringify(config, null, 2) + "\n",
  { mode: 0o600 },
);
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const args = [
  Deno.execPath(),
  "run",
  "--no-prompt",
  `--config=${join(release, "deno.json")}`,
  `--allow-read=${home},${join(user, ".config/codex-nudge/topic")}`,
  `--allow-write=${directory},${
    join(home, "app-server-control/app-server-control.sock")
  }`,
  "--allow-env",
  "--allow-net=ntfy.sh",
  join(release, "watchdog/main.ts"),
];
// node:net Unix-domain sockets need --allow-net, but do not bind TCP ports.
// Deno uses the socket path as its net permission target; use the existing
// broad network runtime permission until the path permission is proved.
args[args.indexOf("--allow-net=ntfy.sh")] = "--allow-net";
const plist =
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.nv.codex-attention</string><key>ProgramArguments</key><array>${
    args.map((a) => `<string>${xml(a)}</string>`).join("")
  }</array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${
    xml(user)
  }</string><key>CODEX_HOME</key><string>${
    xml(home)
  }</string></dict><key>WorkingDirectory</key><string>${
    xml(release)
  }</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${
    xml(join(directory, "service.log"))
  }</string><key>StandardErrorPath</key><string>${
    xml(join(directory, "service.log"))
  }</string></dict></plist>`;
await Deno.writeTextFile(
  join(directory, "com.nv.codex-attention.prepared.plist"),
  plist,
  { mode: 0o600 },
);
await Deno.writeTextFile(
  join(directory, "prepared-release.json"),
  JSON.stringify({
    version: VERSION,
    hash,
    release,
    hookConfig: join(directory, "hooks.prepared.json"),
  }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    version: VERSION,
    hash,
    release,
    prepared: true,
    installed: false,
    trust: "Normal /hooks review required; trust hashes were not changed",
  }),
);
