// Locate or install an ACP bridge into the plugin's data dir, once.
//   npm install --prefix <bridgeDir> <pkg>@<pinned>
// then the bridge is run as `node <entry>`: no npx at chat time (slow, needs the network).
// No node:fs here (Gecko): the check for "already installed" is a tiny `node -e`.
import type { Spawner } from "../types.ts";
import type { BridgeSpec } from "./backends.ts";
import { dirnameOf, findBinary, withPathFirst } from "./env.ts";
import { shimTarget } from "./windows.ts";

export interface BridgeLocation {
  /** The bridge's JS entry (its package.json `bin`), absolute. */
  entry: string;
  version: string;
}

const LOCATE_SCRIPT =
  'const fs=require("fs"),path=require("path");' +
  "try{const d=path.join(process.argv[1],'node_modules',process.argv[2]);" +
  "const p=JSON.parse(fs.readFileSync(path.join(d,'package.json'),'utf8'));" +
  "const b=typeof p.bin==='string'?p.bin:Object.values(p.bin||{})[0];" +
  "const e=path.join(d,b);fs.accessSync(e);" +
  "console.log(JSON.stringify({version:p.version,entry:e}))}catch(e){}";

/** The installed bridge for `spec`, or null when it is missing (or a different version than pinned). */
export async function locateBridge(spawner: Spawner, env: Record<string, string>, node: string, bridgeDir: string, spec: BridgeSpec): Promise<BridgeLocation | null> {
  const r = await spawner.run(node, ["-e", LOCATE_SCRIPT, bridgeDir, spec.pkg], { env, timeoutMs: 15_000 });
  const line = r.stdout.trim().split("\n").pop();
  if (!line) return null;
  const found = JSON.parse(line) as BridgeLocation;
  return found.version === spec.version ? found : null;
}

const LOCATE_CODEX_SCRIPT =
  'const fs=require("fs"),path=require("path"),{createRequire}=require("module");' +
  'try{const p=createRequire(process.argv[1]).resolve("@openai/codex/package.json");' +
  'const pkg=JSON.parse(fs.readFileSync(p,"utf8"));' +
  'const bin=typeof pkg.bin==="string"?pkg.bin:pkg.bin.codex;' +
  'const entry=path.resolve(path.dirname(p),bin);fs.accessSync(entry);' +
  'console.log(JSON.stringify({codex:entry,version:pkg.version||""}))}catch(e){}';

/** The Codex bundled with the installed bridge: its launcher (run it with node, not a platform shim) and version. */
export async function locateBundledCodex(spawner: Spawner, env: Record<string, string>, node: string, bridge: BridgeLocation): Promise<{ entry: string; version: string } | null> {
  try {
    const r = await spawner.run(node, ["-e", LOCATE_CODEX_SCRIPT, bridge.entry], { env, timeoutMs: 15_000 });
    const line = r.stdout.trim().split("\n").pop();
    if (r.code !== 0 || !line) return null;
    const found: unknown = JSON.parse(line);
    if (!found || typeof found !== "object") return null;
    const { codex: entry, version } = found as { codex?: unknown; version?: unknown };
    return typeof entry === "string" ? { entry, version: typeof version === "string" ? version : "" } : null;
  } catch {
    return null;
  }
}

