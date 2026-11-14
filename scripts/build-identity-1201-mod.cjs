"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const modProject = path.join(root, "client-mod");
const wrapper = path.join(
  modProject,
  isWindows ? "gradlew.bat" : "gradlew"
);

function getJavaVersion(javaHome) {
  const executable = path.join(
    javaHome,
    "bin",
    isWindows ? "java.exe" : "java"
  );
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    windowsHide: true
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/version "(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function locateJavaHome() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  if (isWindows) {
    for (const rootPath of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"]
    ].filter(Boolean)) {
      for (const vendor of ["Eclipse Adoptium", "Java"]) {
        const directory = path.join(rootPath, vendor);
        if (!fs.existsSync(directory)) continue;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && /^jdk[-_]/i.test(entry.name)) {
            candidates.push(path.join(directory, entry.name));
          }
        }
      }
    }
  }

  return candidates.find((candidate) => getJavaVersion(candidate) >= 17);
}

const javaHome = locateJavaHome();
if (!javaHome) {
  console.error(
    "[ERYON] Para compilar ERYON Identity para Minecraft 1.20.1 se necesita un JDK 17 o superior."
  );
  process.exit(1);
}

const command = isWindows ? process.env.ComSpec || "cmd.exe" : wrapper;
const args = isWindows
  ? ["/d", "/s", "/c", "call .\\gradlew.bat build"]
  : ["build"];
const result = spawnSync(
  command,
  args,
  {
    cwd: modProject,
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
  console.error(`[ERYON] No se pudo compilar ERYON Identity 1.20.1: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status || 1;
}
