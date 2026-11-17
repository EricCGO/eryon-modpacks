
"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  safeStorage
} = require("electron");

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { autoUpdater } = require("electron-updater");
const createModpackManager = require("./modpack-manager.cjs");
const { dedupeInheritedLibraries } = require("./version-libraries.cjs");
const { createLocalSkinServer } = require("./local-skin-server.cjs");
const modsManager = require("./mods-manager.cjs");

// ======================================================
// CARGA DIFERIDA DE MÓDULOS PESADOS
// ======================================================
// MSMC (autenticación Microsoft), Discord RPC y el cliente MCLC
// suman decenas de MB de memoria apenas se require()n. El launcher
// solo los necesita al autenticarse, al lanzar el juego o con
// Discord abierto: se requieren en el momento de uso, no al iniciar.

const execFileAsync = promisify(execFile);

function getMsmc() {
  return require("msmc");
}

function getDiscordRpc() {
  return require("discord-rpc");
}

const SETTINGS_FILE = "eryon-settings.json";
const AUTH_FILE = "eryon-auth.enc";
const ACCOUNTS_FILE = "eryon-accounts.enc";
const ELYBY_ACCOUNT_FILE = "eryon-elyby-account.enc";
const LOCAL_PROFILES_FILE = "eryon-local-profiles.json";
const INSTANCE_SETTINGS_FILE = "eryon-instance-settings.json";
const FIREBASE_FILE = "eryon-firebase.json";
const CURSEFORGE_FILE = "eryon-curseforge.json";

// Archivo de estado de la ventana auxiliar de actualización usada por
// versiones anteriores. La ventana ya no se abre, pero una que siga
// viva de una instalación anterior mantiene bloqueado el logo dentro
// de la carpeta del programa y hace fallar el desinstalador de NSIS
// ("Fallo al desinstalar archivos antiguos: 2"). Escribiendo "done"
// la ventana se cierra sola (consulta el archivo cada 150 ms).
const UPDATE_PROGRESS_FILE = path.join(
  os.tmpdir(),
  "eryon-launcher-update-progress.json"
);

// Log plano del updater: cada evento queda en disco para poder
// diagnosticar el estado de la instalación de actualizaciones.
function updaterLog(message) {
  try {
    fsSync.appendFileSync(
      path.join(os.tmpdir(), "eryon-updater.log"),
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch {
    // El log es diagnóstico: si falla, no debe romper nada.
  }
}

// Cierra cualquier ventana auxiliar de actualización que siga viva.
function markUpdateWindowDone() {
  try {
    fsSync.writeFileSync(
      UPDATE_PROGRESS_FILE,
      JSON.stringify({ status: "done", percent: 100 }),
      "utf8"
    );
  } catch {
    // Sin archivo no pasa nada: no hay ventana que cerrar.
  }
}

const VERSION_MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const ERYON_IDENTITY_1201_MINECRAFT_VERSION = "1.20.1";
const ERYON_IDENTITY_1201_MOD_FILE = "eryon-identity-client-1.20.1.jar";
const ERYON_LEGACY_BADGE_MOD_FILE = "eryon-badge-fabric-1.20.1.jar";
const ERYON_IDENTITY_MINECRAFT_VERSION = "1.21.1";
const ERYON_IDENTITY_CLIENT_MOD_FILE = "eryon-identity-client-1.21.1.jar";

// =====================================================
// REGISTRO DE COMPATIBILIDAD DE ERYON IDENTITY
// =====================================================
// Cada fila apunta a un binario COMPILED y verificado en build/.
// 1.20.1 y 1.21 comparten binario con 1.21.1 porque entre parches
// de la misma versión los nombres intermediario de los mixins
// (PlayerListHud.getPlayerName, renderLabelIfPresent) no cambian.
// Para dar soporte a una versión NUEVA hay que compilar el mod
// contra ella (scripts npm de identity en package.json) y añadir
// su fila a este registro: el resto del launcher no cambia.
const ERYON_IDENTITY_VERSION_FILES = {
  [ERYON_IDENTITY_1201_MINECRAFT_VERSION]: ERYON_IDENTITY_1201_MOD_FILE,
  "1.21": ERYON_IDENTITY_CLIENT_MOD_FILE,
  [ERYON_IDENTITY_MINECRAFT_VERSION]: ERYON_IDENTITY_CLIENT_MOD_FILE
};

function identityModFileFor(version) {
  return ERYON_IDENTITY_VERSION_FILES[String(version)] || null;
}

// =====================================================
// REGISTRO FORGE LEGACY DE ERYON IDENTITY
// =====================================================
// Jars compilados con ForgeGradle-equivalente (Unimined) para
// versiones donde no existe Fabric. 1.8.9 usa el mixin coremod
// embebido del propio jar; se aplica SOLO a instancias forge.
const ERYON_IDENTITY_FORGE_189_MOD_FILE =
  "eryon-identity-forge-1.8.9.jar";

const ERYON_IDENTITY_FORGE_VERSION_FILES = {
  "1.8.9": ERYON_IDENTITY_FORGE_189_MOD_FILE
};

function getForgeInstallerBridgePath() {
  return path.join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    ...(app.isPackaged ? ["app.asar.unpacked"] : []),
    "build",
    ERYON_IDENTITY_FORGE_189_MOD_FILE
  );
}

function identityForgeModFileFor(version) {
  return ERYON_IDENTITY_FORGE_VERSION_FILES[String(version)] || null;
}

const DEFAULT_FIREBASE_DATABASE_URL =
  "https://eryon-launcher-default-rtdb.firebaseio.com";

const RAM_OPTIONS = [2, 4, 6, 8, 12, 16];

const RESOLUTION_OPTIONS = [
  "default",
  "1280x720",
  "1600x900",
  "1920x1080"
];

const activeProcesses = new Map();
const launchingAccounts = new Set();
let repairInProgress = false;

function isMinecraftRunning() {
  return activeProcesses.size > 0 || launchingAccounts.size > 0;
}

function releaseMinecraftAccount(accountKey, child = null) {
  const active = activeProcesses.get(accountKey);
  if (!child || active?.child === child) {
    activeProcesses.delete(accountKey);
  }

  if (activeProcesses.size > 0) {
    const latest = [...activeProcesses.values()].at(-1);
    updateDiscordPresence(true, latest.version);
  } else {
    updateDiscordPresence(false);
  }
}

// ======================================================
// CONFIGURACIÓN DE ACTUALIZACIONES
// ======================================================


let updateDownloaded = false;
let updateInstallScheduled = false;
let updateCheckInProgress = false;

const UPDATE_CHECK_INTERVAL_MS =
  6 * 60 * 60 * 1000; // Cada seis horas


// ======================================================
// DISCORD RICH PRESENCE
// ======================================================

const DISCORD_CLIENT_ID = "1560840725774467112";
const DISCORD_LOGO_KEY = "eryon_launcher";

let discordClient = null;
let discordConnected = false;
let discordStartTimestamp = new Date();

function updateDiscordPresence(isPlaying = false, version = "") {
  if (!discordConnected || !discordClient) return;

  try {
    discordClient.setActivity({
      details: isPlaying
        ? `Jugando Minecraft ${version}`
        : "Explorando Eryon Launcher",
      state: isPlaying
        ? "Iniciado desde Eryon"
        : "Tu Minecraft. Tu experiencia.",
      largeImageKey: DISCORD_LOGO_KEY,
      largeImageText: "Eryon Launcher",
      startTimestamp: discordStartTimestamp,
      instance: false
    });
  } catch (error) {
    console.error(
      "[ERYON] Error de Discord:",
      normalizeError(error)
    );
  }
}

function initializeDiscordPresence() {
  try {
    const RPC = getDiscordRpc();

    RPC.register(DISCORD_CLIENT_ID);

    discordClient = new RPC.Client({
      transport: "ipc"
    });

    discordClient.on("ready", () => {
      discordConnected = true;
      discordStartTimestamp = new Date();

      console.log(
        "[ERYON] Discord Rich Presence conectado."
      );

      updateDiscordPresence(false);
    });

    discordClient.on("disconnected", () => {
      discordConnected = false;
    });

    discordClient.login({
      clientId: DISCORD_CLIENT_ID
    }).catch((error) => {
      discordConnected = false;

      console.log(
        "[ERYON] Discord no disponible:",
        normalizeError(error)
      );
    });
  } catch (error) {
    console.error(
      "[ERYON] Error iniciando Discord:",
      normalizeError(error)
    );
  }
}

// ======================================================
// RUTAS Y CONFIGURACIÓN
// ======================================================

function userDataPath(filename) {
  return path.join(app.getPath("userData"), filename);
}

/**
 * True si la instancia pertenece a un evento gestionado por el
 * instalador de eventos (sus archivos se verifican por hash y se
 * restauran desde el manifiesto en cada preparaci├│n).
 */
function isEventManagedInstance(instanceId) {
  if (!instanceId) return false;
  try {
    const data = JSON.parse(
      require("node:fs").readFileSync(
        userDataPath("eryon-event-instances.json"),
        "utf8"
      )
    );
    const events = data?.events || {};
    return Object.values(events).some(
      (entry) => entry && entry.instanceId === instanceId
    );
  } catch {
    return false;
  }
}

async function getBadgePresenceUrl() {
  let savedConfig = null;
  try {
    savedConfig = JSON.parse(
      await fs.readFile(userDataPath(FIREBASE_FILE), "utf8")
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const databaseUrl = String(
    savedConfig?.databaseURL || DEFAULT_FIREBASE_DATABASE_URL
  ).trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("La URL de Firebase para la presencia no es válida.");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("La presencia Eryon requiere una URL HTTPS válida de Firebase.");
  }

  return `${parsedUrl.toString().replace(/\/+$/, "")}/gamePresence.json`;
}

async function installBundledMod(gameDirectory, modFilename, modLabel) {
  const source = path.join(
    app.getAppPath(),
    "build",
    modFilename
  );
  const jar = await fs.readFile(source).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(
        `No se encontró ${modLabel}. Vuelve a compilar el launcher.`
      );
    }
    throw error;
  });
  if (
    jar.length < 1024 ||
    jar.length > 20 * 1024 * 1024 ||
    jar[0] !== 0x50 ||
    jar[1] !== 0x4b
  ) {
    throw new Error(`El archivo ${modLabel} no es un JAR válido.`);
  }

  const modsDirectory = path.join(gameDirectory, "mods");
  await fs.mkdir(modsDirectory, { recursive: true });
  if (process.platform === "win32") {
    // Es solo ocultamiento visual: el mod se vuelve a instalar si falta al
    // siguiente inicio, aunque alguien quite el atributo o borre el archivo.
    await execFileAsync(
      "attrib.exe",
      ["+h", modsDirectory],
      { windowsHide: true }
    ).catch(() => {});
  }
  const destination = path.join(modsDirectory, modFilename);
  const previous = await fs.readFile(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (
    previous &&
    crypto.timingSafeEqual(
      crypto.createHash("sha256").update(previous).digest(),
      crypto.createHash("sha256").update(jar).digest()
    )
  ) {
    return;
  }

  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, jar, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function removeModFile(gameDirectory, filename) {
  const modPath = path.join(gameDirectory, "mods", filename);
  try {
    await fs.unlink(modPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// =====================================================
// AVISO "PULSA E PARA ABRIR INVENTARIO" (LEGACY)
// =====================================================
// En 1.8.x (hasta 1.11) el juego muestra el aviso del logro
// "Tomar inventario" en la esquina superior derecha y en
// servidores multijugador puede quedar pegado para siempre.
// El propio juego trae el interruptor
// showInventoryAchievementHint en options.txt (sin control en
// el menu de opciones), asi que el launcher lo apaga por el
// usuario antes de cada lanzamiento legacy.
async function hideLegacyInventoryHint(gameDirectory) {
  const optionsFile = path.join(gameDirectory, "options.txt");

  const existing = await fs
    .readFile(optionsFile, "utf8")
    .catch(() => null); // Si falta o no se puede leer, partimos de cero.

  let content;
  let modified = false;

  if (existing == null) {
    // El lanzamiento creara el resto de preferencias con sus
    // valores por defecto; fijamos la nuestra desde el inicio.
    content = "showInventoryAchievementHint:false";
    modified = true;
  } else {
    content = existing;
    const lines = content.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) =>
      line.startsWith("showInventoryAchievementHint:")
    );

    if (lineIndex === -1) {
      lines.push("showInventoryAchievementHint:false");
      content = lines.join("\n");
      modified = true;
    } else if (!lines[lineIndex].endsWith(":false")) {
      lines[lineIndex] = "showInventoryAchievementHint:false";
      content = lines.join("\n");
      modified = true;
    }
  }

  if (!modified) {
    return { hidden: false, alreadyHidden: true };
  }

  const temporary = `${optionsFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, optionsFile);

  return { hidden: true, alreadyHidden: false };
}

async function disableLegacyForgeSplash(gameDirectory) {
  const configFile = path.join(
    gameDirectory,
    "config",
    "splash.properties"
  );
  const existing = await fs.readFile(configFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const lines = existing.split(/\r?\n/).filter((line) =>
    !/^\s*enabled\s*=/.test(line)
  );
  lines.push("enabled=false");
  const content = `${lines.filter((line, index) =>
    line.length > 0 || index < lines.length - 1
  ).join("\n")}\n`;

  if (content === existing) return false;

  await fs.mkdir(path.dirname(configFile), { recursive: true });
  const temporary = `${configFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, configFile);
  return true;
}

async function installEryonIdentity1201Mod(gameDirectory) {
  return installBundledMod(
    gameDirectory,
    ERYON_IDENTITY_1201_MOD_FILE,
    "ERYON Identity para Minecraft 1.20.1"
  );
}

async function installEryonIdentityClientMod(gameDirectory) {
  return installBundledMod(
    gameDirectory,
    ERYON_IDENTITY_CLIENT_MOD_FILE,
    "el mod Eryon Identity para Minecraft 1.21.1"
  );
}

function sharedMinecraftPath(...segments) {
  return path.join(
    app.getPath("userData"),
    "eryon-minecraft-shared",
    ...segments
  );
}

function defaultSettings() {
  const defaultGameDirectory = path.join(
    app.getPath("userData"),
    "minecraft"
  );

  // En equipos con 6 GB de RAM o menos, no tiene sentido fijar 4 GB
  // por defecto: dejaría el PC sin margen para el sistema.
  const totalMemoryBytes = os.totalmem();
  const defaultRamGB = totalMemoryBytes <= 6 * 1024 * 1024 * 1024 ? 2 : 4;

  return {
    ramGB: defaultRamGB,
    resolution: "1280x720",
    fullscreen: false,
    gameDirectory: defaultGameDirectory,
    javaPath: "",
    jvmArgs: "",
    lowEndMode: false,
    optimizeBundle: true,
    shareGamePresence: true,
    selectedVersion: "",
    accountMode: "premium"
  };
}

function validateSettings(input = {}) {
  const defaults = defaultSettings();

  const ramGB = Number(input.ramGB);
  const resolution = String(
    input.resolution ?? defaults.resolution
  );

  const gameDirectory = String(
    input.gameDirectory ?? defaults.gameDirectory
  );

  const javaPath = String(input.javaPath ?? "");
  const jvmArgs = String(input.jvmArgs ?? "");

  const selectedVersion = String(
    input.selectedVersion ?? ""
  );

  const accountMode =
    input.accountMode === "elyby"
      ? "elyby"
      : input.accountMode === "local" ||
          input.accountMode === "non-premium"
        ? "local"
        : "premium";

  return {
    ramGB: RAM_OPTIONS.includes(ramGB)
      ? ramGB
      : defaults.ramGB,

    resolution: RESOLUTION_OPTIONS.includes(resolution)
      ? resolution
      : defaults.resolution,

    fullscreen: input.fullscreen === true,

    gameDirectory:
      gameDirectory.length > 0 &&
      gameDirectory.length <= 1024 &&
      !gameDirectory.includes("\0")
        ? gameDirectory
        : defaults.gameDirectory,

    javaPath:
      javaPath.length <= 1024 &&
      !javaPath.includes("\0")
        ? javaPath
        : "",

    jvmArgs:
      jvmArgs.length <= 2000 &&
      !jvmArgs.includes("\0")
        ? jvmArgs
        : "",

    lowEndMode: input.lowEndMode === true,
    optimizeBundle: input.optimizeBundle !== false,
    shareGamePresence: true,

    selectedVersion:
      /^[A-Za-z0-9._-]{1,40}$/.test(selectedVersion)
        ? selectedVersion
        : "",

    accountMode
  };
}

async function readSettings() {
  try {
    const content = await fs.readFile(
      userDataPath(SETTINGS_FILE),
      "utf8"
    );

    return validateSettings(JSON.parse(content));
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(input = {}) {
  const current = await readSettings();

  const merged = {
    ...current,
    ...(input && typeof input === "object"
      ? input
      : {})
  };

  const settings = validateSettings(merged);

  const destination = userDataPath(SETTINGS_FILE);
  const temporary = `${destination}.tmp`;

  await fs.mkdir(app.getPath("userData"), {
    recursive: true
  });

  await fs.writeFile(
    temporary,
    JSON.stringify(settings, null, 2),
    "utf8"
  );

  await fs.rename(temporary, destination);

  return settings;
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") {
    return "Error desconocido.";
  }

  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof error.error_description === "string" && error.error_description) ||
    (typeof error.errorMessage === "string" && error.errorMessage) ||
    (typeof error.ts === "string"
      ? getMsmc().lexicon.getCode(error.ts)
      : "");
  const status = Number.isInteger(error.response?.status)
    ? ` (HTTP ${error.response.status})`
    : "";

  return message
    ? `${message}${status}`
    : `Error inesperado${status}.`;
}

function redactSensitiveData(value) {
  return String(value ?? "")
    .replace(
      /(--accessToken\s+)\S+/gi,
      "$1[OCULTO]"
    )
    .replace(
      /("access_token"\s*:\s*")[^"]+/gi,
      '$1[OCULTO]'
    )
    .replace(
      /(access_token=)[^\s&]+/gi,
      "$1[OCULTO]"
    );
}

// ======================================================
// COMUNICACIÓN CON LA INTERFAZ
// ======================================================

function sendLaunchEvent(payload, targetWindow = null) {
  if (targetWindow) {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("eryon:launch-event", payload);
    }
    return;
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("eryon:launch-event", payload);
    }
  }
}

// ======================================================
// ALMACENAMIENTO CIFRADO
// ======================================================

