# Local Server Kill

Icono en la bandeja de Windows que muestra qué servidores de desarrollo tienes corriendo (Vite, Next.js, Django, PHP, contenedores de Docker…), en qué puerto y de qué proyecto son, y te deja apagarlos con un clic.

Pensado para cuando se te quedan servidores prendidos sin darte cuenta y no sabes cuál es cuál ni cómo apagarlos.

<!-- Captura del panel: agrega aquí una imagen, por ejemplo docs/panel.png -->

## Instalación

1. Descarga desde **Releases** el instalador (`Local Server Kill Setup x.y.z.exe`) o la versión portable (`Local Server Kill-x.y.z-portable.exe`).
2. Ábrelo. La primera vez Windows puede mostrar **"Windows protegió tu PC"** porque la app no tiene firma digital: da clic en **Más información → Ejecutar de todas formas**.
3. Aparece un círculo junto al reloj. Si no lo ves, búscalo en la flechita **^** de la barra de tareas y arrástralo a la barra.

## Uso

- **Clic izquierdo** en el icono: abre el panel.
  - Clic en el número de puerto: lo abre en el navegador.
  - **Detener**: apaga ese servidor y también el `npm run dev` que lo lanzó.
  - **Apagar todos**: pide confirmación y apaga todos (menos Docker).
  - Pasa el mouse por el nombre del proyecto para ver la carpeta y el comando completo.
  - Cada servidor muestra cuánta memoria y CPU usa, contando a sus procesos hijos.
  - Botón **⋯**: Copiar URL, abrir en VS Code, abrir la carpeta y Reiniciar (lo vuelve a lanzar en una terminal nueva).
- **Ctrl+Alt+P**: abre o cierra el panel desde cualquier lugar.
- **Clic derecho**: Refrescar, avisos, Iniciar con Windows y Salir.
- El icono se pone ámbar cuando hay al menos un servidor activo.

### Avisos

- **Servidor olvidado**: notificación cuando uno lleva prendido más de 3 h (se cambia a 1, 2, 6 h o Nunca en el clic derecho). En el panel, su tiempo se pinta en rojo.
- **Servidor nuevo**: notificación cuando arranca uno (se puede apagar en el clic derecho).
- Si no ves los avisos, revisa que "No molestar" esté apagado en Windows.

### Docker

- Los contenedores aparecen agrupados por proyecto (compose o Supabase), uno por fila, con sus puertos publicados.
- Los que no publican puertos (por ejemplo una base de datos interna) también aparecen, con **—** en lugar del número.
- **Detener** y **Reiniciar** actúan solo sobre los contenedores de ese proyecto; Docker sigue funcionando.
- "Apagar todos" no toca Docker, porque suelen ser bases de datos.
- Si Docker no responde, se muestra una sola fila "Docker" sin botón de detener.

## Requisitos

- Windows 10 u 11.
- Opcional: Docker Desktop (con el comando `docker` disponible) para ver los contenedores por proyecto.

## Limitaciones

- Solo funciona en Windows.
- Si un servidor se inició como administrador, Windows solo deja apagarlo si esta app también se abre como administrador.
- **Reiniciar** relanza el mismo comando desde la misma carpeta, pero no recupera las variables de entorno que pusiste a mano en la terminal original (por ejemplo un venv activado).

## Desarrollo

Requiere Node.js 22 o superior.

```bash
npm install
npm run dev     # compila y abre la app
npm run dist    # genera el instalador y el .exe portable en release/<versión>/
npm run icons   # regenera los iconos de assets/
```

Para revisar el panel sin abrirlo desde la bandeja:

```powershell
$env:LSK_SCREENSHOT = "C:\ruta\panel.png"; npx electron .
```

Guarda una captura del panel en esa ruta unos segundos después de arrancar.

## Licencia

[MIT](LICENSE) © 2026 David Hielo
