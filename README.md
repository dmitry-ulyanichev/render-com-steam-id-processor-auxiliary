# Steam ID Processor

Servicio de procesamiento de Steam IDs que valida perfiles usando Steam Web API y Steam Community endpoints. Incluye sistema de cooldowns escalonados, manejo de proxies SOCKS5 y API HTTP para integración distribuida.

## 🚀 Características

- **Validación completa de perfiles Steam**: Avatares animados, marcos, fondos, nivel Steam, amigos e inventarios CS2/CSGO
- **Sistema de cooldowns escalonados**: Manejo inteligente de rate limits con backoff exponencial (1min → 2min → 4min → 8min → 16min → 32min → 60min → 120min → 240min → 480min)
- **Soporte para proxies SOCKS5**: Rotación automática entre conexiones directas y múltiples proxies
- **API HTTP REST**: Endpoints para integración con otros servicios y despliegue distribuido
- **Procesamiento resiliente**: Manejo de errores, reconexión automática y recuperación de estado
- **File locking thread-safe**: Operaciones seguras de archivos para evitar race conditions

## 📋 Arquitectura

```
Steam ID Processor
├── Procesador Principal (index.js)
│   ├── SteamValidator → Validación con Steam APIs
│   ├── ProxyManager → Manejo de conexiones y cooldowns
│   ├── QueueManager → Gestión de cola de perfiles
│   └── ApiService → Envío a Django backend
└── API Server (api-server.js)
    ├── GET /health/cooldowns → Estado de cooldowns en tiempo real
    ├── POST /profiles → Agregar perfiles a la cola
    └── GET /profiles/queue → Ver contenido de la cola
```

## 🔧 Configuración

### Variables de Entorno Requeridas
```bash
# Steam API
STEAM_API_KEY=tu_steam_api_key

# Backend API
LINK_HARVESTER_API_KEY=tu_api_key

# API Server (opcional)
STEAM_PROCESSOR_API_PORT=3002
STEAM_PROCESSOR_API_HOST=0.0.0.0

# Cooldowns personalizados (opcional)
BACKOFF_SEQUENCE_MINUTES=1,2,4,8,16,32,60,120,240,480
COOLDOWN_CONNECTION_RESET_MS=600000
COOLDOWN_TIMEOUT_MS=300000
COOLDOWN_DNS_FAILURE_MS=900000
COOLDOWN_SOCKS_ERROR_MS=900000
```

### Archivos de Configuración

#### `config_proxies.json` - Configuración de Conexiones
```json
{
  "connections": [
    {
      "type": "direct",
      "url": null
    },
    {
      "type": "socks5", 
      "url": "socks5://user:pass@proxy.example.com:1080"
    }
  ]
}
```

#### `endpoint_cooldowns.json` - Estado de Cooldowns (Auto-generado)
```json
{
  "connections": [
    {
      "index": 0,
      "type": "direct",
      "endpoint_cooldowns": {
        "inventory": {
          "cooldown_until": 1640995200000,
          "reason": "429",
          "backoff_level": 3
        }
      }
    }
  ]
}
```

## 🎯 Instalación y Uso

### 1. Instalación
```bash
cd steam-id-processor
npm install
```

### 2. Configuración
```bash
# Copiar archivo de entorno
cp ../.env.example ../.env

# Editar variables requeridas
vim ../.env

# Configurar proxies (opcional)
cp config_proxies.json.example config_proxies.json
```

### 3. Ejecución

#### Modo Completo (Procesador + API)
```bash
npm start
# o
node src/index.js
```

#### Solo API Server
```bash
npm run api
# o  
node src/api-main.js
```

### 4. Verificación
```bash
# Salud del servicio
curl http://localhost:3002/health
https://kuchababok.online/api/steam-processor/health

# Estado de cooldowns
curl http://localhost:3002/health/cooldowns
https://kuchababok.online/api/steam-processor/health/cooldowns

# Ver cola de perfiles
curl http://localhost:3002/profiles/queue
https://kuchababok.online/api/steam-processor/profiles/queue
```

## 📡 API Endpoints

### Públicos

#### `GET /health`
```json
{
  "status": "ok",
  "service": "steam-id-processor-api", 
  "timestamp": "2025-01-15T10:30:00.000Z",
  "uptime": 3600
}
```

#### `GET /health/cooldowns`
```json
{
  "status": "ok",
  "service": "steam-id-processor",
  "cooldowns": {
    "direct": {
      "type": "direct",
      "endpoints": {
        "inventory": {
          "inCooldown": true,
          "remainingMs": 1800000,
          "remainingMinutes": 30,
          "reason": "429",
          "backoffLevel": 2
        }
      }
    }
  },
  "summary": {
    "totalConnections": 3,
    "availableConnections": 2,
    "longCooldowns": [...],
    "shortCooldowns": [...]
  },
  "overall_status": "limited"
}
```

### Protegidos

#### `POST /profiles`
```bash
# Agregar un perfil
curl -X POST http://localhost:3002/profiles \
  -H "Content-Type: application/json" \
  -d '{"steam_id": "76561198123456789", "username": "testuser"}'

# Agregar múltiples perfiles
curl -X POST http://localhost:3002/profiles \
  -H "Content-Type: application/json" \
  -d '[
    {"steam_id": "76561198123456789", "username": "user1"},
    {"steam_id": "76561198987654321", "username": "user2"}
  ]'
```