async function isSecureStorageAvailable() {
  try {
    if (
      typeof safeStorage.isAsyncEncryptionAvailable ===
      "function"
    ) {
      if (
        !(await safeStorage.isAsyncEncryptionAvailable())
      ) {
        return false;
      }
    } else if (
      typeof safeStorage.isEncryptionAvailable ===
      "function"
    ) {
      if (!safeStorage.isEncryptionAvailable()) {
        return false;
      }
    } else {
      return false;
    }

    if (
      process.platform === "linux" &&
      typeof safeStorage.getSelectedStorageBackend ===
        "function" &&
      safeStorage.getSelectedStorageBackend() ===
        "basic_text"
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function encryptText(text) {
  if (
    typeof safeStorage.encryptStringAsync === "function"
  ) {
    return safeStorage.encryptStringAsync(text);
  }

  if (typeof safeStorage.encryptString === "function") {
    return safeStorage.encryptString(text);
  }

  throw new Error(
    "El almacenamiento cifrado no está disponible."
  );
}

async function decryptText(buffer) {
  if (
    typeof safeStorage.decryptStringAsync === "function"
  ) {
    const result =
      await safeStorage.decryptStringAsync(buffer);

    return typeof result === "string"
      ? result
      : result.result;
  }

  if (typeof safeStorage.decryptString === "function") {
    return safeStorage.decryptString(buffer);
  }

  throw new Error(
    "No se puede descifrar el archivo de cuentas."
  );
}

async function writeEncryptedFile(filename, data) {
  if (!(await isSecureStorageAvailable())) {
    throw new Error(
      "El almacenamiento seguro de Electron no está disponible. " +
      "No se guardaron las credenciales."
    );
  }

  const encrypted = await encryptText(
    JSON.stringify(data)
  );

  const destination = userDataPath(filename);
  const temporary = `${destination}.tmp`;

  await fs.mkdir(app.getPath("userData"), {
    recursive: true
  });

  await fs.writeFile(
    temporary,
    encrypted,
    { mode: 0o600 }
  );

  await fs.rename(temporary, destination);
}

async function readEncryptedFile(filename) {
  if (!(await isSecureStorageAvailable())) {
    return null;
  }

  try {
    const buffer = await fs.readFile(
      userDataPath(filename)
    );

    const content = await decryptText(buffer);

    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

async function deleteFile(filename) {
  try {
    await fs.unlink(userDataPath(filename));
  } catch {
    // El archivo puede no existir.
  }
}

// ======================================================
// CUENTAS PREMIUM — MICROSOFT
// ======================================================

function normalizeUuid(value) {
  return String(value ?? "")
    .replace(/[^a-fA-F0-9-]/g, "");
}

function formatUuid(value) {
  const compact = String(value ?? "").replace(/[^a-fA-F0-9]/g, "");
  if (!/^[a-f\d]{32}$/i.test(compact)) return String(value ?? "");

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join("-");
}

function accountIdentity(token, savedToken) {
  const data = savedToken ?? {};
  const profile = token?.profile ?? token?.user ?? {};
  const metadata = token?.meta ?? {};

  const uuid = normalizeUuid(
    profile.id ??
    profile.uuid ??
    token?.uuid ??
    data.uuid ??
    data.profile?.id
  );

  const name = String(
    profile.name ??
    profile.username ??
    token?.name ??
    token?.username ??
    data.name ??
    data.username ??
    ""
  ).trim();

  if (!uuid || !name) {
    throw new Error(
      "Microsoft autenticó la sesión, pero no se pudo obtener " +
      "el nombre y UUID de Minecraft."
    );
  }

  return {
    id: uuid.toLowerCase(),
    uuid,
    name,
    avatarUrl:
      `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/100`,
    accountType: "Microsoft",
    expiresAt:
      metadata.expiresAt ??
      data.expiresAt ??
      null
  };
}

function publicAccount(account) {
  if (!account) return null;

  return {
    id: account.id,
    uuid: account.uuid,
    name: account.name,
    avatarUrl: account.avatarUrl,
    accountType: account.accountType ?? "Microsoft",
    expiresAt: account.expiresAt ?? null
  };
}

function emptyAccountsStore() {
  return {
    activeAccountId: null,
    accounts: []
  };
}

async function writeAccountsStore(store) {
  const clean = {
    activeAccountId: store.activeAccountId ?? null,
    accounts: Array.isArray(store.accounts)
      ? store.accounts
      : []
  };

  await writeEncryptedFile(
    ACCOUNTS_FILE,
    clean
  );
}

async function readLegacyAuthToken() {
  try {
    const encrypted = await fs.readFile(
      userDataPath(AUTH_FILE)
    );

    const decrypted = await decryptText(encrypted);

    return decrypted ? JSON.parse(decrypted) : null;
  } catch {
    return null;
  }
}

async function migrateLegacyAccount(store) {
  if (store.accounts.length > 0) {
    return store;
  }

  const oldToken = await readLegacyAuthToken();

  if (!oldToken) {
    return store;
  }

  try {
    const { Auth, tokenUtils } = getMsmc();

    if (!tokenUtils?.fromMclcToken) {
      return store;
    }

    const authManager = new Auth("select_account");

    const minecraftToken =
      tokenUtils.fromMclcToken(
        authManager,
        oldToken
      );

    await minecraftToken.refresh(true);

    if (!(await minecraftToken.validate())) {
      return store;
    }

    const savedToken = minecraftToken.mclc(true);

    const identity = accountIdentity(
      minecraftToken,
      savedToken
    );

    const account = {
      ...identity,
      token: savedToken
    };

    store.accounts.push(account);
    store.activeAccountId = account.id;

    await writeAccountsStore(store);
    await deleteFile(AUTH_FILE);

    console.log(
      "[ERYON] Se migró la sesión anterior al sistema de cuentas."
    );
  } catch (error) {
    console.warn(
      "[ERYON] No se pudo migrar la sesión anterior:",
      normalizeError(error)
    );
  }

  return store;
}

async function readAccountsStore() {
  const saved = await readEncryptedFile(
    ACCOUNTS_FILE
  );

  const store =
    saved && Array.isArray(saved.accounts)
      ? {
          activeAccountId:
            saved.activeAccountId ?? null,

          accounts: saved.accounts.filter(
            (account) =>
              account &&
              typeof account.id === "string" &&
              typeof account.token === "object"
          )
        }
      : emptyAccountsStore();

  return migrateLegacyAccount(store);
}

async function getAccountsData() {
  const store = await readAccountsStore();

  const activeAccount =
    store.accounts.find(
      (account) =>
        account.id === store.activeAccountId
    ) ?? null;

  return {
    accounts: store.accounts.map(publicAccount),
    activeAccountId: store.activeAccountId,
    activeAccount: publicAccount(activeAccount)
  };
}

async function saveMinecraftAccount(minecraftToken) {
  if (
    !minecraftToken ||
    !(await minecraftToken.validate())
  ) {
    throw new Error(
      "La sesión no es válida o no tiene acceso a Minecraft Java Edition."
    );
  }

  const savedToken = minecraftToken.mclc(true);

  const identity = accountIdentity(
    minecraftToken,
    savedToken
  );

  const store = await readAccountsStore();

  const existingIndex = store.accounts.findIndex(
    (account) => account.id === identity.id
  );

  const account = {
    ...identity,
    token: savedToken
  };

  if (existingIndex >= 0) {
    store.accounts[existingIndex] = account;
  } else {
    store.accounts.push(account);
  }

  store.activeAccountId = account.id;

  await writeAccountsStore(store);
  await deleteFile(AUTH_FILE);

  return publicAccount(account);
}

async function loginMicrosoftAccount() {
  sendLaunchEvent({
    type: "status",
    message: "Abriendo el inicio de sesión de Microsoft..."
  });

  const { Auth } = getMsmc();
  const authManager = new Auth("select_account");
  const xboxManager = await authManager.launch("raw");

  const minecraftToken =
    await xboxManager.getMinecraft();

  if (
    !minecraftToken ||
    !(await minecraftToken.validate())
  ) {
    throw new Error(
      "No se pudo validar la cuenta. Comprueba que tenga acceso a Minecraft Java Edition."
    );
  }

  const account =
    await saveMinecraftAccount(minecraftToken);

  sendLaunchEvent({
    type: "log",
    message:
      `Cuenta ${account.name} conectada y guardada de forma segura.`
  });

  return {
    minecraftToken,
    account,
    restored: false
  };
}

async function selectStoredAccount(accountId) {
  const store = await readAccountsStore();

  const account = store.accounts.find(
    (item) => item.id === accountId
  );

  if (!account) {
    throw new Error(
      "No se encontró el perfil seleccionado."
    );
  }

  store.activeAccountId = account.id;

  await writeAccountsStore(store);

  // Mantiene Premium como modo predeterminado para ventanas nuevas.
  await saveSettings({
    accountMode: "premium"
  });

  return publicAccount(account);
}

async function logoutAccount(accountId = null) {
  const store = await readAccountsStore();

  const targetId =
    accountId || store.activeAccountId;

  if (!targetId) {
    return getAccountsData();
  }

  store.accounts = store.accounts.filter(
    (account) => account.id !== targetId
  );

  if (store.activeAccountId === targetId) {
    store.activeAccountId =
      store.accounts[0]?.id ?? null;
  }

  if (store.accounts.length === 0) {
    await deleteFile(ACCOUNTS_FILE);
    await deleteFile(AUTH_FILE);
  } else {
    await writeAccountsStore(store);
  }

  return getAccountsData();
}

async function authenticateMinecraft(accountId = null, launchWindow = null) {
  const store = await readAccountsStore();
  const selectedAccountId =
    typeof accountId === "string" && accountId
      ? accountId
      : store.activeAccountId;

  if (
    !store.accounts.length ||
    !selectedAccountId
  ) {
    throw new Error(
      "No hay una cuenta Microsoft seleccionada. " +
      "Abre Perfiles y añade o selecciona tu cuenta Premium."
    );
  }

  let account = store.accounts.find(
    (item) => item.id === selectedAccountId
  );

  if (!account) {
    throw new Error(
      "La cuenta Microsoft seleccionada no se encontró en el almacenamiento."
    );
  }

  try {
    sendLaunchEvent({
      type: "status",
      message:
        `Recuperando la sesión de ${account.name}...`
    }, launchWindow);

    const { Auth, tokenUtils } = getMsmc();
    const authManager = new Auth("select_account");

    const minecraftToken =
      tokenUtils.fromMclcToken(
        authManager,
        account.token
      );

    if (
      (await minecraftToken.validate()) &&
      Number(account.token.meta?.exp) > Date.now() + 5 * 60 * 1000
    ) {
      return {
        minecraftToken,
        account: publicAccount(account),
        restored: true
      };
    }

    await minecraftToken.refresh(false);

    if (!(await minecraftToken.validate())) {
      throw new Error(
        "La sesión guardada ha caducado."
      );
    }

    const savedToken = minecraftToken.mclc(true);

    const identity = accountIdentity(
      minecraftToken,
      savedToken
    );

    account = {
      ...account,
      ...identity,
      token: savedToken
    };

    const index = store.accounts.findIndex(
      (item) => item.id === account.id
    );

    if (index >= 0) {
      store.accounts[index] = account;
    }

    if (!accountId) {
      store.activeAccountId = account.id;
    }

    await writeAccountsStore(store);

    return {
      minecraftToken,
      account: publicAccount(account),
      restored: true
    };
  } catch (error) {
    // No cambiamos automáticamente a Local ni a otra cuenta.
    // El usuario debe poder controlar la identidad desde Perfiles.
    console.warn(
      "[ERYON] No se pudo restaurar la cuenta Microsoft activa:",
      normalizeError(error)
    );

    const authError = error?.response?.status === 429
      ? "Microsoft/Xbox limitó temporalmente los intentos de autenticación (HTTP 429). Espera unos minutos antes de volver a intentarlo."
      : normalizeError(error);
    throw new Error(
      `No se pudo iniciar sesión con la cuenta Microsoft seleccionada (${account.name}): ${authError}. ` +
      "Si el problema continúa, vuelve a conectar la cuenta desde Perfiles."
    );
  }
}

function publicElybyAccount(account) {
  if (!account?.profile?.id || !account.profile.name) return null;
  return {
    id: account.profile.id,
    uuid: account.profile.id,
    name: account.profile.name,
    avatarUrl:
      `https://mc-heads.net/avatar/${encodeURIComponent(account.profile.id)}/100`,
    accountType: "Ely.by"
  };
}

async function getElybyAccount() {
  const saved = await readEncryptedFile(ELYBY_ACCOUNT_FILE);
  return saved?.profile?.id && saved?.profile?.name
    ? saved
    : null;
}

async function authenticateElyby() {
  const saved = await getElybyAccount();
  if (!saved?.token?.accessToken || !saved?.token?.clientToken) {
    throw new Error("Conecta una cuenta Ely.by desde el apartado Skins.");
  }

  const response = await fetch("https://authserver.ely.by/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accessToken: saved.token.accessToken,
      clientToken: saved.token.clientToken,
      selectedProfile: saved.profile,
      requestUser: true
    }),
    signal: AbortSignal.timeout(15000)
  });
  const refreshed = await response.json().catch(() => null);
  if (
    !response.ok ||
    !refreshed?.accessToken ||
    !refreshed?.selectedProfile?.id ||
    !refreshed?.selectedProfile?.name
  ) {
    throw new Error(
      "La sesión de Ely.by ya no es válida. Vuelve a conectar tu cuenta en Skins."
    );
  }

  const account = {
    profile: {
      id: String(refreshed.selectedProfile.id),
      name: String(refreshed.selectedProfile.name)
    },
    token: {
      accessToken: String(refreshed.accessToken),
      clientToken: String(refreshed.clientToken || saved.token.clientToken)
    }
  };
  if (!/^[a-f\d]{32}$/i.test(account.profile.id)) {
    throw new Error("Ely.by devolvió un identificador de perfil no válido.");
  }

  await writeEncryptedFile(ELYBY_ACCOUNT_FILE, account);
  return {
    account: publicElybyAccount(account),
    authorization: {
      access_token: account.token.accessToken,
      client_token: account.token.clientToken,
      uuid: account.profile.id,
      name: account.profile.name,
      user_properties: "{}",
      meta: { type: "ely.by" }
    }
  };
}

function validateSkinImage(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 24 ||
    buffer.length > 2 * 1024 * 1024 ||
    !buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    throw new Error("Selecciona una imagen PNG de skin válida (máximo 2 MB).");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error("La skin debe medir 64×64 o 64×32 píxeles.");
  }
  return buffer;
}

function localSkinPath(profileId) {
  const id = String(profileId ?? "");
  if (!/^[a-f\d-]{1,64}$/i.test(id)) {
    throw new Error("El perfil local seleccionado no es válido.");
  }
  return userDataPath(path.join("eryon-local-skins", `${id}.png`));
}

function localSkinVariantPath(profileId) {
  return localSkinPath(profileId).replace(/\.png$/, ".json");
}

async function readLocalSkinVariant(profileId) {
  const metadataPath = localSkinVariantPath(profileId);
  const metadata = await fs.readFile(metadataPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return "classic";

  const parsed = JSON.parse(metadata);
  return parsed.variant === "slim" ? "slim" : "classic";
}

function imageDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function validateSkinUrl(value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("La dirección de la skin no pertenece a una fuente permitida.");
  }

  const allowedHosts = [
    "textures.minecraft.net",
    "skinsystem.ely.by",
    "ely.by"
  ];
  if (
    !allowedHosts.includes(parsedUrl.hostname) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.port ||
    !["https:", "http:"].includes(parsedUrl.protocol)
  ) {
    throw new Error("La dirección de la skin no pertenece a una fuente permitida.");
  }

  // Minecraft can return legacy HTTP texture URLs; always fetch them over HTTPS.
  parsedUrl.protocol = "https:";
  return parsedUrl;
}

async function downloadSkinImage(url) {
  let parsedUrl = validateSkinUrl(url);
  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetch(parsedUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 5) {
      throw new Error("La skin redirigió demasiadas veces.");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("La fuente de la skin devolvió una redirección no válida.");
    }
    parsedUrl = validateSkinUrl(new URL(location, parsedUrl).toString());
  }

  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`No se pudo cargar la skin (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return imageDataUrl(validateSkinImage(bytes));
}

async function getSkinState(input = {}) {
  const settings = await readSettings();
  if (settings.accountMode === "local") {
    if (!input.localProfileId) {
      return {
        provider: "local",
        skinUrl: "",
        variant: "classic",
        note: "Selecciona un perfil local para guardar una vista previa."
      };
    }
    const skinPath = localSkinPath(input.localProfileId);
    const skin = await fs.readFile(skinPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    return {
      provider: "local",
      skinUrl: skin ? imageDataUrl(validateSkinImage(skin)) : "",
      variant: await readLocalSkinVariant(input.localProfileId),
      note: "La skin se muestra en mundos de un jugador con este perfil local. No cambia tu skin en servidores multijugador."
    };
  }

  if (settings.accountMode === "elyby") {
    const account = await getElybyAccount();
    if (!account) {
      return { provider: "elyby", skinUrl: "", variant: "classic" };
    }
    const skinUrl =
      `https://skinsystem.ely.by/skins/${encodeURIComponent(account.profile.name)}.png`;
    return {
      provider: "elyby",
      account: publicElybyAccount(account),
      skinUrl: await downloadSkinImage(skinUrl) || "",
      variant: "classic",
      note: "La skin se muestra en el juego con Ely.by y authlib-injector."
    };
  }

  const { minecraftToken } = await authenticateMinecraft();
  const minecraftAuthorization = minecraftToken.mclc();
  const response = await fetch(
    "https://api.minecraftservices.com/minecraft/profile",
    {
      headers: {
        authorization: `Bearer ${minecraftAuthorization.access_token}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );
  const profile = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      "No se pudo consultar la skin de Minecraft. Vuelve a conectar tu cuenta Microsoft."
    );
  }
  const skin = Array.isArray(profile?.skins) ? profile.skins[0] : null;
  return {
    provider: "microsoft",
    account: publicAccount((await getAccountsData()).activeAccount),
    skinUrl: skin?.url ? await downloadSkinImage(skin.url) || "" : "",
    variant: skin?.variant === "SLIM" ? "slim" : "classic"
  };
}

async function uploadSkin(input = {}) {
  const settings = await readSettings();
  const result = await dialog.showOpenDialog({
    title: "Seleccionar skin de Minecraft",
    properties: ["openFile"],
    filters: [{ name: "Imagen PNG", extensions: ["png"] }]
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  const skin = validateSkinImage(await fs.readFile(result.filePaths[0]));
  const variant = input.variant === "slim" ? "slim" : "classic";

  if (settings.accountMode === "local") {
    const destination = localSkinPath(input.localProfileId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, skin, { mode: 0o600 });
    await fs.writeFile(
      localSkinVariantPath(input.localProfileId),
      JSON.stringify({ variant }),
      { mode: 0o600 }
    );
    return {
      uploaded: true,
      provider: "local",
      skinUrl: imageDataUrl(skin),
      variant
    };
  }

  if (settings.accountMode === "elyby") {
    throw new Error(
      "La carga de skins para Ely.by se administra desde su sitio oficial. " +
      "Abre el catálogo de Ely.by, inicia sesión y cambia tu skin allí; después vuelve a cargar la vista previa."
    );
  }

  const { minecraftToken } = await authenticateMinecraft();
  const minecraftAuthorization = minecraftToken.mclc();
  const form = new FormData();
  form.append("variant", variant);
  form.append(
    "file",
    new Blob([skin], { type: "image/png" }),
    path.basename(result.filePaths[0])
  );
  const response = await fetch(
    "https://api.minecraftservices.com/minecraft/profile/skins",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${minecraftAuthorization.access_token}`
      },
      body: form,
      signal: AbortSignal.timeout(30000)
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.errorMessage ||
        `Minecraft no pudo cambiar la skin (HTTP ${response.status}).`
    );
  }
  return { uploaded: true, provider: "microsoft" };
}

async function ensureAuthlibInjector() {
  const cacheDirectory = userDataPath("authlib-injector");
  await fs.mkdir(cacheDirectory, { recursive: true });

  const findCachedInjector = async () => {
    const entries = await fs.readdir(cacheDirectory, { withFileTypes: true })
      .catch(() => []);
    const candidates = entries
      .filter((entry) =>
        entry.isFile() &&
        /^authlib-injector-\d+(?:\.\d+){1,3}\.jar$/i.test(entry.name)
      )
      .sort((left, right) => right.name.localeCompare(left.name, undefined, {
        numeric: true,
        sensitivity: "base"
      }));

    for (const candidate of candidates) {
      const candidatePath = path.join(cacheDirectory, candidate.name);
      const stat = await fs.stat(candidatePath).catch(() => null);
      if (!stat?.isFile() || stat.size < 100_000 || stat.size > 10 * 1024 * 1024) {
        continue;
      }
      const handle = await fs.open(candidatePath, "r").catch(() => null);
      if (!handle) continue;
      try {
        const signature = Buffer.alloc(4);
        const { bytesRead } = await handle.read(signature, 0, 4, 0);
        if (
          bytesRead === 4 &&
          signature[0] === 0x50 &&
          signature[1] === 0x4b &&
          signature[2] === 0x03 &&
          signature[3] === 0x04
        ) {
          return candidatePath;
        }
      } finally {
        await handle.close().catch(() => {});
      }
    }
    return null;
  };

  let releaseResponse;
  try {
    releaseResponse = await fetch(
      "https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Eryon-Launcher"
        },
        signal: AbortSignal.timeout(15000)
      }
    );
  } catch (error) {
    const cachedInjector = await findCachedInjector();
    if (cachedInjector) return cachedInjector;
    throw new Error(
      `No se pudo consultar authlib-injector: ${normalizeError(error)}.`
    );
  }
  if (!releaseResponse.ok) {
    const cachedInjector = await findCachedInjector();
    if (cachedInjector) return cachedInjector;
    throw new Error(
      `No se pudo consultar la versión oficial de authlib-injector (HTTP ${releaseResponse.status}).`
    );
  }
  const release = await releaseResponse.json();
  const version = String(release.tag_name || "").replace(/^v/, "");
  const asset = release.assets?.find(
    (item) => item.name === `authlib-injector-${version}.jar`
  );
  const digest = String(asset?.digest || "").replace(/^sha256:/i, "").toLowerCase();
  const expectedDownloadUrl =
    `https://github.com/yushijinhun/authlib-injector/releases/download/${release.tag_name}/${asset?.name}`;
  if (
    !/^\d+(?:\.\d+){1,3}$/.test(version) ||
    !/^[a-f\d]{64}$/.test(digest) ||
    asset?.browser_download_url !== expectedDownloadUrl ||
    asset.size > 10 * 1024 * 1024
  ) {
    throw new Error("La publicación oficial de authlib-injector no es válida.");
  }

  const jarPath = path.join(cacheDirectory, asset.name);
  const existingJar = await fs.readFile(jarPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (
    existingJar &&
    crypto.createHash("sha256").update(existingJar).digest("hex") === digest
  ) {
    return jarPath;
  }

  const download = await fetch(expectedDownloadUrl, {
    signal: AbortSignal.timeout(30000)
  });
  if (!download.ok) {
    throw new Error(
      `No se pudo descargar authlib-injector de su publicación oficial (HTTP ${download.status}).`
    );
  }
  const reader = download.body?.getReader();
  if (!reader) {
    throw new Error("La descarga de authlib-injector no contiene datos.");
  }
  const chunks = [];
  let downloadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    downloadedBytes += value.length;
    if (downloadedBytes > asset.size || downloadedBytes > 10 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("La descarga de authlib-injector excede el tamaño publicado.");
    }
    chunks.push(Buffer.from(value));
  }
  const jar = Buffer.concat(chunks, downloadedBytes);
  if (
    jar.length !== asset.size ||
    crypto.createHash("sha256").update(jar).digest("hex") !== digest
  ) {
    throw new Error("La integridad de authlib-injector no coincide con GitHub.");
  }
  const temporaryJar = `${jarPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryJar, jar, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryJar, jarPath);
  } catch (error) {
    await fs.rm(temporaryJar, { force: true });
    throw error;
  }
  return jarPath;
}

// ======================================================
// PERFILES LOCALES
// ======================================================

function validateLocalProfileName(value) {
  const name = String(value ?? "").trim();

  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw new Error(
      "El nombre debe tener entre 3 y 16 caracteres. " +
      "Solo se permiten letras, números y guion bajo."
    );
  }

  return name;
}

function emptyLocalProfilesStore() {
  return {
    activeProfileId: null,
    profiles: []
  };
}

async function readLocalProfilesStore() {
  try {
    const content = await fs.readFile(
      userDataPath(LOCAL_PROFILES_FILE),
      "utf8"
    );

    const saved = JSON.parse(content);

    if (!saved || !Array.isArray(saved.profiles)) {
      return emptyLocalProfilesStore();
    }

    const profiles = saved.profiles.filter(
      (profile) =>
        profile &&
        typeof profile.id === "string" &&
        typeof profile.name === "string" &&
        /^[A-Za-z0-9_]{3,16}$/.test(profile.name)
    );

    const activeProfileId = profiles.some(
      (profile) =>
        profile.id === saved.activeProfileId
    )
      ? saved.activeProfileId
      : profiles[0]?.id ?? null;

    return {
      activeProfileId,
      profiles
    };
  } catch {
    return emptyLocalProfilesStore();
  }
}

async function writeLocalProfilesStore(store) {
  const clean = {
    activeProfileId:
      store.activeProfileId ?? null,

    profiles: Array.isArray(store.profiles)
      ? store.profiles
      : []
  };

  const destination = userDataPath(
    LOCAL_PROFILES_FILE
  );

  const temporary = `${destination}.tmp`;

  await fs.mkdir(app.getPath("userData"), {
    recursive: true
  });

  await fs.writeFile(
    temporary,
    JSON.stringify(clean, null, 2),
    "utf8"
  );

  await fs.rename(temporary, destination);
}

function publicLocalProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    avatarUrl:
      `https://mc-heads.net/avatar/${encodeURIComponent(profile.name)}/100`,
    accountType: "Local",
    createdAt: profile.createdAt
  };
}

async function getLocalProfilesData() {
  const store = await readLocalProfilesStore();

  const activeProfile =
    store.profiles.find(
      (profile) =>
        profile.id === store.activeProfileId
    ) ?? null;

  return {
    profiles: store.profiles.map(
      publicLocalProfile
    ),
    activeProfileId: store.activeProfileId,
    activeProfile: activeProfile
      ? publicLocalProfile(activeProfile)
      : null
  };
}

