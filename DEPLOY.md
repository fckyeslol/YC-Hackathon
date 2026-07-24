# Deploy — Verdict en Railway

> Server Fastify always-on (Node 24, ESM, corre TS con `tsx` sin build step).
> Railway le da un dominio HTTPS estable que usamos como `PUBLIC_URL` y como
> target del webhook de Linq. Solo testnet (Base Sepolia) — ver [`PLAN.md §8`](PLAN.md).

## Requisitos previos

- Repo en GitHub (entregable §15).
- Cuenta en Railway conectada a ese GitHub.
- Credenciales a mano: `LINQ_API_KEY`, `LINQ_NUMBER`, `TERAC_API_KEY`,
  `LINQ_WEBHOOK_SECRET` (ver [`.env.example`](.env.example)).

## Cómo arranca (ya configurado)

- [`railway.json`](railway.json): builder Nixpacks, `startCommand: npm start`,
  healthcheck en `/health` ([src/server/linqWebhook.ts](src/server/linqWebhook.ts#L94)).
- [`package.json`](package.json): `engines.node = 24.x` → Nixpacks instala Node 24.
- `npm start` = `tsx src/server/index.ts`. No hay `dist/`; se ejecuta TS directo.
- El server bindea `0.0.0.0:$PORT` y lee `PORT` de env — Railway inyecta `$PORT`,
  así que **no** hay que setear `PORT` a mano.

## Pasos

### 1. Crear el servicio

1. Railway → **New Project** → **Deploy from GitHub repo** → elegí este repo.
2. Railway detecta `railway.json` + `package.json` y hace el primer build/deploy.

### 2. Variables de entorno

En el servicio → pestaña **Variables**, agregá (valores reales, nunca commiteados):

| Variable | Valor | Notas |
|---|---|---|
| `LINQ_API_KEY` | `<secreto>` | de `linq whoami` |
| `LINQ_NUMBER` | `+1XXXXXXXXXX` | E.164 |
| `TERAC_API_KEY` | `<secreto>` | |
| `LINQ_WEBHOOK_SECRET` | `<secreto>` | **obligatorio en prod** — sin él, `/webhooks/linq` rechaza todo con 401 (fail-closed, [index.ts:97](src/server/index.ts#L97)) |
| `PUBLIC_URL` | `https://<dominio-railway>` | ver paso 3, **sin barra final** |

> Los `DYNAMIC_*` se agregan cuando exista el cliente Dynamic (hoy corre como stub
> fail-closed y `config.ts` todavía no los valida).

### 3. Dominio público → `PUBLIC_URL`

1. Servicio → **Settings** → **Networking** → **Generate Domain**.
2. Copiá el dominio (ej. `verdict-production.up.railway.app`).
3. Volvé a **Variables** y poné `PUBLIC_URL=https://verdict-production.up.railway.app`.
4. Redeploy para que el server tome el valor (se usa para el `task_url` de Terac y
   los links tokenizados de dashboard).

### 4. Volumen persistente (recomendado)

El store snapshotea a `data/store.json` en disco local ([store.ts](src/store/store.ts#L18)).
Sin volumen, se pierde en cada redeploy/reinicio.

1. Servicio → **Settings** → **Volumes** → **New Volume**.
2. Mount path: `/app/data`.

> Para el demo de 2 min es opcional (el proceso queda arriba), pero evita perder
> opt-outs y polls si Railway recicla el contenedor.

### 5. Registrar el webhook en Linq

Apuntá la suscripción de webhooks de Linq a:

```
https://<dominio-railway>/webhooks/linq
```

Eventos: `message.received`, `reaction.added/removed`, `phone_number.status_updated`.
El server verifica la firma HMAC (`webhook-signature`, con anti-replay por timestamp),
así que el secreto en Linq **debe** coincidir con `LINQ_WEBHOOK_SECRET`.

### 6. Verificar

```bash
curl https://<dominio-railway>/health      # → {"ok":true}
```

En los logs de Railway deberías ver `[verdict] listening on ...`. Aviso esperado
mientras los adapters no estén conectados:
`agent LLM/STT/wallet adapters not configured — running fail-closed stubs`.

## Desarrollo local con túnel (para iterar sin redeployar)

```bash
npm run dev                 # Fastify en :3000
cloudflared tunnel --url http://localhost:3000
```

Poné la URL del túnel como `PUBLIC_URL` local y como target del webhook de Linq
mientras desarrollás. Al final, el entregable "live" apunta al dominio de Railway.

## Fallback si Nixpacks no resuelve Node 24

Si el build falla por la versión de Node, agregá este `Dockerfile` en la raíz
(Railway lo prioriza sobre Nixpacks automáticamente):

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Y en `railway.json` cambiá `"builder": "NIXPACKS"` por `"builder": "DOCKERFILE"`.
