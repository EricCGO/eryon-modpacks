
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const VERSION_MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

// ======================================================
// DEDUPLICACIÓN DE LIBRERÍAS (INHERITSFROM)
// ======================================================
// MCLC no resuelve la herencia "inheritsFrom": añade al classpath
// las librerías del perfil hijo (Fabric) y las de la versión base
// (vanilla). Si ambos declaran el mismo grupo:artefacto (p. ej. ASM
// 9.6 del hijo y ASM 9.10.1 del padre), Fabric Loader aborta con
// "duplicate ASM classes found on classpath".
//
// Esta función deja una sola copia por grupo:artefacto: conserva la
// versión más nueva y elimina la copia redundante de cualquiera de
// los dos perfiles, dejando el resultado persistido en disco para
// que el siguiente arranque ya esté limpio.

function parseLibraryName(name) {
  const parts = String(name ?? "").trim().split(":");

  if (parts.length < 3 || parts.slice(0, 3).some((part) => !part)) {
    return null;
  }

  // Clave = grupo:artefacto (+ clasificador si lo hubiera, porque la
  // variante "natives-windows" y la normal son jars distintos).
  const base = parts.slice(0, 2).join(":");
  const classifier =
    parts.length > 3 ? parts.slice(3).join(":") : "";

  return {
    key: classifier ? `${base}:${classifier}` : base,
    version: parts[2]
  };
}

function compareVersionStrings(a, b) {
  const partsA = String(a ?? "").split(/[._-]/);
  const partsB = String(b ?? "").split(/[._-]/);
  const length = Math.max(partsA.length, partsB.length);

  for (let index = 0; index < length; index++) {
    const partA = partsA[index];
    const partB = partsB[index];

    if (partA === undefined) return -1;
    if (partB === undefined) return 1;

    const numericA = /^\d+$/.test(partA) ? Number(partA) : null;
    const numericB = /^\d+$/.test(partB) ? Number(partB) : null;

    if (numericA !== null && numericB !== null) {
      if (numericA !== numericB) {
        return numericA < numericB ? -1 : 1;
      }
    } else if (partA !== partB) {
      return partA < partB ? -1 : 1;
    }
  }

  return 0;
}

async function readParentVersionJson({
  gameDirectory,
  parentId,
  childDirectory
}) {
  const candidates = [
    // Copia materializada junto al perfil hijo (la escribe esta
    // función y MCLC también la usa al resolver la versión).
    path.join(childDirectory, `${parentId}.json`),

    // Copia estándar de la versión base instalada.
    path.join(gameDirectory, "versions", parentId, `${parentId}.json`),

    // Cache de MCLC (se rellena al descargar el juego).
    path.join(gameDirectory, "cache", "json", `${parentId}.json`)
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8"));
    } catch {
      // Se prueba con la siguiente candidata.
    }
  }

  // Último recurso: descargar el perfil base desde Mojang.
  try {
    const response = await fetch(VERSION_MANIFEST_URL);

    if (!response.ok) {
      return null;
    }

    const manifest = await response.json();
    const entry = Array.isArray(manifest.versions)
      ? manifest.versions.find((item) => item.id === parentId)
      : null;

    if (!entry?.url) {
      return null;
    }

    const versionResponse = await fetch(entry.url);

    if (!versionResponse.ok) {
      return null;
    }

    return await versionResponse.json();
  } catch {
    // Sin red: quedamos sin perfil base y se omite la deduplicación.
    return null;
  }
}

/**
 * Elimina librerías duplicadas entre el perfil hijo (con
 * "inheritsFrom") y su perfil base. Devuelve un resumen de lo hecho.
 *
 * @param {{
 *   gameDirectory: string,
 *   launchVersionId: string,
 *   log?: (message: string) => void | Promise<void>
 * }} input
 */