async function addLocalProfile(nameInput) {
  const name = validateLocalProfileName(nameInput);
  const store = await readLocalProfilesStore();

  const existing = store.profiles.find(
    (profile) =>
      profile.name.toLowerCase() === name.toLowerCase()
  );

  if (existing) {
    store.activeProfileId = existing.id;

    await writeLocalProfilesStore(store);

    return getLocalProfilesData();
  }

  const profile = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString()
  };

  store.profiles.push(profile);
  store.activeProfileId = profile.id;

  await writeLocalProfilesStore(store);

  return getLocalProfilesData();
}

async function selectLocalProfile(profileId) {
  if (
    typeof profileId !== "string" ||
    !profileId
  ) {
    throw new Error(
      "Selecciona un perfil local válido."
    );
  }

  const store = await readLocalProfilesStore();

  const profile = store.profiles.find(
    (item) => item.id === profileId
  );

  if (!profile) {
    throw new Error(
      "No se encontró el perfil local seleccionado."
    );
  }

  store.activeProfileId = profile.id;

  await writeLocalProfilesStore(store);

  // Mantiene Local como modo predeterminado para ventanas nuevas.
  await saveSettings({
    accountMode: "local"
  });

  return getLocalProfilesData();
}

async function deleteLocalProfile(profileId) {
  if (
    typeof profileId !== "string" ||
    !profileId
  ) {
    throw new Error(
      "Selecciona un perfil local válido."
    );
  }

  const store = await readLocalProfilesStore();

  store.profiles = store.profiles.filter(
    (profile) => profile.id !== profileId
  );

  if (store.activeProfileId === profileId) {
    store.activeProfileId =
      store.profiles[0]?.id ?? null;
  }

  if (store.profiles.length === 0) {
    await deleteFile(LOCAL_PROFILES_FILE);
  } else {
    await writeLocalProfilesStore(store);
  }

  await Promise.all([
    fs.rm(localSkinPath(profileId), { force: true }),
    fs.rm(localSkinVariantPath(profileId), { force: true })
  ]);
  return getLocalProfilesData();
}

function offlineUuid(name) {
  const bytes = crypto
    .createHash("md5")
    .update(`OfflinePlayer:${name}`, "utf8")
    .digest();

  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

async function getLocalAuthorization(profileId = null) {
  const store = await readLocalProfilesStore();

  const profile = store.profiles.find(
    (item) =>
      item.id === (profileId || store.activeProfileId)
  );

  if (!profile) {
    throw new Error(
      profileId
        ? "El perfil local seleccionado no se encontró."
        : "No hay un perfil local seleccionado. " +
          "Abre Perfiles y crea o selecciona un perfil local."
    );
  }

  return {
    profileId: profile.id,
    authorization: {
      access_token: "0",
      client_token: "eryon-local",
      uuid: offlineUuid(profile.name).replace(/-/g, ""),
      name: profile.name,
      user_properties: "{}",
      meta: {
        type: "legacy",
        demo: false
      }
    }
  };
}

// ======================================================
// CATÁLOGO OFICIAL DE VERSIONES DE MINECRAFT
// ======================================================

async function getReleaseVersions() {
  const response = await fetch(
    VERSION_MANIFEST_URL
  );

  if (!response.ok) {
    throw new Error(
      `No se pudo consultar el catálogo oficial de Minecraft (HTTP ${response.status}).`
    );
  }

  const manifest = await response.json();

  return {
    latestRelease: manifest.latest?.release ?? null,

    versions: (manifest.versions ?? [])
      .filter((item) => item.type === "release")
      .map((item) => ({
        id: item.id,
        type: item.type,
        releaseTime: item.releaseTime,
        url: item.url
      }))
  };
}

// ======================================================
// JAVA MANAGER
// ======================================================

async function getJavaMajor(javaPath) {
  try {
    const result = await execFileAsync(
      javaPath,
      ["-version"],
      {
        timeout: 10000,
        windowsHide: true
      }
    );

    const output =
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    const match = output.match(
      /version "(?:1\.)?(\d+)/
    );

    return match ? Number(match[1]) : null;
  } catch (error) {
    const output =
      `${error.stdout ?? ""}\n${error.stderr ?? ""}`;

    const match = output.match(
      /version "(?:1\.)?(\d+)/
    );

    return match ? Number(match[1]) : null;
  }
}

async function findJavaExecutable(directory, depth = 0) {
  if (depth > 8) return null;

  let entries;

  try {
    entries = await fs.readdir(
      directory,
      { withFileTypes: true }
    );
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (
      entry.isFile() &&
      entry.name.toLowerCase() === "java.exe"
    ) {
      return path.join(directory, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const found = await findJavaExecutable(
      path.join(directory, entry.name),
      depth + 1
    );

    if (found) return found;
  }

  return null;
}

async function getRequiredJavaMajor(versionInfo) {
  if (!versionInfo?.url) {
    throw new Error(
      "No se encontró la información oficial de esta versión."
    );
  }

  const response = await fetch(versionInfo.url);

  if (!response.ok) {
    throw new Error(
      `No se pudieron consultar los requisitos de Java (HTTP ${response.status}).`
    );
  }

  const metadata = await response.json();
  const major = Number(
    metadata.javaVersion?.majorVersion
  );

  if (!Number.isInteger(major) || major < 8) {
    throw new Error(
      "No se pudo determinar la versión de Java necesaria."
    );
  }

  return major;
}

async function ensureCompatibleJava(versionInfo, settings, launchWindow = null) {
  const requiredMajor =
    await getRequiredJavaMajor(versionInfo);

  sendLaunchEvent({
    type: "status",
    message: `Comprobando Java ${requiredMajor}...`
  }, launchWindow);

  if (settings.javaPath) {
    const major = await getJavaMajor(
      settings.javaPath
    );

    if (major === requiredMajor) {
      return settings.javaPath;
    }
  }

  const systemMajor = await getJavaMajor("java");

  if (systemMajor === requiredMajor) {
    return "java";
  }

  if (process.platform !== "win32") {
    throw new Error(
      "La descarga automática de Java está configurada actualmente para Windows."
    );
  }

  const architecture =
    process.arch === "arm64"
      ? "aarch64"
      : "x64";

  const runtimeDirectory = path.join(
    app.getPath("userData"),
    "java-runtimes",
    `java-${requiredMajor}-${architecture}`
  );

  const existingJava = await findJavaExecutable(
    runtimeDirectory
  );

  if (
    existingJava &&
    (await getJavaMajor(existingJava)) === requiredMajor
  ) {
    return existingJava;
  }

  const downloadUrl =
    `https://api.adoptium.net/v3/binary/latest/${requiredMajor}/ga/` +
    `windows/${architecture}/jre/hotspot/normal/eclipse`;

  const archivePath = userDataPath(
    `java-${requiredMajor}-${Date.now()}.zip`
  );

  const temporaryDirectory =
    `${runtimeDirectory}.tmp-${Date.now()}`;

  try {
    sendLaunchEvent({
      type: "status",
      message: `Descargando Java ${requiredMajor}...`
    }, launchWindow);

    const response = await fetch(
      downloadUrl,
      { redirect: "follow" }
    );

    if (!response.ok) {
      throw new Error(
        `No se pudo descargar Java ${requiredMajor} (HTTP ${response.status}).`
      );
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!buffer.length) {
      throw new Error(
        "El archivo de Java descargado está vacío."
      );
    }

    await fs.mkdir(
      path.dirname(runtimeDirectory),
      { recursive: true }
    );

    await fs.writeFile(
      archivePath,
      buffer
    );

    await fs.mkdir(
      temporaryDirectory,
      { recursive: true }
    );

    sendLaunchEvent({
      type: "status",
      message: `Instalando Java ${requiredMajor}...`
    }, launchWindow);

    const { extractArchive } = require("./extract-archive.cjs");

    await extractArchive(archivePath, temporaryDirectory);

    const downloadedJava =
      await findJavaExecutable(temporaryDirectory);

    if (
      !downloadedJava ||
      (await getJavaMajor(downloadedJava)) !== requiredMajor
    ) {
      throw new Error(
        "El runtime descargado no superó la comprobación."
      );
    }

    await fs.rm(runtimeDirectory, {
      recursive: true,
      force: true
    });

    await fs.rename(
      temporaryDirectory,
      runtimeDirectory
    );

    const installedJava =
      await findJavaExecutable(runtimeDirectory);

    if (
      !installedJava ||
      (await getJavaMajor(installedJava)) !== requiredMajor
    ) {
      throw new Error(
        "No se pudo verificar la instalación de Java."
      );
    }

    return installedJava;
  } catch (error) {
    await fs.rm(
      temporaryDirectory,
      { recursive: true, force: true }
    ).catch(() => {});

    throw new Error(
      `No se pudo preparar Java ${requiredMajor}: ${normalizeError(error)}`
    );
  } finally {
    await fs.rm(
      archivePath,
      { force: true }
    ).catch(() => {});
  }
}

// ======================================================
// GESTOR DE MODPACKS E INSTANCIAS
// ======================================================

const modpackManager = createModpackManager({
  app,
  dialog,
  getReleaseVersions,
  readSettings,
  ensureCompatibleJava,
  sendLaunchEvent,
  isMinecraftRunning
});

// ======================================================
// GESTOR DE EVENTOS
// ======================================================

const { createEventsManager } = require("./events-manager.cjs");

const eventsManager = createEventsManager({
  app,
  sendLaunchEvent
});

ipcMain.handle("eryon:events-list", async (_event, options) => {
  return eventsManager.getEvents(
    options && typeof options === "object" ? options : {}
  );
});

ipcMain.handle("eryon:events-get-admin-token", async () => {
  return { token: eventsManager.readAdminToken() };
});

ipcMain.handle("eryon:events-save-admin-token", async (_event, token) => {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error(
      "La clave de administrador debe tener al menos 16 caracteres."
    );
  }
  await eventsManager.verifyAdminToken(token);
  eventsManager.writeAdminToken(token);
  return { ok: true };
});

ipcMain.handle("eryon:events-verify-admin-token", async (_event, token) => {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error(
      "La clave de administrador debe tener al menos 16 caracteres."
    );
  }
  await eventsManager.verifyAdminToken(token);
  return { ok: true };
});

ipcMain.handle("eryon:events-clear-admin-token", async () => {
  eventsManager.clearAdminToken();
  return { ok: true };
});

ipcMain.handle("eryon:events-publish", async (_event, manifest) => {
  return eventsManager.publishEvents(manifest);
});

ipcMain.handle("eryon:events-publish-pack", async (_event, packId, packManifest) => {
  return eventsManager.publishEventPack(packId, packManifest);
});

ipcMain.handle("eryon:events-upload-image", async (_event, image, contentType) => {
  return eventsManager.uploadEventImage(image, contentType);
});

ipcMain.handle("eryon:events-delete-image", async (_event, key) => {
  return eventsManager.deleteEventImage(key);
});

ipcMain.handle("eryon:events-upload-file", async (_event, buffer, filename) => {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!Buffer.isBuffer(buf) || buf.byteLength === 0) {
    throw new Error("Archivo no válido.");
  }
  return eventsManager.uploadEventFile(buf, filename);
});

ipcMain.handle("eryon:events-import-instance", async (_event, instanceId, options = {}) => {
  if (typeof instanceId !== "string" || !instanceId.trim()) {
    throw new Error("Selecciona una instalación válida.");
  }

  const instance = await modpackManager.getInstance(instanceId);
  const instancesRoot = path.resolve(
    app.getPath("userData"),
    "eryon-instances"
  );
  const gameDirectory = path.resolve(instance.gameDirectory);
  const relativeToRoot = path.relative(instancesRoot, gameDirectory);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("La instalación seleccionada no pertenece a Eryon.");
  }

  const roots = ["config", "resourcepacks", "shaderpacks"];
  if (options?.includeMods !== false) roots.unshift("mods");
  const files = [];

  async function collect(folder, relative = folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name.endsWith(".disabled")) {
        continue;
      }
      const absolute = path.join(folder, entry.name);
      const target = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await collect(absolute, target);
      } else if (entry.isFile()) {
        files.push({ absolute, relative: target.replaceAll(path.sep, "/") });
      }
    }
  }

  for (const root of roots) {
    const directory = path.join(gameDirectory, root);
    try {
      await collect(directory, root);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (files.length === 0) {
    throw new Error("La instalación no contiene mods ni archivos de contenido.");
  }

  const packFiles = [];
  for (let index = 0; index < files.length; index += 1) {
    const item = files[index];
    sendLaunchEvent({
      type: "event-import-progress",
      current: index + 1,
      total: files.length,
      message: `Subiendo ${path.basename(item.relative)}...`
    });
    const uploaded = await eventsManager.uploadEventFile(
      await fs.readFile(item.absolute),
      path.basename(item.relative)
    );
    packFiles.push({
      path: item.relative,
      url: uploaded.url,
      sha256: uploaded.sha256,
      size: uploaded.size
    });
  }

  return {
    id: `pack-${instance.id}`,
    minecraft: instance.minecraftVersion || "",
    loader: instance.loader || "fabric",
    loaderVersion: instance.loaderVersion || "",
    files: packFiles,
    remove: []
  };
});

ipcMain.handle("eryon:events-hash-url", async (_event, url) => {
  return eventsManager.hashFileFromUrl(url);
});

ipcMain.handle("eryon:events-raw", async (_event, options) => {
  return eventsManager.getRawManifest(
    options && typeof options === "object" ? options : {}
  );
});

ipcMain.handle("eryon:events-fetch-pack", async (_event, packId) => {
  return eventsManager.getEventPack(packId);
});

// ======================================================
// MOTOR DE PREPARACION DE EVENTOS
// ======================================================

const { createEventInstaller } = require("./event-installer.cjs");

const eventInstaller = createEventInstaller({
  app,
  eventsManager,
  modpackManager,
  sendLaunchEvent,
  isMinecraftRunning
});

ipcMain.handle("eryon:prepare-event", async (_event, eventId, options) => {
  if (typeof eventId !== "string" || !eventId) {
    throw new Error("Evento no válido.");
  }
  const opts = options && typeof options === "object" ? options : {};
  return eventInstaller.prepareEvent(eventId, {
    forzarDescarga: opts.forzarDescarga === true
  });
});

ipcMain.handle("eryon:event-status", async (_event, eventId) => {
  if (typeof eventId !== "string" || !eventId) {
    throw new Error("Evento no válido.");
  }
  return eventInstaller.getEventStatus(eventId);
});



ipcMain.handle(
  "eryon:get-loader-versions",
  async (_event, minecraftVersion, loader) => {
    if (
      typeof minecraftVersion !== "string" ||
      typeof loader !== "string"
    ) {
      throw new Error(
        "La versión de Minecraft o el cargador no son válidos."
      );
    }

    const supportedLoader = loader.toLowerCase();

    if (!["forge", "fabric"].includes(supportedLoader)) {
      throw new Error(
        "El cargador debe ser Forge o Fabric."
      );
    }

    return modpackManager.getLoaderVersions(
      minecraftVersion,
      supportedLoader
    );
  }
);

// ======================================================
// CONFIGURACIÓN DE RAM POR INSTALACIÓN
// ======================================================

function getInstanceRamLimits() {
  const totalRamGB = Number(
    (os.totalmem() / (1024 ** 3)).toFixed(1)
  );

  const maxAllowedRamGB = Math.max(
    2,
    Math.floor(totalRamGB) - 2
  );

  return {
    totalRamGB,
    maxAllowedRamGB
  };
}

async function readInstanceSettingsStore() {
  try {
    const raw = await fs.readFile(
      userDataPath(INSTANCE_SETTINGS_FILE),
      "utf8"
    );

    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "El archivo de configuración de instancias no es válido."
      );
    }

    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw new Error(
      `No se pudo leer la configuración de las instalaciones: ${normalizeError(error)}`
    );
  }
}

async function loadInstanceSettings(instanceId) {
  const id = String(instanceId ?? "").trim();

  if (!id) {
    throw new Error(
      "No se indicó la instalación."
    );
  }

  const instance =
    await modpackManager.getInstance(id);

  if (!instance) {
    throw new Error(
      "No se encontró la instalación seleccionada."
    );
  }

  const store = await readInstanceSettingsStore();
  const saved = store[id] || {};

  const {
    totalRamGB,
    maxAllowedRamGB
  } = getInstanceRamLimits();

  const requestedMax = Number(
    saved.maxRamGB ?? Math.min(4, maxAllowedRamGB)
  );

  const maxRamGB = Math.min(
    maxAllowedRamGB,
    Math.max(
      2,
      Number.isFinite(requestedMax)
        ? requestedMax
        : Math.min(4, maxAllowedRamGB)
    )
  );

  const requestedMin = Number(
    saved.minRamGB ?? 2
  );

  const minRamGB = Math.min(
    maxRamGB,
    Math.max(
      1,
      Number.isFinite(requestedMin)
        ? requestedMin
        : 2
    )
  );

  return {
    useCustomRam: saved.useCustomRam === true,
    minRamGB,
    maxRamGB,
    useCustomResolution: saved.useCustomResolution === true,
    resolution: RESOLUTION_OPTIONS.includes(saved.resolution)
      ? saved.resolution
      : "default",
    useCustomJvmArgs: saved.useCustomJvmArgs === true,
    jvmArgs:
      typeof saved.jvmArgs === "string" &&
      saved.jvmArgs.length <= 2048 &&
      !saved.jvmArgs.includes("\0")
        ? saved.jvmArgs
        : "",
    totalRamGB,
    maxAllowedRamGB
  };
}

async function persistInstanceSettings(
  instanceId,
  input = {}
) {
  const id = String(instanceId ?? "").trim();

  if (!id) {
    throw new Error(
      "No se indicó la instalación."
    );
  }

  await modpackManager.getInstance(id);

  const {
    totalRamGB,
    maxAllowedRamGB
  } = getInstanceRamLimits();

  const maxRamGB = Number(input.maxRamGB);
  const minRamGB = Number(input.minRamGB);

  if (
    !Number.isInteger(maxRamGB) ||
    maxRamGB < 2 ||
    maxRamGB > maxAllowedRamGB
  ) {
    throw new Error(
      `La RAM máxima debe ser un número entero entre 2 y ${maxAllowedRamGB} GB en este equipo.`
    );
  }

  if (
    !Number.isInteger(minRamGB) ||
    minRamGB < 1 ||
    minRamGB > maxRamGB
  ) {
    throw new Error(
      "La RAM mínima debe estar entre 1 GB y la RAM máxima."
    );
  }

  const store = await readInstanceSettingsStore();

  const jvmArgs = String(input.jvmArgs ?? store[id]?.jvmArgs ?? "");
  const resolution = String(
    input.resolution ?? store[id]?.resolution ?? "default"
  );

  if (jvmArgs.length > 2048 || jvmArgs.includes("\0")) {
    throw new Error("Los argumentos JVM son demasiado largos o no son válidos.");
  }
  parseJvmArgs(jvmArgs);

  if (!RESOLUTION_OPTIONS.includes(resolution)) {
    throw new Error("La resolución seleccionada no es válida.");
  }

  store[id] = {
    ...store[id],
    useCustomRam: input.useCustomRam === true,
    minRamGB,
    maxRamGB,
    useCustomResolution: input.useCustomResolution === true,
    resolution,
    useCustomJvmArgs: input.useCustomJvmArgs === true,
    jvmArgs
  };

  await fs.mkdir(app.getPath("userData"), {
    recursive: true
  });

  const destination = userDataPath(
    INSTANCE_SETTINGS_FILE
  );

  const temporary = `${destination}.tmp`;

  await fs.writeFile(
    temporary,
    JSON.stringify(store, null, 2),
    "utf8"
  );

  await fs.rename(temporary, destination);

  return {
    ...store[id],
    totalRamGB,
    maxAllowedRamGB
  };
}

// ======================================================
// REGISTROS Y DIAGNÓSTICOS DE MINECRAFT
// ======================================================

async function appendDiagnosticLog(file, message) {
  try {
    await fs.appendFile(
      file,
      `[${new Date().toISOString()}] ${redactSensitiveData(message)}\n`,
      "utf8"
    );
  } catch (error) {
    console.error(
      "[ERYON] Error guardando registro:",
      normalizeError(error)
    );
  }
}

async function prepareMinecraftLogs(gameDirectory, version) {
  const logsDirectory = path.join(
    gameDirectory,
    "logs"
  );

  const crashDirectory = path.join(
    gameDirectory,
    "crash-reports"
  );

  await fs.mkdir(logsDirectory, {
    recursive: true
  });

  await fs.mkdir(crashDirectory, {
    recursive: true
  });

  const files = {
    logsDirectory,
    crashDirectory,

    launcherLog: path.join(
      logsDirectory,
      "eryon-launcher.log"
    ),

    consoleLog: path.join(
      logsDirectory,
      "eryon-minecraft-console.log"
    )
  };

  const header = [
    "",
    "",
    `========== ERYON ${new Date().toISOString()} ==========`,
    `Versión de Minecraft: ${version}`,
    `Directorio: ${gameDirectory}`,
    ""
  ].join("\n");

  await fs.appendFile(
    files.launcherLog,
    header,
    "utf8"
  );

  await fs.appendFile(
    files.consoleLog,
    header,
    "utf8"
  );

  await appendDiagnosticLog(
    files.launcherLog,
    "Registros preparados."
  );

  return files;
}

async function saveMinecraftDiagnostic(
  files,
  version,
  code
) {
  const reportPath = path.join(
    files.crashDirectory,
    `eryon-diagnostic-${Date.now()}.txt`
  );

  const report = [
    "ERYON LAUNCHER — INFORME DE DIAGNÓSTICO",
    `Fecha: ${new Date().toISOString()}`,
    `Versión de Minecraft: ${version}`,
    `Código de cierre: ${code}`,
    "",
    "Este archivo es un diagnóstico de Eryon, no un informe oficial de Minecraft.",
    `Registro del launcher: ${files.launcherLog}`,
    `Salida de Minecraft: ${files.consoleLog}`,
    `Registro de Minecraft: ${path.join(files.logsDirectory, "latest.log")}`
  ].join("\n");

  await fs.writeFile(
    reportPath,
    report,
    "utf8"
  );

  return reportPath;
}

// ======================================================
// ARGUMENTOS JVM
// ======================================================

