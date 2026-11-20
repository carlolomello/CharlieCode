import { useEffect, useMemo, useRef, useState } from 'react'

export interface ModelOption {
  key: string
  label: string
  /** Provider shown above the entry, so a filtered list still reads in context. */
  group: string
}

interface ModelPickerProps {
  options: ModelOption[]
  value: string
  onChange: (key: string) => void
  disabled?: boolean
  title?: string
}

/**
 * The topbar model picker.
 *
 * A router can expose hundreds of models, and a native `<select>` cannot be
 * searched: you scroll a list that only shows one entry at a time. This is a
 * combobox with its own filter, grouped results and keyboard navigation, so
 * switching model stays a two-keystroke action.
 */
export function ModelPicker({
  options,
  value,
  onChange,
  disabled,
  title
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => option.key === value)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) =>
      `${option.label} ${option.group} ${option.key}`.toLowerCase().includes(needle)
    )
  }, [options, query])

  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const option of filtered) {
      const list = map.get(option.group) ?? []
      list.push(option)
      map.set(option.group, list)
    }
    return [...map.entries()]
  }, [filtered])

  // The highlighted row must stay inside the filtered list when it shrinks.
  const current = filtered.length === 0 ? -1 : Math.min(active, filtered.length - 1)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, current])

  const show = (): void => {
    const index = options.findIndex((option) => option.key === value)
    setQuery('')
    setActive(index >= 0 ? index : 0)
    setOpen(true)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const choose = (key: string): void => {
    setOpen(false)
    if (key !== value) onChange(key)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(current + 1, filtered.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = filtered[current]
      if (option) choose(option.key)
      return
    }
    if (event.key === 'Escape') {
      // Esc closes the picker, not the drawer behind it.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className={`model-picker ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="select model-select model-picker-trigger"
        onClick={() => (open ? setOpen(false) : show())}
        disabled={disabled}
        title={title ?? selected?.key ?? ''}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Scegli il modello"
      >
        <span className="model-picker-value">
          {selected ? selected.label : options.length === 0 ? 'nessun modello' : 'scegli un modello'}
        </span>
        <span className="model-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="model-picker-pop">
          <input
            ref={inputRef}
            className="model-picker-search"
            value={query}
            placeholder="Cerca modello o provider…"
            aria-label="Cerca modello"
            role="combobox"
            aria-expanded="true"
            aria-controls="model-picker-list"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
          <div className="model-picker-list" id="model-picker-list" role="listbox" ref={listRef}>
            {filtered.length === 0 && (
              <div className="model-picker-empty">Nessun modello per «{query.trim()}»</div>
            )}
            {groups.map(([group, entries]) => (
              <div key={group} className="model-picker-group">
                <div className="model-picker-group-label">{group}</div>
                {entries.map((option) => {
                  const index = filtered.indexOf(option)
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="option"
                      aria-selected={option.key === value}
                      data-active={index === current}
                      className={`model-picker-option ${option.key === value ? 'selected' : ''} ${
                        index === current ? 'active' : ''
                      }`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(option.key)}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
