import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Exercise, Score } from '../types'

// ── Estado ─────────────────────────────────────────────────────────────
const enabled = atom({ plugin: 'mente', key: 'enabled' } as const, null as boolean | null)
const busy = atom({ plugin: 'mente', key: 'busy' } as const, false)
const exercise = atom({ plugin: 'mente', key: 'exercise' } as const, null as Exercise | null)
const feedback = atom({ plugin: 'mente', key: 'feedback' } as const, null as string | null)
const level = atom({ plugin: 'mente', key: 'level' } as const, 1)
const streak = atom({ plugin: 'mente', key: 'streak' } as const, 0)
const turnScore = atom({ plugin: 'mente', key: 'turnScore' } as const, { ok: 0, total: 0 } as Score)


const DELAY_MS = 1500 // no molestar en turnos cortísimos
const MAX_LEVEL = 5
const MAX_QUIZ_CALLS_PER_TURN = 3

// Contexto de lo que Claude está haciendo (para las preguntas de la tarea).
// Vive en el módulo: se pierde en una recarga, y no pasa nada.
let lastPrompt = ''
let recentTools: string[] = []
let quizPool: Exercise[] = []
let quizCalls = 0
let isFetching = false
let served = 0

// ── Utilidades ─────────────────────────────────────────────────────────
const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)] as T
const shuffle = <T,>(list: T[]): T[] => [...list].sort(() => Math.random() - 0.5)

// ── Cálculo mental ─────────────────────────────────────────────────────
function makeCalc(lvl: number): Exercise {
  const kinds: Array<() => [string, number]> = []

  const add = (lo: number, hi: number, lo2: number, hi2: number) => () => {
    const a = rnd(lo, hi), b = rnd(lo2, hi2)
    return [`${a} + ${b} =`, a + b] as [string, number]
  }
  const sub = (lo: number, hi: number, lo2: number, hi2: number) => () => {
    const a = rnd(lo, hi), b = rnd(lo2, Math.min(hi2, a))
    return [`${a} − ${b} =`, a - b] as [string, number]
  }
  const mul = (lo: number, hi: number, lo2: number, hi2: number) => () => {
    const a = rnd(lo, hi), b = rnd(lo2, hi2)
    return [`${a} × ${b} =`, a * b] as [string, number]
  }
  const div = (lo: number, hi: number, lo2: number, hi2: number) => () => {
    const b = rnd(lo, hi), q = rnd(lo2, hi2)
    return [`${b * q} ÷ ${b} =`, q] as [string, number]
  }
  const pct = () => {
    const p = pick([10, 20, 25, 50, 75]), n = pick([40, 60, 80, 120, 160, 200, 240, 360, 480])
    return [`${p}% de ${n} =`, (p * n) / 100] as [string, number]
  }
  const square = () => {
    const a = rnd(11, 25)
    return [`${a}² =`, a * a] as [string, number]
  }
  const series = () => {
    const start = rnd(1, 9)
    const kind = lvl >= 4 ? pick(['arit', 'geo', 'fib']) : pick(['arit', 'geo'])
    let seq: number[]
    if (kind === 'arit') {
      const d = rnd(2, lvl >= 4 ? 13 : 7)
      seq = [0, 1, 2, 3, 4].map(i => start + d * i)
    } else if (kind === 'geo') {
      const r = rnd(2, 3)
      seq = [0, 1, 2, 3, 4].map(i => start * r ** i)
    } else {
      seq = [start, start + rnd(1, 4)]
      while (seq.length < 5) seq.push((seq[seq.length - 1] ?? 0) + (seq[seq.length - 2] ?? 0))
    }
    return [`${seq.slice(0, 4).join(', ')}, ?`, seq[4] ?? 0] as [string, number]
  }

  if (lvl === 1) kinds.push(add(10, 49, 2, 9), sub(20, 59, 2, 9), mul(2, 5, 2, 9))
  if (lvl === 2) kinds.push(add(15, 89, 11, 49), sub(40, 99, 11, 39), mul(3, 9, 3, 9), series)
  if (lvl === 3) kinds.push(add(45, 199, 25, 99), sub(80, 199, 25, 79), mul(12, 29, 3, 9), div(3, 9, 6, 15), series)
  if (lvl === 4) kinds.push(mul(12, 19, 11, 19), div(6, 15, 11, 25), pct, square, series, sub(200, 999, 120, 480))
  if (lvl >= 5) kinds.push(mul(13, 49, 12, 29), add(250, 999, 250, 999), sub(500, 999, 180, 499), square, pct, series)

  const [question, answer] = pick(kinds)()

  // Distractores creíbles: cerca de la respuesta, errores típicos de acarreo.
  const near = shuffle([answer + 1, answer - 1, answer + 10, answer - 10, answer + 2, answer - 2, answer + 100, answer - 100])
  const opts = new Set<number>([answer])
  for (const n of near) {
    if (opts.size >= 4) break
    if (n >= 0) opts.add(n)
  }
  const options = shuffle([...opts])

  return { kind: 'calc', question, options: options.map(String), answer: options.indexOf(answer) }
}

