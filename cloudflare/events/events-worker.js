/**
 * ERYON EVENTS — Backend de eventos del launcher.
 *
 * Worker de Cloudflare (mismo patron que eryon-curseforge-proxy):
 * - Publico:  GET /events   -> manifiesto JSON con hash SHA-256 (ETag + 304)
 *             GET /pack/:id -> manifiesto de modpack de un evento
 *             GET /img/:key -> imagen guardada en KV (png/jpeg/webp)
 * - Admin:    POST /admin/events, POST /admin/pack/:id, POST /admin/img,
 *             DELETE /admin/img/:key
 *
 * La autorizacion admin se hace con un token guardado como SECRETO de
 * Cloudflare (wrangler secret put ADMIN_TOKEN). Nunca viaja en el codigo
 * del launcher: el usuario la escribe en el panel admin y se envia por
 * el header Authorization en cada peticion.
 *
 * Almacenamiento: KV (EVENTS_DATA para manifiestos, EVENTS_IMG para
 * imagenes). Si en el futuro se activa R2, solo cambia el binding.
 */

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_PACK_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB (el cliente ya optimiza a WEBP)
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FILE_CHUNK_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
  "Access-Control-Max-Age": "86400"
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}

/** Comparacion en tiempo constante del token admin. */
function tokenMatches(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") {
    return false;
  }
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(received);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) {
    return { ok: false, status: 503, error: "ADMIN_TOKEN no configurado en el Worker" };
  }
  const header = request.headers.get("Authorization") || "";
  const received = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!received || !tokenMatches(env.ADMIN_TOKEN, received)) {
    return { ok: false, status: 401, error: "La clave no es válida" };
  }
  return { ok: true };
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isValidIsoOrNull(value) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  const t = Date.parse(value);
  return !Number.isNaN(t);
}

/** Validacion minima del manifiesto de eventos antes de guardarlo. */
function validateEventsManifest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "El manifiesto debe ser un objeto JSON";
  }
  if (!Array.isArray(data.events)) {
    return "Falta la lista de eventos (events)";
  }
  for (const [i, ev] of data.events.entries()) {
    const where = `eventos[${i}]`;
    if (!ev || typeof ev !== "object") return `${where}: no es un objeto`;
    if (typeof ev.id !== "string" || !SLUG_RE.test(ev.id)) {
      return `${where}.id invalido (slug a-z0-9 -_)`;
    }
    if (typeof ev.title !== "string" || !ev.title.trim() || ev.title.length > 120) {
      return `${where}.title invalido`;
    }
    if (!isValidIsoOrNull(ev.startAt)) return `${where}.startAt no es fecha ISO`;
    if (!isValidIsoOrNull(ev.endAt)) return `${where}.endAt no es fecha ISO`;
    if (ev.state && !["auto", "upcoming", "active", "finished"].includes(ev.state)) {
      return `${where}.state invalido`;
    }
    if (ev.minecraft) {
      if (typeof ev.minecraft.version !== "string") return `${where}.minecraft.version invalido`;
      if (!["vanilla", "fabric", "forge"].includes(ev.minecraft.loader)) {
        return `${where}.minecraft.loader invalido`;
      }
    }
    if (ev.actions && !Array.isArray(ev.actions)) return `${where}.actions debe ser lista`;
  }
  return null;
}

/** Validacion minima del manifiesto de modpack de un evento. */
function validatePackManifest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "El manifiesto del pack debe ser un objeto JSON";
  }
  if (typeof data.id !== "string" || !SLUG_RE.test(data.id)) {
    return "pack.id invalido";
  }
  const hasArchive = data.archive && typeof data.archive === "object" && !Array.isArray(data.archive);
  if (hasArchive) {
    if (typeof data.archive.url !== "string" || !/^https:\/\//i.test(data.archive.url)) {
      return "archive.url debe ser https";
    }
    if (typeof data.archive.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.archive.sha256)) {
      return "archive.sha256 invalido";
    }
    if (!Number.isFinite(data.archive.size) || data.archive.size <= 0) {
      return "archive.size invalido";
    }
  } else if (!Array.isArray(data.files)) {
    return "pack.files debe ser lista o el pack debe incluir archive";
  }
  for (const [i, file] of (Array.isArray(data.files) ? data.files : [] ).entries()) {
    const where = `files[${i}]`;
    if (typeof file.path !== "string" || file.path.length === 0 || file.path.length > 240) {
      return `${where}.path invalido`;
    }
    // Rutas seguras: nada de traversal ni absolutas.
    const partes = file.path.split(/[\\/]/);
    if (partes.some((p) => p === ".." || p === ".")) {
      return `${where}.path no puede contener ".." ni "."`;
    }
    if (file.path.startsWith("/") || file.path.startsWith("\\")) {
      return `${where}.path no puede ser absoluto`;
    }
    if (typeof file.url !== "string" || !/^https:\/\//i.test(file.url)) {
      return `${where}.url debe ser https`;
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      return `${where}.sha256 invalido`;
    }
    if (!Number.isFinite(file.size) || file.size < 0) return `${where}.size invalido`;
  }
  if (Array.isArray(data.remove)) {
    for (const [i, ruta] of data.remove.entries()) {
      if (typeof ruta !== "string" || ruta.length === 0 || ruta.length > 240) {
        return `remove[${i}]: ruta invalida`;
      }
      const partes = ruta.split(/[\\/]/);
      if (partes.some((p) => p === ".." || p === ".") || ruta.startsWith("/") || ruta.startsWith("\\")) {
        return `remove[${i}]: ruta no puede contener ".." ni ser absoluta`;
      }
    }
  }
  return null;
}

