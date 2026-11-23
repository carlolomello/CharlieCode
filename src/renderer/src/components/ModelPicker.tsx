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
  /** Starred keys, shown in their own group above the providers. */
  favorites?: string[]
  /** Stars an entry, or takes the star away when it is already starred. */
  onToggleFavorite?: (key: string) => void
}

/**
 * The topbar model picker.
 *
 * A router can expose hundreds of models, and a native `<select>` cannot be
 * searched: you scroll a list that only shows one entry at a time. This is a
 * combobox with its own filter, grouped results and keyboard navigation, so
 * switching model stays a two-keystroke action.
 *
 * Starring is what makes a long catalog usable: the few models actually used
 * come first, and the rest stays reachable below.
 */
export function ModelPicker({
  options,
  value,
  onChange,
  disabled,
  title,
  favorites = [],
  onToggleFavorite
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => option.key === value)
  const favoriteSet = useMemo(() => new Set(favorites), [favorites])

  /**
   * Favorites first, then everything else. This is the flat order the keyboard
   * walks, and the groups below follow it, so index and render stay aligned.
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = needle
      ? options.filter((option) =>
          `${option.label} ${option.group} ${option.key}`.toLowerCase().includes(needle)
        )
      : options
    return [
      ...matching.filter((option) => favoriteSet.has(option.key)),
      ...matching.filter((option) => !favoriteSet.has(option.key))
    ]
  }, [options, query, favoriteSet])

  const starred = useMemo(
    () => filtered.filter((option) => favoriteSet.has(option.key)),
    [filtered, favoriteSet]
  )

  /** Flat index per key, so a row knows its place without scanning the list. */
  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    filtered.forEach((option, index) => map.set(option.key, index))
    return map
  }, [filtered])

  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const option of filtered) {
      if (favoriteSet.has(option.key)) continue
      const list = map.get(option.group) ?? []
      list.push(option)
      map.set(option.group, list)
    }
    return [...map.entries()]
  }, [filtered, favoriteSet])

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
    // Same order the open list will render: favorites first, then the rest.
    const ordered = [
      ...options.filter((option) => favoriteSet.has(option.key)),
      ...options.filter((option) => !favoriteSet.has(option.key))
    ]
    const index = ordered.findIndex((option) => option.key === value)
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

  const row = (option: ModelOption): React.JSX.Element => {
    const index = indexOf.get(option.key) ?? -1
    const isFavorite = favoriteSet.has(option.key)
    return (
      <div
        key={option.key}
        className={`model-picker-row ${index === current ? 'active' : ''}`}
      >
        <button
          type="button"
          role="option"
          aria-selected={option.key === value}
          data-active={index === current}
          className={`model-picker-option ${option.key === value ? 'selected' : ''}`}
          title={option.key}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(option.key)}
        >
          {option.label}
        </button>
        {onToggleFavorite && (
          <button
            type="button"
            className={`model-picker-star ${isFavorite ? 'on' : ''}`}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Togli dai preferiti' : 'Metti tra i preferiti'}
            title={isFavorite ? 'Togli dai preferiti' : 'Metti tra i preferiti'}
            onClick={() => onToggleFavorite(option.key)}
          >
            {isFavorite ? '★' : '☆'}
          </button>
        )}
      </div>
    )
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
            {starred.length > 0 && (
              <div className="model-picker-group">
                <div className="model-picker-group-label">Preferiti</div>
                {starred.map((option) => row(option))}
              </div>
            )}
            {groups.map(([group, entries]) => (
              <div key={group} className="model-picker-group">
                <div className="model-picker-group-label">{group}</div>
                {entries.map((option) => row(option))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