// ── Stroop: la palabra dice un color, la tinta es otro ─────────────────
const COLORS: Array<{ name: string; hex: string }> = [
  { name: 'ROJO', hex: '#ef4444' },
  { name: 'AZUL', hex: '#3b82f6' },
  { name: 'VERDE', hex: '#22c55e' },
  { name: 'AMARILLO', hex: '#eab308' },
  { name: 'MORADO', hex: '#a855f7' },
  { name: 'NARANJA', hex: '#f97316' },
]

function makeStroop(): Exercise {
  const four = shuffle(COLORS).slice(0, 4)
  const ink = four[0] as { name: string; hex: string }
  // La palabra casi siempre engaña (otro color); a veces coincide, para no automatizar.
  const word = Math.random() < 0.85 ? (four[1] as { name: string }).name : ink.name
  const options = shuffle(four.map(c => c.name))
  return {
    kind: 'stroop',
    question: '¿De qué COLOR está pintada?',
    word,
    ink: ink.hex,
    options,
    answer: options.indexOf(ink.name),
  }
}

// ── Logros escalonados ─────────────────────────────────────────────────
type Stats = {
  ok: number
  total: number
  bestStreak: number
  streak: number
  calc: number
  stroop: number
  quiz: number
  turns: number
}
const EMPTY_STATS: Stats = { ok: 0, total: 0, bestStreak: 0, streak: 0, calc: 0, stroop: 0, quiz: 0, turns: 0 }

const TIERS = [
  { n: 5, name: 'Madera', icon: '🪵', cheer: '¡Buen comienzo!' },
  { n: 10, name: 'Bronce', icon: '🥉', cheer: '¡Muy bien, fiera!' },
  { n: 50, name: 'Plata', icon: '🥈', cheer: '¡Qué máquina!' },
  { n: 100, name: 'Oro', icon: '🥇', cheer: '¡Brutal, fiera!' },
  { n: 200, name: 'Platino', icon: '💠', cheer: '¡Estás on fire!' },
  { n: 500, name: 'Diamante', icon: '💎', cheer: '¡Bestia parda!' },
  { n: 1000, name: 'Leyenda', icon: '👑', cheer: '¡LEYENDA ABSOLUTA!' },
] as const

const CATEGORIES: Array<{ key: keyof Stats; label: string; unit: string }> = [
  { key: 'bestStreak', label: 'En racha', unit: 'aciertos seguidos' },
  { key: 'ok', label: 'Cerebro activo', unit: 'aciertos en total' },
  { key: 'calc', label: 'Calculadora humana', unit: 'cuentas acertadas' },
  { key: 'stroop', label: 'Ojo de halcón', unit: 'Stroop acertados' },
  { key: 'quiz', label: 'Aprendiz de Claude', unit: 'preguntas de la tarea acertadas' },
  { key: 'turns', label: 'Esperas productivas', unit: 'esperas entrenando' },
]

