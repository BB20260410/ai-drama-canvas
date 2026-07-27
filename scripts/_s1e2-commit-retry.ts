/**
 * Retry wrapper for s1e2-commit-prepared-state when SQLite snapshot races with Electron.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const statePath = process.argv[2];
if (!statePath || !existsSync(statePath)) {
  console.error("usage: tsx scripts/_s1e2-commit-retry.ts <state.json>");
  process.exit(2);
}

function runOnce(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "scripts/s1e2-commit-prepared-state.ts", statePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stderr.write(s);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

function isRace(out: string) {
  return /snapshot|WAL|冻结验证|隔离快照|source identity|changed while|safe regular file/i.test(out);
}

async function main() {
  let last = "";
  for (let i = 0; i < 30; i++) {
    console.log(`\n=== commit attempt ${i} ===`);
    const r = await runOnce();
    last = r.out;
    if (r.code === 0) {
      console.log("COMMIT_OK");
      process.exit(0);
    }
    if (!isRace(r.out) && i >= 4) {
      console.error("non-race failure, stop");
      process.exit(r.code);
    }
    const wait = Math.min(25000, 1200 * Math.pow(1.3, i)) + Math.random() * 800;
    console.log(`race/backoff sleep ${Math.round(wait)}ms`);
    await new Promise((res) => setTimeout(res, wait));
  }
  console.error("exhausted retries");
  process.exit(1);
}
main();
