"use strict";

const http = require("node:http");

function createLocalSkinServer({ profileId, profileName, skin, variant }) {
  const normalizedId = String(profileId ?? "")
    .replace(/-/g, "")
    .toLowerCase();
  if (!/^[a-f\d]{32}$/.test(normalizedId)) {
    throw new Error("El identificador del perfil local no es válido.");
  }
  if (!Buffer.isBuffer(skin)) {
    throw new Error("No se pudo leer la skin local.");
  }

  const textures = {
    timestamp: Date.now(),
    profileId: normalizedId,
    profileName,
    textures: {
      SKIN: {
        url: ""
      }
    }
  };
  if (variant === "slim") {
    textures.textures.SKIN.metadata = { model: "slim" };
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    if (url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify({
        meta: {
          serverName: "Eryon Local Skin",
          implementationName: "Eryon Launcher",
          implementationVersion: "1",
          feature: {
            no_mojang_namespace: true,
            enable_profile_key: false,
            legacy_skin_api: false
          }
        },
        skinDomains: ["127.0.0.1"]
      }));
      return;
    }

    if (
      url.pathname ===
      `/sessionserver/session/minecraft/profile/${normalizedId}`
    ) {
      textures.textures.SKIN.url =
        `http://127.0.0.1:${server.address().port}/textures/${normalizedId}.png`;
      const property = Buffer.from(
        JSON.stringify(textures),
        "utf8"
      ).toString("base64");
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify({
        id: normalizedId,
        name: profileName,
        properties: [{ name: "textures", value: property }]
      }));
      return;
    }

    if (url.pathname === `/textures/${normalizedId}.png`) {
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": skin.length,
        "Cache-Control": "no-store"
      });
      response.end(request.method === "HEAD" ? undefined : skin);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) closeReject(error);
            else closeResolve();
          });
        })
      });
    });
  });
}

module.exports = { createLocalSkinServer };
