
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const extractZip = require("extract-zip");
const { CURSEFORGE_PROXY_URL: CONFIGURED_CURSEFORGE_PROXY_URL } =
  require("./curseforge-proxy-config.cjs");

// ======================================================
// EXPLORADOR DE CONTENIDO (MODRINTH + CURSEFORGE)
// ======================================================
// Módulo unificado para buscar e instalar:
//   mods / modpacks / texturas / shaders / mundos
//
// - Modrinth: API abierta, sin clave.
// - CurseForge: requiere API key gratuita
//   (curseforge.com/developer); su clase de cada categoría se
//   resuelve dinámicamente para no trabajar con IDs fijos.
//
// Instalación: cada tipo va a su carpeta dentro de la instalación
// (mods, resourcepacks, shaderpacks) o a saves/ si es un mundo
// (se descarga y descomprime el zip del mundo).

const USER_AGENT = "EryonLauncher/1.0 ";

const MODRINTH_API = "https://api.modrinth.com/v2";
const CURSEFORGE_API = "https://api.curseforge.com";
const CURSEFORGE_PROXY_URL =
  process.env.ERYON_CURSEFORGE_PROXY_URL ||
  CONFIGURED_CURSEFORGE_PROXY_URL;
const CURSEFORGE_GAME_ID = 432; // Minecraft Java
// Las "classes" de CurseForge (Mods, Modpacks, etc.) vienen en
// /v1/categories con isClass=true (el endpoint antiguo
// /v1/games/:id/classes ya no existe y daba 404).
const CURSEFORGE_CLASSES_URL =
  `${CURSEFORGE_API}/v1/categories?gameId=${CURSEFORGE_GAME_ID}`;

const MODRINTH_LOADERS = new Set([
  "fabric",
  "forge",
  "neoforge",
  "quilt"
]);

const CURSEFORGE_LOADER_NAMES = {
  1: "forge",
  2: "forge",
  3: "liteloader",
  4: "fabric",
  5: "quilt",
  6: "neoforge"
};

function normalizeContentLoaders(loaders) {
  return Array.from(
    new Set(
      (Array.isArray(loaders) ? loaders : [loaders])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function curseforgeLoaders(file) {
  const values = [];
  const type = Number(file?.modLoaderType);
  const typeName = CURSEFORGE_LOADER_NAMES[type];

  if (typeName) values.push(typeName);
  if (file?.modLoader) values.push(file.modLoader);

  return normalizeContentLoaders(values);
}

function validateContentLoader({ type, loader, contentLoaders }) {
  if (type !== "mods") return;

  const requestedLoader = String(loader || "").trim().toLowerCase();
  const availableLoaders = normalizeContentLoaders(contentLoaders);

  // Sin cargador seleccionado o sin metadata del proveedor no podemos
  // afirmar incompatibilidad; el loader validará el archivo al iniciar.
  if (!requestedLoader || availableLoaders.length === 0) return;

  const compatible =
    requestedLoader === "vanilla"
      ? availableLoaders.every((item) => item === "minecraft" || item === "vanilla")
      : availableLoaders.includes(requestedLoader);

  if (!compatible) {
    throw new Error(
      `Este mod es para ${availableLoaders.join(", ")} y la instancia utiliza ${requestedLoader}.`
    );
  }
}

async function detectModFileLoaders(filePath) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "eryon-mod-metadata-")
  );

  try {
    await extractZip(filePath, { dir: temporaryDirectory });
    const metadataFiles = [
      ["fabric.mod.json", "fabric"],
      ["quilt.mod.json", "quilt"],
      ["META-INF/mods.toml", "forge"],
      ["META-INF/neoforge.mods.toml", "neoforge"],
      ["mcmod.info", "forge"]
    ];
    const detected = [];

    for (const [relativePath, loader] of metadataFiles) {
      try {
        await fs.access(path.join(temporaryDirectory, relativePath));
        detected.push(loader);
      } catch {
        // Ese formato de metadata no pertenece a este mod.
      }
    }

    return normalizeContentLoaders(detected);
  } catch {
    // Si el archivo no es un JAR ZIP válido, dejamos que la metadata de
    // CurseForge/Modrinth sea la fuente de compatibilidad disponible.
    return [];
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// Ordenamientos que acepta la búsqueda de Modrinth.
const MODRINTH_SORTS = new Set([
  "relevance",
  "downloads",
  "follows",
  "newest",
  "updated"
]);

// sortField de la búsqueda de CurseForge (verificado contra su
// API): 2=Popularity, 3=LastUpdated, 4=Name, 6=TotalDownloads.
const CURSEFORGE_SORT_FIELDS = {
  relevance: "2",
  downloads: "6",
  newest: "3",
  updated: "3",
  name: "4"
};

// Categorías visibles en la interfaz y su soporte por fuente.
// worlds: Modrinth no tiene mundos en su buscador (API verificada);
// esa pestaña solo queda activa con CurseForge.
const CATEGORY_TYPES = {
  mods: { modrinth: "mod", curseforgeName: "Mods" },
  modpacks: {
    modrinth: "modpack",
    curseforgeName: "Modpacks"
  },
  textures: {
    modrinth: "resourcepack",
    curseforgeName: "Resource Packs"
  },
  shaders: {
    modrinth: "shader",
    curseforgeName: "Shaders"
  },
  datapacks: {
    modrinth: "datapack",
    curseforgeName: "Data Packs"
  },
  worlds: {
    modrinth: null,
    curseforgeName: "Worlds"
  }
};

// Carpeta destino dentro de la instalación, por tipo de contenido.
const TYPE_FOLDERS = {
  mods: "mods",
  modpacks: null, // Los packs se importan manualmente.
  textures: "resourcepacks",
  shaders: "shaderpacks",
  worlds: "saves" // Especial: se descomprime el zip.
};

const FILENAME_PATTERN =
  /^[\p{L}\p{N}][\p{L}\p{N} ._)(+-]*\.(jar|zip|mcpack|mrpack)$/iu;

function safeDownloadFileName(fileName, url) {
  let candidate = String(fileName || '').trim();

  if (!candidate && url) {
    try {
      candidate = decodeURIComponent(
        new URL(url).pathname.split('/').pop() || ''
      );
    } catch {
      candidate = '';
    }
  }

  candidate = path.basename(candidate.replace(/\\/g, '/'));

  const extension = path.extname(candidate).toLowerCase();
  const supportedExtensions = new Set([
    '.jar',
    '.zip',
    '.mcpack',
    '.mrpack'
  ]);

  if (!supportedExtensions.has(extension)) return '';

  let baseName = candidate
    .slice(0, -extension.length)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[^\p{L}\p{N} ._)(+-]/gu, '_')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 160)
    .replace(/[. ]+$/g, '');

  if (!baseName) return '';

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName)) {
    baseName = `_${baseName}`;
  }

  const safeName = `${baseName}${extension}`;
  return FILENAME_PATTERN.test(safeName) ? safeName : '';
}

