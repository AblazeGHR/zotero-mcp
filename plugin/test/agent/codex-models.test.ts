import assert from "node:assert/strict";
import { it } from "node:test";
import { createRuntime } from "../../src/agent/runtime.ts";
import { BACKENDS } from "../../src/agent/backends.ts";
import type { Spawner } from "../../src/types.ts";

it("queries Codex without creating a thread, shares concurrent reads and refreshes the next menu", async () => {
  const launches: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const requests: string[] = [];
  let kills = 0;
  let fail = false;
  const nodePath = "C:\\Node\\node.exe";
  const local = "C:\\npm\\vendor\\codex.exe";
  const bundled = "C:\\bridges\\codex.js";
  const spawner: Spawner = {
    windows: true,
    baseEnv: async () => ({ PATH: "C:\\npm", HOME: "C:\\User", OPENAI_API_KEY: "test-key" }),
    async run(command, args) {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
      if (command.endsWith("where.exe")) return ok("C:\\npm\\codex.cmd\r\n");
      if (args[0] === "--version") {
        assert.equal(command, local);
        return ok("codex-cli 0.170.0");
      }
      if (args[2] === "C:\\bridges") return ok(JSON.stringify({ version: BACKENDS.codex.version, entry: "C:\\bridges\\index.js" }));
      if (args[2] === "C:\\bridges\\index.js") return ok(JSON.stringify({ version: "0.159.3", codex: bundled }));
      if (args[2] === "C:\\npm\\codex.cmd") return ok('@"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
      assert.equal(args[2], "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
      return ok(local);
    },
    async spawn(command, args, { env }) {
      const launch = launches.push({ command, args, env });
      let receive: (line: string) => void;
      let stop: (code: number) => void;
      return {
        pid: launch,
        exited: new Promise<number>((resolve) => { stop = resolve; }),
        onStderr() {},
        onStdoutLine(cb) { receive = cb; },
        write(line) {
          const { id, method, params } = JSON.parse(line);
          requests.push(method);
          if (method === "initialize") receive(JSON.stringify({ id, result: {} }));
          else if (method === "model/list") {
            if (fail) {
              receive(JSON.stringify({ id, error: { code: -1, message: "catalog unavailable" } }));
              return;
            }
            const model = {
              id: params.cursor ? "next-page" : `model-${launch}`,
              displayName: "Codex model",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            };
            receive(JSON.stringify({ id, result: { data: [model], nextCursor: params.cursor ? null : "next" } }));
          }
        },
        async kill() { kills++; stop(0); },
      };
    },
  };
  const runtime = createRuntime({ spawner, bridgeDir: "C:\\bridges", nodePath, codexApiKey: async () => "saved-key" });
  const read = runtime.codexModels!;
  const first = read("subscription");
  assert.strictEqual(read("subscription"), first);
  assert.deepEqual((await first).map((m) => [m.id, m.levels]), [["model-1", ["high"]], ["next-page", ["high"]]]);
  assert.deepEqual(requests, ["initialize", "initialized", "model/list", "model/list"]);
  assert.equal(launches[0]!.command, local);
  assert.deepEqual(launches[0]!.args, ["app-server"]);
  assert.equal(launches[0]!.env.OPENAI_API_KEY, undefined);
  assert.equal(kills, 1);

  fail = true;
  await assert.rejects(read("api-key"), /catalog unavailable/);
  assert.equal(launches[1]!.env.OPENAI_API_KEY, "saved-key");
  fail = false;
  assert.equal((await read("api-key"))[0]!.id, "model-3");
  assert.equal(kills, 3);
});