function parseJvmArgs(value) {
  if (Array.isArray(value)) {
    return value
      .map((argument) => String(argument).trim())
      .filter(Boolean);
  }

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  const input = value.trim();
  const args = [];

  let current = "";
  let quote = null;

  for (let i = 0; i < input.length; i++) {
    const character = input[i];

    if (
      character === "\\" &&
      quote !== "'" &&
      i + 1 < input.length
    ) {
      const next = input[i + 1];

      if (
        next === "\\" ||
        next === '"' ||
        next === "'" ||
        /\s/.test(next)
      ) {
        current += next;
        i++;
        continue;
      }

      current += character;
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }

      continue;
    }

    current += character;
  }

  if (quote !== null) {
    throw new Error(
      "Los argumentos JVM contienen comillas sin cerrar."
    );
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}


async function getForgeProfileJvmArgs(
  gameDirectory,
  launchVersionId,
  libraryDirectory = path.join(gameDirectory, "libraries")
) {
  const profilePath = path.join(
    gameDirectory,
    "versions",
    launchVersionId,
    `${launchVersionId}.json`
  );

  let profile;

  try {
    profile = JSON.parse(
      await fs.readFile(profilePath, "utf8")
    );
  } catch (error) {
    throw new Error(
      `No se pudo leer el perfil JVM de Forge "${launchVersionId}": ${normalizeError(error)}`
    );
  }

  if (
    launchVersionId.startsWith("1.8.9-forge") &&
    typeof profile.minecraftArguments === "string" &&
    profile.minecraftArguments.trim() &&
    (!Array.isArray(profile.arguments?.jvm) ||
      profile.arguments.jvm.length === 0)
  ) {
    return [];
  }

  const rawArgs = profile.arguments?.jvm;

  if (
    !Array.isArray(rawArgs) ||
    rawArgs.length === 0
  ) {
    throw new Error(
      `El perfil ${launchVersionId} no contiene argumentos JVM de Forge.`
    );
  }

  libraryDirectory = libraryDirectory.replace(/\\/g, "/");

  const replacements = {
    "${library_directory}": libraryDirectory,
    "${classpath_separator}": path.delimiter,
    "${version_name}": launchVersionId
  };

  return rawArgs.map((argument) => {
    if (typeof argument !== "string") {
      throw new Error(
        `El perfil de Forge contiene un argumento JVM no compatible: ${JSON.stringify(argument)}`
      );
    }

    let resolved = argument;

    for (const [placeholder, value] of Object.entries(
      replacements
    )) {
      resolved = resolved.split(placeholder).join(value);
    }

    if (
      resolved.includes("${library_directory}") ||
      resolved.includes("${classpath_separator}") ||
      resolved.includes("${version_name}")
    ) {
      throw new Error(
        `No se pudo resolver una variable del perfil de Forge: ${resolved}`
      );
    }

    return resolved;
  });
}

// ======================================================
// INICIAR MINECRAFT
// ======================================================

async function launchMinecraft(
  versionId,
  profileSelection = {},
  instanceId = null,
  launchWindow = null
) {
  if (repairInProgress) {
    throw new Error(
      "No se puede iniciar Minecraft mientras se repara una instalación."
    );
  }

  const launchSettings = await readSettings();
  const accountMode =
    profileSelection?.mode || launchSettings.accountMode;
  let accountId =
    typeof profileSelection?.accountId === "string"
      ? profileSelection.accountId
      : "";

  if (accountMode === "premium") {
    const accounts = await readAccountsStore();
    accountId ||= accounts.activeAccountId || "";
    if (!accounts.accounts.some((account) => account.id === accountId)) {
      throw new Error("La cuenta Microsoft seleccionada ya no está disponible.");
    }
  } else if (accountMode === "local") {
    const profiles = await readLocalProfilesStore();
    accountId =
      (typeof profileSelection?.profileId === "string" &&
        profileSelection.profileId) ||
      profiles.activeProfileId ||
      "";
    if (!profiles.profiles.some((profile) => profile.id === accountId)) {
      throw new Error("El perfil local seleccionado ya no está disponible.");
    }
  } else if (accountMode === "elyby") {
    const account = await getElybyAccount();
    accountId = account?.profile?.id || "elyby";
  } else {
    throw new Error("El modo de cuenta seleccionado no es válido.");
  }

  const accountKey = `${accountMode}:${accountId}`;
  if (repairInProgress) {
    throw new Error(
      "No se puede iniciar Minecraft mientras se repara una instalación."
    );
  }
  if (
    launchingAccounts.has(accountKey) ||
    activeProcesses.has(accountKey)
  ) {
    throw new Error(
      "Esta cuenta ya está iniciando Minecraft o tiene una sesión abierta."
    );
  }

  launchingAccounts.add(accountKey);

  let logFiles = null;
  let localSkinServer = null;
  let childProcessStarted = false;
  async function stopLocalSkinServer() {
    if (!localSkinServer) return;
    const runningServer = localSkinServer;
    localSkinServer = null;
    await runningServer.close();
  }
  const emitLaunchProgressEvent = (payload) =>
    sendLaunchEvent({
      ...payload,
      instanceId,
      gameAccountKey: accountKey
    }, launchWindow);

  try {
    const instance = instanceId
      ? await modpackManager.getInstance(instanceId)
      : null;

    const version = String(
      instance?.minecraftVersion ?? versionId ?? ""
    ).trim();

    let launchVersionId = String(
      instance?.launchVersionId ?? version
    );

    if (!/^[A-Za-z0-9._-]{1,40}$/.test(version)) {
      throw new Error(
        "La versión seleccionada de Minecraft no es válida."
      );
    }

    if (
      !launchVersionId ||
      launchVersionId.length > 160 ||
      !/^[A-Za-z0-9._+-]+$/.test(launchVersionId)
    ) {
      throw new Error(
        "El identificador de la instalación no es válido."
      );
    }

    // Las selecciones de cuenta se mantienen por ventana y se validan
    // contra las cuentas guardadas al momento de iniciar.
    const settings = await saveSettings({
      selectedVersion: version
    });

    if (
      accountMode !== "local" &&
      accountMode !== "premium" &&
      accountMode !== "elyby"
    ) {
      throw new Error(
        "El modo de cuenta guardado en Perfiles no es válido."
      );
    }

    const instanceRamSettings = instance
      ? await loadInstanceSettings(instance.id)
      : null;

    const minimumHeap = settings.lowEndMode ? "512M" : "1G";

    const launchMemory =
      instanceRamSettings?.useCustomRam === true
        ? {
            max: `${instanceRamSettings.maxRamGB}G`,
            min: `${instanceRamSettings.minRamGB}G`
          }
        : {
            max: `${settings.ramGB}G`,
            min: minimumHeap
          };

    const gameDirectory =
      instance?.gameDirectory || settings.gameDirectory;
    const sharedAssetsDirectory = sharedMinecraftPath("assets");
    const sharedLibrariesDirectory = sharedMinecraftPath("libraries");
    const sharedNativesDirectory = sharedMinecraftPath(
      "natives",
      version
    );

    await Promise.all([
      fs.mkdir(sharedAssetsDirectory, { recursive: true }),
      fs.mkdir(sharedLibrariesDirectory, { recursive: true }),
      fs.mkdir(sharedNativesDirectory, { recursive: true })
    ]);

    logFiles = await prepareMinecraftLogs(
      gameDirectory,
      version
    );

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Modo de cuenta seleccionado: ${accountMode}`
    );

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Tipo de instalación: ${instance?.loader || "vanilla"}`
    );

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Memoria Java: mínima ${launchMemory.min}, máxima ${launchMemory.max}`
    );

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Modo de gama baja: ${settings.lowEndMode ? "activado" : "desactivado"}`
    );

    const catalog = await getReleaseVersions();

    const selectedVersion = catalog.versions.find(
      (item) => item.id === version
    );

    if (!selectedVersion) {
      throw new Error(
        `Minecraft ${version} no aparece en el catálogo oficial de versiones estables.`
      );
    }

    const javaPath = await ensureCompatibleJava(
      selectedVersion,
      settings,
      launchWindow
    );

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Java seleccionado: ${javaPath}`
    );

    let authorization;
    let playerName;
    let authlibInjectorPath = null;

    if (accountMode === "local") {
      const localProfile = await getLocalAuthorization(
        profileSelection?.profileId
      );
      authorization = localProfile.authorization;

      playerName = authorization.name;

      await appendDiagnosticLog(
        logFiles.launcherLog,
        `Perfil local activo: ${playerName}`
      );

      const skinPath = localSkinPath(localProfile.profileId);
      const localSkin = await fs.readFile(skinPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (localSkin) {
        try {
          // La skin es opcional para el inicio offline. Si GitHub no permite
          // consultar authlib-injector (por ejemplo, HTTP 403), no bloqueamos
          // Minecraft: solo se omite la skin de este inicio.
          authlibInjectorPath = await ensureAuthlibInjector();
          localSkinServer = await createLocalSkinServer({
            profileId: authorization.uuid,
            profileName: playerName,
            skin: validateSkinImage(localSkin),
            variant: await readLocalSkinVariant(localProfile.profileId)
          });
          await appendDiagnosticLog(
            logFiles.launcherLog,
            "Skin local habilitada para mundos de un jugador."
          );
        } catch (skinError) {
          authlibInjectorPath = null;
          await stopLocalSkinServer();
          await appendDiagnosticLog(
            logFiles.launcherLog,
            `No se pudo habilitar la skin local; se continuará sin ella: ${redactSensitiveData(
              skinError?.message || skinError
            )}`
          );
        }
      }

      emitLaunchProgressEvent({
        type: "status",
        message: `Preparando perfil local ${playerName}...`
      });
    } else if (accountMode === "elyby") {
      const elyby = await authenticateElyby();
      authorization = elyby.authorization;
      playerName = elyby.account.name;
      authlibInjectorPath = await ensureAuthlibInjector();
      await appendDiagnosticLog(
        logFiles.launcherLog,
        `Cuenta Ely.by activa: ${playerName}`
      );
      emitLaunchProgressEvent({
        type: "status",
        message: `Preparando la cuenta Ely.by de ${playerName}...`
      });
    } else {
      const { minecraftToken, account } =
        await authenticateMinecraft(profileSelection?.accountId, launchWindow);

      authorization = minecraftToken.mclc();

      if (
        !authorization?.access_token ||
        !authorization?.uuid
      ) {
        throw new Error(
          "Microsoft no devolvió una autorización válida de Minecraft."
        );
      }

      playerName =
        account?.name ||
        authorization.name ||
        authorization.username ||
        "Jugador";

      await appendDiagnosticLog(
        logFiles.launcherLog,
        `Cuenta Microsoft activa: ${playerName}`
      );
    }

    emitLaunchProgressEvent({
      type: "status",
      message: instance
        ? `Preparando ${instance.name} (${instance.loader})...`
        : `Preparando Minecraft ${version}...`
    });

    const { Client } = require("minecraft-launcher-core");

    const launcher = new Client();

    launcher.on("debug", (data) => {
      const message = redactSensitiveData(data);

      void appendDiagnosticLog(
        logFiles.launcherLog,
        message
      );

      emitLaunchProgressEvent({
        type: "log",
        message
      });
    });

    launcher.on("progress", (data) => {
      emitLaunchProgressEvent({
        type: "progress",
        data
      });
    });

    launcher.on("download-status", (data) => {
      emitLaunchProgressEvent({
        type: "download-status",
        data
      });
    });

    launcher.on("data", (data) => {
      const message = redactSensitiveData(data);

      void appendDiagnosticLog(
        logFiles.consoleLog,
        message
      );

      emitLaunchProgressEvent({
        type: "log",
        message
      });
    });

    const loaderName = (instance?.loader || "").toLowerCase();
    const supportsEryonIdentity =
      !instance || ["vanilla", "fabric"].includes(loaderName);

    // ==================================================
    // FORGE LEGACY AUTOMATICO
    // ==================================================
    // En versiones donde no existe Fabric (1.8.9 etc.), JUGAR
    // instala Forge primero: sin cargador no hay mods ni
    // identificador. En instancias Forge ya creadas se respeta
    // su cargador y no se reinstala.
    let legacyForgeEnsured = false;

    if (
      (!instance || loaderName === "vanilla") &&
      identityForgeModFileFor(version)
    ) {
      try {
        emitLaunchProgressEvent({
          type: "status",
          message: `Preparando Forge para Minecraft ${version}...`
        });

        const forgeProfile =
          await modpackManager.ensureForgeForVersion({
            minecraftVersion: version,
            gameDirectory,
            settings,
            installerBridgeJar: path.join(
              app.isPackaged
                ? process.resourcesPath
                : app.getAppPath(),
              ...(app.isPackaged ? ["app.asar.unpacked"] : []),
              "build",
              ERYON_IDENTITY_FORGE_189_MOD_FILE
            )
          });

        launchVersionId = forgeProfile.launchVersionId;
        legacyForgeEnsured = true;

        await appendDiagnosticLog(
          logFiles.launcherLog,
          `Forge ${forgeProfile.loaderVersion} preparado para Minecraft ${version}.`
        );
      } catch (legacyForgeError) {
        await appendDiagnosticLog(
          logFiles.launcherLog,
          `No se pudo preparar Forge para ${version}: ${redactSensitiveData(
            legacyForgeError?.message || legacyForgeError
          )}`
        );
        throw new Error(
          `No se pudo instalar Forge para Minecraft ${version}: ${
            legacyForgeError?.message || legacyForgeError
          }`
        );
      }
    }

    // ==================================================
    // SIN AVISO "PULSA E PARA ABRIR INVENTARIO"
    // ==================================================
    // En versiones legacy el aviso del logro de inventario se
    // pega en pantalla en servidores; se apaga desde
    // options.txt (el juego no ofrece control para ello).
    if (identityForgeModFileFor(version)) {
      try {
        const hintResult = await hideLegacyInventoryHint(
          gameDirectory
        );
        if (hintResult.hidden) {
          await appendDiagnosticLog(
            logFiles.launcherLog,
            `Aviso de inventario ("pulsa E") desactivado para Minecraft ${version}.`
          );
        }
      } catch (hintError) {
        await appendDiagnosticLog(
          logFiles.launcherLog,
          `No se pudo desactivar el aviso de inventario: ${redactSensitiveData(
            hintError?.message || hintError
          )}`
        );
      }
    }

    // ==================================================
    // MARCAS DE AGUA "NAVITH LABS"
    // ==================================================
    // El mod DEDsafio4FanByNavithLabs pinta su logo encima del de
    // Minecraft en el men├║ principal y en la pantalla de carga.
    // Se quitan sus mixins de marca antes de lanzar. En instancias
    // de eventos no se toca: el instalador de eventos verifica cada
    // archivo por hash y volver├¡a a descargar el jar original.
    if (instance && !isEventManagedInstance(instance.id)) {
      try {
        const { cleanNavithWatermarks } = require("./navith-clean.cjs");
        const jarsLimpios = await cleanNavithWatermarks(gameDirectory);
        for (const jar of jarsLimpios) {
          await appendDiagnosticLog(
            logFiles.launcherLog,
            `Se quitaron las marcas de agua de ${jar}.`
          );
        }
      } catch (navithError) {
        await appendDiagnosticLog(
          logFiles.launcherLog,
          `No se pudo limpiar las marcas de agua: ${redactSensitiveData(
            navithError?.message || navithError
          )}`
        );
      }
    }

    const identityModForLaunch = supportsEryonIdentity
      ? identityModFileFor(version)
      : null;
    // Forge legacy 1.8.9:jar propio compilado para Forge; se
    // aplica a instancias forge y a lanzamientos donde el
    // launcher acabó de instalar Forge automáticamente.
    const identityForgeForLaunch =
      loaderName === "forge" || legacyForgeEnsured
        ? identityForgeModFileFor(version)
        : null;
    if (identityForgeForLaunch) {
      await disableLegacyForgeSplash(gameDirectory);
      await appendDiagnosticLog(
        logFiles.launcherLog,
        "Splash de Forge desactivada para usar el fondo personalizado de Eryon."
      );
    }
    for (const modFile of [
      ERYON_LEGACY_BADGE_MOD_FILE,
      ERYON_IDENTITY_1201_MOD_FILE,
      ERYON_IDENTITY_CLIENT_MOD_FILE,
      ERYON_IDENTITY_FORGE_189_MOD_FILE
    ]) {
      if (
        modFile === identityModForLaunch ||
        modFile === identityForgeForLaunch
      ) continue;
      if (await removeModFile(gameDirectory, modFile)) {
        await appendDiagnosticLog(
          logFiles.launcherLog,
          `Se quitó ${modFile} porque no corresponde a Minecraft ${version} y al cargador seleccionado.`
        );
      }
    }

    let eryonIdentity1201Enabled = false;
    if (identityModForLaunch === ERYON_IDENTITY_1201_MOD_FILE) {
      await installEryonIdentity1201Mod(gameDirectory);
      if (!instance || String(instance.loader).toLowerCase() === "vanilla") {
        const fabricProfile = await modpackManager.ensureEryonIdentity1201Fabric({
          minecraftVersion: version,
          gameDirectory,
          settings
        });
        launchVersionId = fabricProfile.launchVersionId;
      }
      eryonIdentity1201Enabled = true;
      await appendDiagnosticLog(
        logFiles.launcherLog,
        `ERYON Identity preparado para Minecraft ${version} con Fabric.`
      );
    }

    let eryonIdentityEnabled = false;
    if (identityModForLaunch === ERYON_IDENTITY_CLIENT_MOD_FILE) {
      await installEryonIdentityClientMod(gameDirectory);
      const fabricProfile = await modpackManager.ensureEryonIdentityFabric({
        minecraftVersion: version,
        gameDirectory,
        settings,
        requestedLoaderVersion:
          instance?.loader === "fabric"
            ? instance.loaderVersion
            : null
      });
      launchVersionId = fabricProfile.launchVersionId;
      eryonIdentityEnabled = true;
      await appendDiagnosticLog(
        logFiles.launcherLog,
        `ERYON Identity preparado para Minecraft ${version} con Fabric ${fabricProfile.loaderVersion}.`
      );
    }

    // ==================================================
    // ERYON IDENTITY EN FORGE LEGACY
    // ==================================================
    // En versiones donde no existe Fabric (1.8.9 y familia
    // antigua), el identificador viaja como mod de Forge con el
    // runtime de Mixin embebido. No toca el cargador: la
    // instancia ya es Forge.
    let eryonIdentityForgeEnabled = false;

    if (identityForgeForLaunch) {
      await installBundledMod(
        gameDirectory,
        identityForgeForLaunch,
        `el identificador Eryon para Minecraft ${version} (Forge)`
      );
      eryonIdentityForgeEnabled = true;
      await appendDiagnosticLog(
        logFiles.launcherLog,
        `ERYON Identity (Forge) instalado para Minecraft ${version}.`
      );
    }

    // ==================================================
    // OPTIFINE INTEGRADO EN LEGACY
    // ==================================================
    // En 1.8.x los shaders y el rendimiento clásicos vienen de
    // OptiFine (Iris es Fabric y no aplica). El jar se descarga
    // desde el sitio oficial y se coloca en mods/, donde Forge
    // lo carga. Errores no abortan el juego.
    let legacyOptiFineEnabled = false;

    if (
      identityForgeModFileFor(version) &&
      (legacyForgeEnsured || loaderName === "forge") &&
      settings.optimizeBundle !== false
    ) {
      try {
        const optifineResult =
          await modsManager.ensureLegacyOptiFine({
            gameDirectory,
            minecraftVersion: version,
            onStatus: (message) =>
              emitLaunchProgressEvent({
                type: "status",
                message
              })
          });

        if (optifineResult.installed) {
          legacyOptiFineEnabled = true;
          await appendDiagnosticLog(
            logFiles.launcherLog,
            `OptiFine ${optifineResult.fileName} listo para Minecraft ${version}.`
          );
        } else {
          await appendDiagnosticLog(
            logFiles.launcherLog,
            `Sin OptiFine disponible para Minecraft ${version}.`
          );
        }
      } catch (optifineError) {
        await appendDiagnosticLog(
          logFiles.launcherLog,
          `No se pudo preparar OptiFine: ${redactSensitiveData(
            optifineError?.message || optifineError
          )}`
        );
      }
    }

    // ==================================================
    // ESTILO LUNAR: RENDIMIENTO + SHADERS INTEGRADOS
    // ==================================================
    // Como en un "cliente" (Lunar): el launcher se asegura de
    // colocar Sodium (renderizado) e Iris (shaders, la vía
    // compatible con los packs de OptiFine) en CASQUILLOS
    // fabric/vanilla de cualquier versión, instalando Fabric
    // loader automáticamente donde haga falta. OptiFine en sí
    // no se puede redistribuir; sus shaderpacks se ejecutan con
    // Iris sin restricciones.
    let lunarOptimizationsEnabled = false;

    // Fabric loader ya quedó garantizado por el bloque de Eryon
    // Identity (1.20.1, 1.21, 1.21.1) o por la propia instancia
    // fabric; solo hace falta en versiones SIN identity.
    const fabricAlreadyEnsured =
      eryonIdentity1201Enabled || eryonIdentityEnabled;

    if (supportsEryonIdentity && settings.optimizeBundle !== false) {
      try {
        const bundleResult =
          await modsManager.ensureLunarOptimizations({
            gameDirectory,
            minecraftVersion: version,
            onStatus: (message) =>
              emitLaunchProgressEvent({
                type: "status",
                message
              })
          });

        if (bundleResult.appliedCount > 0) {
          lunarOptimizationsEnabled = true;

          await appendDiagnosticLog(
            logFiles.launcherLog,
            `Optimizaciones estilo Lunar (${bundleResult.applied.join(", ")}) preparadas para Minecraft ${version}.`
          );

          // Instancia vanilla: Fabric loader necesario para
          // que los mods de rendimiento carguen.
          if (
            !fabricAlreadyEnsured &&
            (!instance ||
              String(instance.loader).toLowerCase() === "vanilla")
          ) {
            const fabricProfile =
              await modpackManager.ensureFabricForVersion({
                minecraftVersion: version,
                gameDirectory,
                settings
              });
            launchVersionId = fabricProfile.launchVersionId;
          }
        } else if (bundleResult.available === false) {
          await appendDiagnosticLog(
            logFiles.launcherLog,
            `Sin optimizaciones estilo Lunar disponibles para Minecraft ${version}; se lanzará sin ellas.`
          );
        }
      } catch (bundleError) {
        await appendDiagnosticLog(
          logFiles.launcherLog,
          `No se pudo preparar el paquete de optimización: ${redactSensitiveData(bundleError?.message || bundleError)}`
        );
      }
    }

    const versionOptions = {
      number: version,
      type: "release"
    };

    if (launchVersionId !== version) {
      versionOptions.custom = launchVersionId;
    }

    const userJvmArgs = parseJvmArgs(
      instanceRamSettings?.useCustomJvmArgs
        ? instanceRamSettings.jvmArgs
        : settings.jvmArgs
    );

    const loaderType = eryonIdentityEnabled || eryonIdentity1201Enabled
      ? "fabric"
      : String(instance?.loader ?? "").toLowerCase();

    const isFabricLaunch =
      loaderType === "fabric" ||
      launchVersionId.toLowerCase().includes("-fabric-");

    // Los perfiles de Fabric duplican librerías de la versión base
    // (ASM 9.6 frente a la 9.10.1 del vanilla, entre otras). Sin esta
    // limpieza, Fabric Loader aborta al arrancar.
    if (isFabricLaunch) {
      await dedupeInheritedLibraries({
        gameDirectory,
        launchVersionId,
        log: (message) =>
          appendDiagnosticLog(logFiles.launcherLog, message)
      });
    }

    const isForgeLaunch =
      legacyForgeEnsured ||
      Boolean(
        instance &&
        (
          loaderType === "forge" ||
          launchVersionId.toLowerCase().includes("-forge-")
        )
      );

    if (isForgeLaunch && version === "1.8.9") {
      await modpackManager.ensureLegacyAsmLibrary();
      if (eryonIdentityForgeEnabled) {
        await modpackManager.ensureLegacyForgeLaunchLibraries({
          gameDirectory,
          launchVersionId,
          identityModPath: path.join(
            gameDirectory,
            "mods",
            ERYON_IDENTITY_FORGE_189_MOD_FILE
          )
        });
        await appendDiagnosticLog(
          logFiles.launcherLog,
          "Dependencias de Mixin y LZMA agregadas al classpath de Forge 1.8.9."
        );
      }
    }

    const forgeJvmArgs = isForgeLaunch
      ? await getForgeProfileJvmArgs(
          gameDirectory,
          launchVersionId,
          path.join(gameDirectory, "libraries")
        )
      : [];

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Argumentos JVM personalizados del usuario: ${userJvmArgs.length}`
    );

    if (isForgeLaunch) {
      await appendDiagnosticLog(
        logFiles.launcherLog,
        `Argumentos JVM del perfil de Forge: ${forgeJvmArgs.length}`
      );

      if (
        version !== "1.8.9" &&
        (
          !forgeJvmArgs.includes("ALL-MODULE-PATH") ||
          !forgeJvmArgs.includes("-p")
        )
      ) {
        throw new Error(
          "El perfil de Forge no contiene los argumentos modulares requeridos (-p y ALL-MODULE-PATH)."
        );
      }
    }

    // Banderas de recolector de basura estilo launcher vanilla.
    // El modo de gama baja usa Serial GC (menos consumo de memoria y
    // sobrecarga; ideal para equipos de 2-4 núcleos). Si el propio
    // usuario ya definió un recolector con sus argumentos JVM, no se
    // toca nada para no provocar conflictos.
    const usesCustomGc = [...userJvmArgs, ...forgeJvmArgs]
      .some((argument) =>
        /^-XX:[+-]Use\w*(GC|G1)$/.test(argument)
      );

    const gcArguments = [];

    if (!usesCustomGc) {
      if (settings.lowEndMode) {
        gcArguments.push(
          "-XX:+UseSerialGC",
          "-XX:MinHeapFreeRatio=10",
          "-XX:MaxHeapFreeRatio=40"
        );
      } else {
        gcArguments.push(
          "-XX:+UnlockExperimentalVMOptions",
          "-XX:+UseG1GC",
          "-XX:G1NewSizePercent=20",
          "-XX:G1ReservePercent=20",
          "-XX:MaxGCPauseMillis=50",
          "-XX:G1HeapRegionSize=32M"
        );
      }
    }

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Recolector de basura: ${
        usesCustomGc
          ? "definido por el usuario"
          : settings.lowEndMode
            ? "Serial GC (modo gama baja)"
            : "G1 GC (estándar)"
      }`
    );

    const options = {
      authorization,
      root: gameDirectory,
      version: versionOptions,
      overrides: {
        gameDirectory,
        assetRoot: sharedAssetsDirectory,
        libraryRoot: isForgeLaunch
          ? path.join(gameDirectory, "libraries")
          : sharedLibrariesDirectory,
        natives: sharedNativesDirectory
      },

      memory: {
        max: launchMemory.max,
        min: launchMemory.min
      },

      javaPath,

      // Es imprescindible que los argumentos formen una lista plana.
      // No se anidan arrays ni se sustituyen los argumentos originales
      // que requiere el perfil de Forge.
      customArgs: [
        ...gcArguments,
        ...((eryonIdentity1201Enabled ||
          eryonIdentityEnabled ||
          eryonIdentityForgeEnabled)
          ? [
              `-Deryon.presenceUrl=${await getBadgePresenceUrl()}`,
              `-Deryon.playerName=${playerName}`
            ]
          : []),
        ...(authlibInjectorPath
          ? [
              "-Dauthlibinjector.noShowServerName",
              `-javaagent:${authlibInjectorPath}=${
                localSkinServer?.url || "ely.by"
              }`
            ]
          : []),
        ...userJvmArgs,
        ...forgeJvmArgs
      ],

      customLaunchArgs: []
    };

    const launchResolution =
      instanceRamSettings?.useCustomResolution
        ? instanceRamSettings.resolution
        : settings.resolution;

    if (launchResolution !== "default") {
      const [width, height] = launchResolution.split("x");

      options.customLaunchArgs.push(
        "--width",
        width,
        "--height",
        height
      );
    }

    if (settings.fullscreen) {
      options.customLaunchArgs.push(
        "--fullscreen"
      );
    }

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Perfil de lanzamiento: ${launchVersionId}`
    );

    await appendDiagnosticLog(
      logFiles.launcherLog,
      "Iniciando Minecraft."
    );

    emitLaunchProgressEvent({
      type: "status",
      message:
        "Comprobando archivos y descargando recursos..."
    });

    const child = await launcher.launch(options);

    if (!child || typeof child.once !== "function") {
      throw new Error(
        "No se pudo crear el proceso de Minecraft."
      );
    }

    launchingAccounts.delete(accountKey);
    activeProcesses.set(accountKey, { child, version });
    childProcessStarted = true;
    if (instance?.id) {
      void fs.writeFile(
        path.join(logFiles.logsDirectory, "eryon-last-played.txt"),
        new Date().toISOString(),
        "utf8"
      ).catch((error) => {
        console.error(
          "[ERYON] No se pudo guardar la fecha de inicio:",
          normalizeError(error)
        );
      });
    }

    discordStartTimestamp = new Date();
    updateDiscordPresence(true, version);

    child.once("error", async (error) => {
      await stopLocalSkinServer().catch((serverError) => {
        console.error(
          "[ERYON] No se pudo cerrar el servicio de skin local:",
          normalizeError(serverError)
        );
      });
      releaseMinecraftAccount(accountKey, child);

      const message = normalizeError(error);

      void appendDiagnosticLog(
        logFiles.launcherLog,
        `Error del proceso: ${message}`
      );

      emitLaunchProgressEvent({
        type: "error",
        message
      });
    });

    child.once("close", async (code) => {
      await stopLocalSkinServer().catch((error) => {
        console.error(
          "[ERYON] No se pudo cerrar el servicio de skin local:",
          normalizeError(error)
        );
      });
      releaseMinecraftAccount(accountKey, child);

      await appendDiagnosticLog(
        logFiles.launcherLog,
        `Minecraft terminó con código ${code}.`
      );

      if (code !== 0) {
        try {
          const reportPath =
            await saveMinecraftDiagnostic(
              logFiles,
              version,
              code
            );

          await appendDiagnosticLog(
            logFiles.launcherLog,
            `Informe de diagnóstico creado: ${reportPath}`
          );

          emitLaunchProgressEvent({
            type: "log",
            message:
              `Informe guardado en: ${reportPath}`
          });
        } catch (error) {
          console.error(
            "[ERYON] Error creando informe:",
            normalizeError(error)
          );
        }
      }

      emitLaunchProgressEvent({
        type: "closed",
        code,
        message:
          code === 0
            ? "Minecraft se cerró correctamente."
            : `Minecraft se cerró con código ${code}.`
      });
    });

    await appendDiagnosticLog(
      logFiles.launcherLog,
      `Se creó el proceso de Minecraft ${version}.`
    );

    emitLaunchProgressEvent({
      type: "started",
      mode: accountMode,
      playerName,
      playerUuid: formatUuid(authorization?.uuid),
      gameAccountKey: accountKey,
      instanceId: instance?.id ?? null,
      message: instance
        ? `${instance.name} se ha iniciado con ${playerName}.`
        : `Minecraft ${version} se ha iniciado con ${playerName}.`
    });

    return {
      started: true,
      version,
      mode: accountMode,
      playerName,
      playerUuid: formatUuid(authorization?.uuid),
      gameAccountKey: accountKey,
      instanceId: instance?.id ?? null
    };
  } catch (error) {
    const message = normalizeError(error);
    await stopLocalSkinServer().catch((serverError) => {
      console.error(
        "[ERYON] No se pudo cerrar el servicio de skin local:",
        normalizeError(serverError)
      );
    });

    if (logFiles) {
      await appendDiagnosticLog(
        logFiles.launcherLog,
        `Error al iniciar Minecraft: ${message}`
      );
    }

    emitLaunchProgressEvent({
      type: "error",
      message
    });

    throw error;
  } finally {
    launchingAccounts.delete(accountKey);
    if (!childProcessStarted) {
      releaseMinecraftAccount(accountKey);
    }
  }
}