async function readResponseBuffer(response, onProgress) {
  const chunks = [];
  const total = Number(response.headers.get("content-length")) || 0;
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
        typeof onProgress === "function" &&
        (now - lastProgressAt >= 150 || (total > 0 && received >= total))
      ) {
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(100, (received / total) * 100) : null
        });
        lastProgressAt = now;
      }
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    chunks.push(buffer);
    received = buffer.length;
  }

  if (typeof onProgress === "function") {
    onProgress({ received, total, percent: 100 });
  }

  return Buffer.concat(chunks);
}

// ======================================================
// UTILIDADES HTTP
// ======================================================

async function readJson(url, options = {}) {
  const originalUrl = new URL(url);
  let requestUrl = originalUrl;
  const requestHeaders = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    ...(options.headers ?? {})
  };

  if (originalUrl.origin === CURSEFORGE_API) {
    if (!CURSEFORGE_PROXY_URL) {
      throw new Error(
        "El proxy de CurseForge no está configurado. Define ERYON_CURSEFORGE_PROXY_URL."
      );
    }
    requestUrl = new URL(CURSEFORGE_PROXY_URL);
    requestUrl.searchParams.set("path", originalUrl.pathname);
    for (const [key, value] of originalUrl.searchParams) {
      requestUrl.searchParams.append(key, value);
    }
    delete requestHeaders["x-api-key"];
    delete requestHeaders["X-API-Key"];
  }

  const response = await fetch(requestUrl, { headers: requestHeaders });

  if (!response.ok) {
    let details = "";

    try {
      details = await response.text();
    } catch {
      // Sin cuerpo de error.
    }

    throw new Error(
      `Error HTTP ${response.status} en ${originalUrl.host}${
        details ? `: ${details.slice(0, 240)}` : ""
      }`
    );
  }

  return response.json();
}

function sendMessage(message) {
  throw new Error(message);
}

// ======================================================
// CLAVE DE CURSEFORGE
// ======================================================

async function readCurseforgeKey(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    const key = String(parsed?.apiKey ?? "").trim();

    if (key) {
      return key;
    }
  } catch {
    // Sin archivo local: caemos a la clave integrada de fábrica.
  }

  return null;
}

async function writeCurseforgeKey(filePath, apiKey) {
  const key = String(apiKey ?? "").trim();

  if (key && key.length > 200) {
    sendMessage("La API key de CurseForge es demasiado larga.");
  }

  if (key && key.length < 20) {
    sendMessage("La API key de CurseForge no parece válida.");
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ apiKey: key }, null, 2),
    "utf8"
  );

  return Boolean(key);
}

// Cache en memoria del mapa "nombre de clase -> classId".
let curseforgeClassMap = null;

async function getCurseforgeClassMap(apiKey) {
  if (curseforgeClassMap) {
    return curseforgeClassMap;
  }

  const payload = await readJson(CURSEFORGE_CLASSES_URL, {
    headers: { "x-api-key": apiKey }
  });

  const all = payload?.classes ?? payload?.data ?? [];
  const classes = (Array.isArray(all) ? all : []).filter(
    (item) => item?.isClass === true
  );

  const map = {};
  for (const item of classes) {
    const name = String(item?.name ?? "").trim();
    const id = Number(item?.id);

    if (name && Number.isInteger(id)) {
      map[name] = id;
    }
  }

  if (Object.keys(map).length === 0) {
    sendMessage(
      "CurseForge no devolvió sus categorías. Revisa tu API key."
    );
  }

  curseforgeClassMap = map;
  return map;
}

/** Indica qué categorías soporta realmente CurseForge según su clase. */
async function curseforgeSupportCheck(apiKey) {
  const map = await getCurseforgeClassMap(apiKey);

  return {
    mods: map["Mods"] !== undefined,
    modpacks: map["Modpacks"] !== undefined,
    textures: map["Resource Packs"] !== undefined,
    shaders: map["Shaders"] !== undefined,
    worlds: map["Worlds"] !== undefined
  };
}

function requireCurseforgeKey(apiKey) {
  // La clave se mantiene únicamente como secreto de Firebase.
  return;

  if (!String(apiKey ?? "").trim()) {
    sendMessage(
      "Falta la API key de CurseForge. Configúrala en el explorador de Modpacks."
    );
  }
}

// ======================================================
// BÚSQUEDAS
// ======================================================

const MODRINTH_PAGE_SLUGS = {
  mod: "mod",
  modpack: "modpack",
  resourcepack: "resourcepacks",
  shader: "shaders",
  datapack: "datapacks"
};

function normalizeModrinth(hit, type) {
  const pageSegment = MODRINTH_PAGE_SLUGS[type] || type;

  return {
    source: "modrinth",
    type,
    id: hit.project_id,
    slug: hit.slug,
    name: hit.title,
    author: hit.author || "",
    description: hit.description || "",
    iconUrl: hit.icon_url || "",
    downloads: Number(hit.downloads) || 0,
    pageUrl: `https://modrinth.com/${pageSegment}/${hit.slug}`
  };
}

function normalizeCurseforge(project, type) {
  return {
    source: "curseforge",
    type,
    id: String(project.id),
    slug: project.slug ?? "",
    name: project.name,
    author: "",
    description: project.summary || "",
    iconUrl:
      project?.logo?.thumbnailUrl || project?.logo?.url || "",
    downloads: Number(project.downloadCount) || 0,
    pageUrl:
      project.links?.websiteUrl ||
      project.links?.wikiUrl ||
      ""
  };
}

