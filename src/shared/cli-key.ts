/**
 * A model key that points at a CLI profile instead of a native provider.
 *
 * The rest of the app already stores one string per selection (`modelKey`), so
 * a CLI is encoded in the same field: `cli:<profile>` or
 * `cli:<profile>::<model>`. No Node imports here: the renderer, the preload
 * bridge and the engine all share this file.
 */

const PREFIX = 'cli:'

export function cliModelKey(profileId: string, model?: string): string {
  return model ? `${PREFIX}${profileId}::${model}` : `${PREFIX}${profileId}`
}

export function parseCliModelKey(
  key: string
): { profileId: string; model?: string } | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  const rest = key.slice(PREFIX.length)
  if (!rest) return undefined

  const separator = rest.indexOf('::')
  if (separator < 0) return { profileId: rest }

  const profileId = rest.slice(0, separator)
  const model = rest.slice(separator + 2)
  if (!profileId) return undefined
  return { profileId, ...(model ? { model } : {}) }
}

export function isCliModelKey(key: string): boolean {
  return parseCliModelKey(key) !== undefined
}
