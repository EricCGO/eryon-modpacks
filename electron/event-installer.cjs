/**
 * MOTOR DE PREPARACION DE EVENTOS
 *
 * Convierte un evento publicado en una instalacion de Minecraft
 * lista para jugar, reutilizando todo el sistema de instancias:
 *
 * 1. Resuelve/crea la instancia del evento (Fabric + Java via
 *    modpackManager.installInstance).
 * 2. Descarga el manifiesto del modpack del evento (GET /pack/:id)
 *    y verifica cada archivo por SHA-256 y tamano.
 * 3. Descarga SOLO lo que falta o cambio (incremental); los archivos
 *    con hash correcto nunca se vuelven a bajar.
 * 4. Elimina unicamente lo listado en pack.remove (rutas validadas,
 *    nunca saves/ ni datos del jugador).
 * 5. Reporta progreso completo por eryon:launch-event (type
 *    "event-progress"): %, velocidad, archivos, ETA, estado.
 *
 * FancyMenu: los layouts/configs viajan como archivos del manifiesto
 * con hash, asi que cualquier edicion del jugador se detecta y se
 * RESTAURA sola en la siguiente preparacion. Solo se toca lo que
 * esta en el manifiesto: mundos y configuraciones personales no
 * listadas jamas se tocan.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { extractArchive } = require("./extract-archive.cjs");

const TMP_DIRNAME = ".eryon-event-tmp";
const DOWNLOAD_TIMEOUT_MS = 300000;
const DOWNLOAD_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 900;

function createEventInstaller({
  app,
  eventsManager,
  modpackManager,
  sendLaunchEvent,
  isMinecraftRunning
}) {
  const registryFile = () =>
    path.join(app.getPath("userData"), "eryon-event-instances.json");

  const busy = new Set();
  // cache de hash de manifiesto de pack, para no golpear la red en
  // cada consulta de estado.
  const packHashCache = new Map();

  function readRegistry() {
    try {
      const data = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
      return data && typeof data === "object" ? data : { events: {} };
    } catch {
      return { events: {} };
    }
  }

  function writeRegistry(data) {
    const tmp = `${registryFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, registryFile());
  }

  function registryEntry(eventId) {
    return readRegistry().events?.[eventId] || null;
  }

  function saveRegistryEntry(eventId, entry) {
    const data = readRegistry();
    data.events = data.events || {};
    data.events[eventId] = entry;
    writeRegistry(data);
  }

  function emitEventProgress(eventId, payload) {
    if (typeof sendLaunchEvent === "function") {
      sendLaunchEvent({
        type: "event-progress",
        eventId,
        ...payload
      });
    }
  }

  /** Estado de un evento para la UI: preparado y al dia (o no). */
  async function getEventStatus(eventId) {
    if (busy.has(eventId)) {
      return { eventId, status: "preparing" };
    }

    const entry = registryEntry(eventId);
    if (!entry || !entry.instanceId) {
      return { eventId, status: "not-prepared" };
    }

    try {
      const instance = await modpackManager.getInstance(entry.instanceId);
      if (!instance) throw new Error("sin instancia");

      // Al dia: si sabemos el hash del manifiesto publicado y
      // coincide con el instalado, no hace falta tocar nada.
      let upToDate = Boolean(entry.packHash);
      if (entry.packHash && packHashCache.has(eventId)) {
        upToDate = packHashCache.get(eventId) === entry.packHash;
      }

      return {
        eventId,
        status: upToDate ? "ready" : "update-available",
        instanceId: entry.instanceId,
        instanceName: instance.name,
        packHash: entry.packHash,
        preparedAt: entry.preparedAt
      };
    } catch {
      // La instancia del evento fue borrada: hay que prepararla de nuevo.
      return { eventId, status: "not-prepared" };
    }
  }

  /** Nombre de instancia valido (2-48 chars) a partir del evento. */
  function nombreInstancia(event) {
    const base = `Evento ${event.title || event.id}`
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return base.slice(0, 48);
  }

  /**
   * Flujo principal: prepara (o repara/actualiza) la instancia del
   * evento. No lanza: el resultado va por event-progress.
   */
  async function prepareEvent(eventId, { forzarDescarga = false } = {}) {
    if (busy.has(eventId)) {
      throw new Error("Este evento ya se está preparando.");
    }
    busy.add(eventId);

    const tmpRoot = path.join(
      app.getPath("userData"),
      "eryon-event-tmp",
      eventId
    );

    try {
      emitEventProgress(eventId, {
        status: "checking",
        message: "Consultando el manifiesto del evento...",
        percent: 0
      });

      // 1) Evento desde el manifiesto publicado.
      const lista = await eventsManager.getEvents({ force: false });
      const event = (lista.events || []).find((ev) => ev.id === eventId);
      if (!event) {
        throw new Error("El evento ya no existe en el servidor.");
      }

      // 2) Manifiesto del modpack del evento.
      const pack = await eventsManager.getEventPack(event.packId || eventId);

      // 3) Instancia del evento: existente o nueva (Fabric + Java).
      let entry = registryEntry(eventId);
      let instance = null;

      if (entry?.instanceId) {
        try {
          instance = await modpackManager.getInstance(entry.instanceId);
        } catch {
          instance = null;
        }
      }

      if (!instance) {
        emitEventProgress(eventId, {
          status: "checking",
          message: "Creando la instalación del evento (Fabric + Java)...",
          percent: 0
        });

        instance = await modpackManager.installInstance({
          name: nombreInstancia(event),
          minecraftVersion:
            pack.minecraft || event.minecraft?.version || "1.21.1",
          loader: pack.loader || event.minecraft?.loader || "fabric",
          loaderVersion: pack.loaderVersion || null
        });

        entry = {
          instanceId: instance.id,
          instanceName: instance.name,
          preparedAt: null,
          packHash: null
        };
        saveRegistryEntry(eventId, entry);
      }

      const gameDirectory = instance.gameDirectory;

      // 4) Si el pack pide otra version del cargador, se alinea
      //    (sin borrar nada del jugador).
      const packLoaderVersion = pack.loaderVersion || instance.loaderVersion;
      if (
        packLoaderVersion &&
        instance.loaderVersion &&
        packLoaderVersion !== instance.loaderVersion
      ) {
        emitEventProgress(eventId, {
          status: "checking",
          message: `Actualizando Fabric a ${packLoaderVersion}...`,
          percent: 0
        });
        try {
          await modpackManager.updateInstanceLoader(
            instance.id,
            packLoaderVersion
          );
        } catch (error) {
          // El juego puede funcionar con la version previa; no
          // bloqueamos la preparacion por esto.
          emitEventProgress(eventId, {
            status: "checking",
            message: `Aviso: no se pudo alinear Fabric (${error?.message}).`
          });
        }
      }

      if (typeof isMinecraftRunning === "function" && isMinecraftRunning()) {
        throw new Error(
          "Cierra Minecraft antes de preparar o actualizar el evento."
        );
      }

      // 5) Inventario: decide que archivos hay que bajar.
      const files = Array.isArray(pack.files) ? pack.files : [];
      const remove = Array.isArray(pack.remove) ? pack.remove : [];

      // Un modpack completo puede publicarse como un ZIP de GitHub Releases.
      // Se valida el archivo antes de extraerlo y solo se copian las carpetas
      // permitidas; mundos, logs y opciones personales quedan intactos.
      if (pack.archive) {
        const archivePath = path.join(tmpRoot, "event-pack.zip");
        const extractedRoot = path.join(tmpRoot, "archive");
        const archiveState = { velocidad: 0 };
        let archiveBytes = 0;
        emitEventProgress(eventId, {
          status: "downloading",
          message: "Descargando el modpack completo...",
          percent: 0
        });
        await fsp.mkdir(tmpRoot, { recursive: true });
        await downloadWithProgress(
          pack.archive.url,
          archivePath,
          (delta) => {
            archiveBytes += delta;
            emitEventProgress(eventId, {
              status: "downloading",
              message: "Descargando el modpack completo...",
              percent: Math.min(100, (archiveBytes / pack.archive.size) * 100),
              speedBytes: archiveState.velocidad
            });
          },
          archiveState
        );
        const archiveStat = await fsp.stat(archivePath);
        const archiveHash = await sha256File(archivePath);
        if (archiveStat.size !== pack.archive.size || archiveHash.toLowerCase() !== pack.archive.sha256.toLowerCase()) {
          throw new Error(
            `El ZIP no coincide. Esperado: ${pack.archive.sha256} (${pack.archive.size} bytes); ` +
            `recibido: ${archiveHash} (${archiveStat.size} bytes). Verifica que la URL sea el archivo de la Release y vuelve a pulsar VERIFICAR ZIP.`
          );
        }
        await extractArchive(archivePath, extractedRoot);

        const allowedRoots = ["mods", "config", "resourcepacks", "shaderpacks"];
        let sourceRoot = extractedRoot;
        const directEntries = await fsp.readdir(extractedRoot, { withFileTypes: true });
        if (!directEntries.some((entry) => allowedRoots.includes(entry.name))) {
          const folders = directEntries.filter((entry) => entry.isDirectory());
          if (folders.length === 1) sourceRoot = path.join(extractedRoot, folders[0].name);
        }

        async function copyAllowed(sourceDirectory, relativeRoot) {
          let entries;
          try {
            entries = await fsp.readdir(sourceDirectory, { withFileTypes: true });
          } catch (error) {
            if (error?.code === "ENOENT") return;
            throw error;
          }
          for (const entry of entries) {
            const relative = path.join(relativeRoot, entry.name).replaceAll(path.sep, "/");
            const source = path.join(sourceDirectory, entry.name);
            if (entry.isDirectory()) {
              await copyAllowed(source, relative);
            } else if (entry.isFile()) {
              const destination = eventsManager.resolveEventFilePath(gameDirectory, relative);
              await fsp.mkdir(path.dirname(destination), { recursive: true });
              await fsp.copyFile(source, destination);
            }
          }
        }

        for (const root of allowedRoots) {
          await copyAllowed(path.join(sourceRoot, root), root);
        }
        emitEventProgress(eventId, {
          status: "downloading",
          message: "Modpack completo instalado.",
          percent: 100,
          speedBytes: archiveState.velocidad
        });
      }

      let pendientes = [];
      let bytesTotalesPendientes = 0;

      emitEventProgress(eventId, {
        status: "checking",
        message: `Verificando ${files.length} archivos...`,
        percent: 0,
        totalFiles: files.length
      });

      for (const file of files) {
        const destino = eventsManager.resolveEventFilePath(
          gameDirectory,
          file.path
        );

        let necesita = forzarDescarga;
        if (!necesita) {
          try {
            const stat = await fsp.stat(destino);
            if (stat.size !== file.size) {
              necesita = true;
            } else {
              const hash = await sha256File(destino);
              if (hash.toLowerCase() !== String(file.sha256).toLowerCase()) {
                necesita = true;
              }
            }
          } catch {
            necesita = true;
          }
        }

        if (necesita) {
          pendientes.push({ file, destino });
          bytesTotalesPendientes += file.size || 0;
        }
      }

      // 6) Eliminaciones del manifiesto (rutas validadas; NUNCA toca
      //    saves/, screenshots, options.txt ni nada fuera del pack).
      for (const relative of remove) {
        try {
          const destino = eventsManager.resolveEventFilePath(
            gameDirectory,
            relative
          );
          await fsp.rm(destino, { force: true });
        } catch {
          // Si la ruta no valida, resolveEventFilePath ya lanzo y se
          // ignora el elemento problematico sin tocar nada mas.
        }
      }

      // 7) Descarga incremental con progreso, velocidad y ETA.
      const totalArchivos = files.length;
      const completadosBase = totalArchivos - pendientes.length;
      let bytesListos = 0;
      let completados = completadosBase;
      const estadoDescarga = { velocidad: 0 };
      let ultimoAviso = 0;

      function reportar(status, message, forzar = false) {
        const ahora = Date.now();
        if (!forzar && ahora - ultimoAviso < 400) return;
        ultimoAviso = ahora;

        const percent =
          bytesTotalesPendientes > 0
            ? Math.min(100, (bytesListos / bytesTotalesPendientes) * 100)
            : 100;

        const payload = {
          status,
          message,
          percent: status === "ready" ? 100 : percent,
          downloadedFiles: completados,
          totalFiles: totalArchivos,
          speedBytes: estadoDescarga.velocidad,
          etaSeconds:
            estadoDescarga.velocidad > 0
              ? Math.max(0, (bytesTotalesPendientes - bytesListos) / estadoDescarga.velocidad)
              : null
        };
        if (!message) delete payload.message;

        emitEventProgress(eventId, payload);
      }

      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(tmpRoot, { recursive: true });

      let fallidos = 0;
      let ultimoError = null;

      for (const [i, item] of pendientes.entries()) {
        const { file, destino } = item;
        reportar(
          "downloading",
          `Descargando ${path.basename(file.path)} (${completados + 1}/${totalArchivos})...`,
          true
        );

        try {
          const tmpFile = path.join(tmpRoot, `${i}.part`);
          await downloadWithProgress(
            file.url,
            tmpFile,
            (delta) => {
              bytesListos += delta;
            },
            estadoDescarga
          );

          const hash = await sha256File(tmpFile);
          if (hash.toLowerCase() !== String(file.sha256).toLowerCase()) {
            throw new Error(
              `El archivo ${path.basename(file.path)} llegó corrupto (SHA-256 no coincide).`
            );
          }

          await fsp.mkdir(path.dirname(destino), { recursive: true });
          await fsp.copyFile(tmpFile, destino);

          completados += 1;
          bytesListos += 0; // bytes ya contados al descargar
          reportar("downloading", null, true);
        } catch (error) {
          fallidos += 1;
          ultimoError = error;
          emitEventProgress(eventId, {
            status: "downloading",
            message: `Aviso: no se pudo descargar ${path.basename(file.path)} (${error?.message}).`
          });
        }
      }

      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

      // 8) Resultado.
      if (fallidos > 0) {
        throw new Error(
          `${fallidos} archivo(s) no se pudieron instalar. Último problema: ${
            ultimoError?.message || "desconocido"
          }. Reintenta para continuar la descarga (lo ya instalado se conserva).`
        );
      }

      const packHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(pack))
        .digest("hex");

      saveRegistryEntry(eventId, {
        instanceId: instance.id,
        instanceName: instance.name,
        preparedAt: new Date().toISOString(),
        packHash
      });
      packHashCache.set(eventId, packHash);

      // Incluimos instanceId en el evento final: la interfaz lo usa para
      // desbloquear los botones que estaban mostrando PREPARANDO...
      emitEventProgress(eventId, {
        status: "ready",
        message: "Evento listo para jugar",
        percent: 100,
        instanceId: instance.id,
        downloadedFiles: totalArchivos,
        totalFiles: totalArchivos,
        speedBytes: estadoDescarga.velocidad,
        etaSeconds: 0
      });

      return {
        ok: true,
        instanceId: instance.id,
        instanceName: instance.name
      };
    } catch (error) {
      emitEventProgress(eventId, {
        status: "error",
        error: error?.message || "Error desconocido preparando el evento"
      });
      return { ok: false, error: error?.message };
    } finally {
      busy.delete(eventId);
    }
  }

  /** SHA-256 de un archivo leyendo por bloques. */
  async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  /**
   * Descarga https con timeout, reintentos, seguimiento de bytes y
   * velocidad. Verificacion SHA-256 posterior la hace quien llama.
   */
  async function downloadWithProgress(url, destino, onBytes, estadoDescarga) {
    let lastError = null;

    for (let attempt = 0; attempt < DOWNLOAD_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      try {
        if (!/^https:\/\//i.test(url)) {
          throw new Error("La URL de descarga debe ser https");
        }

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "*/*" }
        });

        if (!response.ok) {
          throw new Error(`El servidor respondió ${response.status}`);
        }

        if (!response.body) {
          throw new Error("La descarga no trajo contenido");
        }

        let recibidos = 0;
        let ultimosRecibidos = 0;
        let ultimoTiempo = Date.now();

        const source = Readable.fromWeb(response.body);
        source.on("data", (chunk) => {
          recibidos += chunk.length;
          onBytes(chunk.length);

          const ahora = Date.now();
          if (ahora - ultimoTiempo >= 500) {
            const velocidad =
              (recibidos - ultimosRecibidos) / ((ahora - ultimoTiempo) / 1000);
            if (estadoDescarga) {
              estadoDescarga.velocidad = estadoDescarga.velocidad
                ? estadoDescarga.velocidad * 0.6 + velocidad * 0.4
                : velocidad;
            }
            ultimosRecibidos = recibidos;
            ultimoTiempo = ahora;
          }
        });

        await pipeline(source, fs.createWriteStream(destino));
        clearTimeout(timer);
        return;
      } catch (error) {
        lastError = error;
        clearTimeout(timer);
        await fsp.rm(destino, { force: true }).catch(() => {});
        if (attempt < DOWNLOAD_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, DOWNLOAD_RETRY_DELAY_MS));
        }
      }
    }

    throw lastError || new Error("La descarga falló");
  }

  return {
    prepareEvent,
    getEventStatus,
    isPreparing: (eventId) => busy.has(eventId)
  };
}

module.exports = { createEventInstaller };
