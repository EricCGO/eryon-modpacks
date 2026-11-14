/**
 * Gestor de EVENTOS del launcher.
 *
 * - Descarga el manifiesto publico de eventos del Worker de Cloudflare
 *   (eryon-events) con validacion de hash, reintentos y caché local en
 *   disco para que la seccion funcione incluso sin conexion.
 * - Descarga manifiestos de modpack por evento (GET /pack/:id).
 * - Funciones admin (publicar manifiestos, subir imagenes) que usan la
 *   clave guardada localmente; la clave JAMAS va en el codigo del
 *   launcher, se guarda en userData como la clave de CurseForge.
 *
 * Patrones tomados de modpack-manager.cjs (factory con inyeccion de
 * dependencias) y mods-manager.cjs (reintentos de descarga).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const EVENTS_BASE_URL = "https://eryon-events.eryon-launcher.workers.dev";

const MANIFEST_TTL_MS = 5 * 60 * 1000; // refresco cada 5 minutos
const FETCH_TIMEOUT_MS = 20000;
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 900;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

// Unic+os destinos permitidos pa los archivos de un evento: evita
// rutas arbitrarias y traversal (../, absolutas, unidades, etc).
const ALLOWED_DEST_ROOTS = new Set([
  "mods",
  "resourcepacks",
  "shaderpacks",
  "config"
]);

function createEventsManager({ app, sendLaunchEvent }) {
  const cacheFile = () => path.join(app.getPath("userData"), "eryon-events-cache.json");
  const adminTokenFile = () =>
    path.join(app.getPath("userData"), "eryon-events-admin.json");

  function readCache() {
    try {
      const raw = fs.readFileSync(cacheFile(), "utf8");
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.events)) return null;
      return data;
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    try {
      const tmp = `${cacheFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, cacheFile());
    } catch {
      // La caché es optativa: si falla, seguimos sin ella.
    }
  }

  function sha256Hex(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /** fetch con timeout + reintentos + delay entre intentos. */
  async function fetchWithRetries(url, options = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          return await fetch(url, { ...options, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        lastError = error;
        if (attempt < FETCH_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
        }
      }
    }
    throw lastError;
  }

  /**
   * Estado del evento: manual ("upcoming"/"active"/"finished") o
   * calculado por fechas cuando state = "auto".
   */
  function computeState(ev, now = Date.now()) {
    const manual = ev && ev.state;
    if (manual && manual !== "auto") return manual;
    const start = ev.startAt ? Date.parse(ev.startAt) : NaN;
    const end = ev.endAt ? Date.parse(ev.endAt) : NaN;
    if (!Number.isNaN(end) && now > end) return "finished";
    if (!Number.isNaN(start) && now < start) return "upcoming";
    if (!Number.isNaN(start)) return "active";
    return "active";
  }

  /**
   * Normaliza un evento del manifiesto a la forma que consume la UI:
   * solo campos conocidos, tipos saneados, estado calculado en el
   * momento de la consulta.
   */
  function normalizeEvent(ev, now = Date.now()) {
    if (!ev || typeof ev !== "object" || typeof ev.id !== "string") return null;

    const actions = Array.isArray(ev.actions)
      ? ev.actions
          .filter((a) => a && typeof a === "object" && typeof a.type === "string")
          .map((a) => ({
            type: a.type,
            label: typeof a.label === "string" ? a.label : "",
            url: typeof a.url === "string" && /^https:\/\//i.test(a.url) ? a.url : null
          }))
          .filter((a) =>
            ["play", "download", "info", "discord", "external", "refresh"].includes(a.type) &&
            // Las acciones de enlace exigen URL segura; play/download/refresh no.
            (["play", "download", "refresh"].includes(a.type) || a.url !== null)
          )
      : [];

    const minecraft = ev.minecraft && typeof ev.minecraft === "object"
      ? {
          version: typeof ev.minecraft.version === "string" ? ev.minecraft.version : "",
          loader: typeof ev.minecraft.loader === "string" ? ev.minecraft.loader : "",
          loaderVersion:
            typeof ev.minecraft.loaderVersion === "string" ? ev.minecraft.loaderVersion : ""
        }
      : null;

    const modpack = ev.modpack && typeof ev.modpack === "object"
      ? {
          name: typeof ev.modpack.name === "string" ? ev.modpack.name : "",
          version: typeof ev.modpack.version === "string" ? ev.modpack.version : ""
        }
      : null;

    const media = (value) =>
      typeof value === "string" && /^(https:\/\/|data:image\/)/i.test(value) ? value : null;

    return {
      id: ev.id,
      title: typeof ev.title === "string" ? ev.title : "",
      subtitle: typeof ev.subtitle === "string" ? ev.subtitle : "",
      description: typeof ev.description === "string" ? ev.description : "",
      banner: media(ev.banner),
      cover: media(ev.cover),
      icon: media(ev.icon),
      buttonImage: media(ev.buttonImage),
      accentColor:
        typeof ev.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(ev.accentColor)
          ? ev.accentColor
          : null,
      startAt: typeof ev.startAt === "string" ? ev.startAt : null,
      endAt: typeof ev.endAt === "string" ? ev.endAt : null,
      state: computeState(ev, now),
      order: Number.isFinite(ev.order) ? ev.order : 0,
      enabled: ev.enabled !== false,
      actions,
      minecraft,
      modpack,
      packId: typeof ev.packId === "string" && SLUG_RE.test(ev.packId) ? ev.packId : ev.id,
      infoUrl: media(ev.infoUrl),
      discordUrl: media(ev.discordUrl)
    };
  }

  /**
   * Lista de eventos: 1) si la caché esta fresca la usa, 2) si no
   * consulta el Worker (con reintentos), 3) si la red falla cae a la
   * caché aunque este vieja, 4) sin caché responde vacío marcando
   * offline. Nunca lanza: la UI muestra estados de carga/error.
   */
  async function getEvents({ force = false } = {}) {
    const cached = readCache();
    const fresh =
      cached &&
      typeof cached.fetchedAt === "number" &&
      Date.now() - cached.fetchedAt < MANIFEST_TTL_MS;

    if (!force && fresh) {
      return {
        ok: true,
        source: "cache",
        updated: cached.updated,
        events: cached.events.map((ev) => normalizeEvent(ev)).filter(Boolean)
      };
    }

    try {
      const options = {};
      if (cached && cached.hash) {
        options.headers = { "If-None-Match": `"${cached.hash}"` };
      }

      const response = await fetchWithRetries(`${EVENTS_BASE_URL}/events`, options);

      if (response.status === 304 && cached) {
        writeCache({ ...cached, fetchedAt: Date.now() });
        return {
          ok: true,
          source: "cache",
          updated: cached.updated,
          events: cached.events.map((ev) => normalizeEvent(ev)).filter(Boolean)
        };
      }

      if (!response.ok) {
        throw new Error(`El servidor de eventos respondio ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.events)) {
        throw new Error("Manifiesto de eventos invalido");
      }

      const etag = (response.headers.get("ETag") || "").replace(/"/g, "");
      const cacheData = {
        updated: data.updated || null,
        hash: etag || sha256Hex(Buffer.from(text, "utf8")),
        fetchedAt: Date.now(),
        events: data.events
      };
      writeCache(cacheData);

      return {
        ok: true,
        source: "remote",
        updated: cacheData.updated,
        events: cacheData.events.map((ev) => normalizeEvent(ev)).filter(Boolean)
      };
    } catch (error) {
      if (cached) {
        return {
          ok: true,
          source: "cache-offline",
          updated: cached.updated,
          events: cached.events.map((ev) => normalizeEvent(ev)).filter(Boolean)
        };
      }
      return {
        ok: false,
        source: "offline",
        updated: null,
        events: [],
        error: `No hay conexion con el servidor de eventos: ${error && error.message}`
      };
    }
  }

  /**
   * Manifiesto de modpack de un evento (GET /pack/:id). Devuelve el
   * JSON crudo validado: id, minecraft/loader y files con url https,
   * sha256 y size.
   */
  async function getEventPack(packId) {
    if (typeof packId !== "string" || !SLUG_RE.test(packId)) {
      throw new Error("Identificador de pack de evento invalido");
    }

    const response = await fetchWithRetries(`${EVENTS_BASE_URL}/pack/${packId}`, {
      headers: { Accept: "application/json" }
    });

    if (response.status === 404) {
      throw new Error("Este evento no tiene manifiesto de modpack publicado");
    }
    if (!response.ok) {
      throw new Error(`El servidor respondio ${response.status} al pedir el manifiesto del evento`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Manifiesto de modpack invalido");
    }
    const hasArchive = data.archive && typeof data.archive === "object" && !Array.isArray(data.archive);
    if (!hasArchive && !Array.isArray(data.files)) {
      throw new Error("El manifiesto del evento no trae archivos ni un ZIP");
    }
    if (hasArchive) {
      if (typeof data.archive.url !== "string" || !/^https:\/\//i.test(data.archive.url) ||
          typeof data.archive.sha256 !== "string" || !SHA256_RE.test(data.archive.sha256) ||
          !Number.isFinite(data.archive.size) || data.archive.size <= 0) {
        throw new Error("El archivo ZIP del manifiesto no es valido");
      }
    }
    for (const [i, file] of (Array.isArray(data.files) ? data.files : []).entries()) {
      const where = `archivo ${i + 1}`;
      if (typeof file.path !== "string" || file.path.length === 0) {
        throw new Error(`${where}: ruta invalida`);
      }
      if (typeof file.url !== "string" || !/^https:\/\//i.test(file.url)) {
        throw new Error(`${where}: la URL de descarga debe ser https`);
      }
      if (typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256)) {
        throw new Error(`${where}: hash SHA-256 invalido`);
      }
      if (!Number.isFinite(file.size) || file.size < 0) {
        throw new Error(`${where}: tamano invalido`);
      }
    }
    return data;
  }

  /** Valida que la ruta destino del archivo este dentro de la instancia
   * y en una carpeta permitida (anti path traversal). */
  function resolveEventFilePath(instanceRoot, relativePath) {
    const normalized = path
      .normalize(String(relativePath))
      .replace(/^([\\/])/, "");
    const root = path.normalize(instanceRoot + path.sep);
    const absolute = path.resolve(root, normalized);
    if (!absolute.startsWith(root)) {
      throw new Error(`Ruta de archivo fuera de la instancia: ${relativePath}`);
    }
    const topLevel = normalized.split(/[\\/]/)[0];
    if (!ALLOWED_DEST_ROOTS.has(topLevel)) {
      throw new Error(`Carpeta de destino no permitida: ${topLevel}`);
    }
    return absolute;
  }

  // ------------------------------------------------------------------
  // ADMIN: la clave se guarda local (nunca en el codigo) y viaja en el
  // header Authorization de cada peticion al Worker.
  // ------------------------------------------------------------------

  function readAdminToken() {
    try {
      const raw = fs.readFileSync(adminTokenFile(), "utf8");
      const data = JSON.parse(raw);
      return typeof data.token === "string" && data.token ? data.token : "";
    } catch {
      return "";
    }
  }

  function writeAdminToken(token) {
    const data = { token: String(token || "") };
    const tmp = `${adminTokenFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, adminTokenFile());
  }

  function clearAdminToken() {
    try {
      fs.unlinkSync(adminTokenFile());
    } catch {
      // No habia clave guardada.
    }
  }

  async function adminRequest(pathname, options = {}) {
    const token = readAdminToken();
    if (!token) {
      const error = new Error("No hay clave de administrador configurada");
      error.code = "NO_ADMIN_TOKEN";
      throw error;
    }
    const response = await fetchWithRetries(`${EVENTS_BASE_URL}${pathname}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      }
    });
    if (response.status === 401 || response.status === 403) {
      const error = new Error("La clave no es válida. Comprueba que esté escrita correctamente.");
      error.code = "BAD_ADMIN_TOKEN";
      throw error;
    }
    if (response.status === 503) {
      const error = new Error("El servidor de eventos no tiene clave admin configurada");
      error.code = "SERVER_NO_TOKEN";
      throw error;
    }
    return response;
  }

  /** Verifica la clave contra el servidor (guardar + test). */
  async function verifyAdminToken(token) {
    const response = await fetch(`${EVENTS_BASE_URL}/admin/events`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(
        response.status === 401 || response.status === 403
          ? "La clave no es válida. Comprueba que esté escrita correctamente."
          : data.error || `El servidor respondio ${response.status}`
      );
      error.code = response.status === 401 || response.status === 403 ? "BAD_ADMIN_TOKEN" : "SERVER_ERROR";
      throw error;
    }
    return true;
  }

  /** Publica el manifiesto completo de eventos (reemplaza el anterior). */
  async function publishEvents(manifest) {
    const response = await adminRequest("/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest)
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "El servidor rechazo el manifiesto");
    }
    // Invalida la caché para que la lista nueva aparezca al toque.
    try {
      fs.unlinkSync(cacheFile());
    } catch {
      // No habia caché.
    }
    if (typeof sendLaunchEvent === "function") {
      sendLaunchEvent({ type: "events", action: "published" });
    }
    return data;
  }

  /** Publica el manifiesto de modpack de un evento. */
  async function publishEventPack(packId, packManifest) {
    const response = await adminRequest(`/admin/pack/${packId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(packManifest)
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "El servidor rechazo el manifiesto del pack");
    }
    return data;
  }

  /**
   * Sube una imagen (dataURL o Buffer) al servidor y devuelve la URL
   * publica relativa (/img/<clave>). El panel la optimiza a WEBP
   * ANTES de llamar aqui; el servidor acepta png/jpg/webp hasta 2 MB.
   */
  async function uploadEventImage(dataUrlOrBuffer, contentType) {
    let buffer;
    let type = contentType;
    if (typeof dataUrlOrBuffer === "string") {
      const match = dataUrlOrBuffer.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error("La imagen no tiene un formato reconocible");
      }
      type = type || match[1];
      buffer = Buffer.from(match[2], "base64");
    } else if (Buffer.isBuffer(dataUrlOrBuffer)) {
      buffer = dataUrlOrBuffer;
    } else if (dataUrlOrBuffer instanceof ArrayBuffer) {
      buffer = Buffer.from(dataUrlOrBuffer);
    } else if (ArrayBuffer.isView(dataUrlOrBuffer)) {
      buffer = Buffer.from(
        dataUrlOrBuffer.buffer,
        dataUrlOrBuffer.byteOffset,
        dataUrlOrBuffer.byteLength
      );
    } else {
      throw new Error("Imagen invalida");
    }
    if (!IMAGE_CONTENT_TYPES.has(type)) {
      throw new Error("Solo se permiten imagenes PNG, JPG o WEBP");
    }
    if (buffer.byteLength > 2 * 1024 * 1024) {
      throw new Error("La imagen pesa mas de 2 MB (optimizala antes de subirla)");
    }

    const response = await adminRequest("/admin/img", {
      method: "POST",
      headers: { "Content-Type": type },
      body: new Uint8Array(buffer)
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "El servidor rechazo la imagen");
    }
    return { key: data.key, url: `${EVENTS_BASE_URL}${data.url}`, size: data.size };
  }

  async function deleteEventImage(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.-]{8,80}$/.test(key)) {
      throw new Error("Clave de imagen invalida");
    }
    const response = await adminRequest(`/admin/img/${key}`, { method: "DELETE" });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "El servidor rechazo el borrado");
    }
    return true;
  }

  const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const EVENT_FILE_CHUNK_BYTES = 8 * 1024 * 1024;
  const EVENT_FILE_MAX_BYTES = 100 * 1024 * 1024;

  /**
   * Sube un archivo del pack (mods propios, configs, layouts) al
   * servidor. Devuelve url publica, SHA-256 completo y tamano, listos
   * para el manifiesto del pack. Los archivos grandes se suben en partes.
   */
  async function uploadEventFile(buffer, filename) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error("Archivo invalido");
    }
    if (buffer.byteLength === 0) {
      throw new Error("El archivo esta vacio");
    }
    if (buffer.byteLength > EVENT_FILE_MAX_BYTES) {
      throw new Error("El archivo pesa mas de 100 MB");
    }

    const sha256 = sha256Hex(buffer);
    if (buffer.byteLength > EVENT_FILE_CHUNK_BYTES) {
      const totalChunks = Math.ceil(buffer.byteLength / EVENT_FILE_CHUNK_BYTES);
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * EVENT_FILE_CHUNK_BYTES;
        const chunk = buffer.subarray(start, Math.min(start + EVENT_FILE_CHUNK_BYTES, buffer.length));
        const response = await adminRequest("/admin/file-chunk", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Sha256": sha256,
            "X-Chunk-Index": String(index),
            "X-Chunk-Total": String(totalChunks),
            "X-Filename": String(filename || "archivo").slice(0, 120)
          },
          body: new Uint8Array(chunk)
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || "El servidor rechazo una parte del archivo");
      }
      const complete = await adminRequest("/admin/file-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256, size: buffer.byteLength, chunks: totalChunks })
      });
      const completeData = await complete.json();
      if (!completeData.ok) throw new Error(completeData.error || "No se pudo completar el archivo");
      return {
        key: completeData.key,
        sha256,
        url: `${EVENTS_BASE_URL}${completeData.url}`,
        size: completeData.size
      };
    }

    const response = await adminRequest("/admin/file", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": String(filename || "archivo").slice(0, 120)
      },
      body: new Uint8Array(buffer)
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "El servidor rechazo el archivo");
    }
    return {
      key: data.key,
      sha256: data.sha256,
      url: `${EVENTS_BASE_URL}${data.url}`,
      size: data.size
    };
  }

  /**
   * Calcula SHA-256 y tamano de un archivo en una URL https (pa
   * llenar el manifiesto con mods hospedados fuera, ej Modrinth).
   */
  async function hashFileFromUrl(url) {
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
      throw new Error("La URL debe ser https");
    }
    const response = await fetch(url, { headers: { Accept: "*/*" } });
    if (!response.ok) {
      throw new Error(`El servidor respondio ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Error("El archivo remoto esta vacio");
    }
    return {
      sha256: sha256Hex(buffer),
      size: buffer.byteLength
    };
  }

  /**
   * Manifiesto CRUDO (sin normalizar) pa el panel admin: primero
   * refresca la caché y luego lee el archivo local.
   */
  async function getRawManifest({ force = true } = {}) {
    await getEvents({ force });
    return readCache();
  }

  return {
    EVENTS_BASE_URL,
    getEvents,
    getEventPack,
    resolveEventFilePath,
    readCache,
    computeState,
    normalizeEvent,
    readAdminToken,
    writeAdminToken,
    clearAdminToken,
    verifyAdminToken,
    publishEvents,
    publishEventPack,
    uploadEventImage,
    deleteEventImage,
    uploadEventFile,
    hashFileFromUrl,
    getRawManifest
  };
}

module.exports = { createEventsManager, EVENTS_BASE_URL };
