import { rmSync } from "node:fs";
import { globSync } from "node:fs";
for (const dir of globSync("packages/*/dist")) {
  rmSync(dir, { recursive: true, force: true });
  console.log("removed", dir);
}
