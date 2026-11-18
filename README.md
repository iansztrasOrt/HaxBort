# HaxBort

Fútbol 2D de discos multijugador en el navegador. Se crea una sala, se pasa el código de 5 letras y se juega. Hay hasta 30 jugadores por sala, bots, chat y estadios propios en formato `.hbs`.

Es un proyecto propio. No usa el código, las imágenes, los sonidos ni la marca de ningún otro juego. Lo único en común es la compatibilidad con el formato de estadios `.hbs` (JSON5), que es un formato abierto.

## Jugar

1. En el inicio aparece **Bienvenido a HaxBort**. Tocá **Iniciar**.
2. Escribí tu nombre y elegí un avatar (1 o 2 caracteres). Queda guardado en el navegador.
3. Elegí qué hacer:
   - **Crear sala:** le ponés nombre, máximo de jugadores, contraseña opcional, si es pública y dónde corre el partido.
   - **Unirse con código:** escribís el código o tocás una sala de la lista pública. Un link `https://tu-app.onrender.com/sala/ABCDE` entra directo a esa sala.
   - **Practicar solo contra bots:** funciona sin conexión.

Con **Esc** se abre la sala (el "vestuario"). Ahí están:

- **Equipos:** las columnas Rojo, Espectadores y Azul. Tocás el nombre de un equipo para pasarte. El admin puede arrastrar jugadores de una columna a otra o usar el menú `⋯` para moverlos, darles admin o echarlos.
- **Botones del admin:**
  - **Auto:** pasa a un espectador al equipo con menos jugadores.
  - **Mezclar:** reparte los equipos al azar.
  - **Bloquear:** solo el admin puede cambiar los equipos.
  - **Reiniciar:** manda a todos a espectadores.
  - **+ Bot:** suma un bot al equipo.
- **Reglas:** tiempo, goles para ganar y estadio. El botón **Elegir** muestra los estadios integrados, tu biblioteca y el importador de `.hbs`.
- **Partido:** Empezar, Pausar y Parar.
- **Chat:** queda abajo de la sala. En la cancha se abre con **T**.

Cuando termina el partido aparece el resultado y, a los pocos segundos, todos vuelven solos a la sala.

**Controles**

| Acción | Teclas |
|---|---|
| Moverse | flechas o `W A S D` |
| Patear | mantener `X` o `Espacio` (el anillo blanco indica que vas a patear) |
| Sala | `Esc` |
| Chat | `T` |
| Zoom | rueda del mouse, `+` / `−`; `0` muestra toda la cancha |

En el celular aparecen un joystick y un botón para patear.

**Comandos de chat**

- **Para todos:** `/help`, `/avatar XX`, `/rojo`, `/azul`, `/espectador`.
- **Solo en tu pantalla:** `/zoom N` y `/limpiar`.
- **Del admin:** `/empezar`, `/parar`, `/pausa`, `/mezclar`, `/auto`, `/bloquear`, `/mapa nombre`, `/goles N`, `/tiempo N`, `/bot rojo|azul`, `/echar nombre`, `/ban nombre`, `/admin nombre` y `/clave texto` (sin texto quita la contraseña).

## Publicar en Render (gratis)

1. Subí esta carpeta a un repositorio de GitHub (la carpeta `dist/` tiene que estar incluida).
2. En Render, entrá a **New → Blueprint**, elegí el repositorio y confirmá. El archivo `render.yaml` ya trae todo configurado: Node 22, plan gratis, región Virginia y el chequeo de salud en `/healthz`.
3. Cuando termine, abrí la URL que te da Render y listo.

Para probarlo en tu compu:

```bash
npm install
```

```bash
npm start
```

Después abrí `http://localhost:3000`.

Si cambiás algo de `client/` o de `shared/`, corré `npm run build` para regenerar `dist/index.html` antes de subirlo. Render no compila: sirve el archivo ya armado.

## Cómo se logra el menor delay posible

**1. La sala corre en la compu de quien la crea (P2P, como HaxBall).**
- El partido de verdad se simula en el navegador del anfitrión.
- Los demás se conectan directo a esa compu por WebRTC. Render solo hace de punto de encuentro: códigos, lista de salas y armar la conexión directa.
- Entre compus de la misma ciudad el ping suele ser de 10 a 50 ms, y el anfitrión juega con 0 ms.
- Con un servidor en EE.UU., que es lo más cerca que tiene Render, serían unos 130 a 160 ms entre jugadores de Argentina.

**2. Las posiciones viajan por un canal "rápido".**
- Es un canal WebRTC no ordenado y sin reenvíos: un paquete perdido no frena a los que vienen atrás.
- Cada paquete de controles trae también los dos anteriores. Si uno se pierde, el siguiente lo repone.
- Los mensajes que sí tienen que llegar (chat, equipos, estadio) van por otro canal confiable.

**3. Predicción y reconciliación.**
- Tu compu simula el partido completo sin esperar: tu jugador y la pelota responden al instante.
- Cada foto del anfitrión (60 por segundo) trae el último control tuyo que él aplicó. Tu compu vuelve a esa foto y repite tus controles posteriores.
- La física es determinista, así que si no hubo sorpresas el resultado es idéntico y no se nota ninguna corrección. Los tests lo comprueban.
- Las correcciones chicas se suavizan en pantalla en vez de saltar.

**4. Sin colas de espera.**
- Si por la red llegan varios controles juntos, la sala salta al más nuevo en vez de acumular demora, sin perder una patada apretada.