/** Índice del tier alcanzado con `value`, -1 si ninguno. */
const tierOf = (value: number) => {
  let t = -1
  TIERS.forEach((tier, i) => {
    if (value >= tier.n) t = i
  })
  return t
}

async function loadStats($: EngineInterface): Promise<Stats> {
  const s = (await $.store.get('stats')) as Partial<Stats> | undefined
  if (s) return { ...EMPTY_STATS, ...s }
  // Migración desde la versión anterior ('totals').
  const old = (await $.store.get('totals')) as Partial<Stats> | undefined
  return { ...EMPTY_STATS, ...(old ?? {}) }
}

/** Guarda las stats y lanza un toast por cada logro nuevo (el tier más alto). */
async function saveStats($: EngineInterface, stats: Stats) {
  await $.store.set('stats', stats)
  const got = ((await $.store.get('achievements')) as Record<string, number> | undefined) ?? {}
  let changed = false
  for (const cat of CATEGORIES) {
    const t = tierOf(stats[cat.key])
    if (t > (got[cat.key] ?? -1)) {
      got[cat.key] = t
      changed = true
      const tier = TIERS[t] as (typeof TIERS)[number]
      $.ui.toast(`${tier.icon} ${tier.cheer} Logro ${tier.name.toUpperCase()}: ${cat.label} · ${tier.n} ${cat.unit}`)
    }
  }
  if (changed) await $.store.set('achievements', got)
}

/** "🥈 Plata en racha: faltan 3" — el logro más cercano que te queda. */
function nextGoal(stats: Stats): string | null {
  let best: { left: number; text: string } | null = null
  for (const cat of CATEGORIES) {
    const t = tierOf(stats[cat.key])
    const tier = TIERS[t + 1]
    if (!tier) continue
    const left = tier.n - stats[cat.key]
    // Prioriza lo que está más cerca en proporción.
    if (!best || left / tier.n < best.left) {
      best = { left: left / tier.n, text: `${tier.icon} ${tier.name} en ${cat.label}: faltan ${left}` }
    }
  }
  return best?.text ?? null
}

// ── Preguntas sobre la tarea (las genera Haiku) ────────────────────────
const QUIZ_SYSTEM = `Eres un tutor de programación. A partir de lo que el usuario le ha pedido a un asistente de código y de lo que el asistente está haciendo, genera 2 preguntas tipo test en español para que el usuario aprenda algo útil sobre los conceptos, herramientas, comandos o decisiones de ESA tarea (no preguntes por detalles triviales del texto ni por nombres de ficheros).
Cada pregunta: máx. 90 caracteres; 4 opciones de máx. 40 caracteres, una sola correcta y distractores plausibles; "why": la explicación en máx. 90 caracteres.
Responde SOLO con JSON válido, sin markdown: [{"q":"...","options":["...","...","...","..."],"answer":0,"why":"..."}]`

