"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MODS = ["identity-client", "identity-server"];
const IS_WINDOWS = process.platform === "win32";

function javaVersion(javaHome) {
  const executable = path.join(
    javaHome,
    "bin",
    IS_WINDOWS ? "java.exe" : "java"
  );
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    windowsHide: true
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/version "(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function findJavaHome() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  if (IS_WINDOWS) {
    for (const root of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"]
    ].filter(Boolean)) {
      for (const vendor of ["Eclipse Adoptium", "Java"]) {
        const directory = path.join(root, vendor);
        if (!fs.existsSync(directory)) continue;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && /^jdk[-_]/i.test(entry.name)) {
            candidates.push(path.join(directory, entry.name));
          }
        }
      }
    }
  }

  return candidates.find((candidate) => javaVersion(candidate) >= 21);
}

const javaHome = findJavaHome();
if (!javaHome) {
  console.error(
    "[ERYON] ERYON Identity para Minecraft 1.21.1 requiere un JDK 21 o superior."
  );
  process.exit(1);
}

for (const mod of MODS) {
  const project = path.join(ROOT, mod);
  const wrapper = path.join(project, IS_WINDOWS ? "gradlew.bat" : "gradlew");
  const args = IS_WINDOWS
    ? ["/d", "/c", `call ${wrapper} build`]
    : ["build"];
  const result = spawnSync(
    IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : wrapper,
    args,
    {
      cwd: project,
      env: {
        ...process.env,
        JAVA_HOME: javaHome,
        PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
      },
      stdio: "inherit",
      windowsHide: true
    }
  );

  if (result.error) {
    console.error(`[ERYON] No se pudo compilar ${mod}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
