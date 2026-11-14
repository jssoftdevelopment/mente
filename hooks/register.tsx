import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Exercise, ExerciseKind, Score } from '../types'

const enabled = atom({ plugin: 'mente', key: 'enabled' } as const, null as boolean | null)
const busy = atom({ plugin: 'mente', key: 'busy' } as const, false)
const exercise = atom({ plugin: 'mente', key: 'exercise' } as const, null as Exercise | null)
const feedback = atom({ plugin: 'mente', key: 'feedback' } as const, null as string | null)
const level = atom({ plugin: 'mente', key: 'level' } as const, 1)
const turnScore = atom({ plugin: 'mente', key: 'turnScore' } as const, { ok: 0, total: 0 } as Score)
const paneUp = atom({ plugin: 'mente', key: 'paneUp' } as const, false)

const PANE = 'mente'
const FIRST_EXERCISE_DELAY_MS = 1500
const QUIZ_FETCH_DELAY_MS = 4000
const MAX_LEVEL = 5
const LEVEL_UP_RUN = 3
const MAX_QUIZ_CALLS_PER_TURN = 3
const RECORD_MIN_ANSWERS = 10
const STROOP_MISMATCH_RATE = 0.85
const PROMPT_CONTEXT_CHARS = 800
const TOOL_CONTEXT_CHARS = 140
const TOOL_CONTEXT_ITEMS = 8
const MAX_UNSEEN = 50
const DAY_MS = 86_400_000

// Per-turn context. Lost on reload, which only resets the quiz context.
let lastPrompt = ''
let recentTools: string[] = []
let quizPool: Exercise[] = []
let quizCalls = 0
let isFetchingQuiz = false
let served = 0
let calcRun = 0
let currentTurn: string | null = null
let escapedTurn: string | null = null
let isAnswering = false
let statusPath: string | null = null
// Serializes read-modify-write cycles on the stored stats.
let statsQueue: Promise<unknown> = Promise.resolve()

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const pick = <T,>(list: readonly T[]): T => list[randInt(0, list.length - 1)] as T
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0)

