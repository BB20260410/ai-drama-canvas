import { DEFAULT_PROJECT_ROOT } from "../src/core/constants.js";
import { scanAndPersist, summarizeForMcp } from "../src/core/service.js";

const projectRoot = process.argv[2] ?? DEFAULT_PROJECT_ROOT;

try {
  const index = await scanAndPersist(projectRoot);
  process.stdout.write(`${JSON.stringify(summarizeForMcp(index), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
