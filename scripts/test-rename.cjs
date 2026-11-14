"use strict";

// Prueba local del renombrado de instancias.
// Simula Electron app/dialog y comprueba que la carpeta
// real cambia de nombre junto con el registro.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const createModpackManager = require(
  path.join(ROOT, "electron", "modpack-manager.cjs")
);

const userData = fs.mkdtempSync(
  path.join(os.tmpdir(), "eryon-rename-test-")
);

const app = {
  getPath: (name) =>
    name === "userData" ? userData : null
};

const dialog = {};

function getReleaseVersions() {
  return Promise.resolve({
    latestRelease: "1.21.4",
    versions: []
  });
}

function readSettings() {
  return Promise.resolve({});
}

function ensureCompatibleJava() {
  return Promise.resolve("java");
}

const statusMessages = [];

function sendLaunchEvent(payload) {
  statusMessages.push(payload);
}

const modpackManager = createModpackManager({
  app,
  dialog,
  getReleaseVersions,
  readSettings,
  ensureCompatibleJava,
  sendLaunchEvent,
  isMinecraftRunning: () => false
});

const storeFile = path.join(userData, "eryon-instances.json");

function writeStore(instances) {
  fs.writeFileSync(
    storeFile,
    JSON.stringify({ instances }, null, 2),
    "utf8"
  );
}

function readStore() {
  return JSON.parse(
    fs.readFileSync(storeFile, "utf8")
  );
}

