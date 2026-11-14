# Proxy seguro de CurseForge

Cloudflare Workers Free incluye hasta 100.000 solicitudes diarias. Ese límite
puede cambiar en el futuro; no se puede garantizar que un plan externo sea
gratuito para siempre.

Desde esta carpeta:

```powershell
npx wrangler login
npx wrangler secret put CURSEFORGE_API_KEY
npx wrangler deploy
```

Después copia la URL `workers.dev` que muestre Wrangler en
`electron/curseforge-proxy-config.cjs`, en la constante
`CURSEFORGE_PROXY_URL`. Después compila el launcher:

```powershell
npm run build
```

La clave solo existe como secreto de Cloudflare y no se incluye en el
launcher.
