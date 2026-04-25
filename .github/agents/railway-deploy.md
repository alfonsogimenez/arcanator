# Arcanator — Railway Deployment Knowledge

## Datos del proyecto

| Campo | Valor |
|-------|-------|
| URL pública | `https://arcanator-production.up.railway.app` |
| Project ID | `9c2bce08-81f3-4653-8a49-4cf38a45822b` |
| Service ID | `238279d8-f9b0-45e7-ac76-84eec129c637` |
| Panel | `https://railway.com/project/9c2bce08-81f3-4653-8a49-4cf38a45822b` |
| Cuenta Railway | `gimenez.ucendo@gmail.com` (login con GitHub: `alfonsogimenez`) |
| Región | `us-east4-eqdc4a` |

## Variables de entorno (configuradas en Railway)

| Variable | Valor |
|----------|-------|
| `OUTPUT_DIR` | `/data/output` |
| `PORT` | `8000` |

## Volumen persistente

- **Nombre**: `arcanator-volume`
- **Mount path**: `/data/output`
- Se configuró manualmente desde el panel Railway → servicio → Volumes → Add Volume
- Sin este volumen, los jobs (audio, imágenes, vídeos) se pierden en cada reinicio

## Configuración crítica — railway.toml

```toml
[build]
dockerfile = "Dockerfile"

[deploy]
startCommand = "sh -c \"uvicorn backend.main:app --host 0.0.0.0 --port $PORT\""
healthcheckPath = "/api/health"
healthcheckTimeout = 120
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

### ⚠️ Regla crítica sobre PORT

**NUNCA** usar estas formas — no funcionan en Railway:
- ❌ `uvicorn ... --port $PORT` — Railway pasa `$PORT` como literal, uvicorn lo rechaza
- ❌ `uvicorn ... --port ${PORT:-8000}` — misma razón
- ❌ `CMD ["uvicorn", ..., "--port", "$PORT"]` — forma exec de Docker no expande variables
- ❌ `sh -c 'uvicorn ... --port $PORT'` — comillas simples no expanden variables

**SIEMPRE** usar:
- ✅ `sh -c "uvicorn backend.main:app --host 0.0.0.0 --port $PORT"` con comillas dobles escapadas en el TOML

La razón: Railway inyecta `$PORT` como variable de entorno, pero solo se expande si el comando se ejecuta dentro de un shell (`sh -c`) con comillas dobles.

## Dockerfile (estructura correcta)

```dockerfile
# Stage 1: build deps
FROM python:3.12-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Stage 2: runtime
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /install /usr/local
COPY backend/ ./backend/
COPY frontend/ ./frontend/
# Pre-bake modelo Whisper (~150MB) para que el primer request sea rápido
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
ENV OUTPUT_DIR=/data/output
RUN mkdir -p /data/output
EXPOSE 8000
# CMD solo como fallback — Railway usa startCommand de railway.toml
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## Procedimiento de deploy desde cero

### Primera vez (ya hecho)

```powershell
cd C:\Arcanator

# 1. Instalar Railway CLI
npm install -g @railway/cli
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force

# 2. Login (abre el navegador)
railway login

# 3. Crear proyecto
railway init   # nombre: arcanator

# 4. Configurar variables
railway service   # seleccionar: arcanator
railway variables set OUTPUT_DIR=/data/output
railway variables set PORT=8000

# 5. Deploy
railway up --detach

# 6. Crear dominio público
railway domain

# 7. Añadir volumen (SOLO desde el panel web):
# Railway → proyecto → servicio → Volumes → Add Volume → /data/output
```

### Deploy de actualización (uso habitual)

```powershell
cd C:\Arcanator

# Commit cambios
git add .
git commit -m "descripción del cambio"
git push origin main

# Deploy
railway up --detach

# Ver logs
railway logs
```

## Errores encontrados y soluciones

### Error 1: `$PORT is not a valid integer`
- **Causa**: `startCommand` sin shell wrapper, o con comillas simples
- **Solución**: `sh -c "uvicorn ... --port $PORT"` con comillas dobles

### Error 2: Healthcheck falla sin output de uvicorn
- **Causa**: El comando no arrancaba por el error de PORT
- **Solución**: Mismo fix que Error 1. Una vez resuelto el PORT, uvicorn arranca y el healthcheck pasa

### Error 3: `railway logs` solo muestra build logs
- **Causa**: El CLI de Railway v4.x mezcla build y runtime logs. Los runtime logs reales se ven en el panel web → Deploy Logs
- **Solución**: Para diagnosticar errores de runtime, usar el panel web → pestaña "Deploy Logs"

### Error 4: `No service linked`
- **Causa**: El CLI no tiene servicio vinculado en la sesión actual
- **Solución**: Ejecutar `railway service` y seleccionar `arcanator`

### Error 5: `railway` no reconocido tras instalación
- **Causa**: PowerShell tiene política de ejecución restrictiva
- **Solución**: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force`

## Notas importantes

- El modelo Whisper base (~150MB) está **baked en la imagen Docker** — no se descarga en cada request
- Sin el volumen `/data/output`, los jobs no persisten entre reinicios del servidor
- El healthcheck usa `GET /api/health` → devuelve `{"status": "ok"}`
- Railway plan gratuito: 30 días o $5 de crédito — suficiente para uso personal esporádico
- La cuenta Railway está asociada al GitHub `alfonsogimenez` (OAuth)