function shuffle<T>(list: readonly T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

function withOptions(base: Omit<Exercise, 'options' | 'answer'>, correct: string, wrong: string[]): Exercise {
  const options = shuffle([correct, ...wrong.slice(0, 3)])
  return { ...base, options, answer: options.indexOf(correct) }
}

type Generator = () => [question: string, answer: number]

function calcGenerators(lvl: number): Generator[] {
  const add = (lo: number, hi: number, lo2: number, hi2: number): Generator => () => {
    const a = randInt(lo, hi), b = randInt(lo2, hi2)
    return [`${a} + ${b} =`, a + b]
  }
  const sub = (lo: number, hi: number, lo2: number, hi2: number): Generator => () => {
    const a = randInt(lo, hi), b = randInt(lo2, Math.min(hi2, a))
    return [`${a} − ${b} =`, a - b]
  }
  const mul = (lo: number, hi: number, lo2: number, hi2: number): Generator => () => {
    const a = randInt(lo, hi), b = randInt(lo2, hi2)
    return [`${a} × ${b} =`, a * b]
  }
  const div = (lo: number, hi: number, lo2: number, hi2: number): Generator => () => {
    const b = randInt(lo, hi), q = randInt(lo2, hi2)
    return [`${b * q} ÷ ${b} =`, q]
  }
  const pct: Generator = () => {
    const p = pick([10, 20, 25, 50, 75]), n = pick([40, 60, 80, 120, 160, 200, 240, 360, 480])
    return [`${p}% de ${n} =`, (p * n) / 100]
  }
  const square: Generator = () => {
    const a = randInt(11, 25)
    return [`${a}² =`, a * a]
  }
  const series: Generator = () => {
    const start = randInt(1, 9)
    const kind = pick(lvl >= 4 ? ['arithmetic', 'geometric', 'fibonacci'] : ['arithmetic', 'geometric'])
    let seq: number[]
    if (kind === 'arithmetic') {
      const d = randInt(2, lvl >= 4 ? 13 : 7)
      seq = [0, 1, 2, 3, 4].map(i => start + d * i)
    } else if (kind === 'geometric') {
      const r = randInt(2, 3)
      seq = [0, 1, 2, 3, 4].map(i => start * r ** i)
    } else {
      seq = [start, start + randInt(1, 4)]
      while (seq.length < 5) seq.push((seq[seq.length - 1] ?? 0) + (seq[seq.length - 2] ?? 0))
    }
    return [`${seq.slice(0, 4).join(', ')}, ?`, seq[4] ?? 0]
  }

  switch (lvl) {
    case 1: return [add(10, 49, 2, 9), sub(20, 59, 2, 9), mul(2, 5, 2, 9)]
    case 2: return [add(15, 89, 11, 49), sub(40, 99, 11, 39), mul(3, 9, 3, 9), series]
    case 3: return [add(45, 199, 25, 99), sub(80, 199, 25, 79), mul(12, 29, 3, 9), div(3, 9, 6, 15), series]
    case 4: return [mul(12, 19, 11, 19), div(6, 15, 11, 25), pct, square, series, sub(200, 999, 120, 480)]
    default: return [mul(13, 49, 12, 29), add(250, 999, 250, 999), sub(500, 999, 180, 499), square, pct, series]
  }
}

function makeCalc(lvl: number): Exercise {
  const [question, answer] = pick(calcGenerators(lvl))()
  // Distractors mimic carry and place-value slips.
  const wrong = [
    ...new Set(shuffle([1, -1, 2, -2, 10, -10, 100, -100]).map(d => answer + d).filter(n => n >= 0)),
  ]
  return withOptions({ kind: 'calc', question }, String(answer), wrong.map(String))
}

// Okabe-Ito colors: distinguishable under every common color vision deficiency,
// and they also differ in lightness.
const INKS = [
  { name: 'AZUL', hex: '#0072B2' },
  { name: 'AMARILLO', hex: '#F0E442' },
  { name: 'NARANJA', hex: '#E69F00' },
  { name: 'ROSA', hex: '#CC79A7' },
] as const

function makeStroop(): Exercise {
  const [ink, decoy] = shuffle(INKS) as [(typeof INKS)[number], (typeof INKS)[number]]
  const word = Math.random() < STROOP_MISMATCH_RATE ? decoy.name : ink.name
  return withOptions(
    { kind: 'stroop', question: '¿De qué COLOR está pintada?', word, ink: ink.hex },
    ink.name,
    INKS.filter(c => c !== ink).map(c => c.name),
  )
}

type Stats = {
  ok: number
  total: number
  streak: number
  bestStreak: number
  calc: number
  stroop: number
  quiz: number
  turns: number
  dayStreak: number
  bestDayStreak: number
  /** Local day number of the last answer; 0 means never. */
  lastDay: number
  todayOk: number
  todayTotal: number
  /** Best accuracy of a day with at least RECORD_MIN_ANSWERS answers; -1 means none yet. */
  bestDayPct: number
  bestDayOk: number
  bestDayTotal: number
}

const EMPTY_STATS: Stats = {
  ok: 0, total: 0, streak: 0, bestStreak: 0, calc: 0, stroop: 0, quiz: 0, turns: 0,
  dayStreak: 0, bestDayStreak: 0, lastDay: 0,
  todayOk: 0, todayTotal: 0, bestDayPct: -1, bestDayOk: 0, bestDayTotal: 0,
}

type Tier = { n: number; name: string; icon: string; cheer: string }

const TIERS: Tier[] = [
  { n: 5, name: 'Madera', icon: '🪵', cheer: '¡Buen comienzo!' },
  { n: 10, name: 'Bronce', icon: '🥉', cheer: '¡Muy bien, fiera!' },
  { n: 50, name: 'Plata', icon: '🥈', cheer: '¡Qué máquina!' },
  { n: 100, name: 'Oro', icon: '🥇', cheer: '¡Brutal, fiera!' },
  { n: 200, name: 'Platino', icon: '💠', cheer: '¡Estás on fire!' },
  { n: 500, name: 'Diamante', icon: '💎', cheer: '¡Bestia parda!' },
  { n: 1000, name: 'Leyenda', icon: '👑', cheer: '¡LEYENDA ABSOLUTA!' },
]

const DAY_TIERS: Tier[] = [
  { n: 1, name: 'Semilla', icon: '🌱', cheer: '¡Primer día, fiera!' },
  { n: 2, name: 'Brote', icon: '🌿', cheer: '¡Has vuelto!' },
  { n: 3, name: 'Fuego', icon: '🔥', cheer: '¡Tres días seguidos!' },
  { n: 4, name: 'Rayo', icon: '⚡', cheer: '¡Esto ya es hábito!' },
  { n: 5, name: 'Estrella', icon: '⭐', cheer: '¡Semana laboral completa!' },
  { n: 10, name: 'Bronce', icon: '🥉', cheer: '¡Diez días, fiera!' },
  { n: 30, name: 'Plata', icon: '🥈', cheer: '¡Un mes entero!' },
  { n: 60, name: 'Oro', icon: '🥇', cheer: '¡Dos meses sin fallar!' },
  { n: 90, name: 'Platino', icon: '💠', cheer: '¡Un trimestre, bestia!' },
  { n: 180, name: 'Diamante', icon: '💎', cheer: '¡Medio año, increíble!' },
  { n: 365, name: 'Leyenda', icon: '👑', cheer: '¡UN AÑO ENTERO, LEYENDA!' },
]

type Category = { key: keyof Stats; label: string; unit: string; tiers: Tier[] }

const CATEGORIES: Category[] = [
  { key: 'bestDayStreak', label: 'Racha diaria', unit: 'días seguidos', tiers: DAY_TIERS },
  { key: 'bestStreak', label: 'En racha', unit: 'aciertos seguidos', tiers: TIERS },
  { key: 'ok', label: 'Cerebro activo', unit: 'aciertos en total', tiers: TIERS },
  { key: 'calc', label: 'Calculadora humana', unit: 'cuentas acertadas', tiers: TIERS },
  { key: 'stroop', label: 'Ojo de halcón', unit: 'Stroop acertados', tiers: TIERS },
  { key: 'quiz', label: 'Aprendiz de Claude', unit: 'preguntas de la tarea acertadas', tiers: TIERS },
  { key: 'turns', label: 'Esperas productivas', unit: 'esperas entrenando', tiers: TIERS },
]

const TOTAL_ACHIEVEMENTS = CATEGORIES.reduce((sum, cat) => sum + cat.tiers.length, 0)

/** Index of the highest tier reached, or -1. */
function tierIndex(value: number, tiers: Tier[]) {
  let index = -1
  for (let i = 0; i < tiers.length && value >= (tiers[i] as Tier).n; i++) index = i
  return index
}

function dayNumber(ms: number) {
  return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / DAY_MS)
}

