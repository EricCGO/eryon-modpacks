const CURSEFORGE_API = "https://api.curseforge.com";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders()
      });
    }

    const incoming = new URL(request.url);
    const path = incoming.searchParams.get("path") || "";

    if (!/^\/v1\/[A-Za-z0-9/_-]+$/.test(path)) {
      return Response.json(
        { error: "Ruta de CurseForge no permitida." },
        { status: 400, headers: corsHeaders() }
      );
    }

    const target = new URL(path, CURSEFORGE_API);
    for (const [key, value] of incoming.searchParams) {
      if (key !== "path") target.searchParams.append(key, value);
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          Accept: "application/json",
          "User-Agent": "EryonLauncher/1.0",
          "x-api-key": env.CURSEFORGE_API_KEY
        }
      });

      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60"
        }
      });
    } catch (error) {
      console.error("CurseForge proxy error", error);
      return Response.json(
        { error: "No se pudo contactar CurseForge." },
        { status: 502, headers: corsHeaders() }
      );
    }
  }
};