**5. Plan B.**
- Algunas redes (de colegio, de empresa, ciertos routers) no dejan armar la conexión directa. En ese caso el jugador entra igual y sus datos pasan por el servidor (relay). Arriba a la derecha dice `directo` o `por servidor`.
- Si el anfitrión tiene mala conexión, la sala se puede crear **en el servidor**.

### Diagrama

```
Sala P2P (por defecto)

  Invitado A ──── WebRTC directo ────┐
                                     ▼
  Invitado B ── WebRTC directo ──► ANFITRIÓN (navegador: corre la sala y el partido)
                                     ▲
  Invitado C ── WebSocket ──► Render ┘   (relay solo si no hay conexión directa)

  Render: página, lista de salas, códigos y señalización WebRTC.

Sala en el servidor

  Jugadores ── WebSocket ──► Render (corre la sala y el partido a 60 Hz)
```

### Mensajes

**Binarios**, 60 por segundo:

| Mensaje | Dirección | Formato |
|---|---|---|
| Controles | jugador → sala | `[1][u32 seq][bits][bits-1][bits-2]` (8 bytes) |
| Foto | sala → jugador | `[2][u32 ack][u32 largo][meta JSON][f64 x,y,vx,vy por disco]` |
| Relay | por el servidor | `[0xFE][u16 link][mensaje]` |

**JSON** (por el canal confiable o el WebSocket):

| Tipo | Dirección | Para qué |
|---|---|---|
| `create`, `join`, `resume`, `leave`, `list` | jugador → servidor | crear sala, unirse, volver tras un corte, salir, lista pública |
| `hosted`, `p2p`, `guest`, `signal`, `relay`, `unlink`, `summary` | servidor ↔ navegadores | salas P2P: código, invitados, señalización WebRTC, relay y lista pública |
| `welcome`, `map`, `room`, `history` | sala → jugador | tu id y secreto, el estadio (texto .hbs), el estado de la sala y el chat anterior |
| `chat`, `sys`, `help`, `error`, `ev`, `kicked` | sala → jugador | mensajes, avisos, eventos del partido (patada, gol, saque, fin) y expulsión |
| `team`, `start`, `stop`, `pause`, `rules`, `map`, `lock`, `auto`, `rand`, `reset`, `bot`, `skill`, `kick`, `admin`, `avatar`, `roomcfg` | jugador → sala | acciones. La sala valida los permisos: casi todo es solo del admin. |
| `ping`, `pong` | ida y vuelta | medir el ping que se ve en la sala |

## Estructura

```
shared/                  código que corre igual en el servidor y en el navegador
  json5.js               lector de JSON5 con errores en línea y columna
  stadium/load.js        importador de .hbs: valida, completa valores por defecto y resuelve traits
  stadium/tune.js        ajuste de la fuerza de la patada para que sea pareja en todos los mapas
  physics/world.js       física de discos: segmentos rectos y curvos, planos, vértices y uniones
  game/match.js          reglas: saque con barrera, goles, tiempo, gol de oro y fin del partido
  game/bot.js            bots
  net/protocol.js        fotos y controles binarios, y restauración de estado para la predicción
  room/room.js           la sala: miembros, admin, equipos, chat, comandos, estadio y partido
  room/ticker.js         reloj de 60 Hz
server/index.js          HTTP + WebSocket: página, lista de salas, señalización, relay y salas en el servidor
client/                  interfaz (index.html), app.js, net.js (WebRTC, relay y anfitrión) y render.js
dist/index.html          el cliente ya armado en un solo archivo (lo sirve el servidor)
maps/                    estadios integrados (diseño propio) y un ejemplo
tests/                   pruebas del motor, el protocolo y la sala
```

## Pruebas

| Comando | Qué hace |
|---|---|
| `npm test` | 35 pruebas: física, importador, reglas, protocolo, determinismo de la predicción y permisos de la sala. |
| `npm run test:maps [carpeta o archivos]` | carga estadios `.hbs` y simula 10 segundos de cada uno. |
| `npm run e2e` | prueba con navegadores reales: sala P2P con conexión directa y relay, partido completo, vuelta a la sala, echar, sala en el servidor y reconexión. Necesita Playwright. |

### Checklist manual

- [ ] Dos compus distintas: una crea la sala, la otra entra con el código. Arriba a la derecha dice `directo`.
- [ ] El que entra se mueve y patea sin demora en su pantalla, y el anfitrión lo ve moverse enseguida.
- [ ] El admin arrastra jugadores entre columnas y prueba Auto, Mezclar, Bloquear y Reiniciar.
- [ ] Al terminar el partido aparece el cartel y todos vuelven solos a la sala.
- [ ] Importar un `.hbs` con la pelota liviana: avisa que la patada se ajusta y en la cancha se siente normal.
- [ ] Recargar la página en medio de una sala del servidor (o de un invitado P2P): vuelve solo a la sala, en el mismo equipo.
- [ ] Celular: joystick y botón de patear.

## Límites conocidos

- **Si el anfitrión cierra la pestaña, la sala P2P se termina** (igual que en HaxBall). Si alguien tiene que irse seguido, conviene crear la sala en el servidor.
- **No hay servidor TURN propio:** cuando la conexión directa no se puede armar, se usa el relay por el servidor, con más ping.
- **Render gratis se duerme** después de un rato sin uso. La primera carga puede tardar unos 30 a 60 segundos.
- **La biblioteca de mapas se guarda en cada navegador.** El mapa elegido sí se manda a todos los de la sala.
- **No se pueden importar estadios desde una URL.** Para evitar riesgos de seguridad, solo se aceptan archivos o texto pegado, de hasta 1 MB.
- **Los baneos de las salas P2P duran mientras la sala exista.** En las salas del servidor se banea por IP.