async function handlePublic(request, env, url) {
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "") {
    return jsonResponse({ name: "eryon-events", ok: true });
  }

  if (pathname === "/events") {
    const raw = await env.EVENTS_DATA.get("manifest");
    if (!raw) {
      return jsonResponse({ version: 1, updated: null, events: [] });
    }
    const etag = `"${await sha256Hex(raw)}"`;
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...CORS_HEADERS } });
    }
    return new Response(raw, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        ETag: etag,
        ...CORS_HEADERS
      }
    });
  }

  const packMatch = pathname.match(/^\/pack\/([a-z0-9][a-z0-9_-]{0,63})$/);
  if (packMatch) {
    const raw = await env.EVENTS_DATA.get(`pack:${packMatch[1]}`);
    if (!raw) {
      return jsonResponse({ error: "Manifiesto de pack no encontrado" }, 404);
    }
    const etag = `"${await sha256Hex(raw)}"`;
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...CORS_HEADERS } });
    }
    return new Response(raw, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        ETag: etag,
        ...CORS_HEADERS
      }
    });
  }

  const imgMatch = pathname.match(/^\/img\/([A-Za-z0-9_.-]{8,88})$/);
  if (imgMatch) {
    const key = imgMatch[1];
    const obj = await env.EVENTS_IMG.getWithMetadata(key, { type: "arrayBuffer" });
    if (!obj.value) {
      return jsonResponse({ error: "Imagen no encontrada" }, 404);
    }
    const type = obj.metadata && obj.metadata.type ? obj.metadata.type : "application/octet-stream";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
        ...CORS_HEADERS
      }
    });
  }

  // Archivos del modpack de un evento (mods propios, configs,
  // layouts de FancyMenu, recursos). Siempre se sirven como
  // application/octet-stream: nada se ejecuta desde el Worker; la
  // integridad real la da el SHA-256 que el launcher verifica.
  const fileMatch = pathname.match(/^\/file\/([a-f0-9]{64})$/);
  if (fileMatch) {
    const key = fileMatch[1];
    const manifest = await env.EVENTS_IMG.get(`file:${key}`, "json");
    let body;
    if (manifest?.chunked) {
      const parts = [];
      for (let index = 0; index < manifest.chunks; index += 1) {
        const part = await env.EVENTS_IMG.get(`chunk:${key}:${index}`, "arrayBuffer");
        if (!part) return jsonResponse({ error: "Archivo incompleto" }, 503);
        parts.push(new Uint8Array(part));
      }
      body = new Uint8Array(manifest.size);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }
    } else {
      const obj = await env.EVENTS_IMG.getWithMetadata(key, { type: "arrayBuffer" });
      if (!obj.value) return jsonResponse({ error: "Archivo no encontrado" }, 404);
      body = obj.value;
    }
    return new Response(obj.value, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(manifest?.size || body.byteLength),
        ...CORS_HEADERS
      }
    });
  }

  return jsonResponse({ error: "Ruta no encontrada" }, 404);
}

