import { describe, expect, it } from 'vitest'
import { createPlatform, detectEol, resolveShell, toPlatformEol } from './platform'

describe('createPlatform', () => {
  it('emula Windows: shell, separatori, EOL e path', () => {
    const platform = createPlatform({
      id: 'win32',
      env: { USERPROFILE: 'C:\\Users\\carlo' }
    })

    expect(platform.isWindows).toBe(true)
    expect(platform.shell.command).toBe('cmd.exe')
    expect(platform.eol).toBe('\r\n')
    expect(platform.pathSep).toBe('\\')
    expect(platform.configDir).toBe('C:\\Users\\carlo\\.charlie')
    expect(platform.configPath('config.json')).toBe('C:\\Users\\carlo\\.charlie\\config.json')
  })

  it('emula macOS: zsh, slash, LF', () => {
    const platform = createPlatform({ id: 'darwin', env: { HOME: '/Users/carlo' } })

    expect(platform.isWindows).toBe(false)
    expect(platform.shell.command).toBe('/bin/zsh')
    expect(platform.eol).toBe('\n')
    expect(platform.configDir).toBe('/Users/carlo/.charlie')
  })

  it('rispetta CHARLIE_CONFIG_DIR su entrambe le piattaforme', () => {
    expect(
      createPlatform({ id: 'darwin', env: { HOME: '/Users/carlo', CHARLIE_CONFIG_DIR: '/tmp/x' } })
        .configDir
    ).toBe('/tmp/x')

    expect(
      createPlatform({
        id: 'win32',
        env: { USERPROFILE: 'C:\\Users\\carlo', CHARLIE_CONFIG_DIR: 'D:\\temp\\x' }
      }).configDir
    ).toBe('D:\\temp\\x')
  })
})

describe('resolveShell', () => {
  it('usa cmd.exe /d /s /c su Windows', () => {
    expect(resolveShell('win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c'],
      label: 'cmd.exe'
    })
  })

  it('usa una login shell su macOS e Linux', () => {
    expect(resolveShell('darwin').args).toEqual(['-lc'])
    expect(resolveShell('linux').command).toBe('/bin/bash')
  })
})

describe('gestione EOL', () => {
  it('rileva CRLF solo quando è dominante', () => {
    expect(detectEol('a\r\nb\r\nc\r\nd')).toBe('\r\n')
    expect(detectEol('a\nb\nc\nd\r\n')).toBe('\n')
  })

  it('converte senza lasciare CR orfani', () => {
    const windows = createPlatform({ id: 'win32', env: { USERPROFILE: 'C:\\u' } })
    const mac = createPlatform({ id: 'darwin', env: { HOME: '/u' } })

    expect(toPlatformEol('a\nb', windows)).toBe('a\r\nb')
    expect(toPlatformEol('a\r\nb', mac)).toBe('a\nb')
    expect(toPlatformEol('a\r\nb', windows)).toBe('a\r\nb')
  })
})
