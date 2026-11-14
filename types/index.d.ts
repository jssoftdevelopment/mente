export type ExerciseKind = 'calc' | 'stroop' | 'quiz'

export type Exercise = {
  kind: ExerciseKind
  question: string
  options: string[]
  /** Index of the correct option. */
  answer: number
  why?: string
  /** Stroop only: the written word and the ink color it is drawn in. */
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
      turnScore: Score
      paneUp: boolean
    }
  }
}