function parseQuiz(text: string): Exercise[] {
  const a = text.indexOf('['), b = text.lastIndexOf(']')
  if (a < 0 || b <= a) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(a, b + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Exercise[] = []
  for (const item of raw as Array<Record<string, unknown>>) {
    const q = item?.q, opts = item?.options, ans = item?.answer, why = item?.why
    if (typeof q !== 'string' || !Array.isArray(opts) || opts.length !== 4 || typeof ans !== 'number') continue
    if (!opts.every(o => typeof o === 'string') || ans < 0 || ans > 3) continue
    const correct = opts[ans] as string
    const options = shuffle(opts as string[])
    out.push({
      kind: 'quiz',
      question: q,
      options,
      answer: options.indexOf(correct),
      why: typeof why === 'string' ? why : undefined,
    })
  }
  return out
}

async function fetchQuiz($: EngineInterface) {
  if (isFetching || quizCalls >= MAX_QUIZ_CALLS_PER_TURN || !lastPrompt) return
  if ((await $.store.get('quiz')) === false) return
  isFetching = true
  quizCalls += 1
  try {
    const prompt =
      `Lo que pidió el usuario:\n${lastPrompt.slice(0, 800)}\n\n` +
      `Lo que está haciendo el asistente (últimas acciones):\n${recentTools.slice(-8).join('\n') || '(aún nada)'}`
    const r = await $.model.complete({
      model: 'haiku',
      system: QUIZ_SYSTEM,
      prompt,
      maxTokens: 600,
      effort: 'low',
      timeoutMs: 20000,
    })
    if (r.isAnswered) quizPool.push(...parseQuiz(r.text))
  } finally {
    isFetching = false
  }
  // Si estaba mostrando una cuenta, la siguiente ya podrá ser de la tarea.
}

async function nextExercise($: EngineInterface): Promise<Exercise> {
  served += 1
  // Rota: cálculo → Stroop → tarea (si hay; si no, Stroop otra vez) → ...
  const slot = served % 3
  if (slot === 0 && quizPool.length > 0) {
    const q = quizPool.shift() as Exercise
    if (quizPool.length === 0) void fetchQuiz($)
    return q
  }
  if (slot !== 1) return makeStroop()
  return makeCalc(await read($, level))
}

// ── Respuestas ─────────────────────────────────────────────────────────
async function answer($: EngineInterface, index: number) {
  const ex = await read($, exercise)
  if (!ex) return
  const isRight = index === ex.answer
  const lvl = await read($, level)
  const s = isRight ? (await read($, streak)) + 1 : 0
  await update($, streak, () => s)
  await update($, turnScore, sc => ({ ok: sc.ok + (isRight ? 1 : 0), total: sc.total + 1 }))

  // El nivel solo se adapta con las cuentas.
  let newLvl = lvl
  if (ex.kind === 'calc') {
    if (isRight && s > 0 && s % 3 === 0) newLvl = Math.min(MAX_LEVEL, lvl + 1)
    if (!isRight) newLvl = Math.max(1, lvl - 1)
    if (newLvl !== lvl) {
      await update($, level, () => newLvl)
      await $.store.set('level', newLvl)
    }
  }

  // La racha de logros es la de siempre (sobrevive entre sesiones).
  const stats = await loadStats($)
  const allStreak = isRight ? stats.streak + 1 : 0
  if (isRight) stats[ex.kind] += 1
  await saveStats($, {
    ...stats,
    ok: stats.ok + (isRight ? 1 : 0),
    total: stats.total + 1,
    streak: allStreak,
    bestStreak: Math.max(stats.bestStreak, allStreak),
  })

  const correct = ex.options[ex.answer] ?? ''
  const up = newLvl > lvl ? ` ↑ nivel ${newLvl}` : newLvl < lvl ? ` ↓ nivel ${newLvl}` : ''
  const racha = isRight && allStreak >= 2 ? ` · racha ${allStreak}${allStreak >= 5 ? ' 🔥' : ''}` : ''
  const mark = isRight ? '✓' : '✗'
  const fb =
    ex.kind === 'calc'
      ? `${mark} ${ex.question.replace(/ =$/, '').replace(/, \?$/, ', …')} → ${correct}${racha}${up}`
      : ex.kind === 'stroop'
        ? `${mark} Tinta ${correct} (ponía ${ex.word})${racha}`
        : `${mark} ${correct}${ex.why ? ` — ${ex.why}` : ''}${racha}`
  await update($, feedback, () => fb)

  // Siguiente ejercicio solo si Claude sigue trabajando.
  const nxt = (await read($, busy)) ? await nextExercise($) : null
  await update($, exercise, () => nxt)
  return fb
}

async function setEnabled($: EngineInterface, value: boolean) {
  await update($, enabled, () => value)
  await $.store.set('enabled', value)
  if (!value) await update($, exercise, () => null)
  if (value && (await read($, busy)) && (await read($, exercise)) === null) {
    const ex = await nextExercise($)
    await update($, exercise, () => ex)
  }
}

// ── Módulo ─────────────────────────────────────────────────────────────
export const register: Register = on => {
  let currentTurn: string | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mente',
      description: 'Gimnasio mental mientras Claude trabaja: /mente (on/off), /mente logros, /mente nivel 1-5, /mente tarea on|off',
    })
    const stored = await $.store.get('enabled')
    await update($, enabled, () => (typeof stored === 'boolean' ? stored : null))
    const lvl = Number((await $.store.get('level')) ?? 1)
    await update($, level, () => Math.min(MAX_LEVEL, Math.max(1, lvl || 1)))

    return next(e)
  })

  // Lo que pides a Claude: contexto para las preguntas de la tarea.
  // Un "1".."4" a secas con la franja visible es una respuesta y no se envía.
  on('prompt.submit', async ($, e, next) => {
    const t = e.text.trim()
    if (!e.command && /^[1-4]$/.test(t)) {
      const n = Number(t)
      const state = await read($, enabled)
      if (state === null && n <= 2) {
        await setEnabled($, n === 1)
        return {
          drop:
            n === 1
              ? '🧠 Gimnasio mental activado. Mientras Claude trabaje: ctrl+x tab y flechas + Enter, o escribe 1-4 y Enter.'
              : '🧠 Vale, desactivado. /mente para activarlo cuando quieras.',
        }
      }
      if (state && (await read($, exercise))) {
        const fb = await answer($, n - 1)
        return { drop: fb ?? '🧠' }
      }
    }
    if (!e.command && t.length > 0) {
      lastPrompt = t
      recentTools = []
      quizPool = []
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!e.agentId) {
      const input = JSON.stringify((e as { input?: unknown }).input ?? '')
      recentTools.push(`${e.tool}: ${input.slice(0, 140)}`)
      if (recentTools.length > 12) recentTools = recentTools.slice(-12)
    }
    return next(e)
  })

  // Claude empieza a trabajar → al rato, primer ejercicio.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      currentTurn = e.turnId
      quizCalls = 0
      served = 0
      await update($, busy, () => true)
      await update($, turnScore, () => ({ ok: 0, total: 0 }))
      await update($, feedback, () => null)
      const turnId = e.turnId
      $.clock.after(DELAY_MS, async () => {
        if (currentTurn !== turnId || !(await read($, enabled))) return
        // Pide preguntas de la tarea (con algo de contexto ya) sin bloquear.
        $.clock.after(4000, () => {
          if (currentTurn === turnId) void fetchQuiz($)
        })
        if ((await read($, exercise)) === null) {
          const ex = await nextExercise($)
          await update($, exercise, () => ex)
        }
      })
    }

    return next(e)
  })

  // Claude termina → se quita la franja y resumen breve.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      currentTurn = null
      await update($, busy, () => false)
      await update($, exercise, () => null)
      await update($, feedback, () => null)
      const score = await read($, turnScore)
      if (score.total > 0) {
        const stats = await loadStats($)
        stats.turns += 1
        await saveStats($, stats)
        const pct = Math.round((score.ok / score.total) * 100)
        const face = pct === 100 ? '🤯 Perfecto' : pct >= 75 ? '😎' : pct >= 50 ? '🙂' : '💪'
        const parts = [
          `🧠 ${face} ${score.ok}/${score.total} mientras esperabas`,
          stats.streak >= 2 ? `racha ${stats.streak}${stats.streak >= 5 ? ' 🔥' : ''}` : null,
          `niv ${await read($, level)}`,
          nextGoal(stats),
        ]
        $.ui.toast(parts.filter(Boolean).join(' · '))
      }
    }

    return next(e)
  })

  on('command.run', { command: 'mente' }, async ($, e) => {
    const [cmd, arg] = e.args.trim().toLowerCase().split(/\s+/)
    if (cmd === 'stats' || cmd === 'logros') {
      const t = await loadStats($)
      const pctOk = t.total ? Math.round((t.ok / t.total) * 100) : 0
      const lines = CATEGORIES.map(cat => {
        const i = tierOf(t[cat.key])
        const have = TIERS.map((tier, j) => (j <= i ? tier.icon : '·')).join(' ')
        const nxt = TIERS[i + 1]
        const tail = nxt ? `${t[cat.key]}/${nxt.n} → ${nxt.name}` : 'COMPLETO 👑'
        return `${have}  ${cat.label} — ${tail}`
      })
      return {
        text:
          `🧠 ${t.ok}/${t.total} aciertos (${pctOk}%) · racha actual ${t.streak} · mejor ${t.bestStreak} · nivel ${await read($, level)}\n\n` +
          `🏆 Logros (5 · 10 · 50 · 100 · 200 · 500 · 1000)\n` +
          lines.join('\n'),
      }
    }
    if (cmd === 'nivel') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > MAX_LEVEL) return { text: 'Uso: /mente nivel 1-5' }
      await update($, level, () => n)
      await $.store.set('level', n)
      return { text: `🧠 Nivel fijado en ${n} (se sigue adaptando según aciertes).` }
    }
    if (cmd === 'tarea') {
      const v = arg === 'off' ? false : arg === 'on' ? true : (await $.store.get('quiz')) === false
      await $.store.set('quiz', v)
      if (!v) quizPool = []
      return {
        text: v
          ? '🧠 Preguntas sobre la tarea ACTIVADAS (las genera Haiku: cuesta unos pocos tokens por turno).'
          : '🧠 Preguntas sobre la tarea desactivadas: solo cálculo mental.',
      }
    }
    const value = cmd === 'on' ? true : cmd === 'off' ? false : !(await read($, enabled))
    await setEnabled($, value)
    return {
      text: value
        ? '🧠 Gimnasio mental ACTIVADO. Mientras Claude trabaje: ctrl+x tab para entrar en la franja, flechas + Enter para elegir (o escribe 1-4 y Enter).'
        : '🧠 Gimnasio mental desactivado. /mente para volver a activarlo.',
    }
  })

  // ── La franja encima del prompt ──────────────────────────────────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await read($, enabled)

    // Primera vez: ofrecer activarlo.
    if (isOn === null) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text>🧠 ¿Activar ejercicios mentales mientras Claude trabaja?</Text>
          <Button key="yes" hotkey="1" autoFocus label="Activar" onPress={() => void setEnabled($, true)} />
          <Button key="no" hotkey="2" label="No, gracias" onPress={() => void setEnabled($, false)} />
        </Box>
      )
    }

    const ex = await read($, exercise)
    if (!isOn || !(await read($, busy)) || !ex) return next(e)

    const fb = await read($, feedback)
    const score = await read($, turnScore)
    const lvl = await read($, level)
    const buttons = ex.options.map((opt, i) => (
      <Button
        key={`o${i}`}
        hotkey={String(i + 1)}
        autoFocus={i === 0 ? true : undefined}
        label={opt}
        onPress={() => void answer($, i)}
      />
    ))
    const meta = (
      <Text dimColor>
        niv {lvl} · {score.ok}/{score.total} · ctrl+x tab → ←→ Enter
      </Text>
    )

    return (
      <Box flexDirection="column">
        {fb && <Text color={fb.startsWith('✓') ? 'success' : 'error'}>{fb}</Text>}
        {ex.kind === 'calc' ? (
          <Box flexDirection="row" gap={1}>
            <Text weight="bold">🧠 {ex.question}</Text>
            {buttons}
            {meta}
          </Box>
        ) : ex.kind === 'stroop' ? (
          <Box flexDirection="row" gap={1}>
            <Text>🎨 {ex.question}</Text>
            <Text weight="bold" color={ex.ink}>
              {ex.word}
            </Text>
            {buttons}
            {meta}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text weight="bold">💡 {ex.question}</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {buttons}
            </Box>
            {meta}
          </Box>
        )}
      </Box>
    )
  })
}
