
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { extractArchive } = require('./extract-archive.cjs');

const execFileAsync = promisify(execFile);

const INSTANCES_FILE = 'eryon-instances.json';

const FABRIC_META = 'https://meta.fabricmc.net/v2';

const FORGE_MAVEN_METADATA =
  'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';

const FORGE_PROMOTIONS =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const CATALOG_CACHE_TTL = 5 * 60 * 1000;

// Los CDNs (cdn.modrinth, forgecdn...) cortan conexiones de
// forma esporádica con el error 'terminated' de undici. Cada
// URL de descarga se reintenta antes de probar la siguiente.
const DOWNLOAD_ATTEMPTS_PER_URL = 3;
const RETRY_BASE_DELAY_MS = 900;

function waitRetry(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'gitlab.com',
  'maven.minecraftforge.net',
  'libraries.minecraft.net'
]);

const loaderCatalogCache = new Map();

function createModpackManager(dependencies) {
  const {
    app,
    dialog,
    getReleaseVersions,
    readSettings,
    ensureCompatibleJava,
    sendLaunchEvent,
    isMinecraftRunning
  } = dependencies;

  if (
    !app ||
    !dialog ||
    !getReleaseVersions ||
    !readSettings ||
    !ensureCompatibleJava
  ) {
    throw new Error(
      'Faltan dependencias para inicializar el gestor de instancias.'
    );
  }

  const userData = () => app.getPath('userData');

  const instancesRoot = () =>
    path.join(userData(), 'eryon-instances');

  const storePath = () =>
    path.join(userData(), INSTANCES_FILE);

  // ====================================================
  // ESTADO Y MENSAJES
  // ====================================================

  function emitStatus(message) {
    if (typeof sendLaunchEvent === 'function') {
      sendLaunchEvent({
        type: 'status',
        message
      });
    }
  }

  function reportPackProgress(options, message, progress) {
    if (typeof options?.onProgress !== 'function') return;

    options.onProgress({
      message,
      progress:
        progress === null
          ? null
          : Math.max(0, Math.min(100, Number(progress) || 0))
    });
  }

  function errorMessage(error) {
    return error instanceof Error
      ? error.message
      : String(error ?? 'Error desconocido.');
  }

  // ====================================================
  // VALIDACIÓN
  // ====================================================

  function validateInstanceName(value) {
    const name = String(value ?? '').trim();

    if (
      name.length < 2 ||
      name.length > 48 ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ) {
      throw new Error(
        'El nombre debe tener entre 2 y 48 caracteres y no puede contener caracteres reservados de Windows.'
      );
    }

    return name;
  }

  function validateMinecraftVersion(value) {
    const version = String(value ?? '').trim();

    if (!/^[A-Za-z0-9._-]{1,40}$/.test(version)) {
      throw new Error(
        'La versión de Minecraft seleccionada no es válida.'
      );
    }

    return version;
  }

  function validateLoader(value) {
    const loader = String(value ?? 'vanilla')
      .trim()
      .toLowerCase();

    if (!['vanilla', 'forge', 'fabric'].includes(loader)) {
      throw new Error(
        'Selecciona Vanilla, Forge o Fabric.'
      );
    }

    return loader;
  }

  function validateLoaderVersion(value) {
    const version = String(value ?? '').trim();

    if (
      !version ||
      !/^[A-Za-z0-9.+_-]{1,80}$/.test(version)
    ) {
      throw new Error(
        'La versión del cargador no es válida.'
      );
    }

    return version;
  }

  function slugify(value) {
    return String(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 38) || 'instancia';
  }

  // ====================================================
  // ALMACENAMIENTO
  // ====================================================

  function emptyStore() {
    return {
      instances: []
    };
  }

  async function readStore() {
    try {
      const raw = await fs.readFile(
        storePath(),
        'utf8'
      );

      const parsed = JSON.parse(raw);

      if (
        !parsed ||
        !Array.isArray(parsed.instances)
      ) {
        return emptyStore();
      }

      const instances = parsed.instances.filter(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.minecraftVersion === 'string' &&
          typeof item.loader === 'string' &&
          typeof item.gameDirectory === 'string' &&
          typeof item.launchVersionId === 'string'
      );

      return { instances };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return emptyStore();
      }

      console.error(
        '[ERYON] No se pudo leer el registro de instalaciones:',
        errorMessage(error)
      );

      throw new Error(
        'No se pudo leer el registro de instalaciones. Comprueba eryon-instances.json antes de continuar.'
      );
    }
  }

  async function writeStore(store) {
    await fs.mkdir(userData(), {
      recursive: true
    });

    const destination = storePath();
    const temporary = `${destination}.tmp`;

    await fs.writeFile(
      temporary,
      JSON.stringify(
        { instances: store.instances },
        null,
        2
      ),
      'utf8'
    );

    await fs.rename(
      temporary,
      destination
    );
  }

  function publicInstance(instance) {
    return {
      id: instance.id,
      name: instance.name,
      minecraftVersion: instance.minecraftVersion,
      loader: instance.loader,
      loaderVersion: instance.loaderVersion || null,
      launchVersionId: instance.launchVersionId,
      kind: instance.kind || 'instance',
      summary: instance.summary || '',
      iconUrl: instance.iconUrl || '',
      sourceFile: instance.sourceFile || null,
      createdAt: instance.createdAt,
      gameDirectory: instance.gameDirectory
    };
  }

  async function getInstances() {
    const store = await migrateLegacyInstanceDirectories();

    return store.instances
      .slice()
      .sort((a, b) =>
        String(b.createdAt).localeCompare(
          String(a.createdAt)
        )
      )
      .map(publicInstance);
  }

  async function getInstance(instanceId) {
    if (
      typeof instanceId !== 'string' ||
      !instanceId.trim()
    ) {
      throw new Error(
        'Selecciona una instalación válida.'
      );
    }

    const store = await migrateLegacyInstanceDirectories();

    const instance = store.instances.find(
      (item) => item.id === instanceId
    );

    if (!instance) {
      throw new Error(
        'No se encontró la instalación seleccionada.'
      );
    }

    return publicInstance(instance);
  }

  function validateInstanceIcon(value) {
    const iconUrl = String(value ?? '').trim();

    if (!iconUrl) return '';

    if (
      iconUrl.length > 1_500_000 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(iconUrl)
    ) {
      try {
        const url = new URL(iconUrl);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          return url.href;
        }
      } catch {
        // Se informa un único error para logos locales y URLs inválidas.
      }

      throw new Error(
        'El logo debe ser una imagen PNG, JPG o WebP válida, de hasta 1 MB.'
      );
    }

    return iconUrl;
  }

  async function setInstanceIcon(instanceId, iconInput) {
    if (typeof instanceId !== 'string' || !instanceId.trim()) {
      throw new Error('Selecciona una instalación válida.');
    }

    const iconUrl = validateInstanceIcon(iconInput);
    const store = await readStore();
    const index = store.instances.findIndex(
      (item) => item.id === instanceId
    );

    if (index < 0) {
      throw new Error('No se encontró la instalación seleccionada.');
    }

    const updated = {
      ...store.instances[index],
      iconUrl
    };

    store.instances[index] = updated;
    await writeStore(store);

    return publicInstance(updated);
  }

  
  // ====================================================
  // RENOMBRAR UNA INSTANCIA
  // ====================================================

  async function renameInstance(instanceId, requestedName) {
    if (
      typeof instanceId !== 'string' ||
      !instanceId.trim()
    ) {
      throw new Error('Selecciona una instalación válida.');
    }

    const name = validateInstanceName(requestedName);
    const store = await readStore();

    const index = store.instances.findIndex(
      (item) => item.id === instanceId
    );

    if (index < 0) {
      throw new Error('No se encontró la instalación que quieres renombrar.');
    }

    const current = store.instances[index];

    const duplicate = store.instances.some(
      (item) =>
        item.id !== instanceId &&
        item.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (duplicate) {
      throw new Error('Ya existe una instalación con ese nombre.');
    }

    // La carpeta de la instancia siempre debe estar dentro
    // de eryon-instances. Nunca se renombra otra ruta.
    const instancesBase = path.resolve(instancesRoot());

    const currentDirectory = path.resolve(
      current.gameDirectory
    );

    const relative = path.relative(
      instancesBase,
      currentDirectory
    );

    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        'Se bloqueó el renombrado porque la carpeta de esta instalación no pertenece a las instancias de ERYON.'
      );
    }

    let newDirectory = currentDirectory;

    // Minecraft puede estar usando archivos de la carpeta.
    // Se bloquea siempre que haya un juego abierto o en curso.
    if (
      typeof isMinecraftRunning === 'function' &&
      isMinecraftRunning()
    ) {
      throw new Error(
        'Cierra Minecraft antes de renombrar esta instalación.'
      );
    }

    // Si la carpeta no existe en disco, solo se actualiza el registro.
    if (await directoryExists(currentDirectory)) {
      const target = path.join(
        instancesBase,
        name
      );

      const sameTarget =
        target.toLowerCase() ===
        currentDirectory.toLowerCase();

      if (!sameTarget) {
        if (await directoryExists(target)) {
          throw new Error(
            `No se pudo renombrar: ya existe una carpeta llamada "${name}".`
          );
        }

        try {
          await fs.rename(currentDirectory, target);
        } catch (error) {
          if (
            error.code === 'EBUSY' ||
            error.code === 'EPERM' ||
            error.code === 'ETXTBSY' ||
            error.code === 'EACCES'
          ) {
            throw new Error(
              'No se pudo renombrar la carpeta porque otro programa la está usando. Cierra Minecraft e inténtalo de nuevo.'
            );
          }

          throw error;
        }

        newDirectory = target;
      }
    }

    const updated = {
      ...current,
      name,
      gameDirectory: newDirectory
    };

    try {
      store.instances[index] = updated;

      await writeStore(store);
    } catch (error) {
      // Si el registro no se pudo guardar, la carpeta
      // recupera su nombre original.
      if (newDirectory !== currentDirectory) {
        await fs.rename(newDirectory, currentDirectory)
          .catch(() => {});
      }

      throw error;
    }

    emitStatus(`Instalación renombrada a ${name}.`);

    return publicInstance(updated);
  }

  async function directoryExists(target) {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }


  async function saveInstance(instance) {
    const store = await readStore();

    const index = store.instances.findIndex(
      (item) => item.id === instance.id
    );

    const duplicateName = store.instances.some(
      (item) =>
        item.id !== instance.id &&
        item.name.toLocaleLowerCase() ===
          instance.name.toLocaleLowerCase()
    );

    if (duplicateName) {
      throw new Error(
        'Ya existe una instancia con ese nombre. Elige otro nombre para que cada carpeta sea única.'
      );
    }

    if (index >= 0) {
      store.instances[index] = instance;
    } else {
      store.instances.push(instance);
    }

    await writeStore(store);

    return publicInstance(instance);
  }

  // ====================================================
  // PROTECCIÓN DE RUTAS
  // ====================================================

  function safeResolve(root, relativePath) {
    if (
      typeof relativePath !== 'string' ||
      !relativePath.trim() ||
      relativePath.includes('\0')
    ) {
      throw new Error(
        'El paquete contiene una ruta de archivo no válida.'
      );
    }

    const normalized = relativePath.replace(/\\/g, '/');

    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some(
        (part) => part === '..'
      )
    ) {
      throw new Error(
        `Ruta no permitida dentro del paquete: ${relativePath}`
      );
    }

    const rootResolved = path.resolve(root);

    const destination = path.resolve(
      rootResolved,
      ...normalized.split('/')
    );

    if (
      destination !== rootResolved &&
      !destination.startsWith(rootResolved + path.sep)
    ) {
      throw new Error(
        `Ruta fuera de la instancia: ${relativePath}`
      );
    }

    return destination;
  }

  function isAllowedDownloadHost(hostname) {
    return (
      ALLOWED_DOWNLOAD_HOSTS.has(hostname) ||
      hostname.endsWith('.modrinth.com') ||
      hostname.endsWith('.github.com') ||
      hostname.endsWith('.gitlab.com') ||
      hostname.endsWith('.minecraftforge.net')
    );
  }

  // ====================================================
  // DESCARGAS
  // ====================================================

  async function fetchText(urlString, label) {
    const url = new URL(urlString);

    if (url.protocol !== 'https:') {
      throw new Error(
        `${label}: solo se permiten conexiones HTTPS.`
      );
    }

    const response = await fetch(url.href, {
      headers: {
        'User-Agent': 'ERYON-Launcher/1.0'
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(
        `${label}: error HTTP ${response.status}.`
      );
    }

    return response.text();
  }

  async function fetchJson(urlString, label) {
    const text = await fetchText(
      urlString,
      label
    );

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `${label}: el servidor devolvió JSON no válido.`
      );
    }
  }

  async function readResponseBuffer(response, onProgress) {
    const chunks = [];
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastProgressAt = 0;

    if (response.body?.getReader) {
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(Buffer.from(value));
        received += value.byteLength;
        const now = Date.now();

        if (
          typeof onProgress === 'function' &&
          (now - lastProgressAt >= 150 ||
            (total > 0 && received >= total))
        ) {
          onProgress({
            received,
            total,
            percent: total > 0
              ? Math.min(100, (received / total) * 100)
              : null
          });
          lastProgressAt = now;
        }
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      chunks.push(buffer);
      received = buffer.length;
    }

    if (typeof onProgress === 'function') {
      onProgress({ received, total, percent: 100 });
    }

    return Buffer.concat(chunks);
  }

  async function fetchBuffer(urlString, label, onProgress) {
    const url = new URL(urlString);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    ) {
      throw new Error(
        `${label}: la URL de descarga no es válida.`
      );
    }

    if (!isAllowedDownloadHost(url.hostname)) {
      throw new Error(
        `${label}: el dominio de descarga no está permitido.`
      );
    }

    const response = await fetch(url.href, {
      headers: {
        'User-Agent': 'ERYON-Launcher/1.0'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
      throw new Error(
        `${label}: descarga fallida (HTTP ${response.status}).`
      );
    }

    const finalUrl = new URL(
      response.url || url.href
    );

    if (
      finalUrl.protocol !== 'https:' ||
      !isAllowedDownloadHost(finalUrl.hostname)
    ) {
      throw new Error(
        `${label}: la redirección apunta a un dominio no permitido.`
      );
    }

    const buffer = await readResponseBuffer(response, onProgress);

    if (!buffer.length) {
      throw new Error(
        `${label}: el archivo descargado está vacío.`
      );
    }

    return buffer;
  }

  function validateModrinthDownloadUrl(value) {
    let url;

    try {
      url = new URL(value);
    } catch {
      throw new Error(
        'El modpack contiene una URL de descarga no válida.'
      );
    }

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !isAllowedDownloadHost(url.hostname)
    ) {
      throw new Error(
        'El modpack contiene una URL de descarga no permitida.'
      );
    }

    return url.href;
  }

  // ====================================================
  // ORDENAR VERSIONES
  // ====================================================

  function compareVersionStrings(a, b) {
    const aParts = String(a)
      .split(/[.+-]/)
      .map((part) =>
        /^\d+$/.test(part) ? Number(part) : part
      );

    const bParts = String(b)
      .split(/[.+-]/)
      .map((part) =>
        /^\d+$/.test(part) ? Number(part) : part
      );

    const length = Math.max(
      aParts.length,
      bParts.length
    );

    for (let i = 0; i < length; i += 1) {
      const left = aParts[i] ?? 0;
      const right = bParts[i] ?? 0;

      if (left === right) continue;

      if (
        typeof left === 'number' &&
        typeof right === 'number'
      ) {
        return left - right;
      }

      return String(left).localeCompare(
        String(right),
        undefined,
        { numeric: true }
      );
    }

    return 0;
  }

  function orderLoaderVersions(versions) {
    return versions.sort((a, b) => {
      if (a.recommended !== b.recommended) {
        return a.recommended ? -1 : 1;
      }

      if (a.latest !== b.latest) {
        return a.latest ? -1 : 1;
      }

      if (a.stable !== b.stable) {
        return a.stable ? -1 : 1;
      }

      return compareVersionStrings(
        b.version,
        a.version
      );
    });
  }

  function normalizeForgeLoaderVersion(minecraftVersion, version) {
    let normalized = String(version ?? '').trim();
    const fullPrefix = `${minecraftVersion}-`;

    // El catálogo, los perfiles y la configuración antigua pueden guardar
    // la versión corta o el prefijo de Minecraft. El coordenado Maven solo
    // debe contener la versión de Minecraft una vez.
    if (normalized.startsWith(fullPrefix)) {
      normalized = normalized.slice(fullPrefix.length);
    }

    if (normalized.startsWith(`${minecraftVersion}-forge`)) {
      normalized = normalized.slice(
        `${minecraftVersion}-forge`.length
      );
      if (normalized.startsWith('-')) {
        normalized = normalized.slice(1);
      }
    }

    return normalized;
  }

  function cacheCatalog(key, versions) {
    loaderCatalogCache.set(key, {
      timestamp: Date.now(),
      versions
    });

    return versions;
  }

  function readCatalogCache(key) {
    const entry = loaderCatalogCache.get(key);

    if (
      !entry ||
      Date.now() - entry.timestamp >= CATALOG_CACHE_TTL
    ) {
      loaderCatalogCache.delete(key);
      return null;
    }

    return entry.versions;
  }

  // ====================================================
  // CATÁLOGO DE FABRIC
  // ====================================================

  async function getFabricVersions(minecraftVersion) {
    const url =
      `${FABRIC_META}/versions/loader/` +
      `${encodeURIComponent(minecraftVersion)}`;

    const data = await fetchJson(
      url,
      'No se pudo consultar el catálogo de Fabric'
    );

    if (!Array.isArray(data)) {
      throw new Error(
        'Fabric devolvió un catálogo con formato inesperado.'
      );
    }

    const unique = new Map();

    for (const item of data) {
      const version = item?.loader?.version;

      if (
        typeof version !== 'string' ||
        !/^[A-Za-z0-9.+_-]{1,80}$/.test(version)
      ) {
        continue;
      }

      unique.set(version, {
        version,
        stable: item.loader.stable === true,
        recommended: false,
        latest: false
      });
    }

    const versions = orderLoaderVersions([
      ...unique.values()
    ]);

    const latestStable = versions.find(
      (item) => item.stable
    );

    const latest = latestStable || versions[0];

    if (latest) {
      latest.latest = true;
    }

    if (versions.length === 0) {
      throw new Error(
        `No hay versiones de Fabric disponibles para Minecraft ${minecraftVersion}.`
      );
    }

    return versions;
  }

  // ====================================================
  // CATÁLOGO DE FORGE
  // ====================================================

  async function getForgeVersions(minecraftVersion) {
    const xml = await fetchText(
      FORGE_MAVEN_METADATA,
      'No se pudo consultar el catálogo de Forge'
    );

    let promotions = {};

    try {
      const data = await fetchJson(
        FORGE_PROMOTIONS,
        'No se pudieron consultar las promociones de Forge'
      );

      promotions = data?.promos ?? {};
    } catch (error) {
      console.warn(
        '[ERYON] No se pudo consultar la versión recomendada de Forge:',
        errorMessage(error)
      );
    }

    const prefix = `${minecraftVersion}-`;

    const matches = [
      ...xml.matchAll(
        /<version>\s*([^<]+)\s*<\/version>/g
      )
    ];

    const unique = new Set();

    for (const match of matches) {
      const fullVersion = match[1].trim();

      if (!fullVersion.startsWith(prefix)) {
        continue;
      }

      const loaderVersion = fullVersion.slice(
        prefix.length
      );

      if (
        loaderVersion &&
        /^[A-Za-z0-9.+_-]{1,80}$/.test(loaderVersion)
      ) {
        unique.add(loaderVersion);
      }
    }

    if (unique.size === 0) {
      throw new Error(
        `No hay versiones de Forge disponibles para Minecraft ${minecraftVersion}.`
      );
    }

    const recommended =
      promotions[`${minecraftVersion}-recommended`] ?? null;

    const latest =
      promotions[`${minecraftVersion}-latest`] ?? null;

    const versions = [...unique].map((version) => ({
      version,
      stable: true,
      recommended: version === recommended,
      latest: version === latest
    }));

    // La versión recomendada tiene prioridad.
    // Si no existe recomendada, se utiliza latest o la más reciente.
    orderLoaderVersions(versions);

    if (!versions.some((item) => item.latest)) {
      const latestFallback = versions.find(
        (item) => !item.recommended
      ) || versions[0];

      if (latestFallback) {
        latestFallback.latest = true;
      }
    }

    return versions;
  }

  // ====================================================
  // CATÁLOGO PÚBLICO DE CARGADORES
  // ====================================================

  async function getLoaderVersions(
    minecraftVersionInput,
    loaderInput
  ) {
    const minecraftVersion =
      validateMinecraftVersion(minecraftVersionInput);

    const loader = validateLoader(loaderInput);

    if (loader === 'vanilla') {
      return [];
    }

    const cacheKey = `${loader}:${minecraftVersion}`;

    const cached = readCatalogCache(cacheKey);

    if (cached) {
      return cached.map((item) => ({ ...item }));
    }

    let versions;

    if (loader === 'fabric') {
      versions = await getFabricVersions(
        minecraftVersion
      );
    } else {
      versions = await getForgeVersions(
        minecraftVersion
      );
    }

    const cachedVersions = cacheCatalog(
      cacheKey,
      versions
    );

    return cachedVersions.map(
      (item) => ({ ...item })
    );
  }

  async function resolveLoaderVersion(
    minecraftVersion,
    loader,
    requestedVersion
  ) {
    if (loader === 'vanilla') {
      return null;
    }

    const versions = await getLoaderVersions(
      minecraftVersion,
      loader
    );

    if (requestedVersion) {
      let requested = validateLoaderVersion(
        requestedVersion
      );

      // Algunos metadatos de paquetes incluyen Minecraft delante
      // de la versión Forge, por ejemplo 1.20.1-47.4.28.
      const prefix = `${minecraftVersion}-`;

      if (
        loader === 'forge' &&
        requested.startsWith(prefix)
      ) {
        requested = requested.slice(prefix.length);
      }

      const exact = versions.find(
        (item) => item.version === requested
      );

      if (!exact) {
        throw new Error(
          `La versión ${requested} de ${loader} no aparece en el catálogo para Minecraft ${minecraftVersion}.`
        );
      }

      return exact.version;
    }

    const defaultVersion =
      versions.find((item) => item.recommended) ||
      versions.find(
        (item) => item.latest && item.stable
      ) ||
      versions.find((item) => item.stable) ||
      versions.find((item) => item.latest) ||
      versions[0];

    if (!defaultVersion) {
      throw new Error(
        `No se encontró una versión predeterminada de ${loader} para Minecraft ${minecraftVersion}.`
      );
    }

    return defaultVersion.version;
  }

  // ====================================================
  // VERSIONES OFICIALES DE MINECRAFT
  // ====================================================

  async function getOfficialVersionInfo(
    minecraftVersion
  ) {
    const catalog = await getReleaseVersions();

    const info = (catalog.versions || []).find(
      (item) => item.id === minecraftVersion
    );

    if (!info) {
      throw new Error(
        `Minecraft ${minecraftVersion} no aparece como versión estable en el catálogo oficial.`
      );
    }

    return info;
  }

  // ====================================================
  // CARPETAS DE INSTANCIAS
  // ====================================================

  async function prepareInstanceDirectory(name) {
    // La carpeta contenedora se crea al guardar el registro, pero
    // una instalación nueva puede no tener registro todavía.
    await fs.mkdir(instancesRoot(), {
      recursive: true
    });

    const directory = path.join(
      instancesRoot(),
      instanceDirectoryName(name)
    );

    if (await directoryExists(directory)) {
      throw new Error(
        `Ya existe una carpeta para la instancia "${name}". Elige otro nombre o revisa la carpeta de instalaciones.`
      );
    }

    await fs.mkdir(directory, {
      recursive: false
    });

    return directory;
  }

  function instanceDirectoryName(name) {
    return String(name).replace(/[. ]+$/g, '');
  }

  async function migrateLegacyInstanceDirectories() {
    const store = await readStore();
    const instancesBase = path.resolve(instancesRoot());

    for (const instance of store.instances) {
      const currentDirectory = path.resolve(instance.gameDirectory);
      const relative = path.relative(instancesBase, currentDirectory);
      const legacyFolder =
        `${slugify(instance.name)}-${instance.id.slice(0, 8)}`;

      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative)
      ) {
        continue;
      }

      const directoryName = instanceDirectoryName(instance.name);

      if (!directoryName) {
        continue;
      }

      const target = path.join(instancesBase, directoryName);
      const currentExists = await directoryExists(currentDirectory);
      let targetExists = await directoryExists(target);
      const currentIsLegacy =
        path.basename(currentDirectory) === legacyFolder;

      if (
        currentExists &&
        (!currentIsLegacy ||
          currentDirectory.toLowerCase() === target.toLowerCase())
      ) {
        continue;
      }

      if (!currentExists && !targetExists) {
        continue;
      }

      let moved = false;

      if (currentExists && targetExists) {
        throw new Error(
          `No se pudo actualizar la carpeta de "${instance.name}" porque ya existe una carpeta con ese nombre.`
        );
      }

      if (currentExists) {
        try {
          await fs.rename(currentDirectory, target);
          moved = true;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }

          targetExists = await directoryExists(target);
          if (!targetExists) {
            continue;
          }
        }
      }

      const previousDirectory = instance.gameDirectory;
      instance.gameDirectory = target;

      try {
        await writeStore(store);
      } catch (error) {
        instance.gameDirectory = previousDirectory;
        if (moved) {
          await fs.rename(target, currentDirectory).catch(() => {});
        }
        throw error;
      }
    }

    return store;
  }

  // ====================================================
  // INSTALAR FABRIC
  // ====================================================

  async function installFabricLoader({
    minecraftVersion,
    gameDirectory,
    requestedLoaderVersion,
    settings
  }) {
    const loaderVersion = await resolveLoaderVersion(
      minecraftVersion,
      'fabric',
      requestedLoaderVersion
    );

    const profileUrl =
      `${FABRIC_META}/versions/loader/` +
      `${encodeURIComponent(minecraftVersion)}/` +
      `${encodeURIComponent(loaderVersion)}/profile/json`;

    emitStatus(
      `Instalando Fabric ${loaderVersion} para Minecraft ${minecraftVersion}...`
    );

    const profile = await fetchJson(
      profileUrl,
      'No se pudo descargar el perfil de Fabric'
    );

    if (
      !profile ||
      typeof profile.id !== 'string' ||
      !profile.id ||
      profile.inheritsFrom !== minecraftVersion
    ) {
      throw new Error(
        'Fabric devolvió un perfil de instalación no válido.'
      );
    }

    const versionDirectory = path.join(
      gameDirectory,
      'versions',
      profile.id
    );

    await fs.mkdir(versionDirectory, {
      recursive: true
    });

    await fs.writeFile(
      path.join(
        versionDirectory,
        `${profile.id}.json`
      ),
      JSON.stringify(profile, null, 2),
      'utf8'
    );

    const baseVersionInfo =
      await getOfficialVersionInfo(minecraftVersion);

    await ensureCompatibleJava(
      baseVersionInfo,
      settings
    );

    return {
      loader: 'fabric',
      loaderVersion,
      launchVersionId: profile.id
    };
  }

  async function ensureEryonIdentity1201Fabric({
    minecraftVersion,
    gameDirectory,
    settings
  }) {
    if (minecraftVersion !== "1.20.1") {
      throw new Error(
        "ERYON Identity está disponible para esta ruta en Minecraft 1.20.1."
      );
    }

    return installFabricLoader({
      minecraftVersion,
      gameDirectory,
      requestedLoaderVersion: null,
      settings
    });
  }

  async function ensureEryonIdentityFabric({
    minecraftVersion,
    gameDirectory,
    settings,
    requestedLoaderVersion = null
  }) {
    // El binario compilado de 1.21.1 usa APIs estables en toda la
    // línea 1.21 (los nombres intermediario no cambian entre
    // parches), así que 1.21 y 1.21.1 comparten archivo.
    const identityReady = /^(1\.21|1\.21\.1)$/.test(
      String(minecraftVersion ?? "")
    );

    if (!identityReady) {
      throw new Error(
        "ERYON Identity está disponible actualmente para Minecraft 1.21.1."
      );
    }

    return installFabricLoader({
      minecraftVersion,
      gameDirectory,
      requestedLoaderVersion,
      settings
    });
  }

  // Fabric loader para CUALQUIER versión (sin identity): es la
  // pieza que permite llevar mods de optimización estilo Lunar
  // a instancias vanilla de cualquier versión.
  async function ensureFabricForVersion({
    minecraftVersion,
    gameDirectory,
    settings
  }) {
    return installFabricLoader({
      minecraftVersion,
      gameDirectory,
      requestedLoaderVersion: null,
      settings
    });
  }

  // Forge para CUALQUIER versión: es el cargador que permite
  // llevar el identificador Eryon y OptiFine a lanzamientos
  // legacy (1.8.x etc.) donde Fabric no existe.
  async function ensureForgeForVersion({
    minecraftVersion,
    gameDirectory,
    settings,
    installerBridgeJar
  }) {
    const installed = await findInstalledForgeProfile(
      minecraftVersion,
      gameDirectory
    );
    if (installed) {
      await ensureForgeRuntimeLibrary(
        minecraftVersion,
        installed.loaderVersion
      );
      emitStatus(
        `Forge ${installed.loaderVersion} ya está instalado para Minecraft ${minecraftVersion}.`
      );
      return installed;
    }

    return installForgeLoader({
      minecraftVersion,
      gameDirectory,
      requestedLoaderVersion: null,
      settings,
      installerBridgeJar
    });
  }

  async function ensureForgeRuntimeLibrary(
    minecraftVersion,
    forgeVersion
  ) {
    forgeVersion = normalizeForgeLoaderVersion(
      minecraftVersion,
      forgeVersion
    );
    const coordinateVersion = `${minecraftVersion}-${forgeVersion}`;
    const libraryDirectory = path.join(
      userData(),
      "eryon-minecraft-shared",
      "libraries",
      "net",
      "minecraftforge",
      "forge",
      coordinateVersion
    );
    const expectedJar = path.join(
      libraryDirectory,
      `forge-${coordinateVersion}.jar`
    );

    if (await isValidJarFile(expectedJar, 100_000)) {
      await ensureLegacyLaunchwrapperLibrary();
      await ensureLegacyAsmLibrary();
      return;
    }

    emitStatus(`Preparando el runtime de Forge ${forgeVersion}...`);
    const universalUrl =
      `https://maven.minecraftforge.net/net/minecraftforge/forge/` +
      `${encodeURIComponent(coordinateVersion)}/` +
      `forge-${encodeURIComponent(coordinateVersion)}-universal.jar`;
    const buffer = await fetchBuffer(
      universalUrl,
      "runtime de Forge"
    );

    await fs.mkdir(libraryDirectory, { recursive: true });
    const temporary = `${expectedJar}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, buffer, { flag: "wx" });
    // Forge's legacy installer may have left a small Maven 404 page at this
    // path. Remove that invalid artifact before replacing it with the real
    // universal jar so MCLC cannot keep reusing the corrupted file.
    await fs.rm(expectedJar, { force: true });
    await fs.rename(temporary, expectedJar);

    await ensureLegacyLaunchwrapperLibrary();
    await ensureLegacyAsmLibrary();
  }

  async function ensureLegacyAsmLibrary() {
    const libraryDirectory = path.join(
      userData(),
      "eryon-minecraft-shared",
      "libraries",
      "org",
      "ow2",
      "asm",
      "asm-all",
      "5.0.3"
    );
    const destination = path.join(
      libraryDirectory,
      "asm-all-5.0.3.jar"
    );
    if (await isValidJarFile(destination, 10_000)) {
      return;
    }

    emitStatus("Preparando ASM de Forge 1.8.9...");
    const buffer = await fetchBuffer(
      "https://maven.minecraftforge.net/org/ow2/asm/asm-all/5.0.3/asm-all-5.0.3.jar",
      "ASM de Forge 1.8.9"
    );

    await fs.mkdir(libraryDirectory, { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, buffer, { flag: "wx" });
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
  }

  async function ensureLegacyLaunchwrapperLibrary() {
    const libraryDirectory = path.join(
      userData(),
      "eryon-minecraft-shared",
      "libraries",
      "net",
      "minecraft",
      "launchwrapper",
      "1.12"
    );
    const destination = path.join(
      libraryDirectory,
      "launchwrapper-1.12.jar"
    );
    if (await isValidJarFile(destination, 10_000)) {
      return;
    }

    emitStatus("Preparando la dependencia LaunchWrapper de Forge 1.8.9...");
    const buffer = await fetchBuffer(
      "https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar",
      "LaunchWrapper de Forge"
    );

    await fs.mkdir(libraryDirectory, { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, buffer, { flag: "wx" });
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
  }

  async function ensureLegacyForgeLaunchLibraries({
    gameDirectory,
    launchVersionId,
    identityModPath
  }) {
    const profilePath = path.join(
      gameDirectory,
      "versions",
      launchVersionId,
      `${launchVersionId}.json`
    );
    const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
    if (profile.inheritsFrom !== "1.8.9") {
      throw new Error(
        `El perfil ${launchVersionId} no corresponde a Forge 1.8.9.`
      );
    }

    const libraries = Array.isArray(profile.libraries)
      ? profile.libraries
      : [];
    const sharedLibraries = path.join(
      userData(),
      "eryon-minecraft-shared",
      "libraries"
    );

    // MCLC no pone LZMA en classpath porque la distribución de Forge 1.8.9
    // lo etiqueta como dependencia de servidor. Lo declaramos explícitamente
    // para cliente y lo descargamos antes de pedirle a MCLC el classpath.
    const lzmaPath = path.join(
      sharedLibraries,
      "lzma",
      "lzma",
      "0.0.1",
      "lzma-0.0.1.jar"
    );
    if (!await isValidJarFile(lzmaPath, 1_000)) {
      emitStatus("Preparando LZMA requerido por Forge 1.8.9...");
      const buffer = await fetchBuffer(
        "https://libraries.minecraft.net/lzma/lzma/0.0.1/lzma-0.0.1.jar",
        "LZMA de Forge 1.8.9"
      );
      await fs.mkdir(path.dirname(lzmaPath), { recursive: true });
      const temporary = `${lzmaPath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, buffer, { flag: "wx" });
      await fs.rm(lzmaPath, { force: true });
      await fs.rename(temporary, lzmaPath);
    }

    const identityModBuffer = await fs.readFile(identityModPath);
    const identityModVersion =
      `1.0.0-${crypto.createHash("sha256")
        .update(identityModBuffer)
        .digest("hex")
        .slice(0, 16)}`;
    const eryonLibraryCoordinate =
      `app.eryon:eryon-identity-forge-1.8.9:${identityModVersion}`;
    const eryonLibraryPath = path.join(
      sharedLibraries,
      "app",
      "eryon",
      "eryon-identity-forge-1.8.9",
      identityModVersion,
      `eryon-identity-forge-1.8.9-${identityModVersion}.jar`
    );
    if (
      identityModBuffer.length < 100_000 ||
      identityModBuffer[0] !== 0x50 ||
      identityModBuffer[1] !== 0x4b
    ) {
      throw new Error(
        "No se encontró el mod Eryon Forge válido para preparar el classpath."
      );
    }

    await fs.mkdir(path.dirname(eryonLibraryPath), { recursive: true });
    const existingMod = await fs.readFile(eryonLibraryPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!existingMod?.equals(identityModBuffer)) {
      const temporaryMod = `${eryonLibraryPath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryMod, identityModBuffer, { flag: "wx" });
      try {
        // The shared library can be open in another Minecraft process. Use a
        // content-addressed path and publish without replacing an existing JAR.
        await fs.link(temporaryMod, eryonLibraryPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const concurrentMod = await fs.readFile(eryonLibraryPath).catch(() => null);
        if (!concurrentMod?.equals(identityModBuffer)) throw error;
      } finally {
        await fs.rm(temporaryMod, { force: true });
      }
    }

    const addLibraryIfMissing = (name, library) => {
      const current = libraries.find((item) => item?.name === name);
      if (current) Object.assign(current, library);
      else libraries.push({ name, ...library });
    };

    addLibraryIfMissing("lzma:lzma:0.0.1", {
      url: "https://libraries.minecraft.net/"
    });
    for (let index = libraries.length - 1; index >= 0; index -= 1) {
      if (libraries[index]?.name?.startsWith(
        "app.eryon:eryon-identity-forge-1.8.9:"
      )) {
        libraries.splice(index, 1);
      }
    }
    addLibraryIfMissing(eryonLibraryCoordinate, {});

    // MCLC arma el classpath a partir del JSON incluso si un JAR nunca llego
    // al disco. Forge 1.8.9 puede entonces fallar tarde con NoClassDefFoundError
    // (por ejemplo, trove4j). Verificamos y recuperamos cada artefacto cliente
    // Maven del perfil antes de que MCLC construya el classpath.
    for (const library of libraries) {
      if (
        !library ||
        library.clientreq === false ||
        typeof library.name !== "string"
      ) {
        continue;
      }

      const coordinate = library.name.split(":");
      if (coordinate.length < 3) continue;

      const [group, artifact, version, classifier] = coordinate;
      if (!group || !artifact || !version) continue;

      const relativePath = path.posix.join(
        group.replace(/\./g, "/"),
        artifact,
        version,
        `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`
      );
      const artifactPath = path.join(sharedLibraries, ...relativePath.split("/"));
      if (await isValidJarFile(artifactPath, 4)) continue;

      const repository =
        typeof library.url === "string" && library.url.trim()
          ? library.url
          : "https://libraries.minecraft.net/";
      const downloadUrl = new URL(
        relativePath,
        repository.endsWith("/") ? repository : `${repository}/`
      ).href;
      emitStatus(`Verificando dependencia ${artifact}:${version} de Forge...`);
      const buffer = await fetchBuffer(
        downloadUrl,
        `Dependencia ${artifact}:${version} de Forge`
      );

      if (
        buffer.length < 4 ||
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4b ||
        buffer[2] !== 0x03 ||
        buffer[3] !== 0x04
      ) {
        throw new Error(
          `La dependencia ${artifact}:${version} descargada no es un JAR válido.`
        );
      }

      const expectedSha1 = Array.isArray(library.checksums)
        ? library.checksums.find((checksum) => /^[a-f\d]{40}$/i.test(checksum))
        : null;
      if (
        expectedSha1 &&
        crypto.createHash("sha1").update(buffer).digest("hex") !==
          expectedSha1.toLowerCase()
      ) {
        throw new Error(
          `La dependencia ${artifact}:${version} no coincide con su SHA-1 publicado.`
        );
      }

      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      const temporaryArtifact = `${artifactPath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryArtifact, buffer, { flag: "wx" });
      await fs.rm(artifactPath, { force: true });
      await fs.rename(temporaryArtifact, artifactPath);
    }

    profile.libraries = libraries;

    const temporaryProfile = `${profilePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(
      temporaryProfile,
      JSON.stringify(profile, null, 2),
      { encoding: "utf8", flag: "wx" }
    );
    await fs.rename(temporaryProfile, profilePath);
  }

  async function isValidJarFile(filePath, minimumSize) {
    let handle;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size < minimumSize) return false;

      handle = await fs.open(filePath, "r");
      const signature = Buffer.alloc(4);
      const { bytesRead } = await handle.read(signature, 0, 4, 0);
      return (
        bytesRead === 4 &&
        signature[0] === 0x50 &&
        signature[1] === 0x4b &&
        signature[2] === 0x03 &&
        signature[3] === 0x04
      );
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function findInstalledForgeProfile(
    minecraftVersion,
    gameDirectory
  ) {
    const versionsDirectory = path.join(gameDirectory, "versions");
    const entries = await fs.readdir(versionsDirectory, {
      withFileTypes: true
    }).catch(() => []);

    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        !entry.name.startsWith(`${minecraftVersion}-forge-`) &&
        !entry.name.startsWith(`${minecraftVersion}-forge`)
      ) continue;

      const jsonPath = path.join(
        versionsDirectory,
        entry.name,
        `${entry.name}.json`
      );
      try {
        const profile = JSON.parse(await fs.readFile(jsonPath, "utf8"));
        if (profile.inheritsFrom !== minecraftVersion) continue;
        const forgePrefix = `${minecraftVersion}-forge`;
        let loaderVersion = entry.name
          .slice(forgePrefix.length)
          .trim();
        if (loaderVersion.startsWith("-")) {
          loaderVersion = loaderVersion.slice(1);
        }
        candidates.push({
          loader: "forge",
          loaderVersion: loaderVersion || entry.name,
          launchVersionId: entry.name
        });
      } catch {
        // Ignorar perfiles incompletos y continuar buscando otro válido.
      }
    }

    candidates.sort((left, right) =>
      compareVersionStrings(left.loaderVersion, right.loaderVersion)
    );
    return candidates.at(-1) || null;
  }

  // ====================================================
  // INSTALAR FORGE
  // ====================================================


  // ====================================================
  // INSTALAR FORGE
  // ====================================================

  async function installForgeLoader({
    minecraftVersion,
    gameDirectory,
    requestedLoaderVersion,
    settings,
    installerBridgeJar
  }) {
    const forgeVersion = await resolveLoaderVersion(
      minecraftVersion,
      "forge",
      requestedLoaderVersion
    );

    const normalizedForgeVersion = normalizeForgeLoaderVersion(
      minecraftVersion,
      forgeVersion
    );

    const coordinateVersion =
      `${minecraftVersion}-${normalizedForgeVersion}`;

    const installerUrl =
      "https://maven.minecraftforge.net/net/minecraftforge/forge/" +
      `${encodeURIComponent(coordinateVersion)}/` +
      `forge-${encodeURIComponent(coordinateVersion)}-installer.jar`;

    emitStatus(
      `Descargando Forge ${normalizedForgeVersion} para Minecraft ${minecraftVersion}...`
    );

    const installerBuffer = await fetchBuffer(
      installerUrl,
      "Instalador de Forge"
    );

    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eryon-forge-")
    );

    const installerPath = path.join(
      temporaryRoot,
      "forge-installer.jar"
    );

    try {
      await fs.writeFile(
        installerPath,
        installerBuffer
      );

      const versionInfo =
        await getOfficialVersionInfo(minecraftVersion);

      const javaPath = await ensureCompatibleJava(
        versionInfo,
        settings
      );

      if (
        typeof javaPath !== "string" ||
        !javaPath.trim()
      ) {
        throw new Error(
          "No se encontró una ruta válida de Java para instalar Forge."
        );
      }

      // Crear la carpeta de la instalación.
      await fs.mkdir(gameDirectory, {
        recursive: true
      });

      // Forge requiere que exista launcher_profiles.json.
      // Si no existe, creamos una estructura inicial válida.
      // Nunca sobrescribimos un archivo existente.
      const launcherProfilesPath = path.join(
        gameDirectory,
        "launcher_profiles.json"
      );

      try {
        await fs.access(launcherProfilesPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }

        const initialProfiles = {
          profiles: {},
          settings: {}
        };

        try {
          await fs.writeFile(
            launcherProfilesPath,
            JSON.stringify(initialProfiles, null, 2),
            {
              encoding: "utf8",
              flag: "wx"
            }
          );
        } catch (writeError) {
          // Si otro proceso lo creó al mismo tiempo,
          // conservamos el archivo existente.
          if (writeError.code !== "EEXIST") {
            throw writeError;
          }
        }
      }

      emitStatus(
        `Instalando Forge ${normalizedForgeVersion}...`
      );

      try {
        const isLegacyForge = minecraftVersion === "1.8.9";
        const command = isLegacyForge
          ? [
              "-cp",
              `${installerPath}${path.delimiter}${installerBridgeJar}`,
              "app.eryon.identity.forge.ForgeClientInstallerBridge",
              gameDirectory
            ]
          : ["-jar", installerPath, "--installClient", gameDirectory];

        if (isLegacyForge) {
          if (!installerBridgeJar) {
            throw new Error(
              "No se encontró el puente del instalador de Forge 1.8.9 incluido en el launcher."
            );
          }
          await fs.access(installerBridgeJar);
        }

        await execFileAsync(javaPath, command, {
          cwd: gameDirectory,
          timeout: 15 * 60 * 1000,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024
        });
      } catch (error) {
        const output =
          `${error.stdout || ""}\n${error.stderr || ""}`.trim();

        throw new Error(
          `El instalador de Forge falló: ${
            output
              ? output.slice(-1600)
              : error.message || error
          }`
        );
      }

      // Localizar el perfil de Forge que se acaba de instalar.
      const versionsDirectory = path.join(
        gameDirectory,
        "versions"
      );

      const entries = await fs.readdir(
        versionsDirectory,
        { withFileTypes: true }
      ).catch(() => []);

      const candidates = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        if (
          !entry.name.startsWith(
            `${minecraftVersion}-forge-`
          ) &&
          !entry.name.startsWith(
            `${minecraftVersion}-forge`
          )
        ) {
          continue;
        }

        const jsonPath = path.join(
          versionsDirectory,
          entry.name,
          `${entry.name}.json`
        );

        try {
          const profile = JSON.parse(
            await fs.readFile(jsonPath, "utf8")
          );

          if (
            profile.inheritsFrom === minecraftVersion &&
            entry.name.includes(normalizedForgeVersion)
          ) {
            candidates.push(entry.name);
          }
        } catch {
          // Ignorar directorios sin un perfil de Forge válido.
        }
      }

      candidates.sort(compareVersionStrings);

      const launchVersionId =
        candidates.find(
          (name) =>
            name === `${minecraftVersion}-forge-${normalizedForgeVersion}`
        ) ||
        candidates.find(
          (name) => name.endsWith(`forge-${normalizedForgeVersion}`)
        ) ||
        candidates[candidates.length - 1];

      if (!launchVersionId) {
        throw new Error(
          `Forge ${forgeVersion} terminó de instalarse, pero no se encontró su perfil de lanzamiento.`
        );
      }

      const expectedJson = path.join(
        versionsDirectory,
        launchVersionId,
        `${launchVersionId}.json`
      );

      await fs.access(expectedJson);
      await ensureForgeRuntimeLibrary(
        minecraftVersion,
        normalizedForgeVersion
      );

      return {
        loader: "forge",
        loaderVersion: forgeVersion,
        launchVersionId
      };
    } finally {
      await fs.rm(
        temporaryRoot,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }


  // ====================================================
  // INSTALAR UN CARGADOR
  // ====================================================

  async function installLoader({
    loader,
    minecraftVersion,
    gameDirectory,
    loaderVersion,
    settings,
    installerBridgeJar
  }) {
    if (loader === 'vanilla') {
      await getOfficialVersionInfo(
        minecraftVersion
      );

      return {
        loader: 'vanilla',
        loaderVersion: null,
        launchVersionId: minecraftVersion
      };
    }

    if (loader === 'fabric') {
      return installFabricLoader({
        minecraftVersion,
        gameDirectory,
        requestedLoaderVersion: loaderVersion,
        settings
      });
    }

    if (loader === 'forge') {
      return installForgeLoader({
        minecraftVersion,
        gameDirectory,
        requestedLoaderVersion: loaderVersion,
        settings,
        installerBridgeJar
      });
    }

    throw new Error(
      'Cargador no compatible. Selecciona Vanilla, Forge o Fabric.'
    );
  }

  // ====================================================
  // CREAR UNA INSTANCIA
  // ====================================================

  async function installInstance(input = {}) {
    const name = validateInstanceName(input.name);

    const minecraftVersion = validateMinecraftVersion(
      input.minecraftVersion
    );

    const loader = validateLoader(
      input.loader
    );

    const loaderVersion =
      input.loaderVersion == null ||
      String(input.loaderVersion).trim() === ''
        ? null
        : String(input.loaderVersion).trim();

    const id = crypto.randomUUID();

    const gameDirectory =
      await prepareInstanceDirectory(name);

    const settings = await readSettings();

    try {
      emitStatus(
        `Preparando la instalación ${name}...`
      );

      const installed = await installLoader({
        loader,
        minecraftVersion,
        gameDirectory,
        loaderVersion,
        settings,
        installerBridgeJar: input.installerBridgeJar
      });

      const instance = {
        id,
        name,
        minecraftVersion,
        loader: installed.loader,
        loaderVersion: installed.loaderVersion,
        launchVersionId: installed.launchVersionId,
        kind: 'instance',
        createdAt: new Date().toISOString(),
        gameDirectory
      };

      await saveInstance(instance);

      emitStatus(
        `${name} está lista para jugar.`
      );

      return publicInstance(instance);
    } catch (error) {
      await fs.rm(
        gameDirectory,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});

      throw error;
    }
  }

  // ====================================================
  // CAMBIAR LA VERSIÓN DEL CARGADOR DE UNA INSTANCIA
  // ====================================================

  async function updateInstanceLoader(
    instanceId,
    requestedLoaderVersion
  ) {
    if (
      typeof instanceId !== 'string' ||
      !instanceId.trim()
    ) {
      throw new Error(
        'Selecciona una instalación válida.'
      );
    }

    const store = await readStore();

    const index = store.instances.findIndex(
      (item) => item.id === instanceId
    );

    if (index < 0) {
      throw new Error(
        'No se encontró la instalación que quieres modificar.'
      );
    }

    const current = store.instances[index];

    if (!['forge', 'fabric'].includes(current.loader)) {
      throw new Error(
        'Esta instalación no utiliza Forge ni Fabric.'
      );
    }

    const loaderVersion = await resolveLoaderVersion(
      current.minecraftVersion,
      current.loader,
      requestedLoaderVersion
    );

    if (loaderVersion === current.loaderVersion) {
      return publicInstance(current);
    }

    emitStatus(
      `Actualizando ${current.loader} de ${current.name} a la versión ${loaderVersion}...`
    );

    const settings = await readSettings();

    // Se instala la nueva versión en la misma instancia.
    // No se borran mods, configuraciones, mundos ni otros archivos.
    const installed = await installLoader({
      loader: current.loader,
      minecraftVersion: current.minecraftVersion,
      gameDirectory: current.gameDirectory,
      loaderVersion,
      settings
    });

    // Actualiza los metadatos solo después de completar la instalación.
    const updated = {
      ...current,
      loader: installed.loader,
      loaderVersion: installed.loaderVersion,
      launchVersionId: installed.launchVersionId
    };

    store.instances[index] = updated;

    await writeStore(store);

    emitStatus(
      `${current.name} ahora utiliza ${current.loader} ${installed.loaderVersion}.`
    );

    return publicInstance(updated);
  }

  async function repairInstance(instanceId) {
    const store = await readStore();
    const index = store.instances.findIndex(
      (item) => item.id === instanceId
    );
    if (index < 0) {
      throw new Error("No se encontró la instalación que quieres reparar.");
    }

    const current = store.instances[index];
    const settings = await readSettings();
    const installed = await installLoader({
      loader: current.loader,
      minecraftVersion: current.minecraftVersion,
      gameDirectory: current.gameDirectory,
      loaderVersion: current.loaderVersion,
      settings
    });
    const updated = {
      ...current,
      loader: installed.loader,
      loaderVersion: installed.loaderVersion,
      launchVersionId: installed.launchVersionId
    };
    store.instances[index] = updated;
    await writeStore(store);
    return publicInstance(updated);
  }

  // ====================================================
  // COPIAR ARCHIVOS DEL MODPACK
  // ====================================================

  async function copyDirectoryContents(
    sourceDirectory,
    destinationDirectory,
    instanceRoot
  ) {
    let entries;

    try {
      entries = await fs.readdir(
        sourceDirectory,
        { withFileTypes: true }
      );
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    await fs.mkdir(destinationDirectory, {
      recursive: true
    });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          'El paquete contiene un enlace simbólico y no se puede importar de forma segura.'
        );
      }

      const source = path.join(
        sourceDirectory,
        entry.name
      );

      const destinationRelative = path.relative(
        instanceRoot,
        path.join(destinationDirectory, entry.name)
      );

      const destination = safeResolve(
        instanceRoot,
        destinationRelative
      );

      if (entry.isDirectory()) {
        await copyDirectoryContents(
          source,
          destination,
          instanceRoot
        );
      } else if (entry.isFile()) {
        await fs.mkdir(
          path.dirname(destination),
          { recursive: true }
        );

        await fs.copyFile(
          source,
          destination
        );
      }
    }
  }

  // ====================================================
  // DESCARGAR ARCHIVOS DE UN .MRPACK
  // ====================================================

  async function downloadMrpackFiles(
    manifest,
    extractedRoot,
    gameDirectory,
    options = {}
  ) {
    const files = Array.isArray(manifest.files)
      ? manifest.files
      : [];
    const installableFiles = files.filter(
      (file) => file?.env?.client !== 'unsupported'
    );

    let completed = 0;

    for (const file of files) {
      if (
        !file ||
        typeof file.path !== 'string'
      ) {
        throw new Error(
          'El modpack contiene una entrada de archivo no válida.'
        );
      }

      if (file.env?.client === 'unsupported') {
        continue;
      }

      const destination = safeResolve(
        gameDirectory,
        file.path
      );

      const urls = Array.isArray(file.downloads)
        ? file.downloads
        : [];

      if (urls.length === 0) {
        throw new Error(
          `No hay una URL de descarga disponible para ${file.path}. El paquete puede requerir una descarga manual.`
        );
      }

      const hashes =
        file.hashes &&
        typeof file.hashes === 'object'
          ? file.hashes
          : {};

      if (!hashes.sha1 && !hashes.sha512) {
        throw new Error(
          `No se encontró un hash de verificación para ${file.path}.`
        );
      }

      let buffer = null;
      let lastError = null;

      outer: for (const candidate of urls) {
        let url = null;

        try {
          url = validateModrinthDownloadUrl(
            candidate
          );
        } catch (validationError) {
          if (!lastError) {
            lastError = validationError;
          }

          continue;
        }

        for (
          let attempt = 1;
          attempt <= DOWNLOAD_ATTEMPTS_PER_URL;
          attempt += 1
        ) {
          if (attempt > 1) {
            emitStatus(
              `Reintento ${attempt} de ${DOWNLOAD_ATTEMPTS_PER_URL} para ${path.basename(file.path)}...`
            );

            await waitRetry(
              RETRY_BASE_DELAY_MS * (attempt - 1)
            );
          }

          try {
            buffer = await fetchBuffer(
              url,
              `Archivo ${file.path}`,
              ({ percent }) => {
                const fileProgress = Number(percent) || 0;
                const overall = percent === null
                  ? null
                  : installableFiles.length
                    ? 30 + 42 * (
                        (completed + fileProgress / 100) /
                        installableFiles.length
                      )
                    : 72;
                reportPackProgress(
                  options,
                  `Descargando ${path.basename(file.path)} (${completed + 1} de ${installableFiles.length})`,
                  overall
                );
              }
            );

            if (
              hashes.sha1 &&
              crypto.createHash('sha1')
                .update(buffer)
                .digest('hex')
                .toLowerCase() !==
                String(hashes.sha1).toLowerCase()
            ) {
              throw new Error(
                `La comprobación SHA-1 falló para ${file.path}.`
              );
            }

            if (
              hashes.sha512 &&
              crypto.createHash('sha512')
                .update(buffer)
                .digest('hex')
                .toLowerCase() !==
                String(hashes.sha512).toLowerCase()
            ) {
              throw new Error(
                `La comprobación SHA-512 falló para ${file.path}.`
              );
            }

            // Descarga verificada: se deja de probar URLs.
            break outer;
          } catch (error) {
            lastError = error;
            buffer = null;

            // Un hash que no coincide es un problema del
            // archivo, no de la conexión: esta URL nunca
            // servirá, así que se prueba la siguiente.
            if (
              /comprobación SHA-/.test(
                error?.message || ''
              )
            ) {
              continue outer;
            }
          }
        }
      }

      if (!buffer) {
        throw new Error(
          `No se pudo descargar ${file.path} tras ${DOWNLOAD_ATTEMPTS_PER_URL} intentos por URL: ${
            lastError?.message || 'error desconocido'
          }`
        );
      }

      await fs.mkdir(
        path.dirname(destination),
        { recursive: true }
      );

      await fs.writeFile(
        destination,
        buffer
      );

      completed += 1;

      emitStatus(
        `Instalando mods del paquete: ${completed} de ${files.length} archivos...`
      );
      reportPackProgress(
        options,
        `Descargados ${completed} de ${installableFiles.length} archivos`,
        installableFiles.length
          ? 30 + 42 * (completed / installableFiles.length)
          : 72
      );
    }

    void extractedRoot;
  }

  // ====================================================
  // IMPORTAR UN MODPACK MODRINTH
  // ====================================================

  async function importModrinthPack() {
    const dialogResult = await dialog.showOpenDialog({
      title: 'Importar modpack de Minecraft',
      properties: ['openFile'],
      filters: [
        {
          name: 'Modrinth Modpack',
          extensions: ['mrpack']
        }
      ]
    });

    if (
      dialogResult.canceled ||
      !dialogResult.filePaths?.[0]
    ) {
      return null;
    }

    return installMrpackPackFile(
      dialogResult.filePaths[0]
    );
  }

  // ====================================================
  // INSTALAR UN PACK MODRINTH DESDE UN ARCHIVO
  // ====================================================
  // Igual que la importación con diálogo pero con ruta
  // explícita: lo usa el explorador de contenido para
  // descargar un pack y crear la instancia directamente.

  async function installMrpackPackFile(packPath, options = {}) {
    const id = crypto.randomUUID();

    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'eryon-mrpack-')
    );

    let gameDirectory = null;

    try {
      emitStatus('Leyendo el modpack...');
      reportPackProgress(options, 'Extrayendo archivos del modpack', 27);

      await extractArchive(packPath, temporaryRoot);
      reportPackProgress(options, 'Leyendo la configuración del modpack', 30);

      const manifestPath = path.join(
        temporaryRoot,
        'modrinth.index.json'
      );

      const manifestStat = await fs.stat(
        manifestPath
      ).catch(() => null);

      if (
        !manifestStat ||
        manifestStat.size > MAX_MANIFEST_BYTES
      ) {
        throw new Error(
          'El paquete no parece un modpack Modrinth válido: falta modrinth.index.json o es demasiado grande.'
        );
      }

      const manifest = JSON.parse(
        await fs.readFile(
          manifestPath,
          'utf8'
        )
      );

      if (
        manifest.formatVersion !== 1 ||
        manifest.game !== 'minecraft'
      ) {
        throw new Error(
          'Esta versión del formato de modpack no es compatible.'
        );
      }

      const dependenciesMap =
        manifest.dependencies &&
        typeof manifest.dependencies === 'object'
          ? manifest.dependencies
          : {};

      const minecraftVersion = validateMinecraftVersion(
        dependenciesMap.minecraft
      );

      let loader = null;
      let loaderVersion = null;

      if (dependenciesMap['fabric-loader']) {
        loader = 'fabric';
        loaderVersion = String(
          dependenciesMap['fabric-loader']
        );
      } else if (dependenciesMap.forge) {
        loader = 'forge';
        loaderVersion = String(
          dependenciesMap.forge
        );
      } else if (
        dependenciesMap.neoforge ||
        dependenciesMap['quilt-loader']
      ) {
        throw new Error(
          'Este paquete usa NeoForge o Quilt. En esta versión del gestor solo están habilitados Vanilla, Forge y Fabric.'
        );
      } else {
        loader = 'vanilla';
      }

      const rawPackName = String(
        options.instanceName ||
        manifest.name ||
        path.basename(
          packPath,
          path.extname(packPath)
        )
      ).slice(0, 48);

      const packName = validateInstanceName(
        rawPackName
      );

      gameDirectory =
        await prepareInstanceDirectory(packName);

      const settings = await readSettings();

      await downloadMrpackFiles(
        manifest,
        temporaryRoot,
        gameDirectory,
        options
      );

      // Copia overrides normales y específicos del cliente.
      // No copia server-overrides a la instancia del cliente.
      reportPackProgress(options, 'Copiando configuraciones y recursos', 75);
      await copyDirectoryContents(
        path.join(temporaryRoot, 'overrides'),
        gameDirectory,
        gameDirectory
      );

      await copyDirectoryContents(
        path.join(temporaryRoot, 'client-overrides'),
        gameDirectory,
        gameDirectory
      );
      reportPackProgress(
        options,
        `Descargando e instalando ${loader} para Minecraft`,
        80
      );

      emitStatus(
        `Instalando ${loader} para ${packName}...`
      );

      const installed = await installLoader({
        loader,
        minecraftVersion,
        gameDirectory,
        loaderVersion,
        settings,
        installerBridgeJar: options.installerBridgeJar
      });

      const instance = {
        id,
        name: packName,
        minecraftVersion,
        loader: installed.loader,
        loaderVersion: installed.loaderVersion,
        launchVersionId: installed.launchVersionId,
        kind: 'modpack',
        iconUrl: validateInstanceIcon(options.iconUrl),
        summary:
          typeof manifest.summary === 'string'
            ? manifest.summary.slice(0, 300)
            : '',
        sourceFile: path.basename(packPath),
        createdAt: new Date().toISOString(),
        gameDirectory
      };

      await saveInstance(instance);
      reportPackProgress(options, 'Instalación completada', 100);

      emitStatus(
        `Modpack ${packName} importado correctamente.`
      );

      return publicInstance(instance);
    } catch (error) {
      if (gameDirectory) {
        await fs.rm(
          gameDirectory,
          {
            recursive: true,
            force: true
          }
        ).catch(() => {});
      }

      throw error;
    } finally {
      await fs.rm(
        temporaryRoot,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }

  // ====================================================
  // INSTALAR UN PACK CURSEFORGE (.ZIP CON manifest.json)
  // ====================================================
  // El zip de CurseForge lista sus mods por projectID/fileID;
  // hay que resolver cada uno con la API de CurseForge. Para
  // evitar dependencias circulares, main.cjs inyecta aquí la
  // función resolveFile (async => { fileName, url }).

  const PACK_USER_AGENT = 'EryonLauncher/1.0 (pack-installer)';

  async function downloadPackMember(url, destination, onProgress) {
    let lastError = null;

    for (
      let attempt = 1;
      attempt <= DOWNLOAD_ATTEMPTS_PER_URL;
      attempt += 1
    ) {
      if (attempt > 1) {
        emitStatus(
          `Reintento ${attempt} de ${DOWNLOAD_ATTEMPTS_PER_URL} para ${path.basename(destination)}...`
        );

        await waitRetry(
          RETRY_BASE_DELAY_MS * (attempt - 1)
        );
      }

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': PACK_USER_AGENT },
          redirect: 'follow',
          signal: AbortSignal.timeout(180000)
        });

        if (!response.ok || !response.body) {
          throw new Error(
            `No se pudo descargar ${path.basename(destination)} (HTTP ${response.status}).`
          );
        }

        const buffer = await readResponseBuffer(response, onProgress);

        if (buffer.length < 64) {
          throw new Error(
            `El archivo descargado ${path.basename(destination)} está vacío.`
          );
        }

        await fs.mkdir(
          path.dirname(destination),
          { recursive: true }
        );

        await fs.writeFile(destination, buffer);

        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      `No se pudo descargar ${path.basename(destination)} tras ${DOWNLOAD_ATTEMPTS_PER_URL} intentos: ${
        lastError?.message || 'error desconocido'
      }`
    );
  }

  async function installCurseforgePackFile(
    packPath,
    options = {}
  ) {
    const id = crypto.randomUUID();

    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'eryon-cfpack-')
    );

    let gameDirectory = null;

    try {
      emitStatus('Leyendo el modpack de CurseForge...');
      reportPackProgress(options, 'Extrayendo archivos del modpack', 27);

      await extractArchive(packPath, temporaryRoot);
      reportPackProgress(options, 'Leyendo la configuración del modpack', 30);

      const manifestPath = path.join(
        temporaryRoot,
        'manifest.json'
      );

      const manifestStat = await fs.stat(
        manifestPath
      ).catch(() => null);

      if (
        !manifestStat ||
        manifestStat.size > MAX_MANIFEST_BYTES
      ) {
        throw new Error(
          'El paquete no parece un modpack CurseForge válido: falta manifest.json o es demasiado grande.'
        );
      }

      const manifest = JSON.parse(
        await fs.readFile(manifestPath, 'utf8')
      );

      if (
        String(manifest.manifestType) !==
        'minecraftModpack' ||
        Number(manifest.manifestVersion) !== 1
      ) {
        throw new Error(
          'Esta versión del formato de modpack de CurseForge no es compatible.'
        );
      }

      const minecraftData =
        manifest.minecraft &&
        typeof manifest.minecraft === 'object'
          ? manifest.minecraft
          : {};

      const minecraftVersion = validateMinecraftVersion(
        minecraftData.version
      );

      let loader = null;
      let loaderVersion = null;

      const modLoaders = Array.isArray(
        minecraftData.modLoaders
      )
        ? minecraftData.modLoaders
        : [];

      const primaryLoader =
        modLoaders.find((item) => item?.primary) ||
        modLoaders[0] ||
        null;

      if (primaryLoader) {
        const loaderId = String(
          primaryLoader.id ?? ''
        );

        if (loaderId.startsWith('forge-')) {
          loader = 'forge';
          loaderVersion = loaderId.slice('forge-'.length);
        } else if (loaderId.startsWith('fabric-')) {
          loader = 'fabric';
          loaderVersion = loaderId.slice('fabric-'.length);
        } else {
          throw new Error(
            `Este pack usa un cargador no soportado (${loaderId || 'desconocido'}). Solo Vanilla, Forge y Fabric.`
          );
        }
      } else {
        loader = 'vanilla';
      }

      const rawPackName = String(
        options.instanceName ||
        manifest.name ||
        path.basename(
          packPath,
          path.extname(packPath)
        )
      ).slice(0, 48);

      const packName = validateInstanceName(
        rawPackName
      );

      gameDirectory = await prepareInstanceDirectory(packName);

      // Copia overrides: configuraciones, shaders, resourcepacks,
      // opciones.txt, etc. del pack a la instancia.
      const overridesRoot = path.join(
        temporaryRoot,
        String(manifest.overrides || 'overrides')
      );

      await copyDirectoryContents(
        overridesRoot,
        gameDirectory,
        gameDirectory
      );

      // Descarga de los mods listados en el manifest.
      const entries = Array.isArray(manifest.files)
        ? manifest.files
        : [];

      const resolver =
        typeof options.resolveFile === 'function'
          ? options.resolveFile
          : null;

      if (entries.length > 0 && !resolver) {
        throw new Error(
          'No hay resolución de archivos para este pack de CurseForge.'
        );
      }

      let completed = 0;
      const requiredEntries = entries.filter(
        (entry) => entry?.required !== false
      );

      for (const entry of entries) {
        const projectID = Number(entry?.projectID);
        const fileID = Number(entry?.fileID);

        if (
          !Number.isInteger(projectID) ||
          !Number.isInteger(fileID)
        ) {
          throw new Error(
            'El pack contiene una entrada de mod no válida.'
          );
        }

        // required: false = mod opcional; no se instala.
        if (entry.required === false) {
          continue;
        }

        const member = await resolver(
          projectID,
          fileID
        );

        if (!member?.url) {
          throw new Error(
            `CurseForge no devolvió la descarga del mod ${projectID}/${fileID}.`
          );
        }

        const safeName = String(member.fileName || '')
          .replace(/[\\/]/g, '')
          .trim();

        if (!safeName || safeName.includes('..')) {
          throw new Error(
            'El pack contiene un archivo con nombre no válido.'
          );
        }

        const destination = safeResolve(
          gameDirectory,
          path.join('mods', safeName)
        );

        const totalMembers = requiredEntries.length;
        const completedBeforeThis = completed;

        reportPackProgress(
          options,
          `Descargando ${safeName} (${completed + 1} de ${totalMembers})`,
          totalMembers
            ? 30 + 45 * (completed / totalMembers)
            : 75
        );

        await downloadPackMember(
          member.url,
          destination,
          ({ percent }) => {
            const fileProgress = Number(percent) || 0;
            reportPackProgress(
              options,
              `Descargando ${safeName} (${completedBeforeThis + 1} de ${totalMembers})`,
              percent === null
                ? null
                : totalMembers
                  ? 30 + 45 * (
                      (completedBeforeThis + fileProgress / 100) /
                      totalMembers
                    )
                  : 75
            );
          }
        );

        completed += 1;

        emitStatus(
          `Instalando mods del pack: ${completed} de ${entries.length} archivos...`
        );
        reportPackProgress(
          options,
          `Descargados ${completed} de ${totalMembers} archivos`,
          totalMembers
            ? 30 + 45 * (completed / totalMembers)
            : 75
        );
      }

      reportPackProgress(
        options,
        `Descargando e instalando ${loader} para Minecraft`,
        80
      );
      emitStatus(
        `Instalando ${loader} para ${packName}...`
      );

      const settings = await readSettings();

      const installed = await installLoader({
        loader,
        minecraftVersion,
        gameDirectory,
        loaderVersion,
        settings
      });

      const instance = {
        id,
        name: packName,
        minecraftVersion,
        loader: installed.loader,
        loaderVersion: installed.loaderVersion,
        launchVersionId: installed.launchVersionId,
        kind: 'modpack',
        iconUrl: validateInstanceIcon(options.iconUrl),
        summary:
          'Modpack de CurseForge descargado con el explorador de contenido.',
        sourceFile: path.basename(packPath),
        createdAt: new Date().toISOString(),
        gameDirectory
      };

      await saveInstance(instance);
      reportPackProgress(options, 'Instalación completada', 100);

      emitStatus(
        `Modpack ${packName} instalado correctamente como instancia nueva.`
      );

      return publicInstance(instance);
    } catch (error) {
      if (gameDirectory) {
        await fs.rm(
          gameDirectory,
          {
            recursive: true,
            force: true
          }
        ).catch(() => {});
      }

      throw error;
    } finally {
      await fs.rm(
        temporaryRoot,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }

  // ====================================================
  // ELIMINAR UNA INSTANCIA
  // ====================================================

  async function deleteInstance(instanceId) {
    const store = await readStore();

    const instance = store.instances.find(
      (item) => item.id === instanceId
    );

    if (!instance) {
      throw new Error(
        'No se encontró la instalación que quieres eliminar.'
      );
    }

    const instancesBase = path.resolve(
      instancesRoot()
    );

    const directory = path.resolve(
      instance.gameDirectory
    );

    const relative = path.relative(
      instancesBase,
      directory
    );

    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        'Se bloqueó la eliminación porque la carpeta no pertenece a las instancias de ERYON.'
      );
    }

    store.instances = store.instances.filter(
      (item) => item.id !== instanceId
    );

    await writeStore(store);

    await fs.rm(
      directory,
      {
        recursive: true,
        force: true
      }
    );

    return {
      deleted: true,
      instances: await getInstances()
    };
  }

  // ====================================================
  // API DEL GESTOR
  // ====================================================

  return {
    getInstances,
    getInstance,
    setInstanceIcon,
    renameInstance,
    getLoaderVersions,
    ensureEryonIdentity1201Fabric,
    ensureEryonIdentityFabric,
    ensureFabricForVersion,
    ensureForgeForVersion,
    ensureLegacyAsmLibrary,
    ensureLegacyForgeLaunchLibraries,
    installInstance,
    repairInstance,
    updateInstanceLoader,
    importModrinthPack,
    installMrpackPackFile,
    installCurseforgePackFile,
    deleteInstance
  };
}

module.exports = createModpackManager;