async function searchModrinth({
  type,
  query,
  gameVersion,
  loader,
  sort,
  category,
  limit,
  offset
}) {
  const facets = [[`project_type:${type}`]];

  if (gameVersion) {
    facets.push([`versions:${gameVersion}`]);
  }

  // Aquí `type` es el project_type SINGULAR de Modrinth
  // (mod/modpack/resourcepack/shader): el filtro de cargador
  // aplica a mods y modpacks (los packs también tienen loader).
  if (
    (type === "mod" || type === "modpack") &&
    loader &&
    MODRINTH_LOADERS.has(loader)
  ) {
    facets.push([`categories:${loader}`]);
  }

  // Filtro por categoría (slug de Modrinth: technology, magic,
  // adventure, worldgen, etc.).
  if (category) {
    facets.push([`categories:${category}`]);
  }

  // Orden admitido por Modrinth: relevance, downloads, follows,
  // newest, updated. Cualquier otro valor cae a descargas.
  const index = MODRINTH_SORTS.has(sort) ? sort : "downloads";

  const params = new URLSearchParams({
    query: query || "",
    facets: JSON.stringify(facets),
    index,
    limit: String(limit),
    offset: String(offset)
  });

  const payload = await readJson(
    `${MODRINTH_API}/search?${params.toString()}`
  );

  return {
    source: "modrinth",
    total: Number(payload.total_hits) || 0,
    results: (payload.hits ?? []).map((hit) =>
      normalizeModrinth(hit, type)
    )
  };
}

async function searchCurseforge({
  type,
  query,
  gameVersion,
  loader,
  apiKey,
  sort,
  category,
  limit,
  offset
}) {
  requireCurseforgeKey(apiKey);

  const classMap = await getCurseforgeClassMap(apiKey);
  const classId = classMap[CATEGORY_TYPES[type].curseforgeName];

  if (!classId) {
    throw new Error(
      `CurseForge no ofrece esta categoría en su API.`
    );
  }

  const params = new URLSearchParams({
    gameId: String(CURSEFORGE_GAME_ID),
    classId: String(classId),
    searchFilter: query || "",
    sortField: CURSEFORGE_SORT_FIELDS[sort] || "2",
    sortOrder: "desc",
    pageSize: String(limit),
    index: String(offset)
  });

  if (gameVersion) {
    params.set("gameVersion", gameVersion);
  }

  const curseforgeLoaderTypes = {
    forge: "1",
    fabric: "4",
    quilt: "5",
    neoforge: "6"
  };

  if (type === "mods" && curseforgeLoaderTypes[loader]) {
    params.set("modLoaderType", curseforgeLoaderTypes[loader]);
  }

  // Filtro por categoría: llega el id numérico de CurseForge
  // (por ejemplo "Adventure and RPG" tiene su propio id).
  if (category && /^\d+$/.test(String(category))) {
    params.set("categoriesFilter", String(category));
  }

  const payload = await readJson(
    `${CURSEFORGE_API}/v1/mods/search?${params.toString()}`,
    { headers: { "x-api-key": apiKey } }
  );

  return {
    source: "curseforge",
    // CurseForge no usa _meta.total (estilo Modrinth): su paginación
    // trae el total en pagination.totalCount.
    total:
      Number(payload?._meta?.total) ||
      Number(payload?.pagination?.totalCount) ||
      0,
    results: (payload?.data ?? []).slice(0, limit).map(
      (project) => normalizeCurseforge(project, type)
    )
  };
}

/**
 * Búsqueda unificada.
 * type: mods | modpacks | textures | shaders | worlds
 */
async function searchContent({
  source = "modrinth",
  type = "mods",
  query = "",
  gameVersion = "",
  loader = "",
  sort = "relevance",
  category = "",
  apiKey = null,
  limit = 24,
  offset = 0
}) {
  const curseforgeName =
    CATEGORY_TYPES[type]?.curseforgeName;

  if (!curseforgeName) {
    sendMessage("Categoría de contenido no reconocida.");
  }

  const selected =
    source === "curseforge" ? "curseforge" : "modrinth";

  if (selected === "modrinth") {
    const modrinthType = CATEGORY_TYPES[type].modrinth;

    if (!modrinthType) {
      throw new Error(
        `${CATEGORY_TYPES[type].curseforgeName} solo está disponible en CurseForge. Conéctalo con tu API key.`
      );
    }

    const payload = await searchModrinth({
      type: modrinthType,
      query,
      gameVersion,
      loader,
      sort,
      category,
      limit,
      offset
    });

    // Los resultados vienen etiquetados con el tipo SINGULAR que
    // usa la API de Modrinth (mod/resourcepack/shader); la UI y
    // installContent trabajan con la categoría PLURAL (mods/
    // textures/shaders). Se normaliza aquí, en la frontera.
    return {
      ...payload,
      results: (payload.results ?? []).map(
        (result) => ({ ...result, type })
      )
    };
  }

  return searchCurseforge({
    type,
    query,
    gameVersion,
    loader,
    apiKey,
    sort,
    category,
    limit,
    offset
  });
}

// ======================================================
// FILTROS DEL EXPLORADOR (CATEGORÍAS POR FUENTE Y TIPO)
// ======================================================

// Cache en memoria del catálogo de filtros.
let contentFiltersCache = null;

// Convierte slugs de Modrinth ("technology", "juice-and-tools")
// a nombres legibles ("Technology", "Juice and Tools").
function slugBonito(slug) {
  return String(slug)
    .split("-")
    .map((word) =>
      word ? word.charAt(0).toUpperCase() + word.slice(1) : word
    )
    .join(" ");
}

