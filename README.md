# 🧠 mente — gimnasio mental para Claude Code

Mientras Claude trabaja (genera, ejecuta scripts, lee ficheros…), aparece un ejercicio encima del prompt para que entrenes la cabeza en vez de coger el móvil. Cuando Claude termina, la franja desaparece y un aviso te dice qué tal te ha ido.

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

La primera vez verás encima del prompt *"🧠 ¿Activar ejercicios mentales mientras Claude trabaja?"*: escribe `1` y Enter.

## Ejercicios

Rotan entre tres tipos:

- **🧠 Cálculo mental**: sumas, restas, tablas, divisiones, porcentajes, cuadrados y series. 5 niveles que se adaptan solos: 3 aciertos seguidos suben uno y un fallo lo baja.
- **🎨 Stroop**: la palabra dice un color y está pintada de otro, y eliges el color de la tinta.
- **💡 Preguntas sobre la tarea**: preguntas tipo test sobre los conceptos de lo que Claude está haciendo en ese momento. Las genera Haiku (cuesta unos pocos tokens por turno). Se desactivan con `/mente tarea off`.

## Cómo responder

- Escribe `1`–`4` y Enter en el prompt. Mientras la franja está visible, ese número no se envía a Claude.
- O pulsa `ctrl+x tab` para entrar en la franja, elige con ←/→ y confirma con Enter (`Esc` vuelve al prompt).

## 🏆 Logros

Seis categorías (racha, aciertos totales, cálculo, Stroop, preguntas de la tarea y esperas entrenadas), todas con la misma escala:

| 5 | 10 | 50 | 100 | 200 | 500 | 1000 |
|---|---|---|---|---|---|---|
| 🪵 Madera | 🥉 Bronce | 🥈 Plata | 🥇 Oro | 💠 Platino | 💎 Diamante | 👑 Leyenda |

## Comandos

- `/mente`: activar/desactivar (`/mente on`, `/mente off`)
- `/mente logros`: estadísticas y vitrina de logros
- `/mente nivel 1-5`: fijar el nivel de cálculo
- `/mente tarea on|off`: preguntas sobre la tarea

## Licencia

© 2026 JS Soft Development. Este proyecto **no es open source**: se publica bajo la [PolyForm Strict License 1.0.0](LICENSE), que permite instalarlo y usarlo con fines no comerciales, pero no modificarlo, redistribuirlo ni venderlo.

Como excepción, puedes hacer un fork y modificarlo **solo para proponer mejoras o arreglos mediante pull request**. Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de enviar una.