async function handleAdmin(request, env, url) {
  const auth = isAuthorized(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  const pathname = url.pathname;

  // ComprobaciÃ³n segura de credenciales: no modifica el manifiesto.
  if (request.method === "GET" && pathname === "/admin/events") {
    return jsonResponse({ ok: true });
  }

  if (request.method === "POST" && pathname === "/admin/events") {
    const raw = await request.text();
    if (raw.length > MAX_MANIFEST_BYTES) {
      return jsonResponse({ error: "Manifiesto demasiado grande (max 2 MB)" }, 413);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "JSON invalido" }, 400);
    }
    const problem = validateEventsManifest(data);
    if (problem) {
      return jsonResponse({ error: problem }, 400);
    }
    const payload = JSON.stringify({ version: 1, updated: new Date().toISOString(), ...data });
    await env.EVENTS_DATA.put("manifest", payload);
    return jsonResponse({ ok: true, hash: await sha256Hex(payload) });
  }

  const packWrite = pathname.match(/^\/admin\/pack\/([a-z0-9][a-z0-9_-]{0,63})$/);
  if (request.method === "POST" && packWrite) {
    const id = packWrite[1];
    const raw = await request.text();
    if (raw.length > MAX_PACK_BYTES) {
      return jsonResponse({ error: "Manifiesto de pack demasiado grande (max 2 MB)" }, 413);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "JSON invalido" }, 400);
    }
    if (data.id !== id) {
      return jsonResponse({ error: "El id del pack no coincide con la ruta" }, 400);
    }
    const problem = validatePackManifest(data);
    if (problem) {
      return jsonResponse({ error: problem }, 400);
    }
    const payload = JSON.stringify(data);
    await env.EVENTS_DATA.put(`pack:${id}`, payload);
    return jsonResponse({ ok: true, hash: await sha256Hex(payload) });
  }

  if (request.method === "POST" && pathname === "/admin/img") {
    const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim();
    const ext = IMAGE_TYPES[contentType];
    if (!ext) {
      return jsonResponse({ error: "Tipo de imagen no permitido (png, jpg o webp)" }, 415);
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
      return jsonResponse({ error: "Imagen vacia o mayor a 2 MB" }, 413);
    }
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const key = `${hex(digest).slice(0, 32)}.${ext}`;
    await env.EVENTS_IMG.put(key, buffer, {
      metadata: { type: contentType, size: buffer.byteLength }
    });
    return jsonResponse({ ok: true, key, url: `/img/${key}`, size: buffer.byteLength });
  }

  const imgDelete = pathname.match(/^\/admin\/img\/([A-Za-z0-9_.-]{8,88})$/);
  if (request.method === "DELETE" && imgDelete) {
    await env.EVENTS_IMG.delete(imgDelete[1]);
    return jsonResponse({ ok: true });
  }

  // Subida de archivos genericos del pack (mods propios, configs,
  // layouts). Los archivos grandes se dividen en partes de 8 MiB porque
  // KV limita el tamaño de cada valor, pero el archivo completo puede
  // llegar hasta 100 MB. La clave es el SHA-256 completo del contenido.
  if (request.method === "POST" && pathname === "/admin/file-chunk") {
    const fileHash = request.headers.get("X-File-Sha256") || "";
    const index = Number(request.headers.get("X-Chunk-Index"));
    const total = Number(request.headers.get("X-Chunk-Total"));
    if (!/^[a-f0-9]{64}$/.test(fileHash) || !Number.isInteger(index) || index < 0 ||
        !Number.isInteger(total) || total < 2 || total > 20) {
      return jsonResponse({ error: "Datos de parte invalidos" }, 400);
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > FILE_CHUNK_BYTES) {
      return jsonResponse({ error: "Parte vacia o demasiado grande" }, 413);
    }
    await env.EVENTS_IMG.put(`chunk:${fileHash}:${index}`, buffer, {
      metadata: { type: "file-chunk", size: buffer.byteLength, total }
    });
    return jsonResponse({ ok: true, index });
  }

  if (request.method === "POST" && pathname === "/admin/file-complete") {
    const data = await request.json().catch(() => null);
    const fileHash = data?.sha256;
    const size = Number(data?.size);
    const chunks = Number(data?.chunks);
    if (!/^[a-f0-9]{64}$/.test(fileHash) || !Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES ||
        !Number.isInteger(chunks) || chunks < 2 || chunks > 20) {
      return jsonResponse({ error: "Datos de archivo invalidos" }, 400);
    }
    let totalSize = 0;
    for (let index = 0; index < chunks; index += 1) {
      const part = await env.EVENTS_IMG.get(`chunk:${fileHash}:${index}`, "arrayBuffer");
      if (!part) return jsonResponse({ error: "Falta una parte del archivo" }, 409);
      totalSize += part.byteLength;
    }
    if (totalSize !== size) return jsonResponse({ error: "El tamaño del archivo no coincide" }, 400);
    await env.EVENTS_IMG.put(`file:${fileHash}`, JSON.stringify({ chunked: true, size, chunks }));
    return jsonResponse({ ok: true, key: fileHash, sha256: fileHash, url: `/file/${fileHash}`, size });
  }

  // layouts). Para archivos pequeños se conserva la subida directa.
  // La clave es el SHA-256 completo del contenido: quien sube obtiene el hash
  // SHA-256 completo del contenido: quien sube obtiene el hash
  // listo para el manifiesto.
  if (request.method === "POST" && pathname === "/admin/file") {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > FILE_CHUNK_BYTES) {
      return jsonResponse({ error: "Archivo vacio o mayor a 8 MB en subida directa" }, 413);
    }
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const key = hex(digest);
    await env.EVENTS_IMG.put(key, buffer, {
      metadata: { type: "file", size: buffer.byteLength }
    });
    return jsonResponse({
      ok: true,
      key,
      sha256: key,
      url: `/file/${key}`,
      size: buffer.byteLength
    });
  }

  return jsonResponse({ error: "Ruta admin no encontrada" }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/admin")) {
        return await handleAdmin(request, env, url);
      }
      if (request.method === "GET") {
        return await handlePublic(request, env, url);
      }
      return jsonResponse({ error: "Metodo no permitido" }, 405);
    } catch (error) {
      return jsonResponse(
        { error: "Error interno del servidor de eventos" },
        500
      );
    }
  }
};