async function launchInstance(
  instanceId,
  profileSelection,
  launchWindow = null
) {
  const instance =
    await modpackManager.getInstance(instanceId);

  return launchMinecraft(
    instance.minecraftVersion,
    profileSelection,
    instance.id,
    launchWindow
  );
}

// ======================================================
// VENTANA SPLASH (LOGO MIENTRAS CARGA)
// ======================================================

let splashWindow = null;
let splashTimeout = null;
let splashStartedAt = 0;
let mainRevealTimeout = null;
const MIN_SPLASH_DURATION_MS = 2500;

function createSplashWindow() {
  splashStartedAt = Date.now();

  splashWindow = new BrowserWindow({
    width: 420,
    height: 340,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    transparent: false,
    backgroundColor: "#0b0b0d",
    title: "Eryon Launcher",
    icon: path.join(__dirname, "..", "build", "icon.ico"),

    webPreferences: {
      // El splash es estático: no necesita preload ni node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"));

  // Red de seguridad: si la principal nunca termina de cargar,
  // el splash no se queda pegado para siempre.
  splashTimeout = setTimeout(() => closeSplashWindow(), 20000);

  return splashWindow;
}

function closeSplashWindow() {
  if (splashTimeout) {
    clearTimeout(splashTimeout);
    splashTimeout = null;
  }

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }

  splashWindow = null;
}

// ======================================================
// CONFIGURAR LA VENTANA PRINCIPAL
// ======================================================

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "Eryon Launcher",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    backgroundColor: "#0b0b0d",
    autoHideMenuBar: true,
    // Invisible hasta ready-to-show: mientras tanto el splash
    // (solo el logo) cubre la espera, sin pantallazos en blanco.
    show: false,

    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // El título lleva la versión exacta instalada: así es evidente
  // a simple vista cuando una actualización se aplicó bien. El
  // <title> del HTML lo pisa al cargar la página, por eso se
  // vuelve a fijar en cada intento de cambio de título.
  win.setTitle(`Eryon Launcher ${app.getVersion()}`);
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(`Eryon Launcher ${app.getVersion()}`);
  });

  win.once("ready-to-show", () => {
    // La ventana principal ya terminó de renderizarse en segundo plano.
    // Mantenemos el splash un instante adicional para evitar un cambio
    // brusco y permitir que la interfaz aparezca completa.
    const elapsed = Date.now() - splashStartedAt;
    const remaining = Math.max(
      0,
      MIN_SPLASH_DURATION_MS - elapsed
    );

    mainRevealTimeout = setTimeout(() => {
      mainRevealTimeout = null;

      if (win.isDestroyed()) return;

      closeSplashWindow();
      win.show();
    }, remaining);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") {
        shell.openExternal(url).catch((error) => {
          console.error(
            "[ERYON] No se pudo abrir el enlace externo:",
            normalizeError(error)
          );
        });
      }
    } catch (error) {
      console.warn(
        "[ERYON] Se bloqueó una URL externa no válida:",
        normalizeError(error)
      );
    }

    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  win.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });

  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    }
  );

  if (app.isPackaged) {
    await win.loadFile(
      path.join(__dirname, "..", "dist", "index.html")
    );
  } else {
    await win.loadURL(
      "http://127.0.0.1:5173"
    );
  }
}

// ======================================================
// IPC: INFORMACIÓN Y CONFIGURACIÓN
// ======================================================

ipcMain.handle("eryon:get-info", () => ({
  name: "Eryon Launcher",
  version: app.getVersion(),
  platform: process.platform,
  architecture: process.arch
}));

ipcMain.handle(
  "eryon:get-settings",
  () => readSettings()
);

ipcMain.handle(
  "eryon:save-settings",
  (_event, input) => saveSettings(input)
);

ipcMain.handle(
  "eryon:get-firebase-config",
  async () => {
    try {
      const raw = await fs.readFile(
        userDataPath(FIREBASE_FILE),
        "utf8"
      );

      const parsed = JSON.parse(raw);

      return parsed && typeof parsed === "object"
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
);

ipcMain.handle(
  "eryon:save-firebase-config",
  async (_event, input) => {
    if (!input || typeof input !== "object") {
      throw new Error(
        "La configuración de Firebase no es válida."
      );
    }

    const apiKey = String(input.apiKey || "").trim();
    const databaseURL = String(input.databaseURL || "").trim();
    const projectId = String(input.projectId || "").trim();

    if (!apiKey || !databaseURL || !projectId) {
      throw new Error(
        "Faltan datos obligatorios de Firebase: apiKey, databaseURL y projectId."
      );
    }

    if (!/^https?:\/\//i.test(databaseURL)) {
      throw new Error(
        "databaseURL debe ser una URL completa, por ejemplo https://TU-PROYECTO.firebaseio.com"
      );
    }

    const config = {
      apiKey,
      databaseURL,
      projectId,
      appId: String(input.appId || "").trim()
    };

    await fs.mkdir(app.getPath("userData"), {
      recursive: true
    });

    await fs.writeFile(
      userDataPath(FIREBASE_FILE),
      JSON.stringify(config, null, 2),
      "utf8"
    );

    return config;
  }
);

// ======================================================
// IPC: EXPLORADOR DE CONTENIDO (MODS, TEXTURAS, ETC.)
// ======================================================

ipcMain.handle(
  "eryon:content-status",
  async () => {
    const apiKey = await modsManager.readCurseforgeKey(
      userDataPath(CURSEFORGE_FILE)
    );

    // curseforgeReady solo si la clave existe Y la API la acepta:
    // una clave vieja/inválida no deja activar el botón.
    let curseforgeReady = false;

    if (apiKey) {
      try {
        const support = await modsManager.curseforgeSupportCheck(apiKey);
        curseforgeReady = Boolean(support.mods || support.modpacks);
      } catch {
        curseforgeReady = false;
      }
    }

    return {
      modrinthReady: true,
      curseforgeReady
    };
  }
);

ipcMain.handle(
  "eryon:save-curseforge-key",
  async (_event, apiKey) => {
    const configured = await modsManager.writeCurseforgeKey(
      userDataPath(CURSEFORGE_FILE),
      apiKey
    );

    return { configured };
  }
);

ipcMain.handle(
  "eryon:browse-content",
  async (_event, input) => {
    const apiKey = await modsManager.readCurseforgeKey(
      userDataPath(CURSEFORGE_FILE)
    );

    return modsManager.searchContent({
      source: input?.source,
      type: input?.type,
      query: String(input?.query ?? "").slice(0, 128),
      gameVersion: String(input?.gameVersion ?? "").slice(0, 32),
      loader: String(input?.loader ?? "").slice(0, 16),
      sort: String(input?.sort ?? "").slice(0, 16),
      category: String(input?.category ?? "").slice(0, 64),
      apiKey,
      limit: 24,
      offset: Math.max(
        0,
        Math.min(960, Number(input?.offset) || 0)
      )
    });
  }
);

ipcMain.handle(
  "eryon:content-filters",
  async () => {
    const apiKey = await modsManager.readCurseforgeKey(
      userDataPath(CURSEFORGE_FILE)
    );

    try {
      return await modsManager.getContentFilters(apiKey);
    } catch {
      // Sin catálogo, la UI muestra solo orden y texto.
      return {
        versions: [],
        modrinth: { mods: [], modpacks: [], textures: [], shaders: [] },
        curseforge: { mods: [], modpacks: [], textures: [], shaders: [] }
      };
    }
  }
);

ipcMain.handle(
  "eryon:content-versions",
  async (_event, input) => {
    const apiKey = await modsManager.readCurseforgeKey(
      userDataPath(CURSEFORGE_FILE)
    );

    return modsManager.listContentVersions({
      source: input?.source === "curseforge" ? "curseforge" : "modrinth",
      type: String(input?.type ?? "").trim(),
      projectId: String(input?.projectId ?? "").trim(),
      apiKey,
      limit: 60,
      gameVersion: String(input?.gameVersion ?? "").slice(0, 32)
    });
  }
);

ipcMain.handle(
  "eryon:install-content",
  async (_event, input) => {
    const instance = await modpackManager.getInstance(
      input?.instanceId
    );

    if (!instance?.gameDirectory) {
      throw new Error(
        "La instalación no tiene un directorio válido."
      );
    }

    const apiKey = await modsManager.readCurseforgeKey(
      userDataPath(CURSEFORGE_FILE)
    );

    const installed =
      await modsManager.installContent({
        source: input?.source === "curseforge" ? "curseforge" : "modrinth",
        type: String(input?.type ?? "").trim(),
        projectId: String(input?.projectId ?? "").trim(),
        instanceGameDirectory: instance.gameDirectory,
        instanceName: instance.name,
        gameVersion: String(
          input?.gameVersion ?? instance.minecraftVersion ?? ""
        ),
        // La compatibilidad se decide con el cargador real de la instancia,
        // no con el filtro visual "Todos" del explorador.
        loader: String(instance.loader || "vanilla").slice(0, 16),
        apiKey,
        versionId: String(input?.versionId ?? "").trim()
      });

    const iconUrl = String(input?.iconUrl ?? "");
    if (
      installed.path &&
      String(input?.type ?? "").trim() === "shaders" &&
      /^https:\/\/cdn\.modrinth\.com\//i.test(iconUrl)
    ) {
      const metadataPath = path.join(
        path.dirname(installed.path),
        ".eryon-content.json"
      );
      let metadata = {};
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        throw new Error("Los metadatos de shaders de la instalación no son válidos.");
      }
      metadata[path.basename(installed.path)] = iconUrl;
      await fs.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2),
        "utf8"
      );
    }

    sendLaunchEvent({
      type: "log",
      message: `Contenido instalado: ${installed.fileName} (${path.basename(path.dirname(installed.path))})`
    });

    return installed;
  }
);

// =====================================================
// IPC: INSTALACIÓN DIRECTA DE MODPACKS COMO INSTANCIA
// =====================================================
// Descarga el pack desde el explorador (Modrinth o CurseForge)
// y lo instala completo en el launcher como una NUEVA instancia
// (mods, overrides y cargador incluidos), sin interfaz de
// sistema de archivos para el usuario.

// Evita instalar el mismo modpack dos veces a la vez: si llega
// otra petición del mismo pack mientras se instala, se rechaza
// con un mensaje claro en vez de descargarlo dos veces.
const activeModpackInstalls = new Set();

ipcMain.handle(
  "eryon:install-modpack-content",
  async (_event, input) => {
    const source =
      input?.source === "curseforge"
        ? "curseforge"
        : "modrinth";

    const projectId = String(
      input?.projectId ?? ""
    ).trim();

    const instanceName = String(
      input?.name ?? ""
    ).trim();

    if (!projectId) {
      throw new Error(
        "El modpack no tiene identificador válido."
      );
    }

    const packKey = `${source}:${projectId}`;

    if (activeModpackInstalls.has(packKey)) {
      throw new Error(
        "Este modpack ya se está instalando. Espera a que termine antes de volver a intentarlo."
      );
    }

    activeModpackInstalls.add(packKey);

    const reportModpackProgress = (message, progress) => {
      sendLaunchEvent({
        type: "modpack-progress",
        name: instanceName || "Nuevo modpack",
        iconUrl: String(input?.iconUrl || ""),
        message,
        progress:
          progress === null
            ? null
            : Math.max(0, Math.min(100, Number(progress) || 0)),
        status: "installing"
      });
    };

    reportModpackProgress("Buscando el archivo del modpack", 0);

    let apiKey = null;
    let temporaryDirectory = null;

    try {
      apiKey = await modsManager.readCurseforgeKey(
        userDataPath(CURSEFORGE_FILE)
      );

      temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "eryon-pack-")
      );

      const versionId = String(
        input?.versionId ?? ""
      ).trim();

      const file =
        source === "modrinth"
          ? await modsManager.resolveModrinthPackFile(
              projectId,
              versionId
            )
          : await modsManager.resolveCurseforgePackFile(
              projectId,
              apiKey,
              versionId
            );

      reportModpackProgress(`Preparando ${file.fileName}`, 3);

      sendLaunchEvent({
        type: "log",
        message: `Descargando modpack: ${file.fileName}...`
      });

      const packPath =
        await modsManager.downloadContentFile({
          fileName: file.fileName,
          url: file.url,
          directory: temporaryDirectory,
          apiKey,
          fallbackExtension: source === "curseforge" ? ".zip" : ".mrpack",
          onProgress: ({ percent }) => {
            reportModpackProgress(
              `Descargando ${file.fileName}`,
              percent === null ? null : 5 + percent * 0.2
            );
          }
        });

      reportModpackProgress("Archivo descargado; preparando la instalación", 25);

      const instance =
        source === "modrinth"
          ? await modpackManager.installMrpackPackFile(
              packPath,
              {
                instanceName: instanceName || "",
                iconUrl: input?.iconUrl,
                installerBridgeJar: getForgeInstallerBridgePath(),
                onProgress: ({ message, progress }) =>
                  reportModpackProgress(message, progress)
              }
            )
          : await modpackManager.installCurseforgePackFile(
              packPath,
              {
                instanceName: instanceName || "",
                iconUrl: input?.iconUrl,
                installerBridgeJar: getForgeInstallerBridgePath(),
                onProgress: ({ message, progress }) =>
                  reportModpackProgress(message, progress),
                resolveFile:
                  (memberProjectId, memberFileId) =>
                    modsManager.resolveCurseforgePackMember(
                      {
                        projectId: memberProjectId,
                        fileId: memberFileId,
                        apiKey
                      }
                    )
              }
            );

      sendLaunchEvent({
        type: "log",
        message: `Modpack instalado como instancia nueva: ${instance.name}`
      });

      sendLaunchEvent({
        type: "modpack-progress",
        name: instance.name,
        iconUrl: instance.iconUrl || "",
        message: "Instalación completada",
        progress: 100,
        status: "complete"
      });

      return instance;
    } catch (installError) {
      sendLaunchEvent({
        type: "modpack-progress",
        name: instanceName || "Nuevo modpack",
        iconUrl: String(input?.iconUrl || ""),
        message: installError?.message || "No se pudo instalar el modpack.",
        status: "error"
      });
      throw installError;
    } finally {
      activeModpackInstalls.delete(packKey);

      if (temporaryDirectory) {
        await fs
          .rm(temporaryDirectory, {
            recursive: true,
            force: true
          })
          .catch(() => {});
      }
    }
  }
);

