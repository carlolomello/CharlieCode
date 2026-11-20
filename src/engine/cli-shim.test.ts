import { describe, expect, it } from 'vitest'
import { isShimPath, shimScriptCandidates } from './cli-shim'

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*',
  ''
].join('\r\n')

const PNPM_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\..\\node_modules\\.bin\\tool" %*',
  ') ELSE (',
  '  node  "%~dp0\\..\\..\\node_modules\\.bin\\tool" %*',
  ')'
].join('\r\n')

describe('shimScriptCandidates', () => {
  it('legge il percorso JS di uno shim npm e salta node.exe', () => {
    expect(shimScriptCandidates(NPM_SHIM, 'C:\\Users\\me\\AppData\\Roaming\\npm')).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode'
    ])
  })

  it('legge anche lo shim scritto da pnpm, senza duplicati', () => {
    // Il percorso viene normalizzato: `..` non resta nel comando da eseguire.
    expect(shimScriptCandidates(PNPM_SHIM, 'C:\\work\\node_modules\\.bin')).toEqual([
      'C:\\work\\node_modules\\.bin\\tool'
    ])
  })

  it('non propone nulla per uno shim che non lancia JavaScript', () => {
    expect(shimScriptCandidates('@echo off\r\n"C:\\Tools\\agent.exe" %*', 'C:\\Tools')).toEqual([])
  })
})

describe('isShimPath', () => {
  it('riconosce solo cmd e bat', () => {
    expect(isShimPath('C:\\npm\\opencode.cmd')).toBe(true)
    expect(isShimPath('C:\\npm\\opencode.BAT')).toBe(true)
    expect(isShimPath('C:\\Tools\\opencode.exe')).toBe(false)
    expect(isShimPath('/usr/local/bin/opencode')).toBe(false)
  })
})
