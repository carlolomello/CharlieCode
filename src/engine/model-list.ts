const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * Turns a models listing into model names.
 *
 * CLIs print either one id per line, or a decorated table. Help text, usage
 * errors, headers and prose are dropped: a CLI asked for its models and not
 * knowing the flag answers with `Try --help for usage`, and that used to become
 * a picker entry. Bullets are stripped; duplicates are collapsed in the order
 * the CLI printed them.
 */
export function modelNamesFromOutput(output: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()

  for (const raw of output.replace(ANSI, '').split('\n')) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s+/, '')
      .trim()
    if (!line || line.length > 120) continue
    if (/^[[{]/.test(line)) continue
    if (line.endsWith(':')) continue
    if (/^(no|nessun)\s+models?/i.test(line)) continue
    if (/^available\s+models?$/i.test(line)) continue
    if (/^(error|usage|unknown|unrecognized|invalid)\b/i.test(line)) continue
    if (/^(models?|model list)$/i.test(line)) continue
    if (!/[a-z0-9]/i.test(line)) continue
    // Help and usage output is not a model list: a flag, a `Try --help`, an
    // `Options:` header or a sentence about the CLI are all rejected here.
    if (/--/.test(line)) continue
    if (/\b(usage|help|options?|flags?|commands?|arguments?)\b/i.test(line)) continue
    if (/^(try|run|use|see|install|visit|check|note|example|to|for|or)\b/i.test(line)) continue
    if (line.endsWith('?')) continue
    // A sentence is not a model id. Display names with a couple of words pass.
    if (line.split(/\s+/).length > 6) continue

    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(line)
  }

  return names.slice(0, 500)
}
