/**
 * The backend chosen last time.
 *
 * A restart used to open on the catalog default, so the model picked before
 * closing the app was gone and the picker looked like it had forgotten. The
 * choice is kept here, next to the other small preferences, and the CLI model
 * is kept per profile: switching between a native model and a CLI — or between
 * two CLIs — restores the model each one was last used with.
 *
 * Starred models live here too: a router exposes hundreds of entries, and the
 * few actually used should sit at the top of the picker instead of being hunted
 * through the list every time.
 */

const SELECTION_STORE = 'charliecode.selection'

export interface StoredSelection {
  /** `provider::model` or `cli:<profile>`; the key the picker showed. */
  modelKey?: string
  /** Model passed to each CLI profile, keyed by profile id. */
  cliModels?: Record<string, string>
  /** Starred models, in the order they were starred. */
  favorites?: string[]
}

/** Drops empty fields, so a stored selection stays a short, readable object. */
function compact(selection: StoredSelection): StoredSelection {
  const modelKey = selection.modelKey?.trim() ?? ''
  const cliModels = { ...(selection.cliModels ?? {}) }
  const favorites: string[] = []
  for (const key of selection.favorites ?? []) {
    const trimmed = key.trim()
    if (trimmed && !favorites.includes(trimmed)) favorites.push(trimmed)
  }
  return {
    ...(modelKey ? { modelKey } : {}),
    ...(Object.keys(cliModels).length ? { cliModels } : {}),
    ...(favorites.length ? { favorites } : {})
  }
}

/** Reads what was saved, dropping anything that is not the shape we wrote. */
export function parseSelection(raw: string | null): StoredSelection {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}

  const record = parsed as Record<string, unknown>
  const cliModels: Record<string, string> = {}
  if (record.cliModels && typeof record.cliModels === 'object') {
    for (const [id, model] of Object.entries(record.cliModels as Record<string, unknown>)) {
      if (typeof model === 'string' && model.trim()) cliModels[id] = model.trim()
    }
  }

  const favorites: string[] = []
  if (Array.isArray(record.favorites)) {
    for (const key of record.favorites) {
      if (typeof key !== 'string') continue
      const trimmed = key.trim()
      if (trimmed && !favorites.includes(trimmed)) favorites.push(trimmed)
    }
  }

  const modelKey = typeof record.modelKey === 'string' ? record.modelKey.trim() : ''
  return compact({
    ...(modelKey ? { modelKey } : {}),
    ...(Object.keys(cliModels).length ? { cliModels } : {}),
    ...(favorites.length ? { favorites } : {})
  })
}

/** A new selection with the backend the user ended up on. */
export function withModelKey(selection: StoredSelection, modelKey: string): StoredSelection {
  return compact({ ...selection, modelKey })
}

/** A new selection with the model chosen for one CLI profile. */
export function withCliModel(
  selection: StoredSelection,
  profileId: string,
  model: string
): StoredSelection {
  const cliModels = { ...(selection.cliModels ?? {}) }
  if (model.trim()) cliModels[profileId] = model.trim()
  else delete cliModels[profileId]
  return compact({ ...selection, cliModels })
}

/** Stars a model, or takes the star away when it already has one. */
export function withToggledFavorite(selection: StoredSelection, key: string): StoredSelection {
  const trimmed = key.trim()
  if (!trimmed) return compact(selection)
  const favorites = selection.favorites ?? []
  return compact({
    ...selection,
    favorites: favorites.includes(trimmed)
      ? favorites.filter((entry) => entry !== trimmed)
      : [...favorites, trimmed]
  })
}

export function readSelection(): StoredSelection {
  try {
    return parseSelection(window.localStorage.getItem(SELECTION_STORE))
  } catch {
    return {}
  }
}

export function writeSelection(selection: StoredSelection): void {
  try {
    window.localStorage.setItem(SELECTION_STORE, JSON.stringify(selection))
  } catch {
    // A store that refuses the write (private mode) costs a preference, not a turn.
  }
}
