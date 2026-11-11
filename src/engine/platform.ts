import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Everything that differs between macOS and Windows goes through this module.
 * Tools will receive a `Platform` instance instead of reading `process.platform`
 * directly, so the Windows code paths stay testable from a Mac and on CI.
 */

export interface ShellSpec {
  command: string
  args: string[]
  label: string
}

export interface Platform {
  id: string
  isWindows: boolean
  homeDir: string
  /** Root of user configuration: `<home>/.charlie` unless CHARLIE_CONFIG_DIR is set. */
  configDir: string
  pathSep: string
  eol: '\n' | '\r\n'
  shell: ShellSpec
  configPath(...segments: string[]): string
}

export interface PlatformOptions {
  id?: string
  env?: NodeJS.ProcessEnv
}

export function resolveShell(id: string): ShellSpec {
  if (id === 'win32') {
    // `cmd.exe /d /s /c` is the most predictable shell for scripted execution:
    // no profile loading, no PowerShell execution-policy surprises.
    return { command: 'cmd.exe', args: ['/d', '/s', '/c'], label: 'cmd.exe' }
  }
  if (id === 'darwin') {
    return { command: '/bin/zsh', args: ['-lc'], label: 'zsh' }
  }
  return { command: '/bin/bash', args: ['-lc'], label: 'bash' }
}

export function createPlatform(options: PlatformOptions = {}): Platform {
  const id = options.id ?? process.platform
  const env = options.env ?? process.env
  const homeDir = env.HOME ?? env.USERPROFILE ?? homedir()
  const isWindows = id === 'win32'
  // Path handling follows the *emulated* platform, not the host: this is what
  // lets the Windows code paths be unit-tested from macOS and on CI.
  const paths = isWindows ? win32 : posix
  const configDir = env.CHARLIE_CONFIG_DIR ?? paths.join(homeDir, '.charlie')

  return {
    id,
    isWindows,
    homeDir,
    configDir,
    pathSep: isWindows ? '\\' : '/',
    eol: isWindows ? '\r\n' : '\n',
    shell: resolveShell(id),
    configPath: (...segments: string[]) => paths.join(configDir, ...segments)
  }
}

/** Converts any EOL style to the one native for this platform. */
export function toPlatformEol(text: string, platform: Platform): string {
  const normalized = text.replace(/\r\n/g, '\n')
  return platform.eol === '\n' ? normalized : normalized.replace(/\n/g, platform.eol)
}

/** Detects the dominant EOL of a file so we never rewrite line endings by accident. */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}