async function today($: EngineInterface) {
  return dayNumber(await $.clock.now())
}

function rollDay(stats: Stats, day: number): Stats {
  if (stats.lastDay === day) return stats
  const dayStreak = stats.lastDay === day - 1 ? stats.dayStreak + 1 : 1
  return {
    ...stats,
    lastDay: day,
    dayStreak,
    bestDayStreak: Math.max(stats.bestDayStreak, dayStreak),
    todayOk: 0,
    todayTotal: 0,
  }
}

function recordAnswer(prev: Stats, kind: ExerciseKind, isRight: boolean, day: number): Stats {
  const base = rollDay(prev, day)
  const hit = isRight ? 1 : 0
  const streak = isRight ? base.streak + 1 : 0
  const next: Stats = {
    ...base,
    ok: base.ok + hit,
    total: base.total + 1,
    streak,
    bestStreak: Math.max(base.bestStreak, streak),
    [kind]: base[kind] + hit,
    todayOk: base.todayOk + hit,
    todayTotal: base.todayTotal + 1,
  }
  if (next.todayTotal >= RECORD_MIN_ANSWERS) {
    const pct = percent(next.todayOk, next.todayTotal)
    if (pct > next.bestDayPct || (pct === next.bestDayPct && next.todayTotal > next.bestDayTotal)) {
      next.bestDayPct = pct
      next.bestDayOk = next.todayOk
      next.bestDayTotal = next.todayTotal
    }
  }
  return next
}

