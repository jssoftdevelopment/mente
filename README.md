# 🧠 mente — gimnasio mental para Claude Code

Mientras Claude trabaja (genera, ejecuta scripts, lee ficheros…), aparece un ejercicio encima del prompt para que entrenes la cabeza en vez de coger el móvil. Cuando Claude termina, la franja desaparece.

## Instalación

En el prompt de Claude Code (terminal):

```
/plugin install mente --marketplace jssoftdevelopment/mente
```

Responde `y` para añadir el marketplace y elige el ámbito (usuario) con Enter.

Desde la shell:

```
claude plugin install mente --marketplace jssoftdevelopment/mente
```

En la app de escritorio: pulsa **+** junto al cuadro del prompt → **Plugins** → **Add marketplace** con `jssoftdevelopment/mente` → **Add plugin**.

La primera vez verás encima del prompt *"🧠 ¿Activar ejercicios mentales mientras Claude trabaja?"*: pulsa `1`.

## Ejercicios

Rotan entre tres tipos:

- **🧠 Cálculo mental**: sumas, restas, tablas, divisiones, porcentajes, cuadrados y series. 5 niveles que se adaptan solos: 3 cuentas seguidas acertadas suben uno y un fallo lo baja.
- **🎨 Stroop**: la palabra dice un color y está pintada de otro, y eliges el color de la tinta. Usa la paleta Okabe-Ito (azul, amarillo, naranja y rosa), que se distingue con cualquier tipo de daltonismo. Se desactiva con `/mente stroop off`.
- **💡 Preguntas sobre la tarea**: preguntas tipo test sobre los conceptos de lo que Claude está haciendo en ese momento. Las genera Haiku (cuesta unos pocos tokens por turno). Se desactivan con `/mente tarea off`.

## Cómo responder

- Pulsa `1`–`4` con el prompt vacío: responde al momento, sin Enter. Las opciones se numeran de izquierda a derecha: la primera es `1`, la segunda `2`…
- O, con `/mente teclado on`, el ejercicio sale en un panel que intenta coger el teclado (`←` `→` + `Enter`, `Esc` para salir, `x` para apagar). Va apagado por defecto porque Claude Code puede usar las flechas para su propia navegación.

Cuando Claude termina, la franja desaparece sin más. Tus estadísticas y logros están en `/mente logros`.

### En tu status line

El mod escribe cómo vas hoy en `~/.claude/mente/status.txt` (por ejemplo `🧠 hoy 12/15 (80%) ↑ media 72% · récord 91% · 📅 3 días`). Si usas una status line propia con un script, añade esto antes de imprimirla para verlo en la misma línea:

```bash
MENTE_STATUS="$HOME/.claude/mente/status.txt"
if [ -s "$MENTE_STATUS" ] && [ "$(date -r "$MENTE_STATUS" +%Y%m%d)" = "$(date +%Y%m%d)" ]; then
  LINE="$LINE | $(head -n 1 "$MENTE_STATUS")"
fi
```

## 🏆 Logros

**53 logros** en total.

**📅 Racha diaria**: días seguidos entrenando (basta con responder un ejercicio al día):

| 1 | 2 | 3 | 4 | 5 | 10 | 30 | 60 | 90 | 180 | 365 |
|---|---|---|---|---|---|---|---|---|---|---|
| 🌱 Semilla | 🌿 Brote | 🔥 Fuego | ⚡ Rayo | ⭐ Estrella | 🥉 Bronce | 🥈 Plata | 🥇 Oro | 💠 Platino | 💎 Diamante | 👑 Leyenda |

**Seis categorías más** (racha de aciertos, aciertos totales, cálculo, Stroop, preguntas de la tarea y esperas entrenadas), con esta escala:

| 5 | 10 | 50 | 100 | 200 | 500 | 1000 |
|---|---|---|---|---|---|---|
| 🪵 Madera | 🥉 Bronce | 🥈 Plata | 🥇 Oro | 💠 Platino | 💎 Diamante | 👑 Leyenda |

## Comandos

- `/mente`: encender/apagar (`/mente on`, `/mente off`), o `x` con el ejercicio en pantalla
- `/mente logros`: estadísticas, cómo vas hoy frente a tu media, tu mejor día, la vitrina de logros y los nuevos que hayas desbloqueado
- `/mente nivel 1-5`: fijar el nivel de cálculo
- `/mente tarea on|off`: preguntas sobre la tarea
- `/mente stroop on|off`: ejercicios de colores
- `/mente teclado on|off`: si el ejercicio coge el teclado al salir

## Licencia

© 2026 JS Soft Development. Este proyecto **no es open source**: se publica bajo la [PolyForm Strict License 1.0.0](LICENSE), que permite instalarlo y usarlo con fines no comerciales, pero no modificarlo, redistribuirlo ni venderlo.

Como excepción, puedes hacer un fork y modificarlo **solo para proponer mejoras o arreglos mediante pull request**. Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de enviar una.
