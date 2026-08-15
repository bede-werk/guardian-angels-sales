import React from 'react';

// A native <select> styled to read as plain inline text (e.g. a value sitting
// inside a header line, like Route Planner's zone picker) rather than a boxy
// form control, while still being a real <select> for native/keyboard
// picking. `options` is a plain array of strings. If `value` isn't (yet)
// among `options` - e.g. the list hasn't loaded - shows `placeholder` as a
// disabled option instead of silently selecting the wrong thing.
export default function InlineDropdown({ value, options, onChange, disabled, title, placeholder = '…' }) {
  const hasValue = options.includes(value);
  const displayText = hasValue ? value : placeholder;
  return (
    <select
      className="inline-dropdown"
      value={hasValue ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || options.length === 0}
      title={title}
      // A bare <select> sizes its closed box to fit its WIDEST option, not
      // the selected one - with a long option elsewhere in the list, that
      // leaves a visible gap between short selected text and the arrow.
      // Sizing to the selected text's own length (plus a little room for
      // the arrow) keeps the arrow sitting right next to what's shown,
      // and re-measures automatically as `value` changes.
      style={{ width: `${displayText.length + 2.5}ch` }}
    >
      {!hasValue && <option value="" disabled>{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}