/** Figures shown both in the status line and in /mente logros. */
function todayView(stats: Stats, day: number) {
  const isToday = stats.lastDay === day
  const ok = isToday ? stats.todayOk : 0
  const total = isToday ? stats.todayTotal : 0
  const pct = percent(ok, total)
  const avg = percent(stats.ok, stats.total)
  return {
    ok,
    total,
    pct,
    avg,
    trend: pct > avg ? '↑' : pct < avg ? '↓' : '=',
    // A streak survives until the end of the day after the last answer.
    dayStreak: stats.lastDay >= day - 1 ? stats.dayStreak : 0,
  }
}

async function loadStats($: EngineInterface): Promise<Stats> {
  const stored = (await $.store.get('stats')) ?? (await $.store.get('totals'))
  return { ...EMPTY_STATS, ...((stored as Partial<Stats> | undefined) ?? {}) }
}

/** Saves stats and queues newly reached tiers for /mente logros. */
async function saveStats($: EngineInterface, stats: Stats) {
  await $.store.set('stats', stats)
  const reached = ((await $.store.get('achievements')) as Record<string, number> | undefined) ?? {}
  const fresh: string[] = []
  for (const cat of CATEGORIES) {
    const index = tierIndex(stats[cat.key], cat.tiers)
    const tier = cat.tiers[index]
    if (tier && index > (reached[cat.key] ?? -1)) {
      reached[cat.key] = index
      fresh.push(`${tier.icon} ${tier.cheer} Logro ${tier.name.toUpperCase()} · ${cat.label} · ${tier.n} ${cat.unit}`)
    }
  }
  if (fresh.length === 0) return
  await $.store.set('achievements', reached)
  const unseen = ((await $.store.get('unseen')) as string[] | undefined) ?? []
  await $.store.set('unseen', [...unseen, ...fresh].slice(-MAX_UNSEEN))
}

/** Applies `change` to the stored stats, one change at a time, and returns the result. */
function mutateStats($: EngineInterface, change: (stats: Stats) => Stats): Promise<Stats> {
  const run = statsQueue.then(async () => {
    const next = change(await loadStats($))
    await saveStats($, next)
    return next
  })
  statsQueue = run.catch(() => undefined)
  return run
}

/** Closest unreached tier, by remaining fraction. Daily streak is skipped: answering more today does not advance it. */
function nextGoal(stats: Stats): string | null {
  let best: { ratio: number; text: string } | null = null
  for (const cat of CATEGORIES) {
    if (cat.key === 'bestDayStreak') continue
    const tier = cat.tiers[tierIndex(stats[cat.key], cat.tiers) + 1]
    if (!tier) continue
    const left = tier.n - stats[cat.key]
    const ratio = left / tier.n
    if (!best || ratio < best.ratio) best = { ratio, text: `${tier.icon} ${tier.name} en ${cat.label}: faltan ${left}` }
  }
  return best?.text ?? null
}

const QUIZ_SYSTEM = `You are a programming tutor. Given what a user asked a coding assistant and what the assistant is doing, write 2 multiple-choice questions IN SPANISH that teach something useful about the concepts, tools, commands or decisions of THAT task. Do not ask about trivial wording or file names.
Each question: at most 90 characters; exactly 4 options of at most 40 characters, one correct and plausible distractors; "why": the explanation in at most 90 characters.
Reply with valid JSON only, no markdown: [{"q":"...","options":["...","...","...","..."],"answer":0,"why":"..."}]`

function parseQuiz(text: string): Exercise[] {
  const start = text.indexOf('['), end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Exercise[] = []
  for (const item of raw as Array<Record<string, unknown> | null>) {
    const { q, options, answer, why } = item ?? {}
    if (typeof q !== 'string' || typeof answer !== 'number' || !Array.isArray(options) || options.length !== 4) continue
    if (!options.every(o => typeof o === 'string') || new Set(options).size !== 4 || answer < 0 || answer > 3) continue
    const correct = options[answer] as string
    out.push(
      withOptions(
        { kind: 'quiz', question: q, why: typeof why === 'string' ? why : undefined },
        correct,
        (options as string[]).filter((_, i) => i !== answer),
      ),
    )
  }
  return out
}

