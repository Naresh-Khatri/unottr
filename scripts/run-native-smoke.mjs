import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(
  process.execPath,
  [vitest, "run", "test/native-addons.test.ts", "--reporter=verbose"],
  {
    env: { ...process.env, UNOTTR_NATIVE_SMOKE: "1" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
