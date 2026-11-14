export type Exercise = {
  kind: 'calc' | 'quiz' | 'stroop'
  question: string
  options: string[]
  /** índice de la opción correcta */
  answer: number
  why?: string
  /** stroop: la palabra escrita y el color (hex) con que se pinta */
  word?: string
  ink?: string
}
export type Score = { ok: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    mente: {
      enabled: boolean | null
      busy: boolean
      exercise: Exercise | null
      feedback: string | null
      level: number
      streak: number
      turnScore: Score
    }
  }
}