async function isOn($: EngineInterface, key: 'quiz' | 'stroop' | 'keys', fallback: boolean) {
  const value = await $.store.get(key)
  return typeof value === 'boolean' ? value : fallback
}

async function fetchQuiz($: EngineInterface) {
  const turn = currentTurn
  if (!turn || isFetchingQuiz || quizCalls >= MAX_QUIZ_CALLS_PER_TURN || !lastPrompt) return
  if (!(await isOn($, 'quiz', true))) return
  isFetchingQuiz = true
  quizCalls += 1
  try {
    const prompt =
      `User request:\n${lastPrompt.slice(0, PROMPT_CONTEXT_CHARS)}\n\n` +
      `Assistant's latest actions:\n${recentTools.slice(-TOOL_CONTEXT_ITEMS).join('\n') || '(none yet)'}`
    const result = await $.model.complete({
      model: 'haiku',
      system: QUIZ_SYSTEM,
      prompt,
      maxTokens: 600,
      effort: 'low',
      timeoutMs: 20_000,
    })
    // Drop late answers that belong to a previous turn.
    if (result.isAnswered && currentTurn === turn) quizPool.push(...parseQuiz(result.text))
  } finally {
    isFetchingQuiz = false
  }
}

/** Rotation: calc, stroop, quiz (stroop when no quiz is ready), ... */
async function nextExercise($: EngineInterface): Promise<Exercise> {
  served += 1
  const slot = served % 3
  if (slot === 0 && quizPool.length > 0) {
    const quiz = quizPool.shift() as Exercise
    if (quizPool.length === 0) void fetchQuiz($)
    return quiz
  }
  if (slot !== 1 && (await isOn($, 'stroop', true))) return makeStroop()
  return makeCalc(await read($, level))
}

function describeToolCall(tool: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const fields = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
      const value = fields[key]
      if (typeof value === 'string') return `${tool}: ${value.slice(0, TOOL_CONTEXT_CHARS)}`
    }
  }
  return tool
}

// The summary goes to a file the user's own status line reads, because the
// plugin status line is always prefixed with the plugin name.
async function writeStatus($: EngineInterface, text: string) {
  if (statusPath === null) {
    const home = await $.env.get('HOME')
    if (!home) return
    statusPath = `${home}/.claude/mente/status.txt`
  }
  try {
    await $.fs.write(statusPath, text)
  } catch {
    // Not writable: the summary is simply not shown.
  }
}

async function refreshStatus($: EngineInterface, stats?: Stats, day?: number) {
  if ((await read($, enabled)) !== true) return writeStatus($, '')
  const s = stats ?? (await loadStats($))
  const view = todayView(s, day ?? (await today($)))
  const parts = [
    view.total
      ? `🧠 hoy ${view.ok}/${view.total} (${view.pct}%) ${view.trend} media ${view.avg}%`
      : `🧠 hoy aún nada · media ${view.avg}%`,
  ]
  if (s.bestDayPct >= 0) parts.push(`récord ${s.bestDayPct}%`)
  if (view.dayStreak > 0) parts.push(`📅 ${view.dayStreak} día${view.dayStreak === 1 ? '' : 's'}`)
  await writeStatus($, parts.join(' · '))
}

/** Level adapts on calc answers only: LEVEL_UP_RUN right in a row go up, a miss goes down. */
function adaptLevel(lvl: number, isRight: boolean) {
  if (!isRight) {
    calcRun = 0
    return Math.max(1, lvl - 1)
  }
  calcRun += 1
  if (calcRun < LEVEL_UP_RUN) return lvl
  calcRun = 0
  return Math.min(MAX_LEVEL, lvl + 1)
}

function feedbackLine(ex: Exercise, isRight: boolean, streak: number, oldLvl: number, newLvl: number) {
  const mark = isRight ? '✓' : '✗'
  const correct = ex.options[ex.answer] ?? ''
  const streakText = isRight && streak >= 2 ? ` · racha ${streak}${streak >= 5 ? ' 🔥' : ''}` : ''
  const levelText = newLvl > oldLvl ? ` ↑ nivel ${newLvl}` : newLvl < oldLvl ? ` ↓ nivel ${newLvl}` : ''
  switch (ex.kind) {
    case 'calc':
      return `${mark} ${ex.question.replace(/ =$/, '').replace(/, \?$/, ', …')} → ${correct}${streakText}${levelText}`
    case 'stroop':
      return `${mark} Tinta ${correct} (ponía ${ex.word})${streakText}`
    case 'quiz':
      return `${mark} ${correct}${ex.why ? ` — ${ex.why}` : ''}${streakText}`
  }
}

