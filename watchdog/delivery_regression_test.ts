import { Engine, newState, NOTIFICATION_COOLDOWN } from "./engine.ts";
import { capture, type Snapshot } from "./policy.ts";
import { Observer } from "./observe.ts";
import { main } from "./main.ts";
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const snapshot = (at: number): Snapshot => ({ id: "actor", turn: "turn", goalKey: "id:one", goal: "blocked", runtime: "idle", flags: [], terminal: "completed", parent: null, at, complete: true });
Deno.test("hook and identified goal share one notification episode", () => {
  const e = new Engine(newState(1000));
  e.ingest(capture({session_id:"actor",turn_id:"turn",hook_event_name:"Stop"},1000));
  e.observe(snapshot(2000),2000);
  assert(Object.keys(e.state.episodes).length === 1, "hook and goal created duplicate episodes");
});
Deno.test("accepted legacy history tombstone preserves exact cooldown deadline", () => {
  const state = newState(1000);
  state.history = { "actor:turn:stop:turn": { delivery: "accepted", receipt: "confirmed", sentAt: 10000, created: 1000, disposition: "resolved" } };
  const e = new Engine(state);
  e.actor("actor",11000)!.snapshot = snapshot(11000);
  const p = e.add("actor","next","blocked","stop:next",11000)!;
  assert(!e.eligible(11000).length, "compacted success allowed immediate validation");
  assert(p.retryAt === 10000 + NOTIFICATION_COOLDOWN, "wrong migration deadline");
  assert(e.eligible(p.retryAt).length === 1, "exact six-hour eligibility lost");
  const restarted = new Engine(JSON.parse(JSON.stringify(e.state)));
  restarted.state.actors.actor.snapshot = { ...snapshot(11000), goalKey: "id:two" };
  const different = restarted.add("actor","different","blocked","stop:different",11000)!;
  assert(restarted.canNotify(different,11000), "history rebound to a different goal after restart");
});
Deno.test("runtime suppresses repeated reads and uncertain duplicate posts while retrying definite rejection", async () => {
  const root = await Deno.makeTempDir({dir:"/tmp"}), previousHome = Deno.env.get("HOME"), previousCodex = Deno.env.get("CODEX_HOME");
  const originalNow=Date.now, originalFetch=globalThis.fetch, originalFresh=Observer.prototype.fresh, argsLength=Deno.args.length;
  Deno.args.push("--once");
  try {
    for (const outcome of ["accepted","uncertain","rejected"] as const) {
      const fixture = `${root}/${outcome}`;
      Deno.env.set("HOME",fixture); Deno.env.set("CODEX_HOME",fixture);
      let now=originalNow(), reads=0, posts=0;
      Date.now=()=>now;
      Observer.prototype.fresh=async()=>{reads++;return snapshot(now);};
      globalThis.fetch=async(input)=>{assert(String(input)==="https://ntfy.sh/fixture","external request refused");posts++;return new Response(JSON.stringify(outcome==="accepted"?{id:"confirmed"}:{}),{status:outcome==="rejected"?503:200});};
      const state=newState(now), e=new Engine(state);
      e.ingest(capture({session_id:"actor",turn_id:"turn",hook_event_name:"Stop"},now-50000));
      if(outcome==="uncertain")e.add("actor","turn","blocked","stop:turn:id:one",now-50000);
      await Deno.mkdir(`${fixture}/attention-watchdog`,{recursive:true});
      await Deno.mkdir(`${fixture}/.config/codex-nudge`,{recursive:true});
      await Deno.writeTextFile(`${fixture}/attention-watchdog/hook-state.json`,JSON.stringify(state));
      await Deno.writeTextFile(`${fixture}/.config/codex-nudge/topic`,"fixture");
      for(let i=0;i<3;i++){
        await main();now+=25000;
        if(i===0 && outcome==="accepted"){
          const next=JSON.parse(await Deno.readTextFile(`${fixture}/attention-watchdog/hook-state.json`));
          new Engine(next).add("actor","next","blocked","stop:next",now);
          await Deno.writeTextFile(`${fixture}/attention-watchdog/hook-state.json`,JSON.stringify(next));
        }
      }
      const saved=JSON.parse(await Deno.readTextFile(`${fixture}/attention-watchdog/hook-state.json`));
      assert(posts===(outcome==="rejected"?3:1),`duplicate/missing ${outcome} posts: ${posts}`);
      assert(reads===(outcome==="rejected"?3:1),`unnecessary ${outcome} RPC validation: ${reads}`);
      if(outcome!=="accepted")assert(Object.keys(saved.successfulNotices).length===0,"failed POST invented success");
      if(outcome==="uncertain")assert(Object.values(saved.episodes).every((p:any)=>p.delivery==="uncertain"),"legacy alias lost shared delivery outcome");
    }
  } finally {
    Date.now=originalNow;globalThis.fetch=originalFetch;Observer.prototype.fresh=originalFresh;Deno.args.splice(argsLength);
    if(previousHome===undefined)Deno.env.delete("HOME");else Deno.env.set("HOME",previousHome);
    if(previousCodex===undefined)Deno.env.delete("CODEX_HOME");else Deno.env.set("CODEX_HOME",previousCodex);
    await Deno.remove(root,{recursive:true});
  }
});
