
'use strict';

// ======================================================
// METADATOS DE ARCHIVOS .JAR DE MODS (SIN DEPENDENCIAS)
// ======================================================
// Lee el directorio central del ZIP directamente y obtiene
// entradas de texto pequeñas (fabric.mod.json, mods.toml,
// quilt.mod.json) sin extraer el archivo completo. Esto evita
// depender de librerías de extracción y es muy rápido.

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readUInt(buffer, offset, bytes) {
  if (bytes === 2) {
    return buffer.readUInt16LE(offset);
  }

  if (bytes === 4) {
    return buffer.readUInt32LE(offset);
  }

  return buffer.readUInt8(offset);
}

// Localiza el bloque EOCD (End of Central Directory) retornando
// el offset de su firma, o -1 si el archivo no es un ZIP válido.
function findEndOfCentralDirectory(footer) {
  for (
    let offset = footer.length - EOCD_MIN_SIZE;
    offset >= 0;
    offset -= 1
  ) {
    if (
      readUInt(footer, offset, 4) === EOCD_SIGNATURE
    ) {
      return offset;
    }
  }

  return -1;
}

// Devuelve la lista de entradas del ZIP central:
// { fileName, compressedSize, uncompressedSize, compressionMethod, localOffset }
async function readZipCentralDirectory(zipPath) {
  const fileHandle = await fs.open(zipPath, 'r');

  try {
    const { size } = await fileHandle.stat();

    // El EOCD vive en los últimos bytes del archivo.
    const footerBytes = Math.min(size, 66000);
    const footerStart = size - footerBytes;

    const footer = Buffer.alloc(footerBytes);
    await fileHandle.read(
      footer,
      0,
      footerBytes,
      footerStart
    );

    const eocdOffset = findEndOfCentralDirectory(footer);

    if (eocdOffset < 0) {
      throw new Error(
        `${path.basename(zipPath)} no es un archivo ZIP válido.`
      );
    }

    const entryCount = readUInt(
      footer,
      eocdOffset + 10,
      2
    );

    const centralSize = readUInt(
      footer,
      eocdOffset + 12,
      4
    );

    const centralOffset = readUInt(
      footer,
      eocdOffset + 16,
      4
    );

    // El directorio central puede quedar tras una marca ZIP64
    // relativa, pero para mod jars el offset directo es válido.
    const toRead = Math.min(
      centralSize,
      Math.max(0, size - centralOffset)
    );

    if (toRead <= 0) {
      return [];
    }

    const central = Buffer.alloc(toRead);

    await fileHandle.read(central, 0, toRead, centralOffset);

    const entries = [];
    let cursor = 0;

    for (
      let index = 0;
      index < Math.min(entryCount, 8000);
      index += 1
    ) {
      if (
        cursor + 46 > toRead ||
        readUInt(central, cursor, 4) !== CENTRAL_SIGNATURE
      ) {
        break;
      }

      const compressionMethod = readUInt(
        central,
        cursor + 10,
        2
      );

      const compressedSize = readUInt(
        central,
        cursor + 20,
        4
      );

      const uncompressedSize = readUInt(
        central,
        cursor + 24,
        4
      );

      const nameLength = readUInt(
        central,
        cursor + 28,
        2
      );

      const extraLength = readUInt(
        central,
        cursor + 30,
        2
      );

      const commentLength = readUInt(
        central,
        cursor + 32,
        2
      );

      const localOffset = readUInt(
        central,
        cursor + 42,
        4
      );

      const fileName = central
        .slice(
          cursor + 46,
          cursor + 46 + nameLength
        )
        .toString('utf8');

      entries.push({
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localOffset
      });

      cursor +=
        46 + nameLength + extraLength + commentLength;
    }

    return entries;
  } finally {
    await fileHandle.close();
  }
}

// Lee una entrada concreta del ZIP y devuelve sus bytes.
async function readZipEntryBuffer(
  zipPath,
  targetFileName
) {
  const entries = await readZipCentralDirectory(zipPath);

  const target = entries.find(
    (entry) =>
      entry.fileName === targetFileName ||
      entry.fileName === `/${targetFileName}`
  );

  if (
    !target ||
    target.compressedSize === 0 ||
    target.compressedSize > 512 * 1024 ||
    target.uncompressedSize > 512 * 1024
  ) {
    return null;
  }

  const fileHandle = await fs.open(zipPath, 'r');

  try {
    // Cabecera local: 30 bytes fijo + nombre + extra variable.
    const localHeader = Buffer.alloc(30);

    await fileHandle.read(
      localHeader,
      0,
      30,
      target.localOffset
    );

    const nameLength = readUInt(localHeader, 26, 2);
    const extraLength = readUInt(localHeader, 28, 2);

    const dataStart =
      target.localOffset + 30 + nameLength + extraLength;

    const compressed = Buffer.alloc(target.compressedSize);

    await fileHandle.read(
      compressed,
      0,
      target.compressedSize,
      dataStart
    );

    if (target.compressionMethod === 0) {
      return compressed;
    }

    if (target.compressionMethod !== 8) {
      return null;
    }

    return zlib.inflateRawSync(compressed, {
      maxOutputLength: 512 * 1024
    });
  } finally {
    await fileHandle.close();
  }
}