async function getContentFilters(apiKey) {
  if (contentFiltersCache) {
    return contentFiltersCache;
  }

  const filtros = {
    versions: [],
    modrinth: { mods: [], modpacks: [], textures: [], shaders: [] },
    curseforge: { mods: [], modpacks: [], textures: [], shaders: [] }
  };

  // Versiones de Minecraft (release) para el filtro manual:
  // la lista la da Modrinth y sirve igual para CurseForge.
  try {
    const versiones = await readJson(
      `${MODRINTH_API}/tag/game_version`
    );

    filtros.versions = (Array.isArray(versiones) ? versiones : [])
      .filter((v) => v?.version && v?.version_type === "release")
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map((v) => v.version)
      .slice(0, 80);
  } catch {
    // Sin lista de versiones: la UI solo usa la de la instancia.
  }

  // Modrinth: tags de categorías públicas (no necesita clave).
  try {
    const tags = await readJson(`${MODRINTH_API}/tag/category`);
    const tipos = {
      mod: "mods",
      modpack: "modpacks",
      resourcepack: "textures",
      shader: "shaders"
    };

    for (const tag of Array.isArray(tags) ? tags : []) {
      const target = tipos[tag?.project_type];
      // Solo las categorías reales: el endpoint también trae
      // "features" y "resolutions" que no sirven como facet.
      if (!target || !tag?.name || tag?.header !== "categories") {
        continue;
      }

      filtros.modrinth[target].push({
        id: tag.name,
        name: slugBonito(tag.name)
      });
    }

    for (const lista of Object.values(filtros.modrinth)) {
      lista.sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    // Sin catálogo de Modrinth: la UI no muestra el filtro.
  }

  // CurseForge: categorías reales agrupadas por su clase
  // (Mods, Modpacks, Resource Packs, Shaders).
  try {
    const classMap = await getCurseforgeClassMap(apiKey);
    const payload = await readJson(CURSEFORGE_CLASSES_URL, {
      headers: { "x-api-key": apiKey }
    });
    const todas = Array.isArray(payload?.data) ? payload.data : [];

    for (const type of ["mods", "modpacks", "textures", "shaders"]) {
      const classId = classMap[CATEGORY_TYPES[type].curseforgeName];
      if (!classId) {
        continue;
      }

      filtros.curseforge[type] = todas
        .filter(
          (cat) =>
            Number(cat?.classId) === Number(classId) &&
            cat?.isClass !== true &&
            cat?.name
        )
        .map((cat) => ({ id: String(cat.id), name: String(cat.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    // Sin clave o sin conexión: filtros de CurseForge vacíos.
  }

  contentFiltersCache = filtros;

  return filtros;
}

// ======================================================
// RESOLUCIÓN DEL ARCHIVO A DESCARGAR
// ======================================================

// Archivo .mrpack de una versión del modpack de Modrinth
// (la más reciente salvo que el usuario elija otra).
async function resolveModrinthPackFile(projectId, versionId = '') {
  if (versionId) {
    const data = await readJson(
      `${MODRINTH_API}/project/${encodeURIComponent(
        projectId
      )}/version/${encodeURIComponent(versionId)}`
    );

    const release = Array.isArray(data) ? data[0] : data;
    const files = release?.files ?? [];

    const packFile =
      files.find((file) => file.primary) ||
      files.find((file) =>
        String(file.filename || '').endsWith('.mrpack')
      );

    if (packFile?.url) {
      return {
        fileName:
          safeDownloadFileName(packFile.filename, packFile.url) ||
          `modpack-${String(projectId).replace(/[^A-Za-z0-9_-]/g, '')}.mrpack`,
        url: packFile.url
      };
    }

    throw new Error(
      'La versión elegida del modpack no trae un archivo .mrpack.'
    );
  }

  const versions = await readJson(
    `${MODRINTH_API}/project/${encodeURIComponent(
      projectId
    )}/version`
  );

  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(
      'Este modpack no tiene archivos descargables en Modrinth.'
    );
  }

  for (const release of versions) {
    const files = release.files ?? [];
    const packFile =
      files.find((file) => file.primary) ||
      files.find((file) =>
        String(file.filename || '').endsWith('.mrpack')
      );

    if (packFile?.url) {
      return {
        fileName:
          safeDownloadFileName(packFile.filename, packFile.url) ||
          `modpack-${String(projectId).replace(/[^A-Za-z0-9_-]/g, '')}.mrpack`,
        url: packFile.url
      };
    }
  }

  throw new Error(
    'Este modpack no trae un archivo .mrpack descargable.'
  );
}

// Archivo .zip (manifest.json + overrides) de un modpack de
// CurseForge: la versión más reciente, o la elegida por el
// usuario en la ventana de versiones (versionId = file id).
async function resolveCurseforgePackFile(
  projectId,
  apiKey,
  versionId = ''
) {
  requireCurseforgeKey(apiKey);

  // Versión ELEGIDA por el usuario: se pide el archivo directo.
  if (versionId) {
    const filePayload = await readJson(
      `${
        CURSEFORGE_API
      }/v1/mods/${encodeURIComponent(
        projectId
      )}/files/${encodeURIComponent(
        String(versionId)
      )}`,
      { headers: { 'x-api-key': apiKey } }
    );

    const chosen = filePayload?.data ?? filePayload;
    const name = String(chosen?.fileName || '');

    if (!name.toLowerCase().endsWith('.zip')) {
      throw new Error(
        'La versión elegida del modpack no es un paquete instalable (.zip).'
      );
    }

    return {
      fileName:
        safeDownloadFileName(name) ||
        `modpack-${String(versionId).replace(/[^A-Za-z0-9_-]/g, '')}.zip`,
      url:
        chosen.downloadUrl ||
        `https://www.curseforge.com/api/v1/mods/${encodeURIComponent(
          projectId
        )}/files/${encodeURIComponent(
          String(versionId)
        )}/download`
    };
  }

  const params = new URLSearchParams({
    pageSize: '30',
    sortField: '0',
    sortOrder: 'desc'
  });

  const payload = await readJson(
    `${
      CURSEFORGE_API
    }/v1/mods/${encodeURIComponent(
      projectId
    )}/files?${params.toString()}`,
    { headers: { 'x-api-key': apiKey } }
  );

  const files = Array.isArray(payload?.data)
    ? payload.data
    : [];

  let fallback = null;

  for (const file of files) {
    if (file.isServerPackOnly) continue;

    const name = String(file.fileName || '');

    if (name.toLowerCase().endsWith('.zip')) {
      return {
        fileName:
          safeDownloadFileName(name) ||
          `modpack-${String(file.id)}.zip`,
        url:
          file.downloadUrl ||
          `https://www.curseforge.com/api/v1/mods/${encodeURIComponent(
            projectId
          )}/files/${encodeURIComponent(
            String(file.id)
          )}/download`
      };
    }

    if (!fallback) {
      fallback = {
        fileName:
          safeDownloadFileName(name) ||
          `modpack-${String(file.id)}.zip`,
        url:
          file.downloadUrl ||
          `https://www.curseforge.com/api/v1/mods/${encodeURIComponent(
            projectId
          )}/files/${encodeURIComponent(
            String(file.id)
          )}/download`
      };
    }
  }

  if (fallback) {
    return fallback;
  }

  throw new Error(
    'No hay archivos descargables de este modpack en CurseForge.'
  );
}

// Resuelve un mod concreto dentro de un pack CurseForge
// (projectID + fileID del manifest.json) a su URL de descarga.
async function resolveCurseforgePackMember({
  projectId,
  fileId,
  apiKey
}) {
  requireCurseforgeKey(apiKey);

  const payload = await readJson(
    `${
      CURSEFORGE_API
    }/v1/mods/${encodeURIComponent(
      projectId
    )}/files/${encodeURIComponent(String(fileId))}`,
    { headers: { 'x-api-key': apiKey } }
  );

  const file = payload?.data ?? payload;

  const fileName = String(file?.fileName || '');

  if (!fileName) {
    throw new Error(
      'CurseForge no devolvió los datos de un mod del pack.'
    );
  }

  return {
    fileName,
    url:
      file?.downloadUrl ||
      `https://www.curseforge.com/api/v1/mods/${encodeURIComponent(
        projectId
      )}/files/${encodeURIComponent(
        String(fileId)
      )}/download`
  };
}

// Descarga pública de un archivo resuelto (pack, etc.).
async function downloadContentFile({
  fileName,
  url,
  directory,
  apiKey = null,
  fallbackExtension = '',
  onProgress
}) {
  return downloadToFile({
    url,
    fileName,
    directory,
    apiKey,
    fallbackExtension,
    onProgress
  });
}

async function resolveModrinthDownload({
  type,
  projectId,
  gameVersion,
  loader,
  versionId = ''
}) {
  // Versión ELEGIDA por el usuario en la ventana de versiones:
  // se descarga tal cual, sin filtrar por versión del juego.
  if (versionId) {
    const data = await readJson(
      `${MODRINTH_API}/project/${encodeURIComponent(
        projectId
      )}/version/${encodeURIComponent(versionId)}`
    );

    const release = Array.isArray(data) ? data[0] : data;
    const files = release?.files ?? [];
    const main =
      files.find((file) => file.primary) || files[0];

    if (!main?.url) {
      throw new Error(
        'La versión elegida no tiene archivo descargable.'
      );
    }

    return {
      fileName: main.filename,
      url: main.url,
      loaders: release.loaders,
      gameVersions: release.game_versions
    };
  }

  const buildUrl = (includeLoader) => {
    const search = new URLSearchParams();

    if (gameVersion) {
      search.append(
        "game_versions",
        JSON.stringify([gameVersion])
      );
    }

    if (includeLoader && type === "mods" && loader && MODRINTH_LOADERS.has(loader)) {
      search.append("loaders", JSON.stringify([loader]));
    }

    const queryStr = search.toString()
      ? `?${search.toString()}`
      : "";

    return `${MODRINTH_API}/project/${encodeURIComponent(
      projectId
    )}/version${queryStr}`;
  };

  let versions = await readJson(buildUrl(true));

  if (
    (!Array.isArray(versions) || versions.length === 0) &&
    loader
  ) {
    versions = await readJson(buildUrl(false));
  }

  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(
      `No hay archivos de este contenido para Minecraft ${gameVersion || "(según la página del contenido)"}.`
    );
  }

  for (const release of versions) {
    const files = release.files ?? [];
    const main = files.find((file) => file.primary) || files[0];

    if (main?.url) {
      return {
        fileName: main.filename,
        url: main.url,
        loaders: release.loaders,
        gameVersions: release.game_versions
      };
    }
  }

  throw new Error("El contenido no tiene archivo descargable.");
}

async function resolveCurseforgeDownload({
  projectId,
  gameVersion,
  apiKey,
  versionId = ''
}) {
  requireCurseforgeKey(apiKey);

  // Archivo ELEGIDO por el usuario en la ventana de versiones.
  if (versionId) {
    const filePayload = await readJson(
      `${
        CURSEFORGE_API
      }/v1/mods/${encodeURIComponent(
        projectId
      )}/files/${encodeURIComponent(versionId)}`,
      { headers: { 'x-api-key': apiKey } }
    );

    const chosen = filePayload?.data ?? filePayload;

    if (!chosen?.fileName) {
      throw new Error(
        'CurseForge no devolvió la versión elegida.'
      );
    }

    return {
      fileName: chosen.fileName,
      url:
        chosen.downloadUrl ||
        `https://www.curseforge.com/api/v1/mods/${encodeURIComponent(
          projectId
        )}/files/${encodeURIComponent(versionId)}/download`
      ,
      loaders: curseforgeLoaders(chosen),
      gameVersions: chosen.gameVersions
    };
  }

  const params = new URLSearchParams({
    pageSize: "30",
    sortField: "0",
    sortOrder: "desc"
  });

  if (gameVersion) {
    params.set("gameVersion", gameVersion);
  }

  const payload = await readJson(
    `${CURSEFORGE_API}/v1/mods/${encodeURIComponent(
      projectId
    )}/files?${params.toString()}`,
    { headers: { "x-api-key": apiKey } }
  );

  const files = Array.isArray(payload?.data) ? payload.data : [];

  for (const file of files) {
    if (file.isServerPackOnly) continue;

    return {
      fileName: file.fileName,
      url:
        file.downloadUrl ||
        // Con distribución deshabilitada la API no devuelve la URL;
        // este enlace de redirección al CDN funciona para el usuario.
        `https://www.curseforge.com/api/v1/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(
          String(file.id)
        )}/download`
      ,
      loaders: curseforgeLoaders(file),
      gameVersions: file.gameVersions
    };
  }

  throw new Error(
    `No hay archivos de este contenido para Minecraft ${
      gameVersion || "(cualquier versión)"
    }.`
  );
}

async function resolveDownload({
  source,
  type,
  projectId,
  gameVersion,
  loader,
  apiKey,
  versionId = ''
}) {
  if (source === "curseforge") {
    requireCurseforgeKey(apiKey);
    return resolveCurseforgeDownload({
      projectId,
      gameVersion,
      apiKey,
      versionId
    });
  }

  return resolveModrinthDownload({
    type,
    projectId,
    gameVersion,
    loader,
    versionId
  });
}

// ======================================================
// VERSIONES DISPONIBLES DE UN CONTENIDO
// ======================================================
// Lista las ediciones publicadas (mods, texturas, shaders y
// modpacks) para que el usuario elija la que corresponda a su
// juego: versión de Minecraft, cargador y fecha de salida.

async function listContentVersions({
  source = "modrinth",
  type,
  projectId,
  apiKey = null,
  limit = 60,
  gameVersion = ""
}) {
  if (!projectId) {
    throw new Error(
      "El contenido no tiene identificador."
    );
  }

  if (source === "curseforge") {
    requireCurseforgeKey(apiKey);

    const params = new URLSearchParams({
      pageSize: String(limit),
      sortField: "0",
      sortOrder: "desc"
    });

    if (gameVersion) {
      params.set("gameVersion", gameVersion);
    }

    const payload = await readJson(
      `${
        CURSEFORGE_API
      }/v1/mods/${encodeURIComponent(
        projectId
      )}/files?${params.toString()}`,
      { headers: { "x-api-key": apiKey } }
    );

    const files = Array.isArray(payload?.data)
      ? payload.data
      : [];

    // Conjunto de versiones del juego que admite el contenido
    // (deducido de sus propios archivos; solo versiones, no
    // cargadores que CurseForge mezcla en la misma lista).
    const distinctGameVersions = [];

    for (const file of files) {
      for (const entry of file.gameVersions ?? []) {
        if (
          entry &&
          !distinctGameVersions.includes(entry) &&
          /^\d/.test(String(entry)) &&
          !String(entry).includes("-")
        ) {
          distinctGameVersions.push(entry);
        }
      }
    }

    return {
      gameVersions: distinctGameVersions,
      versions: files.map((file) => ({
        versionId: String(file.id),
        name: file.displayName || file.fileName,
        fileName: file.fileName || "",
        gameVersions: Array.isArray(file.gameVersions)
          ? file.gameVersions.slice(0, 4)
          : [],
        loaders: [],
        date: file.fileDate || "",
        size: Number(file.fileLength) || 0
      }))
    };
  }

  const versionQuery = new URLSearchParams();

  if (gameVersion) {
    versionQuery.set(
      "game_versions",
      JSON.stringify([gameVersion])
    );
  }

  const versionQuerySuffix = versionQuery.toString()
    ? `?${versionQuery.toString()}`
    : "";

  const versions = await readJson(
    `${
      MODRINTH_API
    }/project/${encodeURIComponent(
      projectId
    )}/version${versionQuerySuffix}`
  );

  const list = Array.isArray(versions) ? versions : [];

  // Conjunto de versiones del juego que admite el contenido,
  // en orden de aparición (la más reciente primero).
  const distinctGameVersions = [];

  for (const release of list) {
    for (const entry of release.game_versions ?? []) {
      if (
        entry &&
        !distinctGameVersions.includes(entry) &&
        !String(entry).includes("-")
      ) {
        distinctGameVersions.push(entry);
      }
    }
  }

  return {
    gameVersions: distinctGameVersions,
    versions: list.slice(0, limit).map((release) => {
      const files = release.files ?? [];
      const main =
        files.find((file) => file.primary) || files[0];

      return {
        versionId: release.id,
        name: release.version_number || release.name || "",
        fileName: main?.filename || "",
        gameVersions: Array.isArray(release.game_versions)
          ? release.game_versions.slice(0, 4)
          : [],
        loaders: Array.isArray(release.loaders)
          ? release.loaders
          : [],
        date: release.date_published || "",
        size: Number(main?.size) || 0
      };
    })
  };
}

// ======================================================
// ESTILO LUNAR: OPTIMIZACIÓN INTEGRADA
// ======================================================
// Garantiza Sodium (rendimiento) e Iris (shaders de la especie
// OptiFine) en instancias fabric/vanilla de CUALQUIER versión,
// resolviendo en Modrinth la edición exacta para esa versión
// del juego. Un marcador por instancia evita repetir trabajo.

const LUNAR_OPTIMIZATION_PROJECTS = [
  { key: "sodium", projectId: "AANobbMI", label: "Sodium" },
  { key: "iris", projectId: "YL57xq9U", label: "Iris" }
];

async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function ensureLunarOptimizations({
  gameDirectory,
  minecraftVersion,
  apiKey = null,
  onStatus = null
}) {
  const version = String(minecraftVersion || "").trim();

  if (!gameDirectory || !version) {
    throw new Error(
      "Falta la instalación o la versión para las optimizaciones."
    );
  }

  const markerPath = path.join(gameDirectory, "eryon-lunar.json");
  const marker = await readJsonFile(markerPath);

  const modsDirectory = path.join(gameDirectory, "mods");
  let existingNames = [];

  try {
    existingNames = (await fs.readdir(modsDirectory)).map(
      (name) => String(name).toLowerCase()
    );
  } catch {
    // Sin carpeta mods todavía: se creará al descargar.
  }

  // Limpieza defensiva: descargas antiguas con edición de otro
  // cargador (neoforge/forge) no sirven en casillas vanilla/fabric.
  let removedLoaderMismatch = false;

  for (const name of existingNames) {
    if (
      /(sodium|iris)/.test(name) &&
      /(?:neo)?forge/.test(name) &&
      /\.(jar|zip)$/.test(name)
    ) {
      try {
        await fs.rm(path.join(modsDirectory, name), { force: true });
        removedLoaderMismatch = true;
      } catch {
        // Si no se puede borrar no bloqueamos el arranque.
      }
    }
  }

  if (removedLoaderMismatch) {
    try {
      existingNames = (await fs.readdir(modsDirectory)).map(
        (name) => String(name).toLowerCase()
      );
    } catch {
      existingNames = [];
    }
  }

  // Ya preparado para esta versión exacta (y sin restos de otro
  // cargador que limpiar): nada más que hacer.
  if (
    !removedLoaderMismatch &&
    marker &&
    marker.minecraftVersion === version &&
    Array.isArray(marker.applied)
  ) {
    return {
      applied: marker.applied,
      appliedCount: marker.applied.length,
      alreadyReady: true,
      available: marker.applied.length > 0
    };
  }

  const applied = [];
  let attempted = 0;

  for (const project of LUNAR_OPTIMIZATION_PROJECTS) {
    if (
      existingNames.some(
        (name) =>
          name.includes(project.key) ||
          name.includes(project.label.toLowerCase())
      )
    ) {
      applied.push(project.label);
      continue;
    }

    attempted += 1;

    if (typeof onStatus === "function") {
      onStatus(
        `Buscando ${project.label} para Minecraft ${version}...`
      );
    }

    try {
      const info = await resolveModrinthDownload({
        type: "mods",
        projectId: project.projectId,
        gameVersion: version,
        // Siempre fabric: el paquete solo se aplica en casillas
        // vanilla/fabric; sin este filtro Modrinth devolvería la
        // edición de NeoForge más reciente de lo contrario.
        loader: "fabric"
      });

      if (!info?.url || /(?:neo)?forge/i.test(info.fileName || "")) {
        // La edición para esta versión es de otro cargador: no
        // sirve para casillas vanilla/fabric. Se omite.
        continue;
      }

      if (typeof onStatus === "function") {
        onStatus(
          `Descargando ${project.label} (${info.fileName})...`
        );
      }

      await downloadToFile({
        url: info.url,
        fileName: info.fileName,
        directory: modsDirectory,
        apiKey
      });

      applied.push(project.label);
    } catch {
      // Sin edición para esta versión del juego (o fallo de red
      // puntual): se omite este componente sin abortar el juego.
    }
  }

  if (
    attempted > 0 &&
    applied.length === 0 &&
    marker?.lastAttemptVersion === version
  ) {
    throw new Error(
      "Ningún componente del paquete de optimización pudo descargarse."
    );
  }

  await fs.mkdir(gameDirectory, { recursive: true });
  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        minecraftVersion: version,
        applied,
        lastAttemptVersion: version,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    applied,
    appliedCount: applied.length,
    alreadyReady: false,
    available: applied.length > 0
  };
}

// ======================================================
// OPTIFINE EN VERSIONES LEGACY (FORGE)
// ======================================================
// En 1.8.x la vía con shaders es OptiFine (Iris es Fabric y
// no aplica). Se descarga el jar OFICIAL desde optifine.net
// (nunca se redistribuye) y se deja en mods/, donde Forge lo
// carga. Idempotente: si ya hay un OptiFine de esa versión no
// repite la descarga.

async function fetchLegacyText(url, referer = null, cookie = null) {
  const headers = { "User-Agent": USER_AGENT };
  if (referer) headers["Referer"] = referer;
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `optifine.net respondió HTTP ${response.status}.`
    );
  }

  const sessionCookie = response.headers
    .get("set-cookie")
    ?.match(/(?:^|,\s*)(JSESSIONID=[^;,\s]+)/i)?.[1];

  return {
    text: await response.text(),
    cookie: sessionCookie || cookie
  };
}

async function downloadLegacyOptiFineFile({
  url,
  fileName,
  directory,
  cookie,
  referer
}) {
  let currentUrl = new URL(url);

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (
      currentUrl.protocol !== "https:" ||
      !["optifine.net", "www.optifine.net"].includes(currentUrl.hostname)
    ) {
      throw new Error("La descarga de OptiFine redirigió a un dominio no permitido.");
    }

    const headers = {
      "User-Agent": USER_AGENT,
      Referer: referer
    };
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 5) {
        throw new Error("OptiFine devolvió una redirección de descarga no válida.");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error(`No se pudo descargar OptiFine (HTTP ${response.status}).`);
    }

    const buffer = await readResponseBuffer(response);
    if (buffer.length < 256 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error(
        "OptiFine devolvió una respuesta vacía o que no es un archivo JAR."
      );
    }

    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, fileName);
    await fs.writeFile(destination, buffer);
    return destination;
  }

  throw new Error("OptiFine excedió el límite de redirecciones de descarga.");
}

