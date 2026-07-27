/**
 * 兼容旧入口；真实实现已泛化到 project+season+episode，且只允许源码 dev/build。
 */
import { run } from "./t23-project-raw-sha-ui-verify.js";

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