// Lee una entrada concreta del ZIP y la devuelve como texto.
async function readZipEntryText(zipPath, targetFileName) {
  const contents = await readZipEntryBuffer(zipPath, targetFileName);
  return contents ? contents.toString('utf8') : null;
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 200);
    }
  }

  return '';
}

// fabric.mod.json: { id, name, version, description }
async function metadataFromFabricModJson(text) {
  const parsed = JSON.parse(text);
  const icon = parsed.icon;

  return {
    modId: pickString(parsed, ['id']),
    name: pickString(parsed, ['name', 'id']),
    version: pickString(parsed, ['version']),
    description: pickString(parsed, ['description']),
    dependencies: {
      depends: parsed.depends ?? {},
      breaks: parsed.breaks ?? {}
    },
    provides: Array.isArray(parsed.provides)
      ? parsed.provides.filter(
          (id) => typeof id === 'string' && id.trim()
        )
      : [],
    icon: pickString(
      typeof icon === 'string'
        ? { icon }
        : icon && typeof icon === 'object'
          ? { icon: icon["128"] || icon["64"] || Object.values(icon)[0] }
          : null,
      ['icon']
    )
  };
}

// quilt.mod.json: { quilt_loader: { id, version, metadata: { name, description } } }
async function metadataFromQuiltModJson(text) {
  const parsed = JSON.parse(text);

  return {
    modId: pickString(parsed?.quilt_loader, ['id']),
    name: pickString(
      parsed?.quilt_loader?.metadata,
      ['name']
    ) || pickString(parsed?.quilt_loader, ['id']),
    version: pickString(parsed?.quilt_loader, ['version']),
    description: pickString(
      parsed?.quilt_loader?.metadata,
      ['description']
    ),
    dependencies: {
      depends: parsed?.quilt_loader?.depends ?? [],
      breaks: parsed?.quilt_loader?.breaks ?? []
    },
    icon: pickString(parsed?.quilt_loader?.metadata, ['icon'])
  };
}

// mods.toml / neoforge.mods.toml: líneas `modId="..."`, `displayName="..."`.
function metadataFromModsToml(text) {
  const grab = (key) => {
    const match = text.match(
      new RegExp(`^\\s*#?\\s*${key}\\s*=\\s*"([^"]*)"`, 'im')
    );

    return match ? match[1] : '';
  };

  const dependencies = {};
  const dependencySections =
    text.matchAll(/\[\[dependencies\.[^\]]+\]\]([\s\S]*?)(?=\r?\n\s*\[\[|\s*$)/g);

  for (const section of dependencySections) {
    const body = section[1];
    const dependencyId = body.match(/^\s*modId\s*=\s*"([^"]+)"/im)?.[1];
    const required = body.match(/^\s*mandatory\s*=\s*(true|false)/im)?.[1];
    const versionRange = body.match(/^\s*versionRange\s*=\s*"([^"]*)"/im)?.[1] || '*';

    if (dependencyId && required !== 'false') {
      dependencies[dependencyId] = versionRange;
    }
  }

  return {
    modId: grab('modId'),
    name: grab('displayName') || grab('modId'),
    version: grab('version'),
    description: grab('description').replace(/\\n/g, ' '),
    dependencies: { depends: dependencies, breaks: {} },
    icon: grab('logoFile')
  };
}

// Devuelve { modId, name, version, description, metadataSource }
// usando el primer metadato reconocible dentro del .jar.
async function readJarModMetadata(jarPath, options = {}) {
  const forgeCandidates = [
    {
      entry: 'META-INF/mods.toml',
      parser: metadataFromModsToml
    },
    {
      entry: 'META-INF/neoforge.mods.toml',
      parser: metadataFromModsToml
    },
    {
      entry: 'fabric.mod.json',
      parser: metadataFromFabricModJson
    },
    {
      entry: 'quilt.mod.json',
      parser: metadataFromQuiltModJson
    }
  ];

  const defaultCandidates = [
    {
      entry: 'fabric.mod.json',
      parser: metadataFromFabricModJson
    },
    {
      entry: 'quilt.mod.json',
      parser: metadataFromQuiltModJson
    },
    {
      entry: 'META-INF/mods.toml',
      parser: metadataFromModsToml
    },
    {
      entry: 'META-INF/neoforge.mods.toml',
      parser: metadataFromModsToml
    }
  ];

  const candidates = String(options.loader || '').toLowerCase() === 'forge'
    ? forgeCandidates
    : defaultCandidates;

  for (const candidate of candidates) {
    try {
      const text = await readZipEntryText(
        jarPath,
        candidate.entry
      );

      if (text) {
        const metadata = await candidate.parser(text);

        if (metadata?.name || metadata?.modId) {
          metadata.metadataSource = candidate.entry;

          return metadata;
        }
      }
    } catch {
      // Entrada ausente o corrupta: siguiente candidato.
    }
  }

  return null;
}

module.exports = {
  readJarModMetadata,
  readZipCentralDirectory,
  readZipEntryBuffer,
  readZipEntryText
};