async function ensureLegacyOptiFine({
  gameDirectory,
  minecraftVersion,
  onStatus = null
}) {
  const version = String(minecraftVersion || "").trim();

  if (!gameDirectory || !version) {
    throw new Error(
      "Falta la instalación o la versión para OptiFine."
    );
  }

  const modsDirectory = path.join(gameDirectory, "mods");
  await fs.mkdir(modsDirectory, { recursive: true });

  const existing = (await fs.readdir(modsDirectory).catch(() => []))
    .map((name) => String(name));

  const optiFinePattern = new RegExp(
    `^OptiFine_${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_`,
    "i"
  );

  const alreadyInstalled = existing.find(
    (name) => optiFinePattern.test(name)
  );
  if (alreadyInstalled) {
    return {
      installed: true,
      alreadyReady: true,
      fileName: alreadyInstalled
    };
  }

  const escapeForRegExp = (value) =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (typeof onStatus === "function") {
    onStatus(
      `Buscando OptiFine para Minecraft ${version} en optifine.net...`
    );
  }

  const downloadsPage = await fetchLegacyText(
    "https://optifine.net/downloads.php",
    "https://optifine.net/"
  );

  const namePattern = new RegExp(
    `(?:preview_)?(OptiFine_${escapeForRegExp(version)}_HD_U_[A-Za-z0-9]+(?:_pre\\d+)?)\\.jar`,
    "g"
  );

  // La página muestra primero previews y luego versiones estables, de más
  // nueva a más antigua. Seleccionamos la primera estable y guardamos el
  // nombre completo del JAR; recortar `.jar` o `_preN` produce un 404.
  const candidates = [...downloadsPage.text.matchAll(namePattern)]
    .filter((match) => !match[0].startsWith("preview_"))
    .map((match) => match[1]);

  if (!candidates.length) {
    return {
      installed: false,
      available: false
    };
  }

  const releaseName = candidates[0];
  const releaseFileName = `${releaseName}.jar`;

  if (typeof onStatus === "function") {
    onStatus(`Descargando OptiFine ${releaseName}...`);
  }

  const adPage = await fetchLegacyText(
    `https://optifine.net/adloadx?f=${encodeURIComponent(releaseFileName)}`,
    "https://optifine.net/downloads.php",
    downloadsPage.cookie
  );

  const jarMatch = adPage.text.match(
    /downloadx\?f=([^&"'\s]+)&(?:amp;)?x=([a-f0-9]+)/i
  );

  if (!jarMatch) {
    throw new Error(
      "No se pudo resolver la descarga oficial de OptiFine."
    );
  }

  const downloadQuery = new URLSearchParams({
    f: jarMatch[1],
    x: jarMatch[2]
  });

  const destination = await downloadLegacyOptiFineFile({
    url: `https://optifine.net/downloadx?${downloadQuery.toString()}`,
    fileName: releaseFileName,
    directory: modsDirectory,
    cookie: adPage.cookie || downloadsPage.cookie,
    referer: `https://optifine.net/adloadx?f=${encodeURIComponent(releaseFileName)}`
  });

  // Validar cabecera ZIP antes de dar por buena la descarga.
  const magic = await fs.open(destination, "r").then(async (handle) => {
    try {
      const buffer = Buffer.alloc(2);
      await handle.read(buffer, 0, 2, 0);
      return buffer;
    } finally {
      await handle.close();
    }
  });

  if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw new Error(
      "El archivo de OptiFine descargado no es un JAR válido."
    );
  }

  return {
    installed: true,
    alreadyReady: false,
    fileName: path.basename(destination)
  };
}

// ======================================================
// INSTALACIÓN
// ======================================================

async function downloadToFile({
  url,
  fileName,
  directory,
  apiKey,
  fallbackExtension = '',
  onProgress
}) {
  let safeName = safeDownloadFileName(fileName, url);

  if (!safeName) {
    const supportedFallbacks = new Set(['.zip', '.mrpack']);
    const normalizedFallback = String(fallbackExtension).toLowerCase();

    if (!supportedFallbacks.has(normalizedFallback)) {
      throw new Error(
        `El servidor no proporcionó un nombre de archivo válido para la descarga${
          fileName ? ` (${String(fileName).slice(0, 100)})` : ''
        }.`
      );
    }

    safeName = `modpack-download${normalizedFallback}`;
  }

  const headers = { "User-Agent": USER_AGENT };

  if (String(url).startsWith(`${CURSEFORGE_API}/`) && apiKey) {
    headers["x-api-key"] = apiKey;
  }

  // Reintentos ante cortes de conexión del CDN ('terminated').
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 900;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, RETRY_DELAY_MS * (attempt - 1));
      });
    }

    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(180000)
      });

      if (!response.ok || !response.body) {
        throw new Error(
          `No se pudo descargar el archivo (HTTP ${response.status}).`
        );
      }

      const buffer = await readResponseBuffer(response, onProgress);

      if (buffer.length < 256) {
        throw new Error("El archivo descargado está vacío.");
      }

      await fs.mkdir(directory, { recursive: true });

      const destination = path.join(directory, safeName);
      await fs.writeFile(destination, buffer);

      return destination;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `No se pudo descargar el archivo tras ${MAX_ATTEMPTS} intentos: ${
      lastError?.message || "error desconocido"
    }`
  );
}