const semver = (v: string): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** a >= b, comparing major.minor.patch. */
export function atLeast(a: string, b: string): boolean {
  const x = semver(a), y = semver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

const WINDOWS_CODEX_SCRIPT = `
const { existsSync, realpathSync, statSync } = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const targets = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
const target = targets[process.arch];
if (!target) process.exit(1);
const launcher = realpathSync(process.argv[1]);
const platform = "@openai/codex-win32-" + process.arch;
let pkg = path.join(path.dirname(launcher), "..");
try {
  pkg = path.dirname(createRequire(launcher).resolve(platform + "/package.json"));
} catch {}
const exe = path.join(pkg, "vendor", target, "bin", "codex.exe");
if (existsSync(exe) && statSync(exe).isFile()) console.log(exe);
`;

async function windowsCodexExecutable(spawner: Spawner, env: Record<string, string>, node: string, shim: string): Promise<string | null> {
  const opts = { env, timeoutMs: 15_000 };
  const source = await spawner.run(node, ["-e", 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', shim], opts);
  const target = source.code === 0 ? shimTarget(source.stdout) : null;
  if (!target || !/(?:^|\\)@openai\\codex\\bin\\codex\.js$/i.test(target)) return null;
  const found = await spawner.run(node, ["-e", WINDOWS_CODEX_SCRIPT, `${dirnameOf(shim)}\\${target}`], opts);
  const exe = found.stdout.trim();
  return found.code === 0 && /^[A-Za-z]:[\\/][^\r\n]+\.exe$/i.test(exe) ? exe : null;
}

/**
 * The user's own Codex, when chats should run it instead of the bridge's bundled one: when it is at least as new
 * (#811: a config.toml written for a newer Codex fails to load in the older bundled one, as "failed to load
 * workspace requirements"). codex-acp runs it through CODEX_PATH. On Windows, resolve an npm shim to the native
 * executable from its own package. An older, unversioned or unresolvable Codex keeps the bundled one.
 */
export async function systemCodexForChats(spawner: Spawner, env: Record<string, string>, node: string, cli: string | null, bundled: { version: string } | null): Promise<string | null> {
  if (!cli || !bundled?.version) return null;
  try {
    const exe = spawner.windows && !/\.exe$/i.test(cli)
      ? await windowsCodexExecutable(spawner, env, node, cli)
      : cli;
    if (!exe) return null;
    const r = await spawner.run(exe, ["--version"], { env, timeoutMs: 15_000 });
    return r.code === 0 && atLeast(r.stdout, bundled.version) ? exe : null;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<BridgeLocation>>();

interface EnsureBridgeOpts {
  spawner: Spawner;
  /** The login-shell environment (Spawner.baseEnv()). */
  env: Record<string, string>;
  node: string;
  bridgeDir: string;
  spec: BridgeSpec;
  onProgress?: (message: string) => void;
}

/** Make sure the pinned bridge is installed; a no-op (one `node -e`) when it is. Concurrent callers share one install. */
export function ensureBridge(opts: EnsureBridgeOpts): Promise<BridgeLocation> {
  const key = `${opts.bridgeDir}\u0000${opts.spec.pkg}@${opts.spec.version}`;
  let p = inflight.get(key);
  if (!p) {
    p = install(opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function install(opts: EnsureBridgeOpts): Promise<BridgeLocation> {
  const { spawner, node, bridgeDir, spec } = opts;
  const env = withPathFirst(opts.env, dirnameOf(node));
  const have = await locateBridge(spawner, env, node, bridgeDir, spec);
  if (have) return have;

  const npm = await findBinary(spawner, env, "npm");
  if (!npm) throw new Error(`npm was not found on your PATH, so ${spec.label}'s bridge (${spec.pkg}) cannot be installed. Install Node.js (it includes npm).`);

  opts.onProgress?.(`Installing ${spec.pkg}@${spec.version}…`);
  const r = await spawner.run(npm, ["install", "--prefix", bridgeDir, `${spec.pkg}@${spec.version}`, "--no-audit", "--no-fund", "--loglevel=error"], {
    env,
    timeoutMs: 600_000,
  });
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
    throw new Error(`npm could not install ${spec.pkg}@${spec.version} (exit ${r.code}).${tail ? "\n" + tail : ""}`);
  }
  const done = await locateBridge(spawner, env, node, bridgeDir, spec);
  if (!done) throw new Error(`${spec.pkg}@${spec.version} installed, but its entry point was not found in ${bridgeDir}`);
  return done;
}