async function answer($: EngineInterface, index: number): Promise<string | null> {
  if (isAnswering) return null
  isAnswering = true
  try {
    return await answerExercise($, index)
  } finally {
    isAnswering = false
  }
}

async function answerExercise($: EngineInterface, index: number): Promise<string | null> {
  const ex = await read($, exercise)
  if (!ex) return null
  const isRight = index === ex.answer

  const oldLvl = await read($, level)
  const newLvl = ex.kind === 'calc' ? adaptLevel(oldLvl, isRight) : oldLvl
  if (newLvl !== oldLvl) {
    await update($, level, () => newLvl)
    await $.store.set('level', newLvl)
  }
  await update($, turnScore, s => ({ ok: s.ok + (isRight ? 1 : 0), total: s.total + 1 }))

  const day = await today($)
  const stats = await mutateStats($, prev => recordAnswer(prev, ex.kind, isRight, day))
  await refreshStatus($, stats, day)

  const line = feedbackLine(ex, isRight, stats.streak, oldLvl, newLvl)
  await update($, feedback, () => line)
  const next = (await read($, busy)) ? await nextExercise($) : null
  await update($, exercise, () => next)
  return line
}

async function openPane($: EngineInterface) {
  if (!(await isOn($, 'keys', false)) || (await read($, paneUp))) return
  if (currentTurn === null || escapedTurn === currentTurn) return
  const opened = await $.ui.open({ id: PANE, title: '🧠 mente', focus: true, closeOnEscape: true, rows: 6 })
  if (opened.isPlaced) await update($, paneUp, () => true)
  // No room: do not leave it queued; the band above the prompt is the fallback.
  else await $.ui.close({ id: PANE })
}

async function closePane($: EngineInterface) {
  if (await read($, paneUp)) await $.ui.close({ id: PANE })
  await update($, paneUp, () => false)
}

async function showExercise($: EngineInterface) {
  if ((await read($, exercise)) === null) {
    const next = await nextExercise($)
    await update($, exercise, () => next)
  }
  await openPane($)
}

async function finishTurn($: EngineInterface) {
  await update($, busy, () => false)
  await update($, exercise, () => null)
  await update($, feedback, () => null)
  await closePane($)
  const score = await read($, turnScore)
  await update($, turnScore, () => ({ ok: 0, total: 0 }))
  if (score.total > 0) await mutateStats($, stats => ({ ...stats, turns: stats.turns + 1 }))
}

async function setEnabled($: EngineInterface, value: boolean) {
  await update($, enabled, () => value)
  await $.store.set('enabled', value)
  await refreshStatus($)
  if (!value) {
    await update($, exercise, () => null)
    await update($, feedback, () => null)
    await closePane($)
    $.ui.toast('🧠 mente apagado · /mente para volver a encenderlo')
  } else if (await read($, busy)) {
    await showExercise($)
  }
}

async function toggleSetting($: EngineInterface, key: 'quiz' | 'stroop' | 'keys', arg: string | undefined, fallback: boolean) {
  const value = arg === 'on' ? true : arg === 'off' ? false : !(await isOn($, key, fallback))
  await $.store.set(key, value)
  return value
}