function run(label, asyncFunction) {
  return asyncFunction().then(
    () => {
      console.log(`OK    ${label}`);
    },
    (error) => {
      console.error(`FALLO ${label}: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

async function main() {
  await run(
    "renombra la carpeta y el registro",
    async () => {
      writeStore([
        {
          id: "aaaaaaaa-1111-2222-3333-444444444444",
          name: "Prueba",
          minecraftVersion: "1.21.4",
          loader: "vanilla",
          loaderVersion: null,
          launchVersionId: "1.21.4",
          kind: "instance",
          summary: "",
          sourceFile: null,
          createdAt: "2026-10-19T00:00:00.000Z",
          gameDirectory: path.join(userData, "eryon-instances", "Prueba-aaaaaaaa")
        }
      ]);

      const directoryA = path.join(
        userData,
        "eryon-instances",
        "Prueba-aaaaaaaa"
      );

      fs.mkdirSync(path.join(directoryA, "mods"), {
        recursive: true
      });

      fs.writeFileSync(
        path.join(directoryA, "mods", "test.jar"),
        "datos",
        "utf8"
      );

      const updated = await modpackManager.renameInstance(
        "aaaaaaaa-1111-2222-3333-444444444444",
        "Supervivencia"
      );

      const directoryB = path.join(
        userData,
        "eryon-instances",
        "Supervivencia-aaaaaaaa"
      );

      if (
        !fs.existsSync(directoryB) ||
        fs.existsSync(directoryA)
      ) {
        throw new Error("La carpeta no cambió de nombre.");
      }

      if (!fs.existsSync(path.join(directoryB, "mods", "test.jar"))) {
        throw new Error("El contenido de la carpeta no se conservó.");
      }

      const saved = readStore();

      if (saved.instances[0].name !== "Supervivencia") {
        throw new Error("El registro conserva el nombre antiguo.");
      }

      if (
        path.resolve(saved.instances[0].gameDirectory) !==
        path.resolve(directoryB)
      ) {
        throw new Error(
          "El registro conserva la ruta antigua de la carpeta."
        );
      }

      if (updated.gameDirectory !== directoryB) {
        throw new Error("La respuesta no devuelve la nueva ruta.");
      }
    }
  );

  await run(
    "actualiza una instancia creada con nombre antiguo sin carpeta",
    async () => {
      writeStore([
        {
          id: "bbbbbbbb-1111-2222-3333-444444444444",
          name: "Fantasma",
          minecraftVersion: "1.21.4",
          loader: "fabric",
          loaderVersion: "0.16.0",
          launchVersionId: "fabric-loader-0.16.0-1.21.4",
          kind: "instance",
          createdAt: "2026-10-19T00:00:00.000Z",
          gameDirectory: path.join(userData, "eryon-instances", "Fantasma-bbbbbbbb")
        }
      ]);

      const updated = await modpackManager.renameInstance(
        "bbbbbbbb-1111-2222-3333-444444444444",
        "SinCarpeta"
      );

      if (updated.name !== "SinCarpeta") {
        throw new Error("El registro no se actualizó.");
      }
    }
  );

  await run(
    "bloquea el renombrado mientras Minecraft está abierto",
    async () => {
      const busyDirectory = path.join(
        userData,
        "eryon-instances",
        "Ocupada-cccccccc"
      );

      fs.mkdirSync(busyDirectory, { recursive: true });

      writeStore([
        {
          id: "cccccccc-1111-2222-3333-444444444444",
          name: "Ocupada",
          minecraftVersion: "1.21.4",
          loader: "vanilla",
          loaderVersion: null,
          launchVersionId: "1.21.4",
          createdAt: "2026-10-19T00:00:00.000Z",
          gameDirectory: path.join(userData, "eryon-instances", "Ocupada-cccccccc")
        }
      ]);

      const busyManager = createModpackManager({
        app,
        dialog,
        getReleaseVersions,
        readSettings,
        ensureCompatibleJava,
        sendLaunchEvent,
        isMinecraftRunning: () => true
      });

      let rejected = null;

      try {
        await busyManager.renameInstance(
          "cccccccc-1111-2222-3333-444444444444",
          "Renombrada"
        );
      } catch (error) {
        rejected = error;
      }

      if (!rejected) {
        throw new Error("Debía rechazarse el renombrado.");
      }

      if (
        fs.existsSync(
          path.join(userData, "eryon-instances", "Renombrada-cccccccc")
        )
      ) {
        throw new Error(
          "La carpeta cambió a pesar de estar bloqueada."
        );
      }
    }
  );

  await run(
    "rechaza nombres inválidos sin tocar la carpeta",
    async () => {
      writeStore([
        {
          id: "dddddddd-1111-2222-3333-444444444444",
          name: "Valida",
          minecraftVersion: "1.21.4",
          loader: "vanilla",
          loaderVersion: null,
          launchVersionId: "1.21.4",
          createdAt: "2026-10-19T00:00:00.000Z",
          gameDirectory: path.join(userData, "eryon-instances", "Valida-dddddddd")
        }
      ]);

      fs.mkdirSync(
        path.join(userData, "eryon-instances", "Valida-dddddddd")
      );

      let rejected = null;

      try {
        await modpackManager.renameInstance(
          "dddddddd-1111-2222-3333-444444444444",
          "name<con>caracteres"
        );
      } catch (error) {
        rejected = error;
      }

      if (!rejected) {
        throw new Error("Debía rechazarse el nombre.");
      }

      if (
        !fs.existsSync(
          path.join(userData, "eryon-instances", "Valida-dddddddd")
        )
      ) {
        throw new Error("La carpeta desapareció o cambió.");
      }
    }
  );

  await run(
    "rechaza renombrar una instancia que está fuera de eryon-instances",
    async () => {
      const outside = path.join(userData, "fuera");

      fs.mkdirSync(outside, { recursive: true });

      writeStore([
        {
          id: "eeeeeeee-1111-2222-3333-444444444444",
          name: "Externa",
          minecraftVersion: "1.21.4",
          loader: "vanilla",
          loaderVersion: null,
          launchVersionId: "1.21.4",
          createdAt: "2026-10-19T00:00:00.000Z",
          gameDirectory: outside
        }
      ]);

      let rejected = null;

      try {
        await modpackManager.renameInstance(
          "eeeeeeee-1111-2222-3333-444444444444",
          "Cualquiera"
        );
      } catch (error) {
        rejected = error;
      }

      if (!rejected) {
        throw new Error("Debía bloquearse el renombrado externo.");
      }

      if (!fs.existsSync(outside)) {
        throw new Error("La carpeta externa se modificó.");
      }
    }
  );

  console.log(
    `\n[${
      process.exitCode ? "CON FALLOS" : "TODO EN ORDEN"
    }] Carpeta temporal: ${userData}`
  );
}

main();
