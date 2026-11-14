
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("eryon", {
  // ====================================================
  // INFORMACIÓN DE LA APLICACIÓN
  // ====================================================

  getInfo: () =>
    ipcRenderer.invoke("eryon:get-info"),

  // ====================================================
  // CONFIGURACIÓN GENERAL
  // ====================================================

  getSettings: () =>
    ipcRenderer.invoke("eryon:get-settings"),

  saveSettings: (settings) =>
    ipcRenderer.invoke("eryon:save-settings", settings),

  // ====================================================
  // CONFIGURACIÓN DE FIREBASE (AMIGOS Y MENSAJES)
  // ====================================================

  getFirebaseConfig: () =>
    ipcRenderer.invoke("eryon:get-firebase-config"),

  saveFirebaseConfig: (config) =>
    ipcRenderer.invoke("eryon:save-firebase-config", config),

  chooseGameDirectory: () =>
    ipcRenderer.invoke("eryon:choose-game-directory"),

  chooseJava: () =>
    ipcRenderer.invoke("eryon:choose-java"),

  checkJava: (javaPath) =>
    ipcRenderer.invoke("eryon:check-java", javaPath),

  openGameDirectory: () =>
    ipcRenderer.invoke("eryon:open-game-directory"),

  // ====================================================
  // VERSIONES DE MINECRAFT
  // ====================================================

  getVersions: () =>
    ipcRenderer.invoke("eryon:get-versions"),

  // ====================================================
  // LANZAMIENTO NORMAL DE MINECRAFT
  // ====================================================

  launchMinecraft: (version, profileSelection) =>
    ipcRenderer.invoke(
      "eryon:launch-minecraft",
      version,
      profileSelection
    ),

  // ====================================================
  // CUENTAS MICROSOFT
  // ====================================================

  getAccounts: () =>
    ipcRenderer.invoke("eryon:get-accounts"),

  getActiveAccount: () =>
    ipcRenderer.invoke("eryon:get-active-account"),

  addElybyAccount: (credentials) =>
    ipcRenderer.invoke("eryon:add-elyby-account", credentials),

  disconnectElybyAccount: () =>
    ipcRenderer.invoke("eryon:disconnect-elyby-account"),

  getSkinState: (options) =>
    ipcRenderer.invoke("eryon:get-skin-state", options),

  getElybyAccount: () =>
    ipcRenderer.invoke("eryon:get-elyby-account"),

  uploadSkin: (options) =>
    ipcRenderer.invoke("eryon:upload-skin", options),

  openSkinCatalog: () =>
    ipcRenderer.invoke("eryon:open-skin-catalog"),

  addAccount: () =>
    ipcRenderer.invoke("eryon:add-account"),

  selectAccount: (accountId) =>
    ipcRenderer.invoke(
      "eryon:select-account",
      accountId
    ),

  logout: (accountId) =>
    ipcRenderer.invoke(
      "eryon:logout",
      accountId
    ),

  // ====================================================
  // PERFILES LOCALES
  // ====================================================

  getLocalProfiles: () =>
    ipcRenderer.invoke("eryon:get-local-profiles"),

  addLocalProfile: (name) =>
    ipcRenderer.invoke(
      "eryon:add-local-profile",
      name
    ),

  selectLocalProfile: (profileId) =>
    ipcRenderer.invoke(
      "eryon:select-local-profile",
      profileId
    ),

  deleteLocalProfile: (profileId) =>
    ipcRenderer.invoke(
      "eryon:delete-local-profile",
      profileId
    ),

  // ====================================================
  // MODO DE CUENTA
  // ====================================================

  getAccountMode: () =>
    ipcRenderer.invoke("eryon:get-account-mode"),

  setAccountMode: (mode) =>
    ipcRenderer.invoke(
      "eryon:set-account-mode",
      mode
    ),

  // ====================================================
  // EVENTOS DEL LAUNCHER
  // ====================================================

  getEvents: (options) =>
    ipcRenderer.invoke("eryon:events-list", options),

  getEventPack: (packId) =>
    ipcRenderer.invoke("eryon:events-fetch-pack", packId),

  getEventsAdminToken: () =>
    ipcRenderer.invoke("eryon:events-get-admin-token"),

  saveEventsAdminToken: (token) =>
    ipcRenderer.invoke("eryon:events-save-admin-token", token),

  verifyEventsAdminToken: (token) =>
    ipcRenderer.invoke("eryon:events-verify-admin-token", token),

  clearEventsAdminToken: () =>
    ipcRenderer.invoke("eryon:events-clear-admin-token"),

  publishEvents: (manifest) =>
    ipcRenderer.invoke("eryon:events-publish", manifest),

  publishEventPack: (packId, packManifest) =>
    ipcRenderer.invoke("eryon:events-publish-pack", packId, packManifest),

  uploadEventImage: (image, contentType) =>
    ipcRenderer.invoke("eryon:events-upload-image", image, contentType),

  deleteEventImage: (key) =>
    ipcRenderer.invoke("eryon:events-delete-image", key),

  uploadEventFile: (buffer, filename) =>
    ipcRenderer.invoke("eryon:events-upload-file", buffer, filename),

  importEventInstance: (instanceId, options) =>
    ipcRenderer.invoke("eryon:events-import-instance", instanceId, options),

  hashFileFromUrl: (url) =>
    ipcRenderer.invoke("eryon:events-hash-url", url),

  getRawEvents: (options) =>
    ipcRenderer.invoke("eryon:events-raw", options),

  prepareEvent: (eventId, options) =>
    ipcRenderer.invoke("eryon:prepare-event", eventId, options),

  getEventStatus: (eventId) =>
    ipcRenderer.invoke("eryon:event-status", eventId),

  // ====================================================
  // GESTOR DE INSTALACIONES Y MODPACKS
  // ====================================================

  getInstances: () =>
    ipcRenderer.invoke("eryon:get-instances"),

  getInstance: (instanceId) =>
    ipcRenderer.invoke(
      "eryon:get-instance",
      instanceId
    ),

  setInstanceIcon: (instanceId, iconUrl) =>
    ipcRenderer.invoke(
      "eryon:set-instance-icon",
      instanceId,
      iconUrl
    ),

  renameInstance: (instanceId, name) =>
    ipcRenderer.invoke(
      "eryon:rename-instance",
      instanceId,
      name
    ),

  installInstance: (options) =>
    ipcRenderer.invoke(
      "eryon:install-instance",
      options
    ),

  importModpack: () =>
    ipcRenderer.invoke("eryon:import-modpack"),

  deleteInstance: (instanceId) =>
    ipcRenderer.invoke(
      "eryon:delete-instance",
      instanceId
    ),

  launchInstance: (instanceId, profileSelection) =>
    ipcRenderer.invoke(
      "eryon:launch-instance",
      instanceId,
      profileSelection
    ),

  // ====================================================
  // EXPLORADOR DE CONTENIDO (MODRINTH + CURSEFORGE)
  // ====================================================

  getModsStatus: () =>
    ipcRenderer.invoke("eryon:content-status"),

  getContentFilters: () =>
    ipcRenderer.invoke("eryon:content-filters"),

  saveCurseForgeKey: (apiKey) =>
    ipcRenderer.invoke("eryon:save-curseforge-key", apiKey),

  browseContent: (params) =>
    ipcRenderer.invoke("eryon:browse-content", params),

  listContentVersions: (params) =>
    ipcRenderer.invoke(
      "eryon:content-versions",
      params
    ),

  installContent: (params) =>
    ipcRenderer.invoke("eryon:install-content", params),

  installModpackContent: (params) =>
    ipcRenderer.invoke(
      "eryon:install-modpack-content",
      params
    ),

  listInstanceMods: (instanceId) =>
    ipcRenderer.invoke(
      "eryon:list-instance-mods",
      instanceId
    ),

  checkInstanceModUpdates: (instanceId) =>
    ipcRenderer.invoke("eryon:check-instance-mod-updates", instanceId),

  updateInstanceMod: (params) =>
    ipcRenderer.invoke("eryon:update-instance-mod", params),

  listInstanceContent: (params) =>
    ipcRenderer.invoke(
      "eryon:list-instance-content",
      params
    ),

  listInstanceWorlds: (instanceId) =>
    ipcRenderer.invoke("eryon:list-instance-worlds", instanceId),

  backupInstanceWorld: (params) =>
    ipcRenderer.invoke("eryon:backup-instance-world", params),

  restoreInstanceWorldBackup: (params) =>
    ipcRenderer.invoke("eryon:restore-instance-world-backup", params),

  getInstanceStatus: (instanceId) =>
    ipcRenderer.invoke("eryon:get-instance-status", instanceId),

  repairInstance: (instanceId) =>
    ipcRenderer.invoke("eryon:repair-instance", instanceId),

  exportInstanceModpack: (instanceId) =>
    ipcRenderer.invoke("eryon:export-instance-modpack", instanceId),

  deleteInstanceFile: (params) =>
    ipcRenderer.invoke(
      "eryon:delete-instance-file",
      params
    ),

  // ====================================================
  // VERSIONES DE FORGE Y FABRIC
  // ====================================================
  getLoaderVersions: (minecraftVersion, loader) =>
    ipcRenderer.invoke(
      "eryon:get-loader-versions",
      minecraftVersion,
      loader
    ),

  // ====================================================
  // CAMBIAR FORGE O FABRIC
  // ====================================================

  updateInstanceLoader: (instanceId, loaderVersion) =>
    ipcRenderer.invoke(
      "eryon:update-instance-loader",
      instanceId,
      loaderVersion
    ),

  // ====================================================
  // ABRIR CARPETA DE UNA INSTALACIÓN
  // ====================================================

  openInstanceFolder: (instanceId, folder = "") =>
    ipcRenderer.invoke(
      "eryon:open-instance-folder",
      instanceId,
      folder
    ),

  // ====================================================
  // CONFIGURACIÓN DE RAM POR INSTALACIÓN
  // ====================================================

  getInstanceSettings: (instanceId) =>
    ipcRenderer.invoke(
      "eryon:get-instance-settings",
      instanceId
    ),

  saveInstanceSettings: (instanceId, settings) =>
    ipcRenderer.invoke(
      "eryon:save-instance-settings",
      instanceId,
      settings
    ),

  // ====================================================
  // ACTUALIZACIONES AUTOMÁTICAS
  // ====================================================

  // Instalar la actualización descargada y reiniciar ERYON.
  installUpdate: () =>
    ipcRenderer.invoke("eryon:install-update"),

  // ====================================================
  // EVENTOS DE LA APLICACIÓN
  // ====================================================

  // Recibe eventos de lanzamiento, progreso y actualizaciones.
  onLaunchEvent: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on(
      "eryon:launch-event",
      listener
    );

    // Devuelve una función para retirar el listener al desmontar React.
    return () => {
      ipcRenderer.removeListener(
        "eryon:launch-event",
        listener
      );
    };
  }
});