// =====================================================
// IPC: MODS DE UNA INSTANCIA (VISTA ESTILO CURSEFORGE)
// =====================================================
// Lista el contenido .jar de la carpeta mods de la instancia
// con nombre/versión/descripción leídos del propio jar
// (fabric.mod.json / quilt.mod.json / mods.toml).

function dependencyEntries(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        id: String(entry.id || entry.modid || "").trim(),
        version:
          typeof entry.versions === "string"
            ? entry.versions
            : typeof entry.version === "string"
              ? entry.version
              : "*"
      }))
      .filter((entry) => entry.id);
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([id, constraint]) => ({
      id: id.trim(),
      version:
        typeof constraint === "string"
          ? constraint
          : typeof constraint?.versions === "string"
            ? constraint.versions
            : typeof constraint?.version === "string"
              ? constraint.version
              : "*"
    })).filter((entry) => entry.id);
  }

  return [];
}

function compareModVersions(left, right) {
  const leftParts = String(left).match(/\d+|[A-Za-z]+/g) || [];
  const rightParts = String(right).match(/\d+|[A-Za-z]+/g) || [];

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index] || "0";
    const b = rightParts[index] || "0";
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);

    if (aNumber && bNumber) {
      const difference = Number(a) - Number(b);
      if (difference) return Math.sign(difference);
    } else {
      const comparison = a.localeCompare(b, undefined, { sensitivity: "base" });
      if (comparison) return Math.sign(comparison);
    }
  }

  return 0;
}

function satisfiesModVersion(version, range) {
  const actual = String(version || "").trim();
  const requested = String(range || "*").trim();

  if (!actual || !requested || requested === "*") return true;

  return requested.split("||").some((alternative) => {
    const normalizedAlternative = alternative.trim();
    const exactRange = normalizedAlternative.match(/^\[([^,\[\]]+)\]$/);
    if (exactRange) {
      const expectedExact = exactRange[1].trim();
      return (
        compareModVersions(actual, expectedExact) === 0 ||
        actual === expectedExact ||
        actual.startsWith(`${expectedExact}.`)
      );
    }

    const interval = normalizedAlternative
      .match(/^(\[|\()([^,]*),([^\]\)]*)(\]|\))$/);
    if (interval) {
      const lower = interval[2].trim();
      const upper = interval[3].trim();
      const lowerCompare = lower ? compareModVersions(actual, lower) : 1;
      const upperCompare = upper ? compareModVersions(actual, upper) : -1;
      return (
        (!lower || (interval[1] === "[" ? lowerCompare >= 0 : lowerCompare > 0)) &&
        (!upper || (interval[4] === "]" ? upperCompare <= 0 : upperCompare < 0))
      );
    }

    const conditions = normalizedAlternative
      .split(/\s*,\s*|\s+/)
      .filter(Boolean);

    return conditions.every((condition) => {
      const match = condition.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
      if (!match) return true;

      const operator = match[1] || "=";
      if (!match[1] && /[xX*]/.test(match[2])) {
        const prefix = match[2].split(/[xX*]/)[0];
        return actual.startsWith(prefix);
      }
      const expected = match[2].replace(/[xX*]$/, "");
      if (!expected) return true;

      const comparison = compareModVersions(actual, expected);
      if (operator === ">=") return comparison >= 0;
      if (operator === "<=") return comparison <= 0;
      if (operator === ">") return comparison > 0;
      if (operator === "<") return comparison < 0;
      if (operator === "^") {
        const parts = expected.split(".").map(Number);
        const upper = parts[0] > 0
          ? `${parts[0] + 1}.0.0`
          : `${parts[0] || 0}.${(parts[1] || 0) + 1}.0`;
        return comparison >= 0 && compareModVersions(actual, upper) < 0;
      }
      if (operator === "~") {
        const parts = expected.split(".").map(Number);
        const upper = `${parts[0] || 0}.${(parts[1] || 0) + 1}.0`;
        return comparison >= 0 && compareModVersions(actual, upper) < 0;
      }

      return actual === expected || actual.startsWith(`${expected}.`);
    });
  });
}

ipcMain.handle(
  "eryon:list-instance-mods",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(
      instanceId
    );

    if (!instance?.gameDirectory) {
      throw new Error(
        "La instalación no tiene un directorio válido."
      );
    }

    const modsDirectory = path.join(
      instance.gameDirectory,
      "mods"
    );

    let directoryEntries = [];

    try {
      directoryEntries = await fs.readdir(
        modsDirectory,
        { withFileTypes: true }
      );
    } catch {
      // Sin carpeta mods: la vista se muestra vacía.
      return [];
    }

    const {
      readJarModMetadata,
      readZipEntryBuffer
    } = require("./jar-metadata.cjs");

    const mods = [];

    for (const entry of directoryEntries) {
      if (!entry.isFile()) continue;

      const fileName = entry.name;

      if (!/\.jar$/i.test(fileName)) continue;

      const filePath = path.join(modsDirectory, fileName);

      const stats = await fs
        .stat(filePath)
        .catch(() => null);

      if (!stats) continue;

      let metadata = null;
      let iconUrl = "";

      try {
        metadata = await readJarModMetadata(filePath);
      } catch {
        metadata = null;
      }

      if (metadata?.icon) {
        try {
          const iconPath = metadata.icon.replace(/\\/g, "/");
          const iconBytes = await readZipEntryBuffer(
            filePath,
            iconPath
          );
          const extension = path.extname(iconPath).toLowerCase();
          const mimeType = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp"
          }[extension];

          if (iconBytes && mimeType) {
            iconUrl = `data:${mimeType};base64,${iconBytes.toString("base64")}`;
          }
        } catch {
          // Un icono ausente o inválido no impide mostrar el mod.
        }
      }

      mods.push({
        fileName,
        modId: metadata?.modId || "",
        name:
          metadata?.name ||
          fileName.replace(/\.jar$/i, ""),
        version: metadata?.version || "",
        description: metadata?.description || "",
        iconUrl,
        size: stats.size,
        modifiedAt: Math.round(stats.mtimeMs)
      });
    }

    mods.sort((a, b) =>
      a.name.localeCompare(b.name, "es")
    );

    return mods;
  }
);

ipcMain.handle(
  "eryon:check-instance-mod-updates",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(instanceId);
    if (!instance?.gameDirectory) {
      throw new Error("La instalación no tiene un directorio válido.");
    }

    const modsDirectory = path.join(instance.gameDirectory, "mods");
    const entries = await fs.readdir(modsDirectory, {
      withFileTypes: true
    }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const { readJarModMetadata } = require("./jar-metadata.cjs");
    const updates = [];

    for (const entry of entries) {
      if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
      const metadata = await readJarModMetadata(
        path.join(modsDirectory, entry.name),
        { loader: instance.loader }
      ).catch(() => null);
      const modId = String(metadata?.modId || "").trim();
      const installedVersion = String(metadata?.version || "").trim();
      if (!modId || !installedVersion) continue;

      try {
        const search = await modsManager.searchContent({
          source: "modrinth",
          type: "mods",
          query: modId,
          gameVersion: instance.minecraftVersion,
          loader: instance.loader,
          limit: 20,
          offset: 0
        });
        const project = search.results?.find(
          (item) =>
            String(item.slug).toLowerCase() === modId.toLowerCase() ||
            String(item.id).toLowerCase() === modId.toLowerCase()
        );
        if (!project) continue;

        const releases = await modsManager.listContentVersions({
          source: "modrinth",
          type: "mods",
          projectId: project.id,
          limit: 100,
          gameVersion: instance.minecraftVersion
        });
        const compatible = releases.versions?.filter(
          (release) =>
            (!release.loaders?.length ||
              release.loaders.includes(instance.loader)) &&
            (!release.gameVersions?.length ||
              release.gameVersions.includes(instance.minecraftVersion))
        ) || [];
        const latest = compatible[0];
        if (
          latest?.versionId &&
          compareModVersions(latest.name, installedVersion) > 0
        ) {
          updates.push({
            fileName: entry.name,
            modId,
            name: metadata?.name || modId,
            installedVersion,
            latestVersion: latest.name,
            projectId: project.id,
            versionId: latest.versionId
          });
        }
      } catch (error) {
        console.warn(
          `[ERYON] No se pudieron consultar actualizaciones de ${modId}:`,
          error?.message || error
        );
      }
    }

    return updates;
  }
);

