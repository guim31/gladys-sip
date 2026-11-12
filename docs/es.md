# Llamadas de voz SIP (Asterisk)

Llame a un teléfono desde una escena de Gladys y reprodúzcale un mensaje (alarma, fuga de agua, puerta abierta), y
reaccione a las llamadas recibidas (abrir el portón cuando llama un número conocido). La integración controla **su
propio Asterisk o FreePBX** mediante ARI, la interfaz REST de Asterisk: nunca habla SIP por sí misma, lo hace su
servidor telefónico.

Desarrollada sin línea de operador: probada con Asterisk 23.5 en Docker y teléfonos simulados. Sus comentarios son
bienvenidos.

## Lo que obtiene

- Una acción de escena **«Llamar y reproducir un mensaje»**: llama a un número permitido, reproduce el mensaje una o
  varias veces y vuelve a llamar si nadie contesta. Opcionalmente, la llamada solo queda **confirmada** cuando alguien
  pulsa **1**: hasta entonces, la integración sigue llamando (hasta el número de intentos).
- Una acción de escena **«Detener las llamadas»**: cuelga y cancela los reintentos (falsa alarma).
- Un desencadenante **«Llamada recibida»**, filtrado por número de quien llama y número llamado, con el número y el
  nombre de quien llama como variables.
- Un desencadenante **«Llamada realizada terminada»**, filtrado por número y resultado (confirmada, contestada, sin
  respuesta, ocupado, error, cancelada).
- Un dispositivo **Servidor Asterisk**: servidor accesible, última llamada recibida, última llamada realizada.
- Un widget de panel **Llamadas telefónicas**.

## Requisitos: Asterisk

1. Active el servidor HTTP en `/etc/asterisk/http.conf`:

   ```ini
   [general]
   enabled=yes
   bindaddr=0.0.0.0
   bindport=8088
   ```

2. Cree un usuario ARI en `/etc/asterisk/ari.conf` (elija una contraseña larga):

   ```ini
   [general]
   enabled=yes

   [gladys]
   type=user
   read_only=no
   password=una-contrasena-larga-y-aleatoria
   ```

3. Grabe sus mensajes. Un mensaje es uno o varios sonidos de Asterisk: coloque `alarma.wav` (8 kHz mono) en
   `/var/lib/asterisk/sounds/es/custom/` y use `custom/alarma`. Los medios `digits:1234`, `number:42` y `tone:ring`
   también funcionan.
4. Para las llamadas recibidas, envíe las llamadas a la integración desde el contexto del trunk de su operador en
   `extensions.conf`, antes de hacer sonar sus teléfonos:

   ```ini
   [from-trunk]
   exten => _X.,1,Stasis(gladys)
    same => n,Dial(PJSIP/100,30)
   ```

   Cuando la integración está detenida, `Stasis()` falla en el acto y la llamada continúa: sus teléfonos siguen
   sonando.

5. Las llamadas salientes usan el trunk de su operador: la cadena de marcación `PJSIP/{number}@mi-trunk` llama por
   el endpoint PJSIP `mi-trunk`. Ejecute `core reload` después de estos cambios.

## Requisitos: FreePBX

1. **Settings → Asterisk REST Interface Users**: añada un usuario (lectura/escritura) y anote su contraseña.
   Compruebe en **Settings → Advanced Settings** que el mini servidor HTTP de Asterisk está activado (puerto 8088).
2. **Admin → System Recordings**: grabe o suba los mensajes; una grabación llamada `alarma` es el sonido
   `custom/alarma`.
3. Cadena de marcación: `Local/{number}@from-internal`, para que las rutas salientes de FreePBX elijan el trunk.
4. Llamadas recibidas: en `extensions_custom.conf`, añada un contexto que pase por Stasis y luego por su ruta
   entrante, y haga que un **Custom Destination** o el contexto del trunk apunte a él:

   ```ini
   [gladys-incoming]
   exten => _X.,1,Stasis(gladys)
    same => n,Goto(from-trunk,${EXTEN},1)
   ```

## Configuración

