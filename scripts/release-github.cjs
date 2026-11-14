
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");

const ROOT = path.resolve(__dirname, "..");
const VERSION = String(packageJson.version);
const TAG = `v${VERSION}`;

const PUBLISH = packageJson.build?.publish;

if (
  !PUBLISH ||
  PUBLISH.provider !== "github" ||
  !PUBLISH.owner ||
  !PUBLISH.repo
) {
  console.error(
    "[ERYON] Configura build.publish en package.json antes de publicar."
  );
  process.exit(1);
}

const REPOSITORY = `${PUBLISH.owner}/${PUBLISH.repo}`;

const SETUP_NAME = `Eryon-Launcher-${VERSION}-Setup.exe`;
const BLOCKMAP_NAME = `${SETUP_NAME}.blockmap`;
const MANIFEST_NAME = "latest.yml";

function run(command, args, options = {}) {
  const useCmd = process.platform === "win32" &&
    ["npm", "npx"].includes(command);

  const executable = useCmd ? `${command}.cmd` : command;

  const result = spawnSync(executable, args, {
    cwd: ROOT,
    stdio: options.silent ? "ignore" : "inherit",
    shell: useCmd
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function runOrFail(command, args) {
  const result = run(command, args);

  if (result.status !== 0) {
    throw new Error(
      `El comando "${command}" terminó con código ${result.status}.`
    );
  }
}

function checkReleaseDoesNotExist() {
  const result = run(
    "gh",
    ["release", "view", TAG, "--repo", REPOSITORY],
    { silent: true }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    throw new Error(
      `La publicación ${TAG} ya existe. ` +
      "Aumenta la versión en package.json antes de publicar otra vez."
    );
  }
}

function checkBuildFiles() {
  const releaseDirectory = path.join(ROOT, "release");

  const files = [
    SETUP_NAME,
    BLOCKMAP_NAME,
    MANIFEST_NAME
  ].map((name) => path.join(releaseDirectory, name));

  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `No se encontró ${path.basename(file)}. ` +
        "Comprueba la compilación."
      );
    }
  }

  const manifest = fs.readFileSync(files[2], "utf8");

  const versionPattern = new RegExp(
    `^version:\\s*['"]?${VERSION.replace(/\./g, "\\.")}['"]?\\s*$`,
    "m"
  );

  if (!versionPattern.test(manifest)) {
    throw new Error(
      `latest.yml no corresponde a la versión ${VERSION}.`
    );
  }

  if (
    !manifest.includes(`url: ${SETUP_NAME}`) ||
    !manifest.includes(`path: ${SETUP_NAME}`)
  ) {
    throw new Error(
      `latest.yml no apunta a ${SETUP_NAME}.`
    );
  }

  return files;
}

function main() {
  console.log("\n========================================");
  console.log(`  ERYON LAUNCHER ${VERSION}`);
  console.log(`  Publicación: ${REPOSITORY}`);
  console.log("========================================\n");

  console.log("[ERYON] Comprobando autenticación de GitHub...");
  runOrFail("gh", ["auth", "status", "--hostname", "github.com"]);

  // Evita compilar si esta versión ya está publicada.
  checkReleaseDoesNotExist();

  console.log("\n[ERYON] Compilando la interfaz...");
  runOrFail("npm", ["run", "build"]);

  console.log("\n[ERYON] Generando el instalador NSIS...");
  runOrFail("npx", [
    "electron-builder",
    "--win",
    "nsis",
    "--publish",
    "never"
  ]);

  console.log("\n[ERYON] Verificando los archivos...");
  const files = checkBuildFiles();

  console.log("\n[ERYON] Publicando en GitHub...");
  runOrFail("gh", [
    "release",
    "create",
    TAG,
    ...files,
    "--repo",
    REPOSITORY,
    "--title",
    `Eryon Launcher ${VERSION}`,
    "--notes",
    `Actualización de Eryon Launcher ${VERSION}.`
  ]);

  console.log("\n========================================");
  console.log("  PUBLICACIÓN COMPLETADA");
  console.log(`  Versión: ${VERSION}`);
  console.log(
    `  https://github.com/${REPOSITORY}/releases/tag/${TAG}`
  );
  console.log("========================================\n");
}

try {
  main();
} catch (error) {
  console.error(`\n[ERYON] ERROR: ${error.message}`);
  process.exitCode = 1;
}
