'use client';

import { KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';

type Props = { value: string; onChange: (value: string) => void; options: readonly string[]; placeholder?: string };

/** Text input with suggestions. The full list opens on focus/click; it only filters after the user types. Any custom value is allowed. */
export function ComboInput({ value, onChange, options, placeholder }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const unique = useMemo(() => Array.from(new Set(options)), [options]);
  const shown = useMemo(() => {
    const query = value.trim().toLowerCase();
    return typed && query ? unique.filter(option => option.toLowerCase().includes(query)) : unique;
  }, [unique, value, typed]);

  const optionId = (index: number) => `${listId}-option-${index}`;
  // Keep the keyboard-highlighted option visible inside the scrollable list.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  const show = () => { setTyped(false); setOpen(true); setActive(-1); };
  const choose = (option: string) => { onChange(option); setOpen(false); setTyped(false); setActive(-1); };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) { show(); setActive(0); return; }
      setActive(index => Math.min(shown.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) setActive(index => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && open && active >= 0 && shown[active]) {
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <span className="admin-combo">
      <input
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off" aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        value={value} placeholder={placeholder}
        onFocus={show} onClick={show} onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
        onChange={event => { onChange(event.target.value); setTyped(true); setOpen(true); setActive(-1); }}
      />
      {open && shown.length > 0 && (
        <span id={listId} role="listbox" className="admin-combo-list" onMouseDown={event => event.preventDefault()}>
          {shown.map((option, index) => (
            <span key={option} id={optionId(index)} role="option" aria-selected={option === value} className={index === active ? 'admin-combo-option active' : 'admin-combo-option'} onClick={() => choose(option)}>{option}</span>
          ))}
        </span>
      )}
    </span>
  );
}