ipcMain.handle(
  "eryon:update-instance-mod",
  async (_event, input) => {
    const instance = await modpackManager.getInstance(input?.instanceId);
    if (!instance?.gameDirectory) {
      throw new Error("La instalación no tiene un directorio válido.");
    }

    const oldFileName = String(input?.fileName || "").trim();
    const projectId = String(input?.projectId || "").trim();
    const versionId = String(input?.versionId || "").trim();
    if (
      !oldFileName ||
      path.basename(oldFileName) !== oldFileName ||
      !/\.jar$/i.test(oldFileName) ||
      !projectId ||
      !versionId
    ) {
      throw new Error("Los datos de actualización del mod no son válidos.");
    }

    const modsDirectory = path.resolve(instance.gameDirectory, "mods");
    const oldPath = path.resolve(modsDirectory, oldFileName);
    if (path.dirname(oldPath) !== modsDirectory) {
      throw new Error("La ruta del mod no es válida.");
    }

    const tempRoot = path.join(
      os.tmpdir(),
      `eryon-mod-update-${crypto.randomUUID()}`
    );
    await fs.mkdir(tempRoot, { recursive: true });

    try {
      const downloaded = await modsManager.installContent({
        source: "modrinth",
        type: "mods",
        projectId,
        instanceGameDirectory: tempRoot,
        gameVersion: instance.minecraftVersion,
        loader: instance.loader,
        versionId
      });

      const downloadedPath = path.resolve(downloaded.path);
      if (path.dirname(downloadedPath) !== path.join(tempRoot, "mods")) {
        throw new Error("El archivo descargado salió de la carpeta temporal.");
      }
      const destinationPath = path.join(modsDirectory, downloaded.fileName);
      const oldExists = await fs.stat(oldPath).then(
        (stat) => stat.isFile(),
        (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        }
      );
      if (!oldExists) {
        throw new Error("El mod original ya no está en la instalación.");
      }

      const backupPath = `${oldPath}.eryon-backup-${crypto.randomUUID()}`;
      await fs.rename(oldPath, backupPath);
      try {
        await fs.rename(downloadedPath, destinationPath);
      } catch (error) {
        await fs.rename(backupPath, oldPath);
        throw error;
      }

      await fs.rm(backupPath, { force: true });
      return { updated: true, fileName: downloaded.fileName };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
);

ipcMain.handle(
  "eryon:list-instance-content",
  async (_event, input) => {
    const instance = await modpackManager.getInstance(
      input?.instanceId
    );

    if (!instance?.gameDirectory) {
      throw new Error(
        "La instalación no tiene un directorio válido."
      );
    }

    const categories = {
      textures: {
        directory: "resourcepacks",
        extensions: /\.(zip)$/i
      },
      shaders: {
        directory: "shaderpacks",
        extensions: /\.(zip|jar)$/i
      }
    };
    const category = categories[input?.category];

    if (!category) {
      throw new Error("La categoría de contenido no es válida.");
    }

    const contentDirectory = path.join(
      instance.gameDirectory,
      category.directory
    );

    let entries;
    try {
      entries = await fs.readdir(contentDirectory, {
        withFileTypes: true
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const files = [];
    const { readZipEntryBuffer } = require("./jar-metadata.cjs");
    const previewCandidates =
      input.category === "textures"
        ? ["pack.png"]
        : [
            "preview.png",
            "shaders/preview.png",
            "pack.png",
            "icon.png",
            "logo.png",
            "image.png",
            "preview.jpg",
            "preview.webp"
          ];
    const imageMimeTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    };
    const metadataPath = path.join(
      contentDirectory,
      ".eryon-content.json"
    );
    let contentMetadata = {};

    if (input.category === "shaders") {
      try {
        contentMetadata = JSON.parse(
          await fs.readFile(metadataPath, "utf8")
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (
        !contentMetadata ||
        typeof contentMetadata !== "object" ||
        Array.isArray(contentMetadata)
      ) {
        throw new Error("Los metadatos de shaders de la instalación no son válidos.");
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || !category.extensions.test(entry.name)) {
        continue;
      }

      const filePath = path.join(contentDirectory, entry.name);
      const stats = await fs.stat(filePath);
      let iconUrl = "";

      for (const previewPath of previewCandidates) {
        try {
          const preview = await readZipEntryBuffer(
            filePath,
            previewPath
          );
          const mimeType =
            imageMimeTypes[path.extname(previewPath).toLowerCase()];

          if (preview && mimeType) {
            iconUrl = `data:${mimeType};base64,${preview.toString("base64")}`;
            break;
          }
        } catch {
          // A missing or unreadable preview should not hide the pack.
        }
      }

      if (!iconUrl && input.category === "shaders") {
        const savedIcon = contentMetadata[entry.name];
        iconUrl =
          typeof savedIcon === "string" &&
          /^https:\/\/cdn\.modrinth\.com\//i.test(savedIcon)
            ? savedIcon
            : "";
      }

      if (
        !iconUrl &&
        input.category === "shaders" &&
        !Object.prototype.hasOwnProperty.call(
          contentMetadata,
          entry.name
        )
      ) {
        const searchTerm = entry.name.replace(/\.(zip|jar)$/i, "");
        try {
          const search = await modsManager.searchContent({
            source: "modrinth",
            type: "shaders",
            query: searchTerm,
            limit: 10,
            offset: 0
          });
          let searchCompleted = true;
          for (const project of search.results ?? []) {
            if (!project.iconUrl) continue;
            const versions = await modsManager.listContentVersions({
              source: "modrinth",
              type: "shaders",
              projectId: project.id,
              limit: 100
            });
            const matchingFile = versions.versions?.some(
              (version) =>
                String(version.fileName || "").toLowerCase() ===
                entry.name.toLowerCase()
            );
            if (matchingFile) {
              iconUrl = project.iconUrl;
              contentMetadata[entry.name] = project.iconUrl;
              await fs.writeFile(
                metadataPath,
                JSON.stringify(contentMetadata, null, 2),
                "utf8"
              );
              break;
            }
          }
          if (!iconUrl && searchCompleted) {
            contentMetadata[entry.name] = "";
            await fs.writeFile(
              metadataPath,
              JSON.stringify(contentMetadata, null, 2),
              "utf8"
            );
          }
        } catch (error) {
          console.warn(
            `[ERYON] No se pudo obtener el icono de ${entry.name} desde Modrinth:`,
            error?.message || error
          );
        }
      }

      files.push({
        fileName: entry.name,
        name: entry.name.replace(/\.(zip|jar)$/i, ""),
        iconUrl,
        size: stats.size,
        modifiedAt: Math.round(stats.mtimeMs)
      });
    }

    files.sort((a, b) => a.name.localeCompare(b.name, "es"));
    return files;
  }
);

async function getDirectorySize(directory) {
  let total = 0;
  const pending = [directory];

  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile()) {
        total += (await fs.stat(target)).size;
      }
    }
  }

  return total;
}

function getWorldBackupRoot(instance) {
  return path.join(instance.gameDirectory, ".eryon-world-backups");
}

async function listWorldBackupEntries(instance, worldName) {
  const worldBackupDirectory = path.join(
    getWorldBackupRoot(instance),
    worldName
  );

  let entries;
  try {
    entries = await fs.readdir(worldBackupDirectory, {
      withFileTypes: true
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{13}-[a-f0-9]{8}$/.test(entry.name)) {
      continue;
    }
    const directory = path.join(worldBackupDirectory, entry.name);
    backups.push({
      id: entry.name,
      createdAt: new Date(Number(entry.name.slice(0, 13))).toISOString(),
      size: await getDirectorySize(directory)
    });
  }
  return backups.sort((a, b) => b.id.localeCompare(a.id));
}

ipcMain.handle(
  "eryon:list-instance-worlds",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(instanceId);
    const savesDirectory = path.resolve(instance.gameDirectory, "saves");

    let saveEntries;
    try {
      saveEntries = await fs.readdir(savesDirectory, {
        withFileTypes: true
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      saveEntries = [];
    }

    const worldNames = new Set(
      saveEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    );
    const backupRoot = getWorldBackupRoot(instance);
    const backupWorldEntries = await fs.readdir(backupRoot, {
      withFileTypes: true
    }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of backupWorldEntries) {
      if (
        entry.isDirectory() &&
        entry.name !== "." &&
        entry.name !== ".." &&
        !/[<>:"/\\|?*\0]/.test(entry.name)
      ) {
        worldNames.add(entry.name);
      }
    }

    const worlds = [];
    for (const name of worldNames) {
      const worldDirectory = path.resolve(savesDirectory, name);
      if (path.dirname(worldDirectory) !== savesDirectory) continue;
      const stat = await fs.stat(worldDirectory).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      worlds.push({
        name,
        size: stat?.isDirectory()
          ? await getDirectorySize(worldDirectory)
          : 0,
        modifiedAt: stat?.mtimeMs || 0,
        backups: await listWorldBackupEntries(instance, name)
      });
    }

    return worlds.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }
);

ipcMain.handle(
  "eryon:get-instance-status",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(instanceId);
    const logsDirectory = path.join(instance.gameDirectory, "logs");
    const lastPlayedPath = path.join(logsDirectory, "eryon-last-played.txt");
    const lastPlayed = await fs.readFile(lastPlayedPath, "utf8").catch(
      async (error) => {
        if (error?.code !== "ENOENT") throw error;
        const logStat = await fs.stat(
          path.join(logsDirectory, "eryon-launcher.log")
        ).catch((statError) => {
          if (statError?.code === "ENOENT") return null;
          throw statError;
        });
        return logStat?.mtime?.toISOString() || "";
      }
    );
    const crashDirectory = path.join(
      instance.gameDirectory,
      "crash-reports"
    );
    const crashEntries = await fs.readdir(crashDirectory, {
      withFileTypes: true
    }).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    let lastCrash = null;
    for (const entry of (crashEntries || [])
      .filter((item) => item.isFile() && /^eryon-diagnostic-\d+\.txt$/.test(item.name))
      .sort((a, b) => b.name.localeCompare(a.name))) {
      const reportPath = path.join(crashDirectory, entry.name);
      const report = await fs.readFile(reportPath, "utf8");
      const code = report.match(/^Código de cierre: (.+)$/m)?.[1] || "desconocido";
      lastCrash = {
        code,
        reportName: entry.name,
        createdAt: (await fs.stat(reportPath)).mtime.toISOString()
      };
      break;
    }

    return {
      size: await getDirectorySize(instance.gameDirectory),
      lastPlayedAt: lastPlayed.trim(),
      lastCrash
    };
  }
);

ipcMain.handle(
  "eryon:export-instance-modpack",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(instanceId);
    const approval = await dialog.showMessageBox({
      type: "warning",
      title: "Exportar modpack",
      message: "El archivo incluirá configuración de mods",
      detail:
        "Los archivos de mods se referencian desde Modrinth y no se copian al paquete. Revisa los archivos de configuración antes de compartirlo para asegurarte de que no contengan contraseñas, tokens ni datos privados.",
      buttons: ["Cancelar", "Continuar"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (approval.response !== 1) return { canceled: true };

    const safeFileName =
      instance.name.replace(/[<>:"/\\|?*]/g, "_").trim() || "Modpack";
    const result = await dialog.showSaveDialog({
      title: "Exportar modpack Modrinth",
      defaultPath: `${safeFileName}.mrpack`,
      filters: [{ name: "Modrinth Modpack", extensions: ["mrpack"] }]
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const modsDirectory = path.join(instance.gameDirectory, "mods");
    const entries = await fs.readdir(modsDirectory, {
      withFileTypes: true
    }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const { readJarModMetadata } = require("./jar-metadata.cjs");
    const manifestFiles = [];
    const unsupportedMods = [];

    for (const entry of entries) {
      if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
      const metadata = await readJarModMetadata(
        path.join(modsDirectory, entry.name)
      ).catch(() => null);
      const modId = String(metadata?.modId || "").trim();
      const installedVersion = String(metadata?.version || "").trim();
      if (!modId) {
        unsupportedMods.push(entry.name);
        continue;
      }

      try {
        const search = await modsManager.searchContent({
          source: "modrinth",
          type: "mods",
          query: modId,
          gameVersion: instance.minecraftVersion,
          loader: instance.loader,
          limit: 20,
          offset: 0
        });
        const project = search.results?.find(
          (item) =>
            String(item.slug).toLowerCase() === modId.toLowerCase() ||
            String(item.id).toLowerCase() === modId.toLowerCase()
        );
        if (!project) {
          unsupportedMods.push(entry.name);
          continue;
        }

        const releases = await modsManager.listContentVersions({
          source: "modrinth",
          type: "mods",
          projectId: project.id,
          limit: 100,
          gameVersion: instance.minecraftVersion
        });
        const release = releases.versions?.find(
          (item) =>
            item.fileName.toLowerCase() === entry.name.toLowerCase() ||
            (installedVersion && item.name === installedVersion)
        );
        if (!release?.versionId) {
          unsupportedMods.push(entry.name);
          continue;
        }

        const response = await fetch(
          `https://api.modrinth.com/v2/version/${encodeURIComponent(release.versionId)}`,
          { signal: AbortSignal.timeout(15000) }
        );
        if (!response.ok) {
          throw new Error(`Modrinth respondió ${response.status}.`);
        }
        const releaseDetails = await response.json();
        const file =
          releaseDetails.files?.find((item) => item.primary) ||
          releaseDetails.files?.[0];
        if (
          !file?.filename ||
          !file?.url ||
          !/^https:\/\/cdn\.modrinth\.com\//i.test(file.url) ||
          !file.hashes?.sha1 ||
          !file.hashes?.sha512
        ) {
          unsupportedMods.push(entry.name);
          continue;
        }

        manifestFiles.push({
          path: `mods/${file.filename}`,
          hashes: {
            sha1: file.hashes.sha1,
            sha512: file.hashes.sha512
          },
          env: { client: "required", server: "optional" },
          downloads: [file.url],
          fileSize: Number(file.size) || 0
        });
      } catch (error) {
        throw new Error(
          `No se pudo preparar ${entry.name} para exportar: ${normalizeError(error)}`
        );
      }
    }

    if (unsupportedMods.length) {
      throw new Error(
        `No se exportó el modpack porque no se pudieron vincular estos mods con archivos oficiales de Modrinth: ${unsupportedMods.join(", ")}.`
      );
    }

    const dependencies = { minecraft: instance.minecraftVersion };
    const loaderDependency = {
      fabric: "fabric-loader",
      forge: "forge",
      neoforge: "neoforge",
      quilt: "quilt-loader"
    }[instance.loader];
    if (instance.loader && instance.loader !== "vanilla" && instance.loaderVersion) {
      if (loaderDependency) {
        dependencies[loaderDependency] = instance.loaderVersion;
      }
    }
    const manifest = {
      game: "minecraft",
      formatVersion: 1,
      versionId: crypto.randomUUID(),
      name: instance.name,
      summary: `Exportado desde Eryon Launcher`,
      files: manifestFiles,
      dependencies
    };

    const yazl = require("yazl");
    const { pipeline } = require("node:stream");
    const archive = new yazl.ZipFile();
    archive.addBuffer(
      Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      "modrinth.index.json"
    );
    async function addFolder(sourceDirectory, archiveDirectory) {
      const folderEntries = await fs.readdir(sourceDirectory, {
        withFileTypes: true
      });
      for (const entry of folderEntries) {
        if (
          !entry.name ||
          entry.name === "." ||
          entry.name === ".." ||
          /[\\/\0]/.test(entry.name)
        ) {
          throw new Error("La configuración incluye un nombre de archivo no válido.");
        }

        const sourcePath = path.join(sourceDirectory, entry.name);
        const archivePath = `${archiveDirectory}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw new Error(
            `No se puede exportar el enlace simbólico de configuración "${entry.name}".`
          );
        }
        if (entry.isDirectory()) {
          await addFolder(sourcePath, archivePath);
        } else if (entry.isFile()) {
          archive.addFile(sourcePath, archivePath);
        }
      }
    }

    const overrides = [
      "config",
      "defaultconfigs",
      "kubejs",
      "scripts"
    ];
    for (const folder of overrides) {
      const source = path.join(instance.gameDirectory, folder);
      const stat = await fs.stat(source).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isDirectory()) {
        await addFolder(source, `overrides/${folder}`);
      }
    }
    const optionsFile = path.join(instance.gameDirectory, "options.txt");
    const optionsStat = await fs.stat(optionsFile).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (optionsStat?.isFile()) {
      archive.addBuffer(
        await fs.readFile(optionsFile),
        "overrides/options.txt"
      );
    }

    const temporaryPackPath =
      `${result.filePath}.eryon-${crypto.randomUUID()}.tmp`;
    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(temporaryPackPath, {
          flags: "wx"
        });
        pipeline(archive.outputStream, output, (error) =>
          error ? reject(error) : resolve()
        );
        archive.end();
      });
      await fs.rename(temporaryPackPath, result.filePath);
    } catch (error) {
      try {
        await fs.rm(temporaryPackPath, { force: true });
      } catch (cleanupError) {
        throw new Error(
          `No se pudo exportar el modpack: ${normalizeError(error)}. Tampoco se pudo limpiar el archivo temporal: ${normalizeError(cleanupError)}`
        );
      }
      throw error;
    }
    return { exported: true, filePath: result.filePath, modCount: manifestFiles.length };
  }
);

ipcMain.handle(
  "eryon:backup-instance-world",
  async (_event, input) => {
    if (isMinecraftRunning() || repairInProgress) {
      throw new Error("No se puede respaldar un mundo mientras Minecraft se inicia, está abierto o se repara.");
    }

    const instance = await modpackManager.getInstance(input?.instanceId);
    const worldName = String(input?.worldName ?? "").trim();
    if (
      !worldName ||
      worldName === "." ||
      worldName === ".." ||
      path.basename(worldName) !== worldName ||
      /[<>:"/\\|?*\0]/.test(worldName)
    ) {
      throw new Error("El nombre del mundo no es válido.");
    }

    const savesDirectory = path.resolve(instance.gameDirectory, "saves");
    const source = path.resolve(savesDirectory, worldName);
    if (path.dirname(source) !== savesDirectory) {
      throw new Error("La carpeta del mundo no es válida.");
    }
    const sourceStat = await fs.stat(source).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!sourceStat?.isDirectory()) {
      throw new Error("No se encontró la carpeta de ese mundo.");
    }

    const timestamp = Date.now();
    const id = `${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
    const backupDirectory = path.join(
      getWorldBackupRoot(instance),
      worldName
    );
    const temporary = path.join(backupDirectory, `.tmp-${id}`);
    const destination = path.join(backupDirectory, id);

    await fs.mkdir(backupDirectory, { recursive: true });
    try {
      await fs.cp(source, temporary, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw new Error(`No se pudo crear el respaldo: ${normalizeError(error)}`);
    }

    const backups = await listWorldBackupEntries(instance, worldName);
    for (const stale of backups.slice(5)) {
      await fs.rm(path.join(backupDirectory, stale.id), {
        recursive: true,
        force: true
      });
    }

    return { created: true, backups: await listWorldBackupEntries(instance, worldName) };
  }
);

ipcMain.handle(
  "eryon:restore-instance-world-backup",
  async (_event, input) => {
    if (isMinecraftRunning() || repairInProgress) {
      throw new Error("No se puede restaurar un mundo mientras Minecraft se inicia, está abierto o se repara.");
    }

    const instance = await modpackManager.getInstance(input?.instanceId);
    const worldName = String(input?.worldName ?? "").trim();
    const backupId = String(input?.backupId ?? "");
    if (
      !worldName ||
      worldName === "." ||
      worldName === ".." ||
      path.basename(worldName) !== worldName ||
      /[<>:"/\\|?*\0]/.test(worldName) ||
      !/^\d{13}-[a-f0-9]{8}$/.test(backupId)
    ) {
      throw new Error("El respaldo seleccionado no es válido.");
    }

    const backupRoot = path.resolve(
      getWorldBackupRoot(instance),
      worldName
    );
    const source = path.resolve(backupRoot, backupId);
    if (path.dirname(source) !== backupRoot) {
      throw new Error("La ruta del respaldo no es válida.");
    }
    const backupStat = await fs.stat(source).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!backupStat?.isDirectory()) {
      throw new Error("No se encontró el respaldo seleccionado.");
    }

    const savesDirectory = path.resolve(instance.gameDirectory, "saves");
    await fs.mkdir(savesDirectory, { recursive: true });
    let restoredName = `${worldName} (restaurado)`;
    let suffix = 2;
    while (await fs.stat(path.join(savesDirectory, restoredName)).then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    )) {
      restoredName = `${worldName} (restaurado ${suffix})`;
      suffix += 1;
    }

    await fs.cp(source, path.join(savesDirectory, restoredName), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    return { restored: true, worldName: restoredName };
  }
);

ipcMain.handle(
  "eryon:repair-instance",
  async (_event, instanceId) => {
    if (isMinecraftRunning() || repairInProgress) {
      throw new Error("No se puede reparar mientras Minecraft se inicia, está abierto o hay otra reparación.");
    }

    repairInProgress = true;
    try {
    let instance = await modpackManager.getInstance(instanceId);
    if (instance.loader && instance.loader !== "vanilla") {
      sendLaunchEvent({
        type: "status",
        instanceId,
        message: `Reinstalando ${instance.loader} sin borrar mundos ni mods...`
      });
      instance = await modpackManager.repairInstance(instanceId);
    }
    const launchVersionId = String(
      instance.launchVersionId || instance.minecraftVersion
    );
    if (!/^[A-Za-z0-9._+-]{1,160}$/.test(launchVersionId)) {
      throw new Error("El identificador de versión de la instalación no es válido.");
    }

    const EventEmitter = require("node:events");
    const Handler = require("minecraft-launcher-core/components/handler");
    const client = new EventEmitter();
    const versionDirectory = path.join(
      instance.gameDirectory,
      "versions",
      launchVersionId
    );
    client.options = {
      root: instance.gameDirectory,
      directory: versionDirectory,
      version: {
        number: instance.minecraftVersion,
        type: "release",
        custom:
          launchVersionId === instance.minecraftVersion
            ? undefined
            : launchVersionId
      },
      overrides: {
        directory: versionDirectory,
        gameDirectory: instance.gameDirectory,
        assetRoot: sharedMinecraftPath("assets"),
        libraryRoot: sharedMinecraftPath("libraries"),
        natives: sharedMinecraftPath("natives", instance.minecraftVersion),
        url: {
          meta: "https://launchermeta.mojang.com",
          resource: "https://resources.download.minecraft.net",
          mavenForge: "https://files.minecraftforge.net/maven/",
          defaultRepoForge: "https://libraries.minecraft.net/",
          fallbackMaven: "https://search.maven.org/remotecontent?filepath="
        }
      }
    };

    const handler = new Handler(client);
    sendLaunchEvent({
      type: "status",
      instanceId,
      message: `Verificando archivos de ${instance.name}...`
    });

    try {
      await fs.mkdir(versionDirectory, { recursive: true });
      const baseVersionJson = path.join(
        versionDirectory,
        `${instance.minecraftVersion}.json`
      );
      const cachedVersionJson = await fs.readFile(baseVersionJson, "utf8").catch(
        (error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        }
      );
      if (cachedVersionJson !== null) {
        try {
          JSON.parse(cachedVersionJson);
        } catch {
          await fs.rm(baseVersionJson, { force: true });
        }
      }

      const versionInfo = await handler.getVersion();
      if (instance.loader === "vanilla") {
        const versionJar = path.join(
          versionDirectory,
          `${launchVersionId}.jar`
        );
        const jarExists = await fs.stat(versionJar).then(
          (stat) => stat.isFile(),
          (error) => {
            if (error?.code === "ENOENT") return false;
            throw error;
          }
        );
        if (
          !jarExists ||
          !await handler.checkSum(
            versionInfo.downloads?.client?.sha1,
            versionJar
          )
        ) {
          if (!versionInfo.downloads?.client?.url) {
            throw new Error("No hay un archivo oficial disponible para reparar Minecraft.");
          }
          await handler.getJar();
          if (
            !await handler.checkSum(
              versionInfo.downloads.client.sha1,
              versionJar
            )
          ) {
            throw new Error("No se pudo verificar el JAR descargado de Minecraft.");
          }
        }
      }

      let customVersion = null;
      if (client.options.version.custom) {
        const customPath = path.join(
          versionDirectory,
          `${launchVersionId}.json`
        );
        customVersion = JSON.parse(await fs.readFile(customPath, "utf8"));
      }

      const assetId = client.options.version.custom || instance.minecraftVersion;
      const assetIndexPath = path.join(
        sharedMinecraftPath("assets"),
        "indexes",
        `${assetId}.json`
      );
      const cachedAssetIndex = await fs.readFile(assetIndexPath, "utf8").catch(
        (error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        }
      );
      if (cachedAssetIndex !== null) {
        try {
          const parsedIndex = JSON.parse(cachedAssetIndex);
          if (!parsedIndex.objects || typeof parsedIndex.objects !== "object") {
            throw new Error("El índice de recursos no es válido.");
          }
        } catch {
          await fs.rm(assetIndexPath, { force: true });
        }
      }

      await handler.getNatives();
      await handler.getClasses(customVersion);
      await handler.getAssets();

      return {
        repaired: true,
        instanceId,
        message: "Se verificaron y repararon los archivos descargables."
      };
    } catch (error) {
      throw new Error(`No se pudo reparar la instalación: ${normalizeError(error)}`);
    }
    } finally {
      repairInProgress = false;
    }
  }
);

async function inspectInstanceCompatibility(instance) {
    const modsDirectory = path.join(instance.gameDirectory, "mods");
    const entries = await fs.readdir(modsDirectory, {
      withFileTypes: true
    }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const { readJarModMetadata } = require("./jar-metadata.cjs");
    const mods = [];

    for (const entry of entries) {
      if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
      const metadata = await readJarModMetadata(
        path.join(modsDirectory, entry.name),
        { loader: instance.loader }
      ).catch(() => null);
      const fallbackMetadata = !metadata
        ? (
            /connector/i.test(entry.name)
              ? {
                  modId: "connector",
                  name: "Connector",
                  version: "",
                  dependencies: { depends: {}, breaks: {} },
                  provides: ["connectormod"]
                }
              : /kotlinforforge/i.test(entry.name)
                ? {
                    modId: "kotlinforforge",
                    name: "Kotlin for Forge",
                    version: "",
                    dependencies: { depends: {}, breaks: {} },
                    provides: []
                  }
                : /(^|[-_])gml[-_]/i.test(entry.name)
                  ? {
                      modId: "gml",
                      name: "GML",
                      version: "",
                      dependencies: { depends: {}, breaks: {} },
                      provides: []
                    }
                  : null
          )
        : null;
      const resolvedMetadata = metadata || fallbackMetadata;
      if (resolvedMetadata?.modId) {
        mods.push({ ...resolvedMetadata, fileName: entry.name });
      }
    }

    const byId = new Map();
    for (const mod of mods) {
      byId.set(mod.modId.toLowerCase(), mod);
      if (/connector/i.test(String(mod.fileName || ""))) {
        // Algunos builds de Connector no exponen un metadata reconocible,
        // pero el propio archivo sigue identificando el puente Fabric-Forge.
        byId.set("connector", mod);
        byId.set("connectormod", mod);
      }
      for (const providedId of mod.provides || []) {
        const normalizedId = String(providedId).trim().toLowerCase();
        if (normalizedId && !byId.has(normalizedId)) {
          byId.set(normalizedId, mod);
        }
      }
    }
    const missingDependencies = new Map();
    const incompatibleMods = [];
    const conflicts = [];
    const builtInDependencies = new Set([
      "minecraft",
      "java"
    ]);
    const hasFabricApi = byId.has("fabric-api") || byId.has("fabric_api");
    const hasFabricForgeBridge =
      instance.loader === "forge" &&
      (
        hasFabricApi ||
        byId.has("connector") ||
        mods.some((mod) => /connector/i.test(String(mod.fileName || "")))
      );

    for (const mod of mods) {
      const depends = dependencyEntries(mod.dependencies?.depends);
      const breaks = dependencyEntries(mod.dependencies?.breaks);

      for (const dependency of depends) {
        const id = dependency.id.toLowerCase();
        if (builtInDependencies.has(id)) {
          if (
            id === "minecraft" &&
            !satisfiesModVersion(instance.minecraftVersion, dependency.version)
          ) {
            incompatibleMods.push({
              mod: mod.name || mod.modId,
              dependency: "Minecraft",
              expected: dependency.version,
              actual: instance.minecraftVersion
            });
          }
          continue;
        }

        const loaderNames = {
          "fabric-loader": "fabric",
          fabricloader: "fabric",
          fabric_loader: "fabric",
          fabric: "fabric",
          quilt_loader: "quilt",
          forge: "forge",
          neoforge: "neoforge"
        };

        // Forge modpacks pueden incluir mods Fabric mediante Connector y
        // Forgified Fabric API. En ese caso estos identificadores pertenecen
        // al puente y no son dependencias faltantes del cargador principal.
        if (
          hasFabricForgeBridge &&
          [
            "fabric-loader",
            "fabricloader",
            "fabric_loader",
            "fabric",
            "fabric-api",
            "fabric_api"
          ].includes(id)
        ) {
          continue;
        }

        if (loaderNames[id]) {
          const expectedLoader = loaderNames[id];
          if (
            instance.loader !== expectedLoader ||
            (
              dependency.version !== "*" &&
              (
                !instance.loaderVersion ||
                !satisfiesModVersion(instance.loaderVersion, dependency.version)
              )
            )
          ) {
            incompatibleMods.push({
              mod: mod.name || mod.modId,
              dependency: expectedLoader,
              expected: dependency.version,
              actual: instance.loaderVersion || "desconocida"
            });
          }
          continue;
        }

        if (
          hasFabricApi &&
          instance.loader === "fabric" &&
          /^fabric-.+-v\d+$/i.test(id)
        ) {
          continue;
        }

        const installed = byId.get(id);
        if (!installed) {
          missingDependencies.set(id, {
            id,
            name: dependency.id,
            version: dependency.version,
            requiredBy: mod.name || mod.modId
          });
        } else if (
          dependency.version !== "*" &&
          (
            !installed.version ||
            !satisfiesModVersion(installed.version, dependency.version)
          )
        ) {
          incompatibleMods.push({
            mod: mod.name || mod.modId,
            dependency: installed.name || installed.modId,
            expected: dependency.version,
            actual: installed.version || "desconocida"
          });
        }
      }

      for (const conflict of breaks) {
        const other = byId.get(conflict.id.toLowerCase());
        if (
          other &&
          (
            conflict.version === "*" ||
            !other.version ||
            satisfiesModVersion(other.version, conflict.version)
          )
        ) {
          conflicts.push({
            mod: mod.name || mod.modId,
            conflict: other.name || other.modId,
            version: conflict.version
          });
        }
      }
    }

    return {
      missingDependencies: [...missingDependencies.values()],
      incompatibleMods,
      conflicts
    };
}

ipcMain.handle(
  "eryon:check-instance-compatibility",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(instanceId);
    if (!instance?.gameDirectory) {
      throw new Error("La instalación no tiene un directorio válido.");
    }

    return inspectInstanceCompatibility(instance);
  }
);

ipcMain.handle(
  "eryon:install-instance-dependencies",
  async (_event, instanceId) => {
    const instance = await modpackManager.getInstance(instanceId);

    if (!instance?.gameDirectory) {
      throw new Error("La instalación no tiene un directorio válido.");
    }

    const installed = [];
    const manualDependencies = new Map();
    let remaining = await inspectInstanceCompatibility(instance);
    const curseforgeApiKey = await modsManager.readCurseforgeKey(
      userDataPath(CURSEFORGE_FILE)
    );
    const curseforgeDependencyProjects = {
      ftbquests: "289412"
    };

    for (let pass = 0; pass < 4 && remaining.missingDependencies.length; pass += 1) {
      const currentMissing = remaining.missingDependencies;
      for (const dependency of currentMissing) {
        const dependencyId = String(dependency.id || "").toLowerCase();
        if (manualDependencies.has(dependencyId)) continue;

        try {
          if (!/^[a-z0-9_.-]{1,128}$/i.test(dependencyId)) {
            throw new Error("El identificador de dependencia no es válido.");
          }

          const isFabricApiModule =
            instance.loader === "fabric" &&
            /^fabric-.+-v\d+$/i.test(dependencyId);
          const projectSlugs = [
            ...(isFabricApiModule ? ["fabric-api"] : [dependencyId]),
            ...(dependencyId.startsWith("cardinal-components-")
              ? ["cardinal-components-api"]
              : [])
          ];
          let project = null;
          let installSource = "modrinth";
          let installProjectId = "";

          for (const projectSlug of [...new Set(projectSlugs)]) {
            const search = await modsManager.searchContent({
              source: "modrinth",
              type: "mods",
              query: projectSlug,
              gameVersion: instance.minecraftVersion,
              loader: instance.loader,
              limit: 30,
              offset: 0
            });
            project = search.results.find(
              (result) =>
                String(result.slug).toLowerCase() === projectSlug.toLowerCase() ||
                String(result.id).toLowerCase() === projectSlug.toLowerCase()
            );
            if (project) {
              installProjectId = project.id;
              break;
            }
          }

          // Si no existe una coincidencia exacta en Modrinth, buscar el
          // mismo identificador en CurseForge. La descarga sigue pasando
          // por el proxy configurado y la API key nunca llega al renderer.
          if (!project && curseforgeApiKey) {
            const curseforgeSearch = await modsManager.searchContent({
              source: "curseforge",
              type: "mods",
              query: dependencyId,
              gameVersion: instance.minecraftVersion,
              loader: instance.loader,
              apiKey: curseforgeApiKey,
              limit: 30,
              offset: 0
            });
            project = curseforgeSearch.results.find(
              (result) =>
                String(result.slug).toLowerCase() === dependencyId ||
                String(result.name).toLowerCase() ===
                  String(dependency.name || dependency.id).toLowerCase()
            );
            if (project) {
              installSource = "curseforge";
              installProjectId = project.id;
            }
          }

          if (!project && curseforgeDependencyProjects[dependencyId]) {
            if (!curseforgeApiKey) {
              throw new Error(
                "No está configurada una API key para CurseForge."
              );
            }
            installSource = "curseforge";
            installProjectId = curseforgeDependencyProjects[dependencyId];
          }

          if (!project && !installProjectId) {
            throw new Error(
              `No se encontró una descarga automática de ${dependency.name}.`
            );
          }

          let versionId = "";
          if (
            installSource === "modrinth" &&
            !isFabricApiModule &&
            dependency.version &&
            dependency.version !== "*"
          ) {
            const versions = await modsManager.listContentVersions({
              source: "modrinth",
              type: "mods",
              projectId: project.id,
              limit: 100,
              gameVersion: instance.minecraftVersion
            });
            const compatibleVersion = versions.versions.find(
              (version) =>
                satisfiesModVersion(version.name, dependency.version) &&
                (
                  !version.loaders?.length ||
                  version.loaders.includes(instance.loader)
                )
            );
            if (!compatibleVersion) {
              throw new Error(
                `No hay una versión automática que cumpla ${dependency.version}.`
              );
            }
            versionId = compatibleVersion.versionId;
          }

          const result = await modsManager.installContent({
            source: installSource,
            type: "mods",
            projectId: installProjectId,
            instanceGameDirectory: instance.gameDirectory,
            instanceName: instance.name,
            gameVersion: instance.minecraftVersion,
            loader: instance.loader,
            apiKey: curseforgeApiKey,
            versionId
          });
          installed.push({
            id: dependency.id,
            name: dependency.name,
            fileName: result.fileName
          });
        } catch (installError) {
          const isFtbQuests = dependencyId === "ftbquests";
          manualDependencies.set(dependencyId, {
            id: dependency.id,
            name: dependency.name,
            version: dependency.version || "",
            requiredBy: dependency.requiredBy,
            reason: installError?.message || "No se pudo instalar automáticamente.",
            url: isFtbQuests
              ? "https://www.curseforge.com/minecraft/mc-mods/ftb-quests"
              : `https://modrinth.com/mods?q=${encodeURIComponent(dependency.name || dependency.id)}`
          });
        }
      }

      remaining = await inspectInstanceCompatibility(instance);
    }

    return {
      installed,
      manualDependencies: [...manualDependencies.values()],
      remaining
    };
  }
);

ipcMain.handle(
  "eryon:delete-instance-file",
  async (_event, input) => {
    const instance =
      await modpackManager.getInstance(
        input?.instanceId
      );

    if (!instance?.gameDirectory) {
      throw new Error(
        "La instalación no tiene un directorio válido."
      );
    }

    const fileName = String(input?.fileName || "").trim();
    const requestedCategory = String(input?.category || "mods");
    const fileCategories = {
      mods: {
        directory: "mods",
        extensions: /\.jar$/i,
        label: "Mod"
      },
      textures: {
        directory: "resourcepacks",
        extensions: /\.zip$/i,
        label: "Textura"
      },
      shaders: {
        directory: "shaderpacks",
        extensions: /\.(zip|jar)$/i,
        label: "Shader"
      }
    };
    const category = fileCategories[requestedCategory];

    if (
      !fileName ||
      fileName.includes("..") ||
      path.basename(fileName) !== fileName
    ) {
      throw new Error(
        "El nombre del archivo no es válido."
      );
    }

    if (!category) {
      throw new Error(
        "La categoría del archivo no es válida."
      );
    }

    if (!category.extensions.test(fileName)) {
      throw new Error(
        `El tipo de archivo no es válido para ${category.label.toLowerCase()}.`
      );
    }

    const contentDirectory = path.resolve(
      instance.gameDirectory,
      category.directory
    );

    const target = path.resolve(
      contentDirectory,
      fileName
    );

    if (
      path.dirname(target) !== contentDirectory
    ) {
      throw new Error(
        "Ruta de archivo no permitida."
      );
    }

    await fs.rm(target, { force: true });

    sendLaunchEvent({
      type: "log",
      message: `${category.label} quitado de ${instance.name}: ${fileName}`
    });

    return { deleted: true };
  }
);

ipcMain.handle(
  "eryon:choose-game-directory",
  async () => {
    const current = await readSettings();

    const result = await dialog.showOpenDialog({
      title: "Seleccionar carpeta de Minecraft",
      defaultPath: current.gameDirectory,
      properties: [
        "openDirectory",
        "createDirectory"
      ]
    });

    return result.canceled
      ? null
      : result.filePaths[0] ?? null;
  }
);

ipcMain.handle(
  "eryon:choose-java",
  async () => {
    const current = await readSettings();

    const result = await dialog.showOpenDialog({
      title: "Seleccionar ejecutable de Java",
      defaultPath: current.javaPath || undefined,
      properties: ["openFile"],
      filters: [
        {
          name: "Java",
          extensions: ["exe"]
        },
        {
          name: "Todos los archivos",
          extensions: ["*"]
        }
      ]
    });

    return result.canceled
      ? null
      : result.filePaths[0] ?? null;
  }
);

ipcMain.handle(
  "eryon:open-game-directory",
  async () => {
    const settings = await readSettings();

    await fs.mkdir(
      settings.gameDirectory,
      { recursive: true }
    );

    const error = await shell.openPath(
      settings.gameDirectory
    );

    if (error) {
      throw new Error(error);
    }

    return true;
  }
);

ipcMain.handle(
  "eryon:get-versions",
  () => getReleaseVersions()
);

ipcMain.handle(
  "eryon:check-java",
  async (_event, requestedPath) => {
    const settings = await readSettings();

    const javaPath = String(
      requestedPath ||
      settings.javaPath ||
      "java"
    ).trim();

    if (!javaPath || javaPath.includes("\0")) {
      throw new Error(
        "La ruta de Java no es válida."
      );
    }

    const major = await getJavaMajor(javaPath);

    if (!major) {
      throw new Error(
        "No se pudo detectar Java. Selecciona un archivo java.exe válido."
      );
    }

    let requiredMajor = null;

    if (settings.selectedVersion) {
      try {
        const catalog = await getReleaseVersions();

        const versionInfo = catalog.versions.find(
          (item) =>
            item.id === settings.selectedVersion
        );

        if (versionInfo) {
          requiredMajor =
            await getRequiredJavaMajor(versionInfo);
        }
      } catch (error) {
        console.warn(
          "[ERYON] No se pudo consultar el requisito de Java:",
          normalizeError(error)
        );
      }
    }

    return {
      path: javaPath,
      major,
      requiredMajor,
      compatible:
        requiredMajor === null
          ? null
          : major === requiredMajor
    };
  }
);

// ======================================================
// IPC: CUENTAS PREMIUM
// ======================================================

ipcMain.handle(
  "eryon:get-accounts",
  async () => {
    const data = await getAccountsData();
    return data.accounts;
  }
);

ipcMain.handle(
  "eryon:get-active-account",
  async () => {
    const settings = await readSettings();
    if (settings.accountMode === "elyby") {
      return publicElybyAccount(await getElybyAccount());
    }
    const data = await getAccountsData();
    return data.activeAccount;
  }
);

ipcMain.handle(
  "eryon:add-elyby-account",
  async (_event, input) => {
    const username = String(input?.username || "").trim();
    const password = String(input?.password || "");
    const totp = String(input?.totp || "").trim();
    if (
      !username ||
      username.length > 255 ||
      !password ||
      password.length > 512 ||
      totp.length > 16 ||
      /[\r\n\0]/.test(username + password + totp)
    ) {
      throw new Error("Completa un usuario, contraseña y código de verificación válidos.");
    }

    const clientToken = crypto.randomUUID();
    const response = await fetch(
      "https://authserver.ely.by/auth/authenticate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password: totp ? `${password}:${totp}` : password,
          clientToken,
          requestUser: true
        }),
        signal: AbortSignal.timeout(20000)
      }
    );
    const data = await response.json().catch(() => null);
    if (
      response.status === 401 &&
      /two.factor|2fa/i.test(String(data?.errorMessage || ""))
    ) {
      throw new Error("Esta cuenta requiere verificación en dos pasos. Escribe el código de tu aplicación autenticadora e inténtalo otra vez.");
    }
    if (
      !response.ok ||
      !data?.accessToken ||
      !data?.selectedProfile?.id ||
      !data?.selectedProfile?.name ||
      !/^[a-f\d]{32}$/i.test(String(data.selectedProfile.id))
    ) {
      throw new Error(
        response.status === 401
          ? "Ely.by rechazó el inicio de sesión. Revisa el usuario, contraseña y código de verificación."
          : `No se pudo conectar con Ely.by (HTTP ${response.status}).`
      );
    }
    const account = {
      profile: {
        id: String(data.selectedProfile.id),
        name: String(data.selectedProfile.name)
      },
      token: {
        accessToken: String(data.accessToken),
        clientToken: String(data.clientToken || clientToken)
      }
    };
    await writeEncryptedFile(ELYBY_ACCOUNT_FILE, account);
    await saveSettings({ accountMode: "elyby" });
    return publicElybyAccount(account);
  }
);

ipcMain.handle(
  "eryon:disconnect-elyby-account",
  async () => {
    const saved = await getElybyAccount();
    if (saved?.token?.accessToken && saved?.token?.clientToken) {
      try {
        const response = await fetch(
          "https://authserver.ely.by/auth/invalidate",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accessToken: saved.token.accessToken,
              clientToken: saved.token.clientToken
            }),
            signal: AbortSignal.timeout(10000)
          }
        );
        if (!response.ok) {
          console.warn(
            `[ERYON] Ely.by no confirmó la revocación de la sesión (HTTP ${response.status}).`
          );
        }
      } catch (error) {
        console.warn(
          "[ERYON] No se pudo revocar la sesión Ely.by en línea:",
          normalizeError(error)
        );
      }
    }

    await deleteFile(ELYBY_ACCOUNT_FILE);
    const microsoftAccounts = await getAccountsData();
    const localProfiles = await getLocalProfilesData();
    await saveSettings({
      accountMode: microsoftAccounts.activeAccount
        ? "premium"
        : localProfiles.activeProfile
          ? "local"
          : "premium"
    });
    return true;
  }
);

ipcMain.handle(
  "eryon:get-skin-state",
  async (_event, input) => getSkinState(input)
);

ipcMain.handle(
  "eryon:get-elyby-account",
  async () => publicElybyAccount(await getElybyAccount())
);

ipcMain.handle(
  "eryon:upload-skin",
  async (_event, input) => uploadSkin(input)
);

ipcMain.handle(
  "eryon:open-skin-catalog",
  async () => {
    const error = await shell.openExternal("https://ely.by/skins");
    if (error) throw new Error(error);
    return true;
  }
);

ipcMain.handle(
  "eryon:add-account",
  async () => {
    // El login guarda automáticamente esta cuenta como activa.
    const result = await loginMicrosoftAccount();

    // Añadir/autorizar una cuenta Premium activa el modo premium
    // de forma global para todas las instalaciones.
    await saveSettings({
      accountMode: "premium"
    });

    return {
      account: result.account,
      accounts: (await getAccountsData()).accounts
    };
  }
);

ipcMain.handle(
  "eryon:select-account",
  async (_event, accountId) => {
    if (
      typeof accountId !== "string" ||
      !accountId
    ) {
      throw new Error(
        "Selecciona un perfil válido."
      );
    }

    // selectStoredAccount también guarda el modo premium global.
    const account =
      await selectStoredAccount(accountId);

    return {
      account,
      accounts: (await getAccountsData()).accounts
    };
  }
);

ipcMain.handle(
  "eryon:logout",
  async (_event, accountId) => {
    return logoutAccount(
      typeof accountId === "string" && accountId
        ? accountId
        : null
    );
  }
);

// ======================================================
// IPC: PERFILES LOCALES
// ======================================================

ipcMain.handle(
  "eryon:get-local-profiles",
  () => getLocalProfilesData()
);

ipcMain.handle(
  "eryon:add-local-profile",
  async (_event, name) => {
    // addLocalProfile activa el perfil recién creado o reutilizado.
    const result = await addLocalProfile(name);

    // Los perfiles locales nuevos se usan como modo predeterminado.
    await saveSettings({
      accountMode: "local"
    });

    return result;
  }
);

ipcMain.handle(
  "eryon:select-local-profile",
  async (_event, profileId) => {
    // Guarda el perfil local activo y activa el modo local global.
    return selectLocalProfile(profileId);
  }
);

ipcMain.handle(
  "eryon:delete-local-profile",
  (_event, profileId) =>
    deleteLocalProfile(profileId)
);

// ======================================================
// IPC: MODO DE CUENTA
// ======================================================

ipcMain.handle(
  "eryon:set-account-mode",
  async (_event, mode) => {
    if (mode !== "premium" && mode !== "local" && mode !== "elyby") {
      throw new Error(
        "El modo de cuenta seleccionado no es válido."
      );
    }

    if (mode === "elyby" && !(await getElybyAccount())) {
      throw new Error("Conecta una cuenta Ely.by antes de seleccionarla.");
    }

    const settings = await saveSettings({
      accountMode: mode
    });

    return {
      accountMode: settings.accountMode
    };
  }
);

ipcMain.handle(
  "eryon:get-account-mode",
  async () => {
    const settings = await readSettings();
    return settings.accountMode;
  }
);

// ======================================================
// IPC: GESTOR DE INSTANCIAS Y MODPACKS
// ======================================================

ipcMain.handle(
  "eryon:get-instances",
  () => modpackManager.getInstances()
);

ipcMain.handle(
  "eryon:rename-instance",
  (_event, instanceId, name) =>
    modpackManager.renameInstance(instanceId, name)
);

ipcMain.handle(
  "eryon:get-instance",
  (_event, instanceId) =>
    modpackManager.getInstance(instanceId)
);

ipcMain.handle(
  "eryon:set-instance-icon",
  (_event, instanceId, iconUrl) =>
    modpackManager.setInstanceIcon(instanceId, iconUrl)
);

ipcMain.handle(
  "eryon:install-instance",
  async (_event, options) => {
    console.log(
      "[ERYON] Creando instalación:",
      options?.name,
      options?.loader,
      options?.minecraftVersion,
      options?.loaderVersion
    );

    return modpackManager.installInstance({
      ...options,
      installerBridgeJar: getForgeInstallerBridgePath()
    });
  }
);

ipcMain.handle(
  "eryon:import-modpack",
  () => modpackManager.importModrinthPack()
);

ipcMain.handle(
  "eryon:update-instance-loader",
  (_event, instanceId, loaderVersion) =>
    modpackManager.updateInstanceLoader(
      instanceId,
      loaderVersion
    )
);

ipcMain.handle(
  "eryon:open-instance-folder",
  async (_event, instanceId, folder = "") => {
    const instance =
      await modpackManager.getInstance(instanceId);

    if (!instance?.gameDirectory) {
      throw new Error("La instalación no tiene un directorio válido.");
    }

    const instancesRoot = path.resolve(
      app.getPath("userData"),
      "eryon-instances"
    );

    const gameDirectory = path.resolve(instance.gameDirectory);

    const relativePath = path.relative(
      instancesRoot,
      gameDirectory
    );

    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(
        "La carpeta de esta instalación no es válida."
      );
    }

    const gameDirectoryStats = await fs.stat(gameDirectory).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

    if (!gameDirectoryStats?.isDirectory()) {
      throw new Error(
        `No se encontró la carpeta de "${instance.name}". Si la renombraste manualmente, ponle el nombre de la instancia o restáurala desde la Papelera.`
      );
    }

    if (folder && !["mods", "logs", "crash-reports"].includes(folder)) {
      throw new Error("La carpeta solicitada no es válida.");
    }

    const targetFolder = folder
      ? path.resolve(gameDirectory, folder)
      : gameDirectory;
    const targetRelativePath = path.relative(gameDirectory, targetFolder);
    if (
      targetRelativePath.startsWith("..") ||
      path.isAbsolute(targetRelativePath)
    ) {
      throw new Error("La carpeta solicitada no es válida.");
    }

    if (["mods", "logs", "crash-reports"].includes(folder)) {
      await fs.mkdir(targetFolder, {
        recursive: true
      });
    }

    const targetStats = await fs.stat(targetFolder);
    if (!targetStats.isDirectory()) {
      throw new Error(
        "La ruta solicitada existe, pero no es una carpeta."
      );
    }

    let openError = await shell.openPath(
      targetFolder
    );

    if (openError && process.platform === "win32") {
      try {
        await execFileAsync(
          "explorer.exe",
          [targetFolder],
          { windowsHide: true }
        );
        openError = "";
      } catch (error) {
        openError =
          `${openError}; Explorer: ${normalizeError(error)}`;
      }
    }

    if (openError) {
      throw new Error(
        `No se pudo abrir la carpeta: ${openError}`
      );
    }

    return {
      ok: true,
      path: targetFolder
    };
  }
);

ipcMain.handle(
  "eryon:get-instance-settings",
  (_event, instanceId) =>
    loadInstanceSettings(instanceId)
);

ipcMain.handle(
  "eryon:save-instance-settings",
  (_event, instanceId, settings) =>
    persistInstanceSettings(
      instanceId,
      settings
    )
);

ipcMain.handle(
  "eryon:delete-instance",
  async (_event, instanceId) => {
    // La confirmación se muestra en la interfaz (ConfirmDialog).
    // Aquí solo se valida la instancia y se elimina.

    await modpackManager.getInstance(instanceId);

    return modpackManager.deleteInstance(instanceId);
  }
);

ipcMain.handle(
  "eryon:launch-instance",
  async (event, instanceId, profileSelection) => {
    console.log(
      "[ERYON] Iniciando instancia:",
      instanceId,
      "selección de cuenta de Perfiles"
    );

    return launchInstance(
      instanceId,
      profileSelection,
      BrowserWindow.fromWebContents(event.sender)
    );
  }
);

// ======================================================
// IPC: LANZAMIENTO NORMAL
// ======================================================

ipcMain.handle(
  "eryon:launch-minecraft",
  async (event, version, profileSelection) => {
    console.log(
      "[ERYON] Solicitud de lanzamiento:",
      version,
      "selección de cuenta de Perfiles"
    );

    try {
      return await launchMinecraft(
        version,
        profileSelection,
        null,
        BrowserWindow.fromWebContents(event.sender)
      );
    } catch (error) {
      console.error(
        "[ERYON] Error al iniciar Minecraft:",
        normalizeError(error)
      );

      throw error;
    }
  }
);



 // ======================================================
// ACTUALIZACIONES AUTOMÁTICAS
// ======================================================

function initializeAutoUpdates() {
  // Solo funciona en la aplicación instalada de Windows.
  if (!app.isPackaged || process.platform !== "win32") {
    return;
  }

  // Descargar automáticamente. La instalación se inicia
  // cuando el usuario pulsa el botón de la interfaz.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  async function checkForLatestUpdate() {
    if (updateDownloaded || updateCheckInProgress) {
      return;
    }

    updateCheckInProgress = true;

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error(
        "[ERYON] No se pudieron buscar actualizaciones:",
        normalizeError(error)
      );
    } finally {
      updateCheckInProgress = false;
    }
  }

  autoUpdater.on("checking-for-update", () => {
    console.log(
      "[ERYON] Buscando la última versión estable..."
    );
  });

  autoUpdater.on("update-available", (info) => {
    console.log(
      `[ERYON] Actualización disponible: ${info.version}`
    );
    updaterLog(`update-available: ${info.version}`);

    sendLaunchEvent({
      type: "updater",
      action: "available",
      version: info.version
    });

    // La descarga continúa en segundo plano y se muestra únicamente en la
    // interfaz del launcher. No abrimos una ventana auxiliar de PowerShell.
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log(
      `[ERYON] ERYON ya está actualizado: ${info.version}`
    );
    updaterLog(`update-not-available: ${info.version}`);

    sendLaunchEvent({
      type: "updater",
      action: "not-available",
      version: info.version
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendLaunchEvent({
      type: "updater",
      action: "progress",
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total
    });
  });

  
autoUpdater.on("update-downloaded", (info) => {
  updateDownloaded = true;

  console.log(
    `[ERYON] Actualización ${info.version} descargada. Se instala al cerrar o con el botón de la interfaz.`
  );
  updaterLog(`update-downloaded: ${info.version}`);

  sendLaunchEvent({
    type: "updater",
    action: "downloaded",
    version: info.version
  });
});


  autoUpdater.on("error", (error) => {
    console.error(
      "[ERYON] Error del actualizador:",
      normalizeError(error)
    );
    updaterLog(`updater error: ${normalizeError(error)}`);

    sendLaunchEvent({
      type: "updater",
      action: "error",
      message: normalizeError(error)
    });
  });

  // Busca actualizaciones al iniciar ERYON.
  void checkForLatestUpdate();

  // Comprueba de nuevo cada seis horas mientras esté abierto.
  const updateCheckTimer = setInterval(() => {
    void checkForLatestUpdate();
  }, UPDATE_CHECK_INTERVAL_MS);

  // El temporizador no debe mantener vivo el proceso.
  updateCheckTimer.unref();
}

// ======================================================
// INSTALAR LA ACTUALIZACIÓN DESCARGADA
// ======================================================

ipcMain.handle("eryon:install-update", async () => {
  if (!app.isPackaged || process.platform !== "win32") {
    throw new Error(
      "La instalación automática solo está disponible en la versión instalada de Windows."
    );
  }

  if (!updateDownloaded) {
    throw new Error(
      "La actualización todavía no se ha descargado completamente."
    );
  }

  console.log(
    "[ERYON] Cerrando la aplicación para instalar la actualización..."
  );

  // Marcar ANTES: evita que before-quit intente instalar otra vez.
  updateInstallScheduled = true;

  // Cierra de inmediato cualquier ventana auxiliar vieja: libera los
  // archivos del programa antes de que el desinstalador de NSIS
  // intente borrarlos.
  markUpdateWindowDone();

  // NSIS instala la nueva versión en modo silencioso
  // e inicia ERYON automáticamente al finalizar.
  autoUpdater.quitAndInstall(true, true);

  return {
    started: true
  };
});


 // ======================================================
// CICLO DE VIDA
// ======================================================

const appReady = app.whenReady();

appReady
  .then(async () => {
  initializeDiscordPresence();

  // Si quedó viva una ventana auxiliar de actualización de una
  // sesión o versión anterior, se le avisa que ya puede cerrarse.
  markUpdateWindowDone();

  // El splash aparece de inmediato (solo el logo): da la
  // sensación de arranque instantáneo mientras la ventana
  // principal carga su interfaz por detrás.
  createSplashWindow();

    // Primero creamos la ventana para que esté preparada
    // para recibir los eventos de actualización.
    await createWindow();

    // Después iniciamos la comprobación de actualizaciones.
    initializeAutoUpdates();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((error) => {
          console.error(
            "[ERYON] No se pudo crear la ventana:",
            normalizeError(error)
          );
        });
      }
    });
  })
  .catch((error) => {
    closeSplashWindow();

    console.error(
      "[ERYON] Error al iniciar la aplicación:",
      normalizeError(error)
    );
  });

app.on("before-quit", () => {
  discordConnected = false;

  if (discordClient) {
    try {
      discordClient.destroy();
    } catch (error) {
      console.log(
        "[ERYON] Error cerrando Discord:",
        normalizeError(error)
      );
    }

    discordClient = null;
  }

  // Si hay una actualización ya descargada, al cerrar Eryon se
  // instala sola y se vuelve a abrir con la versión nueva.
  if (
    updateDownloaded &&
    !updateInstallScheduled &&
    app.isPackaged &&
    process.platform === "win32"
  ) {
    updateInstallScheduled = true;

    try {
      console.log(
        "[ERYON] Cerrando para instalar la actualización y volver a abrir..."
      );
      updaterLog("before-quit: instalando actualización descargada");

      // Cierra cualquier ventana auxiliar vieja antes de que el
      // desinstalador de NSIS toque los archivos del programa.
      markUpdateWindowDone();

      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      updateInstallScheduled = false;

      console.error(
        "[ERYON] No se pudo programar la instalación al cerrar:",
        normalizeError(error)
      );
      updaterLog(`before-quit: ERROR ${normalizeError(error)}`);
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
