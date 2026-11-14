
'use strict';

// ======================================================
// EXTRACCIÓN DE ARCHIVOS ZIP (INSTALADORES Y MODPACKS)
// ======================================================
// La librería extract-zip (yauzl) se cuelga de forma
// esporádica en Windows sin devolver ningún error. Para no
// bloquear la instalación de modpacks ni de Java, se usa una
// cascada de estrategias:
//   1. tar.exe (bsdtar, integrado en Windows 10/11) — rápido
//      y con escape de argumentos fiable.
//   2. Expand-Archive (PowerShell integrado).
//   3. extract-zip como último recurso (rutas no-Windows).

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);

const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

async function extractWithTar(archivePath, destinationDir) {
  await execFileAsync(
    'tar',
    ['-xf', archivePath, '-C', destinationDir],
    {
      timeout: EXTRACT_TIMEOUT_MS,
      windowsHide: true
    }
  );
}

async function extractWithPowerShell(
  archivePath,
  destinationDir
) {
  // Los nombres de archivo de Windows no pueden contener
  // comillas dobles, así que envolver las rutas con " es seguro.
  const command =
    `Expand-Archive -LiteralPath "${archivePath}" ` +
    `-DestinationPath "${destinationDir}" -Force`;

  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ],
    {
      timeout: EXTRACT_TIMEOUT_MS,
      windowsHide: true
    }
  );
}

async function extractWithExtractZip(
  archivePath,
  destinationDir
) {
  const extractZip = require('extract-zip');

  await extractZip(archivePath, {
    dir: destinationDir
  });
}

async function extractArchive(
  archivePath,
  destinationDir
) {
  await fs.mkdir(destinationDir, {
    recursive: true
  });

  const resolvedArchive = path.resolve(archivePath);
  const resolvedDestination = path.resolve(destinationDir);

  const strategies =
    process.platform === 'win32'
      ? [
          extractWithTar,
          extractWithPowerShell,
          extractWithExtractZip
        ]
      : [extractWithExtractZip];

  const collectedErrors = [];

  for (const strategy of strategies) {
    try {
      await strategy(
        resolvedArchive,
        resolvedDestination
      );

      // Confirmación: la extracción debe haber creado archivos.
      const contents = await fs.readdir(
        resolvedDestination
      );

      if (contents.length === 0) {
        throw new Error(
          'la extracción terminó sin crear archivos.'
        );
      }

      return;
    } catch (error) {
      collectedErrors.push(
        error?.message || String(error)
      );
    }
  }

  throw new Error(
    `No se pudo extraer ${path.basename(
      resolvedArchive
    )}: ${collectedErrors.join(' / ')}`
  );
}

module.exports = { extractArchive };
