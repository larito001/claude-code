export type KeybindingContextName =
  (typeof import('./schema.js').KEYBINDING_CONTEXTS)[number]

export type KeybindingAction =
  | (typeof import('./schema.js').KEYBINDING_ACTIONS)[number]
  | `command:${string}`

export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, KeybindingAction | null>
}

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type Chord = ParsedKeystroke[]

export type ParsedBinding = {
  chord: Chord
  action: KeybindingAction | null
  context: KeybindingContextName
}