async function achievementsText($: EngineInterface) {
  const stats = await loadStats($)
  const view = todayView(stats, await today($))
  const unseen = ((await $.store.get('unseen')) as string[] | undefined) ?? []
  if (unseen.length > 0) await $.store.set('unseen', [])

  const unlocked = CATEGORIES.reduce((sum, cat) => sum + tierIndex(stats[cat.key], cat.tiers) + 1, 0)
  const goal = nextGoal(stats)
  const record =
    stats.bestDayPct >= 0
      ? `récord ${stats.bestDayPct}% (${stats.bestDayOk}/${stats.bestDayTotal})`
      : `récord: haz ${RECORD_MIN_ANSWERS} en un día`
  const todayLine = view.total
    ? `📆 Hoy: ${view.ok}/${view.total} (${view.pct}%) ${view.trend} tu media ${view.avg}% · ${record}`
    : `📆 Hoy: aún nada · tu media ${view.avg}% · ${record}`
  const rows = CATEGORIES.map(cat => {
    const value = stats[cat.key]
    const index = tierIndex(value, cat.tiers)
    const shelf = cat.tiers.map((tier, i) => (i <= index ? tier.icon : '·')).join(' ')
    const next = cat.tiers[index + 1]
    return `${shelf}  ${cat.label} — ${next ? `${value}/${next.n} → ${next.name}` : 'COMPLETO 👑'}`
  })

  return [
    ...(unseen.length > 0 ? ['✨ NUEVO', ...unseen.map(line => `  ${line}`), ''] : []),
    `🧠 ${stats.ok}/${stats.total} aciertos (${view.avg}%) · racha actual ${stats.streak} · mejor ${stats.bestStreak} · nivel ${await read($, level)}`,
    '',
    `📅 Racha diaria: ${view.dayStreak} día${view.dayStreak === 1 ? '' : 's'} (mejor ${stats.bestDayStreak})`,
    todayLine,
    `🏆 Logros: ${unlocked}/${TOTAL_ACHIEVEMENTS}${goal ? ` · lo más cercano: ${goal}` : ''}`,
    ...rows,
  ].join('\n')
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

async function drawExercise($: EngineInterface, { Box, Button, Text }: Elements, inPane: boolean) {
  const ex = await read($, exercise)
  const line = await read($, feedback)
  const score = await read($, turnScore)
  const lvl = await read($, level)

  const buttons = (ex?.options ?? []).map((option, i) => (
    <Button
      key={`o${i}`}
      hotkey={String(i + 1)}
      autoFocus={i === 0 ? true : undefined}
      label={option}
      onPress={() => void answer($, i)}
    />
  ))
  const help = inPane ? '←→ elegir · Enter o 1-4 responder · Esc escribir a Claude · x apagar' : 'pulsa 1-4'

  return (
    <Box flexDirection="column">
      {line && <Text color={line.startsWith('✓') ? 'success' : 'error'}>{line}</Text>}
      {!ex ? (
        <Text dimColor>🧠 …</Text>
      ) : ex.kind === 'quiz' ? (
        <Box flexDirection="column">
          <Text weight="bold">💡 {ex.question}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {buttons}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {ex.kind === 'calc' ? (
            <Text weight="bold">🧠 {ex.question}</Text>
          ) : (
            <>
              <Text>🎨 {ex.question}</Text>
              <Text weight="bold" color={ex.ink}>
                {ex.word}
              </Text>
            </>
          )}
          {buttons}
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>
          niv {lvl} · {score.ok}/{score.total} · {help}
        </Text>
        {inPane && <Button key="off" hotkey="x" label="apagar" onPress={() => void setEnabled($, false)} />}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mente',
      description:
        'Gimnasio mental: /mente (encender/apagar), /mente logros, /mente nivel 1-5, /mente tarea on|off, /mente stroop on|off, /mente teclado on|off',
    })
    const stored = await $.store.get('enabled')
    await update($, enabled, () => (typeof stored === 'boolean' ? stored : null))
    const lvl = Number((await $.store.get('level')) ?? 1)
    await update($, level, () => Math.min(MAX_LEVEL, Math.max(1, lvl || 1)))
    await update($, paneUp, () => false)
    // Older versions pinned a plugin status line; clear it.
    $.ui.status(undefined)
    await refreshStatus($)
    return next(e)
  })

  // A bare 1-4 while an exercise is shown is an answer and never reaches the model.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (!e.command && /^[1-4]$/.test(text)) {
      const n = Number(text)
      const state = await read($, enabled)
      if (state === null && n <= 2) {
        await setEnabled($, n === 1)
        return {
          drop:
            n === 1
              ? '🧠 mente encendido. Mientras Claude trabaje saldrá un ejercicio encima del prompt: responde pulsando 1-4.'
              : '🧠 Vale. /mente para encenderlo cuando quieras.',
        }
      }
      if (state && (await read($, exercise))) return { drop: (await answer($, n - 1)) ?? '🧠' }
    }
    if (!e.command && text) {
      lastPrompt = text
      recentTools = []
      quizPool = []
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!e.agentId) {
      recentTools.push(describeToolCall(e.tool, (e as { input?: unknown }).input))
      if (recentTools.length > TOOL_CONTEXT_ITEMS) recentTools.shift()
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    const turn = e.turnId
    currentTurn = turn
    quizCalls = 0
    served = 0
    await update($, busy, () => true)
    await update($, turnScore, () => ({ ok: 0, total: 0 }))
    await update($, feedback, () => null)
    $.clock.after(FIRST_EXERCISE_DELAY_MS, async () => {
      if (currentTurn !== turn || !(await read($, enabled))) return
      $.clock.after(QUIZ_FETCH_DELAY_MS, () => {
        if (currentTurn === turn) void fetchQuiz($)
      })
      await showExercise($)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      currentTurn = null
      await finishTurn($)
    }
    return next(e)
  })

  // Escape keeps the pane closed until the next turn.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      if (e.origin.kind === 'person') escapedTurn = currentTurn
      await update($, paneUp, () => false)
    }
    return next(e)
  })

  on('command.run', { command: 'mente' }, async ($, e) => {
    const [cmd, arg] = e.args.trim().toLowerCase().split(/\s+/)
    switch (cmd) {
      case 'logros':
      case 'stats':
        return { text: await achievementsText($) }
      case 'nivel': {
        const n = Number(arg)
        if (!Number.isInteger(n) || n < 1 || n > MAX_LEVEL) return { text: 'Uso: /mente nivel 1-5' }
        await update($, level, () => n)
        await $.store.set('level', n)
        calcRun = 0
        return { text: `🧠 Nivel fijado en ${n} (se sigue adaptando según aciertes).` }
      }
      case 'tarea': {
        const value = await toggleSetting($, 'quiz', arg, true)
        if (!value) quizPool = []
        return {
          text: value
            ? '🧠 Preguntas sobre la tarea ACTIVADAS (las genera Haiku: cuesta unos pocos tokens por turno).'
            : '🧠 Preguntas sobre la tarea desactivadas.',
        }
      }
      case 'stroop': {
        const value = await toggleSetting($, 'stroop', arg, true)
        return { text: value ? '🧠 Stroop ACTIVADO.' : '🧠 Stroop desactivado: en su lugar salen cuentas.' }
      }
      case 'teclado': {
        const value = await toggleSetting($, 'keys', arg, false)
        if (!value) await closePane($)
        return {
          text: value
            ? '🧠 Modo teclado ACTIVADO: el ejercicio coge el teclado al salir (flechas + Enter, Esc para escribir a Claude).'
            : '🧠 Modo teclado desactivado: el ejercicio sale en la franja y respondes pulsando 1-4.',
        }
      }
      default: {
        const value = cmd === 'on' ? true : cmd === 'off' ? false : !(await read($, enabled))
        await setEnabled($, value)
        return {
          text: value
            ? '🧠 mente ENCENDIDO. Mientras Claude trabaje saldrá un ejercicio encima del prompt: responde pulsando 1-4.'
            : '🧠 mente apagado. /mente para volver a encenderlo.',
        }
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawExercise($, $.ui.resolve(e), true))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const state = await read($, enabled)
    const els = $.ui.resolve(e)

    if (state === null) {
      const { Box, Button, Text } = els
      return (
        <Box flexDirection="row" gap={1}>
          <Text>🧠 ¿Activar ejercicios mentales mientras Claude trabaja?</Text>
          <Button key="yes" hotkey="1" autoFocus label="Activar" onPress={() => void setEnabled($, true)} />
          <Button key="no" hotkey="2" label="No, gracias" onPress={() => void setEnabled($, false)} />
        </Box>
      )
    }

    const isVisible = state && (await read($, busy)) && (await read($, exercise)) !== null && !(await read($, paneUp))
    return isVisible ? drawExercise($, els, false) : next(e)
  })
}
