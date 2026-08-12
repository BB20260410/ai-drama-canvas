import { DatabaseSync } from "node:sqlite";

function runtimeMode() {
  if (!process.versions.electron) return "system-node";
  return process.env.ELECTRON_RUN_AS_NODE === "1" ? "electron-run-as-node" : "electron-main";
}

function runtimeVersions() {
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    sqlite: process.versions.sqlite ?? null,
  };
}

function probeFts5() {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE VIRTUAL TABLE novel_probe USING fts5(chapter_id UNINDEXED, body, tokenize='unicode61')");
    const insert = database.prepare("INSERT INTO novel_probe(chapter_id, body) VALUES (?, ?)");
    insert.run("chapter-001", "青铜 神树 嘟嘟 金面具");
    insert.run("chapter-002", "火路 阿航 黑水");
    insert.run("chapter-003", "十三人 同桌 人间相");

    const query = "嘟嘟";
    const matches = database
      .prepare("SELECT chapter_id FROM novel_probe WHERE novel_probe MATCH ? ORDER BY chapter_id")
      .all(query)
      .map((row) => row.chapter_id);
    if (matches.length !== 1 || matches[0] !== "chapter-001") {
      throw new Error(`FTS5 中文参数查询结果不唯一：${JSON.stringify(matches)}`);
    }

    return {
      schemaVersion: 1,
      kind: "novel-fts5-runtime-probe",
      ok: true,
      runtime: runtimeMode(),
      inMemory: true,
      parameterBinding: true,
      query,
      matchIds: matches,
      versions: runtimeVersions(),
    };
  } finally {
    database.close();
  }
}

async function emit(payload) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, (error) => error ? reject(error) : resolve());
  });
}

let exitCode = 0;
try {
  await emit(probeFts5());
} catch (error) {
  exitCode = 1;
  await emit({
    schemaVersion: 1,
    kind: "novel-fts5-runtime-probe",
    ok: false,
    runtime: runtimeMode(),
    versions: runtimeVersions(),
    error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) },
  });
}

if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") {
  const electron = await import("electron");
  const app = electron.app ?? electron.default?.app;
  if (!app) throw new Error("Electron main runtime 缺少 app API，无法确定性退出。");
  app.exit(exitCode);
} else {
  process.exitCode = exitCode;
}
