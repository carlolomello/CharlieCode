import { describe, expect, it } from 'vitest'
import {
  SELF_BUILD_MARGIN_MS,
  decideUpdate,
  isNewerVersion,
  parseRelease,
  pickAsset,
  type ReleaseInfo
} from './update-check'

const release: ReleaseInfo = {
  tag: 'v0.0.1',
  version: '0.0.1',
  url: 'https://github.com/carlolomello/CharlieCode/releases/tag/v0.0.1',
  publishedAt: '2026-11-21T23:40:00Z',
  assets: [
    {
      id: 1,
      name: 'CharlieCode-0.0.1-arm64.dmg',
      url: 'https://example.com/arm64.dmg',
      updatedAt: '2026-11-21T23:57:55Z',
      size: 123850952
    },
    {
      id: 2,
      name: 'CharlieCode-0.0.1.dmg',
      url: 'https://example.com/intel.dmg',
      updatedAt: '2026-11-21T23:57:54Z',
      size: 130742000
    },
    {
      id: 3,
      name: 'CharlieCode-Setup-0.0.1.exe',
      url: 'https://example.com/setup.exe',
      updatedAt: '2026-11-21T23:57:54Z',
      size: 124201072
    }
  ]
}

describe('parseRelease', () => {
  it('legge tag, url e asset del payload GitHub', () => {
    const parsed = parseRelease({
      tag_name: 'v0.0.1',
      html_url: 'https://github.com/x/y/releases/tag/v0.0.1',
      published_at: '2026-11-21T23:40:00Z',
      assets: [
        {
          id: 9,
          name: 'CharlieCode-0.0.1-arm64.dmg',
          browser_download_url: 'https://example.com/a.dmg',
          updated_at: '2026-11-21T23:57:55Z',
          size: 10
        },
        { id: 10, name: 'senza-url' }
      ]
    })

    expect(parsed?.version).toBe('0.0.1')
    expect(parsed?.assets).toHaveLength(1)
    expect(parsed?.assets[0]).toMatchObject({ id: 9, url: 'https://example.com/a.dmg' })
  })

  it('senza tag non è una release', () => {
    expect(parseRelease({ assets: [] })).toBeUndefined()
    expect(parseRelease('nope')).toBeUndefined()
  })
})

describe('pickAsset', () => {
  it('sceglie il dmg giusto per l’architettura', () => {
    expect(pickAsset(release.assets, 'darwin', 'arm64')?.name).toBe(
      'CharlieCode-0.0.1-arm64.dmg'
    )
    expect(pickAsset(release.assets, 'darwin', 'x64')?.name).toBe('CharlieCode-0.0.1.dmg')
  })

  it('su Apple Silicon ripiega sull’Intel invece di non offrire nulla', () => {
    const intelOnly = release.assets.filter((asset) => !/arm64/i.test(asset.name))
    expect(pickAsset(intelOnly, 'darwin', 'arm64')?.name).toBe('CharlieCode-0.0.1.dmg')
  })

  it('su Windows prende l’installer, altrove niente', () => {
    expect(pickAsset(release.assets, 'win32', 'x64')?.name).toBe('CharlieCode-Setup-0.0.1.exe')
    expect(pickAsset(release.assets, 'linux', 'x64')).toBeUndefined()
  })
})

describe('isNewerVersion', () => {
  it('confronta i numeri, non le stringhe', () => {
    expect(isNewerVersion('0.0.10', '0.0.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.0.9')).toBe(true)
    expect(isNewerVersion('0.0.1', '0.0.1')).toBe(false)
    expect(isNewerVersion('0.0.1', '0.0.2')).toBe(false)
    expect(isNewerVersion('v0.0.2', '0.0.1')).toBe(true)
  })

  it('una versione illeggibile non è mai più nuova', () => {
    expect(isNewerVersion('build', '0.0.1')).toBe(false)
  })
})

describe('decideUpdate', () => {
  const built = '2026-11-21T23:30:00Z'

  it('offre la build quando l’asset è più recente di quella installata', () => {
    const candidate = decideUpdate({
      release,
      currentVersion: '0.0.1',
      buildTime: built,
      platform: 'darwin',
      arch: 'arm64'
    })

    expect(candidate?.asset.id).toBe(1)
    expect(candidate?.sameVersion).toBe(true)
  })

  it('non offre la build che sta già girando', () => {
    expect(
      decideUpdate({
        release,
        currentVersion: '0.0.1',
        buildTime: '2026-11-21T23:57:00Z',
        platform: 'darwin',
        arch: 'arm64'
      })
    ).toBeUndefined()
  })

  it('rispetta il margine tra build e pubblicazione', () => {
    const buildTime = new Date(Date.parse('2026-11-21T23:57:55Z') - SELF_BUILD_MARGIN_MS / 2)
    expect(
      decideUpdate({
        release,
        currentVersion: '0.0.1',
        buildTime: buildTime.toISOString(),
        platform: 'darwin',
        arch: 'arm64'
      })
    ).toBeUndefined()
  })

  it('una versione più alta vince anche con lo stesso orologio', () => {
    const candidate = decideUpdate({
      release: { ...release, tag: 'v0.0.2', version: '0.0.2' },
      currentVersion: '0.0.1',
      buildTime: '2026-11-21T23:57:00Z',
      platform: 'win32',
      arch: 'x64'
    })

    expect(candidate?.sameVersion).toBe(false)
    expect(candidate?.asset.name).toBe('CharlieCode-Setup-0.0.1.exe')
  })

  it('non ripropone un asset già rimandato', () => {
    expect(
      decideUpdate({
        release,
        currentVersion: '0.0.1',
        buildTime: built,
        platform: 'darwin',
        arch: 'arm64',
        dismissedAssetId: 1
      })
    ).toBeUndefined()
  })

  it('una release più vecchia dell’app non è un aggiornamento', () => {
    expect(
      decideUpdate({
        release: { ...release, tag: 'v0.0.0', version: '0.0.0' },
        currentVersion: '0.0.1',
        buildTime: built,
        platform: 'darwin',
        arch: 'arm64'
      })
    ).toBeUndefined()
  })

  it('senza installer per questa piattaforma non c’è nulla da offrire', () => {
    expect(
      decideUpdate({
        release,
        currentVersion: '0.0.1',
        buildTime: built,
        platform: 'linux',
        arch: 'x64'
      })
    ).toBeUndefined()
  })
})
