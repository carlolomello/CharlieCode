/**
 * Whether a GitHub release is worth offering.
 *
 * Pure on purpose: the network, the dialog and the installer live in
 * `updater.ts`, so the decision can be tested without a release or an app.
 *
 * Two questions are answered here:
 *  - which asset belongs to this machine (`pickAsset`);
 *  - whether it is newer than the build that is running (`decideUpdate`).
 *
 * The version is the first answer. The second one exists because this project
 * ships a rolling `v0.0.1`: the tag does not move, its assets are replaced, so
 * the upload time of the asset is what tells a new build from the one already
 * installed. The build time is stamped into the app at compile time, and a
 * margin keeps a freshly installed build from offering itself.
 */

export interface ReleaseAsset {
  id: number
  name: string
  /** Public download URL, not the API asset URL. */
  url: string
  /** Last upload of the asset: a rebuilt release keeps the same tag. */
  updatedAt: string
  size: number
  /** `sha256:<hex>` computed by GitHub at upload; absent on old uploads. */
  digest?: string
}

export interface ReleaseInfo {
  tag: string
  /** Tag without the leading `v`. */
  version: string
  url: string
  publishedAt: string
  /** Release notes in Markdown, as written on GitHub. */
  body?: string
  assets: ReleaseAsset[]
}

export interface UpdateCandidate {
  version: string
  asset: ReleaseAsset
  /** Upload of the asset, or the release date when it is missing. */
  releasedAt: string
  /** Same version, different build: the rolling-release case. */
  sameVersion: boolean
}

/**
 * How much newer than this build an asset must be before it is offered. The
 * installer is uploaded minutes after it is built, so a freshly installed app
 * would otherwise offer to update itself to the build it is already running.
 */
export const SELF_BUILD_MARGIN_MS = 15 * 60_000

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

export function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(value.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index++) {
    const a = next[index] ?? 0
    const b = now[index] ?? 0
    if (a !== b) return a > b
  }
  return false
}

function parseAsset(value: unknown): ReleaseAsset | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const url = typeof record.browser_download_url === 'string' ? record.browser_download_url : ''
  const id = typeof record.id === 'number' ? record.id : undefined
  if (!name || !url || id === undefined) return undefined
  const digest = typeof record.digest === 'string' ? record.digest.trim() : ''
  return {
    id,
    name,
    url,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
    size: typeof record.size === 'number' ? record.size : 0,
    ...(digest ? { digest } : {})
  }
}

/** The hex half of a `sha256:<hex>` digest, or undefined when it is not one. */
export function sha256FromDigest(digest: string | undefined): string | undefined {
  const match = /^sha256:([0-9a-f]{64})$/i.exec((digest ?? '').trim())
  return match?.[1]?.toLowerCase()
}

/**
 * A readable excerpt of the release notes, for the dialog that asks whether to
 * update.
 *
 * GitHub serves Markdown, and a native dialog shows plain text: the markup is
 * dropped instead of being displayed literally. Long notes are cut — the
 * dialog has to stay a question, not become a changelog.
 */
export function summarizeReleaseNotes(
  body: string | undefined,
  maxChars = 600
): string | undefined {
  if (!body) return undefined
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/[*_`>]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
  if (!text) return undefined
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text
}

/** Reads the GitHub release payload; anything malformed is "no release". */
export function parseRelease(payload: unknown): ReleaseInfo | undefined {
  const record = asRecord(payload)
  if (!record) return undefined
  const tag = typeof record.tag_name === 'string' ? record.tag_name.trim() : ''
  if (!tag) return undefined
  const assets = (Array.isArray(record.assets) ? record.assets : [])
    .map(parseAsset)
    .filter((asset): asset is ReleaseAsset => Boolean(asset))
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    url: typeof record.html_url === 'string' ? record.html_url : '',
    publishedAt: typeof record.published_at === 'string' ? record.published_at : '',
    ...(typeof record.body === 'string' && record.body.trim() ? { body: record.body } : {}),
    assets
  }
}

/**
 * The installer that belongs to this machine. An Apple Silicon Mac falls back
 * to the Intel dmg (Rosetta) rather than offering nothing.
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: string,
  arch: string
): ReleaseAsset | undefined {
  if (platform === 'darwin') {
    const arm = assets.find((asset) => /-arm64\.dmg$/i.test(asset.name))
    const intel = assets.find((asset) => /\.dmg$/i.test(asset.name) && !/arm64/i.test(asset.name))
    return arch === 'arm64' ? (arm ?? intel) : (intel ?? arm)
  }
  if (platform === 'win32') return assets.find((asset) => /\.exe$/i.test(asset.name))
  return undefined
}

export interface DecideInput {
  release: ReleaseInfo
  currentVersion: string
  /** Compile-time stamp of the running build. */
  buildTime: string
  platform: string
  arch: string
  /** An asset the user already said "later" to. */
  dismissedAssetId?: number
  /** An asset that was already installed: it is not an update any more. */
  installedAssetId?: number
  /** Verification only: ignore the build margin. */
  force?: boolean
  marginMs?: number
}

export function decideUpdate(input: DecideInput): UpdateCandidate | undefined {
  const asset = pickAsset(input.release.assets, input.platform, input.arch)
  if (!asset) return undefined
  if (input.dismissedAssetId === asset.id) return undefined
  if (input.installedAssetId === asset.id) return undefined

  const newer = isNewerVersion(input.release.version, input.currentVersion)
  const same = !newer && !isNewerVersion(input.currentVersion, input.release.version)
  // A release older than the app is not an update.
  if (!newer && !same) return undefined

  if (same && !input.force) {
    const uploaded = Date.parse(asset.updatedAt)
    const built = Date.parse(input.buildTime)
    if (!Number.isFinite(uploaded) || !Number.isFinite(built)) return undefined
    if (uploaded - built <= (input.marginMs ?? SELF_BUILD_MARGIN_MS)) return undefined
  }

  return {
    version: input.release.version,
    asset,
    releasedAt: input.release.publishedAt || asset.updatedAt,
    sameVersion: same
  }
}