#### `GET /profiles/queue`
```json
{
  "success": true,
  "queue": {
    "profiles": [
      {
        "steam_id": "76561198123456789",
        "username": "testuser",
        "timestamp": 1640995200000,
        "checks": {
          "animated_avatar": "to_check",
          "steam_level": "passed",
          "csgo_inventory": "deferred"
        }
      }
    ],
    "stats": {
      "totalProfiles": 1,
      "byUsername": {"testuser": 1},
      "byStatus": {"to_check": 5, "passed": 1, "deferred": 1}
    }
  }
}
```

## 🔄 Sistema de Cooldowns

### Tipos de Cooldowns

#### Rate Limits (429 - Backoff Exponencial)
- **Secuencia**: 1min → 2min → 4min → 8min → 16min → 32min → 60min → 120min → 240min → 480min
- **Reset**: En request exitoso o al llegar al máximo
- **Scope**: Por conexión y endpoint específico

#### Errores de Conexión (Duración Fija)
- **Connection Reset**: 10 minutos (default)
- **Timeout**: 5 minutos (default)  
- **DNS Failure**: 15 minutos (default)
- **SOCKS Error**: 15 minutos (default)

### Estados de Disponibilidad
- **`healthy`**: Sin cooldowns activos
- **`limited`**: Solo cooldowns cortos (< 30min)
- **`degraded`**: Cooldowns largos presentes (≥ 30min)

## 🔍 Monitoreo y Debugging

### Logs
```bash
# Logs principales
tail -f ../logs/steam_id_processor.log

# Errores
tail -f ../logs/error.log

# API requests
tail -f ../logs/steam_id_processor.log | grep "API:"
```

### Estados de Archivos
```bash
# Ver cola actual
cat profiles_queue.json | jq '.[] | {steam_id, username, checks}'

# Ver cooldowns activos
cat endpoint_cooldowns.json | jq '.connections[] | select(.endpoint_cooldowns | length > 0)'

# Ver configuración de proxies
cat config_proxies.json | jq '.connections[] | {type, url}'
```

### Métricas Clave
- **Processing Rate**: ~1-2 profiles/segundo (cuando no hay cooldowns)
- **Queue Size**: Monitoreado en logs cada minuto
- **Cooldown Coverage**: Por conexión y endpoint
- **Success Rate**: Profiles procesados vs errores

## 🚨 Troubleshooting

### Problema: No procesa perfiles
```bash
# 1. Verificar que la cola tenga perfiles
curl http://localhost:3002/profiles/queue

# 2. Verificar estado de cooldowns
curl http://localhost:3002/health/cooldowns

# 3. Revisar logs de errores
tail -20 ../logs/error.log
```

### Problema: Cooldowns excesivos
```bash
# 1. Ver backoff levels actuales
cat endpoint_cooldowns.json | jq '.connections[] | select(.endpoint_cooldowns.inventory)'

# 2. Considerar agregar más proxies
vim config_proxies.json

# 3. Ajustar secuencia de backoff
export BACKOFF_SEQUENCE_MINUTES=1,2,4,8,16
```

### Problema: API no responde
```bash
# 1. Verificar que el puerto esté abierto
netstat -tlnp | grep 3002

# 2. Revisar configuración del puerto
echo $STEAM_PROCESSOR_API_PORT

# 3. Verificar logs de inicio
tail -50 ../logs/steam_id_processor.log | grep "API Server"
```

## 🔗 Integración con Otros Servicios

### Con node_api_service (Coordinador)
```javascript
// Ejemplo de uso desde coordinador
const response = await axios.get('http://steam-processor:3002/health/cooldowns');
if (response.data.overall_status === 'healthy') {
  await axios.post('http://steam-processor:3002/profiles', profileData);
}
```

### Con filter_raw_ids (Submitter)
El servicio puede recibir perfiles desde el submitter de filter_raw_ids via API en lugar de escritura directa de archivos.

### Deployment Distribuido
Cada instancia mantiene su propio estado de cooldowns y configuración de proxies, permitiendo deployment independiente en diferentes servidores/regiones.

## 📈 Optimización de Performance

### Configuración Agresiva
```bash
# Delays mínimos (más agresivo)
export PROCESSING_DELAY=200
export REQUEST_DELAY=1000

# Backoff más corto (más reintentos)
export BACKOFF_SEQUENCE_MINUTES=30,60,120,240
```

### Configuración Conservadora  
```bash
# Delays mayores (más estable)
export PROCESSING_DELAY=1000
export REQUEST_DELAY=3000

# Backoff más largo (menos reintentos)
export BACKOFF_SEQUENCE_MINUTES=2,5,10,30,60,120,240,480
```

## 🔄 Changelog

### v2.0.0 - API Integration
- ✅ API Server HTTP endpoints
- ✅ Real cooldown status monitoring  
- ✅ Distributed deployment support
- ✅ Thread-safe file operations
- ✅ Enhanced proxy management

### v1.0.0 - Initial Release
- ✅ Steam profile validation
- ✅ Exponential backoff system
- ✅ SOCKS5 proxy support
- ✅ Queue management
- ✅ Django API integration