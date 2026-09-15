import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJsonPath = path.join(packageRoot, "package.json");
const backupPackageJsonPath = path.join(packageRoot, ".package.json.prepack-backup");

main();

function main() {
  if (!fs.existsSync(backupPackageJsonPath)) {
    return;
  }

  fs.copyFileSync(backupPackageJsonPath, packageJsonPath);
  fs.rmSync(backupPackageJsonPath, { force: true });
}
