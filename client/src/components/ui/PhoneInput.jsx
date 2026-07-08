import React from 'react';

// Reformats whatever's typed into "(402) 555-1234" as the user goes, so every
// phone number entered anywhere in the app (a place's main line, a person's
// direct line, a visit's contact snapshot) ends up in the same format.
export function formatPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// A phone field is valid if it's empty (optional everywhere) or a complete
// "(402) 555-1234" — used to block saving on a half-typed number.
export const PHONE_REGEX = /^\(\d{3}\) \d{3}-\d{4}$/;
export function isCompletePhone(value) {
  return !value || PHONE_REGEX.test(value);
}

// Controlled phone input: `onChange` receives the formatted string directly
// (not an event), unlike a plain <input>, so it drops straight into a
// setForm(f => ({...f, phone: v})) call at the callsite.
export default function PhoneInput({ value, onChange, ...props }) {
  return (
    <input
      type="tel"
      inputMode="tel"
      value={value}
      onChange={(e) => onChange(formatPhone(e.target.value))}
      placeholder="(402) 555-1234"
      {...props}
    />
  );
}
