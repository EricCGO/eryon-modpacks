"use strict";

// ======================================================
// BUILD ERYON IDENTITY FORGE 1.8.9
// ======================================================
// Port del identificador a Forge legacy. Reusa el wrapper de
// Gradle del proyecto identity-client (Gradle 8.x already
// configurado) apuntando al proyecto forge-mod-189. El jar
// final queda en build/eryon-identity-forge-1.8.9.jar con el
// runtime de Mixin embebido.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_DIR = path.join(ROOT, "forge-mod-189");
const OUTPUT = path.join(ROOT, "build", "eryon-identity-forge-1.8.9.jar");

const gradlew = process.platform === "win32"
  ? path.join(ROOT, "identity-client", "gradlew.bat")
  : path.join(ROOT, "identity-client", "gradlew");

if (!fs.existsSync(gradlew)) {
  console.error("[ERROK/identity-forge] No se encontró " + gradlew);
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });

const result = spawnSync(
  gradlew,
  ["build", "-x", "test", "--console=plain"],
  {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
    env: process.env
  }
);

if (result.status !== 0) {
  console.error(
    "[ERROK/identity-forge] La compilación de Forge 1.8.9 falló."
  );
  process.exit(result.status || 1);
}

if (!fs.existsSync(OUTPUT)) {
  console.error(
    "[ERROK/identity-forge] Gradle no generó " + OUTPUT
  );
  process.exit(1);
}

console.log(
  "[OK/identity-forge] " +
    path.basename(OUTPUT) +
    " (" +
    Math.round(fs.statSync(OUTPUT).size / 1024) +
    " KB)"
);
