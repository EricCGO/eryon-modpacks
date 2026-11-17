/**
 * LIMPIEZA DE MARCAS DE AGUA "NAVITH LABS"
 *
 * El mod DEDsafio4FanByNavithLabs dibuja su logo ("navith labs")
 * encima del logo de Minecraft en la pantalla de título y en la
 * pantalla de carga (splash overlay). Ambos dibujos salen de dos
 * mixins del propio mod:
 *
 *   - TitleScreenMixin   (envuelve LogoDrawer.draw y pinta la marca)
 *   - SplashOverlayMixin (reemplaza el logo de Mojang por la marca)
 *
 * Este módulo quita esas dos entradas del archivo ruleta.mixins.json
 * que va dentro del jar. Quitar entradas de la lista de mixins es
 * seguro: el mixin simplemente no se aplica y el resto del mod
 * (ruleta, momentos, HUD, mapa Xaero, etc.) sigue funcionando igual.
 *
 * La edición del zip se hace con .NET ZipArchive (modo Update) a
 * través de PowerShell. NO se usa adm-zip: su versión 0.4.16 corrompe
 * jars grandes (recompresión defectuosa, CRC invalido en miles de
 * entradas). .NET escribe zips correctos y es el método probado.
 *
 * Es idempotente: si las entradas ya no están, no toca nada.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const JAR_PATTERN = /^DEDsafio4FanByNavithLabs.*\.jar$/i;
const MIXIN_CONFIG_ENTRY = "ruleta.mixins.json";
const MIXINS_A_QUITAR = ["TitleScreenMixin", "SplashOverlayMixin"];

function listarJarsNavith(gameDirectory) {
  const modsDirectory = path.join(gameDirectory, "mods");
  let entries;
  try {
    entries = fs.readdirSync(modsDirectory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => JAR_PATTERN.test(name))
    .map((name) => path.join(modsDirectory, name));
}

/**
 * Parchea un jar con PowerShell (.NET ZipArchive, modo Update).
 * Devuelve true si lo modificó, false si ya estaba limpio.
 * Lanza Error con el mensaje si algo falla.
 */
function patchJar(jarPath) {
  const script = `
$ErrorActionPreference = 'Stop'
$jar = '${jarPath.split("\\").join("\\\\").replace(/'/g, "''")}'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

# 1. Leer el JSON actual del jar
$zipLectura = [System.IO.Compression.ZipFile]::OpenRead($jar)
try {
  $entrada = $zipLectura.GetEntry('${MIXIN_CONFIG_ENTRY}')
  if (-not $entrada) { Write-Output 'SIN_CONFIG'; exit 0 }
  $lector = New-Object System.IO.StreamReader($entrada.Open())
  $json = $lector.ReadToEnd()
  $lector.Dispose()
} finally {
  $zipLectura.Dispose()
}

# 2. Quitar las entradas de los mixins de marca (solo si están)
$quitar = @('${MIXINS_A_QUITAR.join("','")}')
$jsonNuevo = $json
foreach ($nombre in $quitar) {
  $jsonNuevo = $jsonNuevo -replace ('\\s*"' + $nombre + '",'), ''
  $jsonNuevo = $jsonNuevo -replace (',\\s*"' + $nombre + '"'), '$1'
}
if ($jsonNuevo -eq $json) { Write-Output 'YA_LIMPIO'; exit 0 }

# 3. Validar que el JSON queda parseable
try {
  $null = $jsonNuevo | ConvertFrom-Json
} catch {
  Write-Output ('JSON_INVALIDO: ' + $_.Exception.Message)
  exit 1
}

# 4. Escribir el JSON corregido dentro del jar (modo Update)
$nuevo = [System.Text.Encoding]::UTF8.GetBytes($jsonNuevo)
$zip = [System.IO.Compression.ZipFile]::Open($jar, 'Update')
try {
  $vieja = $zip.GetEntry('${MIXIN_CONFIG_ENTRY}')
  if ($vieja) { $vieja.Delete() }
  $creada = $zip.CreateEntry('${MIXIN_CONFIG_ENTRY}')
  $flujo = $creada.Open()
  $flujo.Write($nuevo, 0, $nuevo.Length)
  $flujo.Dispose()
} finally {
  $zip.Dispose()
}
Write-Output 'MODIFICADO'
`;

  const resultado = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10 * 60 * 1000 }
  );

  if (resultado.error) {
    throw new Error(resultado.error.message);
  }
  const salida = String(resultado.stdout || "").trim();
  if (salida.includes("MODIFICADO")) return true;
  if (salida.includes("YA_LIMPIO") || salida.includes("SIN_CONFIG")) return false;
  throw new Error(
    salida || `PowerShell termino con codigo ${resultado.status}`
  );
}

/**
 * Quita las marcas de agua de todos los jars de NavithLabs que
 * encuentre en <gameDirectory>/mods. Devuelve la lista de archivos
 * modificados (para el log del launcher).
 */
function cleanNavithWatermarks(gameDirectory) {
  const modificados = [];
  for (const jarPath of listarJarsNavith(gameDirectory)) {
    try {
      if (patchJar(jarPath)) {
        modificados.push(path.basename(jarPath));
      }
    } catch (error) {
      // Nunca romper el arranque por esto: se registra y continúa.
      modificados.push(
        `${path.basename(jarPath)} (ERROR: ${error?.message || error})`
      );
    }
  }
  return modificados;
}

module.exports = { cleanNavithWatermarks };