/**
 * Descarga el zip de un mundo y lo deja en saves/<nombre>.
 * Normaliza el caso donde el zip descansa en una carpeta raíz.
 */
async function installWorld({
  fileUrl,
  fileName,
  gameDirectory,
  worldName,
  apiKey
}) {
const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "eryon-world-")
);

  try {
    const zipPath = await downloadToFile({
      url: fileUrl,
      fileName,
      directory: temporaryDirectory,
      apiKey
    });

    const { extractArchive } = require("./extract-archive.cjs");
    const extractDirectory = path.join(
      temporaryDirectory,
      "extracted"
    );

    await fs.mkdir(extractDirectory, { recursive: true });
    await extractArchive(zipPath, extractDirectory);

    // Localizar la carpeta del mundo (donde vive level.dat).
    const levelEntry = await findWorldRoot(
      extractDirectory
    );

    if (!levelEntry) {
      throw new Error(
        "El zip no parece contener un mundo de Minecraft válido."
      );
    }

    const savesDirectory = path.join(gameDirectory, "saves");
    await fs.mkdir(savesDirectory, { recursive: true });

    const baseName = worldFolderName(worldName);

    let targetDirectory = path.join(savesDirectory, baseName);
    let suffix = 1;

    while (await exists(targetDirectory)) {
      suffix += 1;
      targetDirectory = path.join(
        savesDirectory,
        `${baseName} (${suffix})`
      );
    }

    await rename(levelEntry.directory, targetDirectory);

    return {
      fileName: path.basename(targetDirectory),
      path: targetDirectory
    };
  } finally {
    await fs.rm(temporaryDirectory, {
      recursive: true,
      force: true
    });
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findWorldRoot(root) {
  const entries = await fs.readdir(root, {
    withFileTypes: true
  });

  const levelDat = entries.find(
    (entry) =>
      entry.isFile() && entry.name === "level.dat"
  );

  if (levelDat) {
    return { directory: root };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "extracted") continue;

    const found = await findWorldRoot(
      path.join(root, entry.name)
    );

    if (found) {
      return found;
    }
  }

  return null;
}

