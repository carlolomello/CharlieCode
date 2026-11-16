import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  OnboardingAnswers,
  OnboardingFacts,
  OnboardingPlan,
  OnboardingResult
} from '../../../shared/ipc'

/**
 * The new-project wizard.
 *
 * Three questions and a summary: what this project is, which AGENTS.md to write,
 * which skills to install. Every step shows the exact file that will be
 * created, and nothing is written until the last button. The whole flow is
 * offline — it works before a model is even configured.
 */

const KINDS = [
  { id: 'web', label: 'Web app' },
  { id: 'api', label: 'API / backend' },
  { id: 'cli', label: 'CLI / tool' },
  { id: 'library', label: 'Libreria' },
  { id: 'data', label: 'Data / ML' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'other', label: 'Altro' }
] as const

interface ProjectWizardProps {
  workspace: string
  onClose: (result?: OnboardingResult) => void
  onApplied: () => Promise<void>
}

export function ProjectWizard({
  workspace,
  onClose,
  onApplied
}: ProjectWizardProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [facts, setFacts] = useState<OnboardingFacts | null>(null)
  const [answers, setAnswers] = useState<OnboardingAnswers>({ summary: '', kinds: [] })
  const [plan, setPlan] = useState<OnboardingPlan | null>(null)
  const [agentsText, setAgentsText] = useState('')
  const [writeAgents, setWriteAgents] = useState(true)
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [autoApprove, setAutoApprove] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OnboardingResult | null>(null)
  const [openBody, setOpenBody] = useState<string | null>(null)

  const loadPreview = useCallback(
    async (next: OnboardingAnswers): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const preview = await window.charliecode.onboardingPreview({
          workspace,
          answers: next
        })
        setPlan(preview)
        setAgentsText(preview.agentsMd)
        setSkillIds(preview.skills.map((skill) => skill.id))
        setAutoApprove(preview.autoApproveCommands)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [workspace]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await window.charliecode.onboardingFacts(workspace)
        if (cancelled) return
        setFacts(next)
        await loadPreview({ summary: '', kinds: [] })
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace, loadPreview])

  const toggleKind = (id: string): void => {
    setAnswers((previous) => ({
      ...previous,
      kinds: previous.kinds.includes(id)
        ? previous.kinds.filter((entry) => entry !== id)
        : [...previous.kinds, id]
    }))
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const applied = await window.charliecode.onboardingApply({
        workspace,
        apply: {
          answers,
          writeAgentsMd: writeAgents,
          agentsMd: agentsText,
          skillIds,
          autoApproveCommands: autoApprove
        }
      })
      setResult(applied)
      setStep(3)
      await onApplied()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const skip = async (): Promise<void> => {
    try {
      await window.charliecode.onboardingSkip(workspace)
    } finally {
      onClose()
    }
  }

  const detected = useMemo(() => {
    if (!facts) return []
    const items: string[] = []
    if (facts.languages.length > 0) items.push(facts.languages.join(', '))
    if (facts.packageManager) items.push(facts.packageManager)
    items.push(`${facts.files} file`)
    if (facts.isGit) items.push('git')
    return items
  }, [facts])

  return (
    <div className="overlay wizard-overlay">
      <div className="wizard">
        <header className="wizard-head">
          <div>
            <h2>Configuriamo {workspace.split(/[\\/]/).pop()}</h2>
            <p className="muted small">
              Niente viene scritto senza il tuo ok. Tutto qui funziona anche senza un modello
              collegato.
            </p>
          </div>
          <button className="ghost" onClick={() => void skip()} title="Non ora">
            ✕
          </button>
        </header>

        <ol className="wizard-steps">
          {['Il progetto', 'AGENTS.md', 'Skill', 'Fatto'].map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {error && <div className="message-error">{error}</div>}

        {step === 0 && (
          <div className="wizard-body wizard-form">
            <label className="wizard-label" htmlFor="wizard-summary">
              In due righe, cosa fa questo progetto?
            </label>
            <textarea
              id="wizard-summary"
              rows={3}
              placeholder="Es. Un gestionale di preventivi: React sul frontend, API Node e Postgres."
              value={answers.summary}
              onChange={(event) =>
                setAnswers((previous) => ({ ...previous, summary: event.target.value }))
              }
            />
            <div className="wizard-kinds">
              {KINDS.map((kind) => (
                <button
                  key={kind.id}
                  className={`kind-chip ${answers.kinds.includes(kind.id) ? 'on' : ''}`}
                  onClick={() => toggleKind(kind.id)}
                >
                  {kind.label}
                </button>
              ))}
            </div>
            {detected.length > 0 && (
              <p className="muted small">
                Rilevato da solo: {detected.join(' · ')}
                {facts?.commands.length ? ` · comandi: ${facts.commands.join(', ')}` : ''}
              </p>
            )}
          </div>
        )}

        {step === 1 && plan && (
          <div className="wizard-body wizard-form">
            <label className="provider-toggle">
              <input
                type="checkbox"
                checked={writeAgents}
                onChange={(event) => setWriteAgents(event.target.checked)}
              />
              <span>
                Scrivi <code>{plan.agentsMdPath}</code>
              </span>
            </label>
            {plan.agentsMdExists && (
              <div className="banner warn small">
                Esiste già un file di istruzioni: qui sotto vedi il testo che verrebbe salvato,
                con le righe aggiunte dal wizard. Controlla prima di confermare.
              </div>
            )}
            <textarea
              className="wizard-editor"
              rows={16}
              value={agentsText}
              onChange={(event) => setAgentsText(event.target.value)}
              spellCheck={false}
            />
            <p className="muted small">
              Modificabile a mano. Contiene solo cose rilevate davvero: comandi che esistono,
              linguaggi presenti, regole brevi.
            </p>
          </div>
        )}

        {step === 2 && plan && (
          <div className="wizard-body wizard-form">
            <p className="muted small">
              Skill scritte in locale dai comandi di questo progetto. Nessun download, nessuna
              rete: sono file di testo che l&apos;agente carica solo quando servono.
            </p>
            <div className="skills">
              {plan.skills.map((skill) => (
                <div key={skill.id} className={`skill ${skillIds.includes(skill.id) ? '' : 'off'}`}>
                  <div className="skill-head">
                    <label className="provider-toggle">
                      <input
                        type="checkbox"
                        checked={skillIds.includes(skill.id)}
                        onChange={(event) =>
                          setSkillIds((previous) =>
                            event.target.checked
                              ? [...previous, skill.id]
                              : previous.filter((id) => id !== skill.id)
                          )
                        }
                      />
                      <span>
                        <span className="skill-name">{skill.name}</span>
                        <span className="skill-desc">{skill.description}</span>
                      </span>
                    </label>
                    <div className="skill-actions">
                      <span className={`skill-source ${skill.origin === 'catalog' ? 'project' : ''}`}>
                        {skill.origin === 'catalog' ? 'modello curato' : 'generata'}
                      </span>
                      <button
                        className="ghost small"
                        onClick={() => setOpenBody(openBody === skill.id ? null : skill.id)}
                      >
                        {openBody === skill.id ? 'nascondi' : 'vedi'}
                      </button>
                    </div>
                  </div>
                  {skill.warnings.length > 0 && (
                    <div className="skill-warn">
                      contiene comandi da controllare: {skill.warnings.join(', ')}
                    </div>
                  )}
                  {openBody === skill.id && <pre className="skill-body">{skill.body}</pre>}
                </div>
              ))}
              {plan.skills.length === 0 && (
                <p className="muted small">
                  Nessuna skill sensata da proporre per questo progetto: meglio niente che rumore.
                </p>
              )}
            </div>
            {plan.autoApproveCommands.length > 0 && (
              <div className="wizard-auto">
                <div className="wizard-label">Permessi automatici</div>
                <p className="muted small">
                  Sola verifica, nessuna scrittura. Puoi togliere quelli che non ti convincono.
                </p>
                {plan.autoApproveCommands.map((prefix) => (
                  <label key={prefix} className="provider-toggle small-toggle">
                    <input
                      type="checkbox"
                      checked={autoApprove.includes(prefix)}
                      onChange={(event) =>
                        setAutoApprove((previous) =>
                          event.target.checked
                            ? [...previous, prefix]
                            : previous.filter((entry) => entry !== prefix)
                        )
                      }
                    />
                    <span>
                      <code>{prefix}</code>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 3 && result && (
          <div className="wizard-body wizard-form">
            <h3>Fatto</h3>
            {result.written.length > 0 ? (
              <ul className="wizard-list">
                {result.written.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Non ho scritto niente: hai lasciato tutto deselezionato.</p>
            )}
            {result.skipped.length > 0 && (
              <p className="muted small">Saltate: {result.skipped.join(', ')}</p>
            )}
            {result.autoApprove.length > 0 && (
              <p className="muted small">
                Auto-approvati: {result.autoApprove.map((entry) => `\`${entry}\``).join(', ')}
              </p>
            )}
            <p className="muted small">
              Da qui in poi l&apos;agente legge l&apos;AGENTS.md a ogni sessione e carica le skill
              con il tool <code>skill</code>.
            </p>
          </div>
        )}

        <footer className="wizard-foot">
          <button className="ghost" onClick={() => void skip()}>
            Non ora
          </button>
          <div className="wizard-nav">
            {step > 0 && step < 3 && (
              <button className="ghost" onClick={() => setStep(step - 1)} disabled={busy}>
                Indietro
              </button>
            )}
            {step === 0 && (
              <button
                className="primary"
                onClick={() => {
                  void loadPreview(answers).then(() => setStep(1))
                }}
                disabled={busy}
              >
                {busy ? 'Preparo…' : 'Continua'}
              </button>
            )}
            {step === 1 && (
              <button className="primary" onClick={() => setStep(2)} disabled={busy}>
                Continua
              </button>
            )}
            {step === 2 && (
              <button className="primary" onClick={() => void apply()} disabled={busy}>
                {busy ? 'Scrivo…' : 'Applica'}
              </button>
            )}
            {step === 3 && (
              <button className="primary" onClick={() => onClose(result ?? undefined)}>
                Chiudi
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