async function dedupeInheritedLibraries({
  gameDirectory,
  launchVersionId,
  log
}) {
  const logger = async (message) => {
    if (typeof log === "function") {
      await log(message);
    }
  };

  const report = {
    processed: false,
    removedFromChild: 0,
    removedFromParent: 0
  };

  const childDirectory = path.join(
    gameDirectory,
    "versions",
    launchVersionId
  );

  const childPath = path.join(
    childDirectory,
    `${launchVersionId}.json`
  );

  let profile;

  try {
    profile = JSON.parse(await fs.readFile(childPath, "utf8"));
  } catch (error) {
    await logger(
      `Deduplicación de librerías omitida: no se pudo leer el perfil "${launchVersionId}" (${
        error?.message ?? error
      })`
    );
    return report;
  }

  const parentId = profile?.inheritsFrom;

  // Sin herencia no hay nada que auditar (vanilla puro).
  if (typeof parentId !== "string" || !parentId) {
    return report;
  }

  if (!Array.isArray(profile.libraries)) {
    return report;
  }

  const parent = await readParentVersionJson({
    gameDirectory,
    parentId,
    childDirectory
  });

  if (!parent || !Array.isArray(parent.libraries)) {
    await logger(
      `Deduplicación de librerías omitida: no se pudo resolver el perfil base "${parentId}".`
    );
    return report;
  }

  report.processed = true;

  // Índice de groupId:artifactId(:classifier) del padre. Las entradas
  // con reglas (dependen del sistema operativo) se ignoran para no
  // eliminar copias que aplican solo en algunos entornos.
  const parentByCoordinate = new Map();

  parent.libraries.forEach((library, index) => {
    if (!library || Array.isArray(library.rules)) {
      return;
    }

    const parsed = parseLibraryName(library.name);

    if (parsed) {
      parentByCoordinate.set(parsed.key, {
        index,
        version: parsed.version
      });
    }
  });

  const notes = [];
  const keptParentIndices = new Set(
    parent.libraries.map((_, index) => index)
  );

  const keptChildLibraries = [];

  for (const library of profile.libraries) {
    if (!library || Array.isArray(library.rules)) {
      keptChildLibraries.push(library);
      continue;
    }

    const parsed = parseLibraryName(library.name);
    const official = parsed
      ? parentByCoordinate.get(parsed.key)
      : null;

    if (!official) {
      keptChildLibraries.push(library);
      continue;
    }

    const comparison = compareVersionStrings(
      parsed.version,
      official.version
    );

    if (comparison > 0) {
      // El hijo declara una versión más nueva que la base: se
      // conserva la del hijo y se retira la copia antigua del padre.
      keptParentIndices.delete(official.index);
      keptChildLibraries.push(library);
      report.removedFromParent++;
      notes.push(
        `del padre: ${parsed.key}:${official.version} (se usa ${parsed.version} del hijo)`
      );
    } else if (comparison < 0) {
      // El padre declara una versión más nueva: se descarta la
      // copia antigua del hijo y se usa la del padre.
      report.removedFromChild++;
      notes.push(
        `del hijo: ${parsed.key}:${parsed.version} (se usa ${official.version} del padre)`
      );
    } else {
      // Misma versión: sobra la copia del hijo.
      report.removedFromChild++;
      notes.push(
        `del hijo: ${parsed.key}:${parsed.version} (igual a la del padre)`
      );
    }
  }

  parent.libraries = parent.libraries.filter(
    (_, index) => keptParentIndices.has(index)
  );

  profile.libraries = keptChildLibraries;

  if (report.removedFromChild > 0) {
    try {
      await fs.writeFile(
        childPath,
        JSON.stringify(profile, null, 2),
        "utf8"
      );
    } catch (error) {
      await logger(
        `No se pudo reescribir el perfil de Fabric: ${
          error?.message ?? error
        }`
      );
    }
  }

  // Materializa el perfil base junto al hijo. MCLC lee
  // versions/<perfilHijo>/<versionBase>.json al resolver la versión,
  // así que dejarlo ahí fija el classpath limpio y ahorra la
  // descarga del perfil base en cada arranque.
  try {
    await fs.mkdir(childDirectory, { recursive: true });
    await fs.writeFile(
      path.join(childDirectory, `${parentId}.json`),
      JSON.stringify(parent, null, 2),
      "utf8"
    );
  } catch (error) {
    await logger(
      `No se pudo materializar el perfil base: ${
        error?.message ?? error
      }`
    );
  }

  if (report.removedFromChild > 0 || report.removedFromParent > 0) {
    await logger(
      `Librerías duplicadas eliminadas (${
        report.removedFromChild
      } del hijo, ${report.removedFromParent} del padre): ${notes.join("; ")}`
    );
  }

  return report;
}

module.exports = {
  compareVersionStrings,
  dedupeInheritedLibraries,
  parseLibraryName
};