function worldFolderName(name) {
  const clean = String(name || "Mundo")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return clean || "Mundo descargado";
}

/** Instala un contenido según su tipo en la instalación indicada. */
async function installContent({
  source,
  type,
  projectId,
  instanceGameDirectory,
  instanceName = "",
  gameVersion,
  loader = "",
  apiKey = null,
  versionId = ""
}) {
  const info = await resolveDownload({
    source,
    type,
    projectId,
    gameVersion,
    loader,
    apiKey,
    versionId
  });

  validateContentLoader({
    type,
    loader,
    contentLoaders: info.loaders
  });

  // Los modpacks no se instalan aquí: en la interfaz se sugiere
  // usar IMPORTAR con el .mrpack/.zip.
  if (!TYPE_FOLDERS[type]) {
    throw new Error(
      "El tipo de contenido no se instala automáticamente."
    );
  }

  if (type === "worlds") {
    return installWorld({
      fileUrl: info.url,
      fileName: info.fileName,
      gameDirectory: instanceGameDirectory,
      worldName: instanceName,
      apiKey
    });
  }

  const modsDirectory = path.join(
    instanceGameDirectory,
    TYPE_FOLDERS[type]
  );
  const temporaryDirectory =
    type === "mods"
      ? await fs.mkdtemp(path.join(os.tmpdir(), "eryon-mod-download-"))
      : null;

  try {
    const downloadedPath = await downloadToFile({
      url: info.url,
      fileName: info.fileName,
      directory: temporaryDirectory || modsDirectory,
      apiKey
    });

    if (type === "mods") {
      const detectedLoaders = await detectModFileLoaders(downloadedPath);
      validateContentLoader({
        type,
        loader,
        contentLoaders:
          detectedLoaders.length > 0 ? detectedLoaders : info.loaders
      });

      await fs.mkdir(modsDirectory, { recursive: true });
      const destination = path.join(modsDirectory, path.basename(downloadedPath));
      await fs.copyFile(downloadedPath, destination);

      return {
        fileName: path.basename(destination),
        path: destination
      };
    }

    return {
      fileName: path.basename(downloadedPath),
      path: downloadedPath
    };
  } finally {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, {
        recursive: true,
        force: true
      });
    }
  }
}

async function rename(sourceDirectory, directory) {
  await fs.rename(sourceDirectory, directory);
}

module.exports = {
  downloadContentFile,
  ensureLunarOptimizations,
  ensureLegacyOptiFine,
  getContentFilters,
  installContent,
  listContentVersions,
  readCurseforgeKey,
  resolveCurseforgePackFile,
  resolveCurseforgePackMember,
  resolveModrinthPackFile,
  searchContent,
  writeCurseforgeKey,
  curseforgeSupportCheck
};