| Campo                    | Uso                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Dirección ARI            | `http://<dirección del servidor>:8088`                                                    |
| Usuario, contraseña      | El usuario de `ari.conf` o de FreePBX                                                     |
| Aplicación Stasis        | `gladys` por defecto: el nombre usado en `Stasis(gladys)`                                 |
| Números permitidos       | Los únicos números a los que pueden llamar las escenas, separados por comas               |
| Cadena de marcación      | `{number}` se sustituye por el número llamado                                             |
| Identificador de llamada | Se muestra en el teléfono llamado, p. ej. `Gladys <100>` (el operador puede sustituirlo)  |
| Llamadas entrantes       | Seguir en el plan (suenan los teléfonos) o colgar sin contestar (gratis para quien llama) |
| Idioma de los textos     | Idioma de los nombres de las funciones y de los resultados de llamada                     |

**Probar la conexión** comprueba la dirección y el usuario. **Llamada de prueba** realiza una llamada (un intento,
una reproducción).

## Escenas

- **Alarma por teléfono**: desencadenante «Alarma activada» → acción «Llamar y reproducir un mensaje», número
  `+34612345678`, mensaje `custom/alarma`, 3 reproducciones, 5 intentos, 60 s entre intentos, «Esperar a que se
  pulse 1» marcado.
- **Falsa alarma**: desencadenante «Alarma desarmada» → acción «Detener las llamadas».
- **Portón por teléfono**: desencadenante «Llamada recibida», número de quien llama `+34612345678` → abrir el
  portón. En el modo «colgar sin contestar», la llamada no le cuesta nada a quien llama.
- **Nadie ha confirmado**: desencadenante «Llamada realizada terminada», resultado «Sin respuesta» → enviar un
  mensaje a otra persona.

La acción de escena termina en el acto (una llamada con reintentos dura más de lo que permite una acción de
escena): el resultado llega por el desencadenante «Llamada realizada terminada» y la función «Última llamada
realizada». El número se escribe como en los números permitidos; se ignoran espacios, puntos y guiones. No se
realiza una segunda llamada a un número al que ya se está llamando.

## Panel

El widget **Llamadas telefónicas** muestra el enlace con Asterisk, las llamadas en curso, la hora de la última
llamada recibida y realizada con su resultado y, durante una llamada, un botón para detener las llamadas (se puede
ocultar en la configuración del widget).

## Limitaciones

- **Sin síntesis de voz**: Asterisk reproduce sonidos grabados. Grabe sus mensajes una vez (System Recordings de
  FreePBX o una herramienta de síntesis de voz en su ordenador).
- Solo se puede llamar a los **números permitidos**. No añada nunca números de tarificación especial: una escena
  podría llamarlos en bucle.
- El **número de quien llama puede falsificarse**: no lo use por sí solo para abrir una puerta o desarmar una
  alarma.
- Las llamadas en curso cuando la integración o Asterisk se reinician terminan con error.
- Solo se ven las llamadas enviadas a `Stasis(gladys)`.
- Desarrollada sin el hardware: no se usó ninguna línea de operador real en las pruebas, solo Asterisk 23.5 con
  teléfonos simulados. Sus comentarios son bienvenidos.

## Solución de problemas

- **«Asterisk no responde»**: compruebe la dirección y el puerto, `http show status` en la consola de Asterisk, y
  que el equipo de Gladys alcanza el puerto 8088.
- **«Asterisk rechaza el usuario ARI»**: compruebe `ari.conf` (o el usuario ARI de FreePBX) y ejecute
  `module reload res_ari.so`.
- **«Error» inmediato**: la cadena de marcación es incorrecta (`pjsip show endpoints`), o el trunk rechaza la
  llamada: la consola de Asterisk indica el motivo.
- **El mensaje no suena**: el sonido no existe; compruebe `core show file formats` y la ruta bajo
  `sounds/<idioma>/`.
- **Ningún desencadenante al recibir una llamada**: el plan de marcación no llega a `Stasis(gladys)`, o el nombre de
  la aplicación difiere de la configuración.
