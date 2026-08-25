import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { clearTunablesCache } from '../hooks/useTunables';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// The tuning page: every constant the scheduling, capacity and relationship
// algorithms run on, what each one means, and what moving it actually does.
//
// This screen renders itself entirely from what the server sends. The
// sections, the groups inside them, the labels, the help text, the bounds and
// the legal values all come from server/src/config/tunables.js, so adding a
// new tunable is a one-file change on the server and it appears here with its
// explanation already attached. There is deliberately no list of fields in
// this file - the moment the client had its own copy, the two could disagree
// about what a number means, which is the exact failure this page exists to
// prevent.
//
// EDITING MODEL
// Edits accumulate in local state across every section and are saved as one
// batch. That matters because several tunables only make sense in pairs (high
// capacity must start above medium, and so on) and the server validates the
// batch as a unit: editing one half of a pair and saving would otherwise be
// rejected for a conflict the user is halfway through fixing.

// Deep-equality via JSON, which is enough here: every value on this page is a
// number, a string, or an array of those, and the server hands them back in a
// stable key order.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- controls

// One numeric box with its unit. Kept as a string in local state while the
// user types, so a half-typed "1." or a briefly-empty box doesn't get coerced
// to 0 or NaN under them; it converts to a number on blur, and the parent's
// dirty-check treats an unparseable box as unchanged rather than as a change
// to nothing.
function NumberInput({ field, value, onChange, id, hideUnit }) {
  const [text, setText] = useState(String(value));

  // Follow the value when it changes from outside (a reset, a save, a
  // discard) but not while the user is mid-edit on this very box.
  useEffect(() => { setText(String(value)); }, [value]);

  return (
    <div className="tunable-input">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step || (field.type === 'integer' ? 1 : 'any')}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => {
          const n = Number(text);
          if (text.trim() === '' || !Number.isFinite(n)) setText(String(value)); // put back what was there
        }}
      />
      {field.unit && !hideUnit && <span className="tunable-unit">{field.unit}</span>}
    </div>
  );
}

function SelectInput({ field, value, onChange, id }) {
  return (
    <div className="tunable-input">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function TextInput({ field, value, onChange, id }) {
  return (
    <div className="tunable-input wide">
      <input id={id} type="text" value={value} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// Multi-select over the REAL category list, not free text. The values here
// have to match category names exactly - a near-miss silently falls through
// to the default half-life with no error - so the only safe editor is one
// that can't produce a name that doesn't exist.
function CategoryPicker({ value, onChange, categories }) {
  const selected = new Set(value);
  // A category that was selected and has since been renamed or retired stays
  // listed (struck through) rather than vanishing silently, so a stale entry
  // is something you can see and remove rather than something that just
  // quietly stops matching anything.
  const orphans = value.filter((name) => !categories.some((c) => c.name === name));

  if (categories.length === 0) return <div className="tiny muted">Loading categories...</div>;

  return (
    <div className="category-picker">
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`category-toggle ${selected.has(c.name) ? 'on' : ''}`}
          onClick={() => onChange(selected.has(c.name) ? value.filter((n) => n !== c.name) : [...value, c.name])}
        >
          {c.name}
        </button>
      ))}
      {orphans.map((name) => (
        <button
          key={name}
          type="button"
          className="category-toggle orphan"
          title="This category no longer exists, so it matches nothing. Click to remove it."
          onClick={() => onChange(value.filter((n) => n !== name))}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

// The ordered category -> capacity rule table. Order is meaningful (first
// match wins), so this needs move-up/move-down, not just add and remove.
function SeedTableEditor({ field, value, onChange }) {
  const move = (i, delta) => {
    const next = [...value];
    const [row] = next.splice(i, 1);
    next.splice(i + delta, 0, row);
    onChange(next);
  };
  const update = (i, patch) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="seed-table">
      <div className="seed-head">
        <span>Order</span>
        <span>If the category contains any of these keywords</span>
        <span>Assume capacity</span>
        <span />
      </div>

      {value.map((rule, i) => (
        <div className="seed-row" key={i}>
          <div className="seed-order">
            <span className="seed-index">{i + 1}</span>
            <div className="reorder">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move up">▲</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === value.length - 1} title="Move down">▼</button>
            </div>
          </div>
          <input
            type="text"
            value={rule.keywords.join(', ')}
            placeholder="hospital, medical center"
            onChange={(e) => update(i, { keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
          />
          <select value={rule.level} onChange={(e) => update(i, { level: e.target.value })}>
            {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button type="button" className="icon-remove" title="Remove this rule" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}

      <Button variant="ghost" size="small" onClick={() => onChange([...value, { keywords: [], level: 'low' }])}>
        + Add rule
      </Button>
    </div>
  );
}

// Picks the right control for a field's declared type. A type the client
// doesn't recognise renders read-only rather than as a broken box, so a
// server that has run ahead of the client degrades to "visible but not
// editable" instead of to a blank row.
function TunableControl({ field, value, onChange, categories, id }) {
  switch (field.type) {
    case 'integer':
    case 'number': return <NumberInput field={field} value={value} onChange={onChange} id={id} />;
    case 'select': return <SelectInput field={field} value={value} onChange={onChange} id={id} />;
    case 'text': return <TextInput field={field} value={value} onChange={onChange} id={id} />;
    case 'categories': return <CategoryPicker value={value} onChange={onChange} categories={categories} />;
    case 'seedTable': return <SeedTableEditor field={field} value={value} onChange={onChange} />;
    default: return <div className="tiny muted">{JSON.stringify(value)}</div>;
  }
}

// --------------------------------------------------------------- one field

function TunableRow({ field, value, defaultValue, meta, onChange, onReset, categories }) {
  const changed = !same(value, defaultValue);
  const inputId = `tunable-${field.key.replace(/\./g, '-')}`;
  // A control that owns its own layout (the rule table, the category picker)
  // needs the full width of the row rather than a label/input two-column
  // split.
  const isWide = field.type === 'seedTable' || field.type === 'categories';

  return (
    <div className={`tunable ${isWide ? 'wide' : ''} ${changed ? 'changed' : ''}`}>
      <div className="tunable-main">
        <div className="tunable-label">
          <label htmlFor={inputId}>{field.label}</label>
          {changed && <span className="tunable-flag" title="Different from the value this app ships with">Customised</span>}
        </div>
        {!isWide && <TunableControl field={field} value={value} onChange={onChange} categories={categories} id={inputId} />}
      </div>

      <p className="tunable-help">{field.help}</p>

      {isWide && <TunableControl field={field} value={value} onChange={onChange} categories={categories} id={inputId} />}

      {(field.raise || field.lower) && (
        <div className="tunable-effects">
          {field.raise && <div><span className="eff-arrow up">▲</span> <strong>Higher:</strong> {field.raise}</div>}
          {field.lower && <div><span className="eff-arrow down">▼</span> <strong>Lower:</strong> {field.lower}</div>}
        </div>
      )}

      <div className="tunable-foot">
        <span className="tiny muted">
          Ships as <code>{formatValue(defaultValue)}</code>
          {meta && meta.updatedByName ? ` · last changed by ${meta.updatedByName}` : ''}
        </span>
        {changed && <button type="button" className="link-button tiny" onClick={onReset}>Reset to default</button>}
      </div>
    </div>
  );
}

// Renders a default for the "ships as" line. Arrays and rule tables get
// summarised rather than dumped, since the point is a quick sanity check
// against what you've typed, not a second copy of the editor.
function formatValue(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return 'nothing selected';
    if (typeof v[0] === 'object') return `${v.length} rules`;
    return v.length > 3 ? `${v.length} categories` : v.join(', ');
  }
  return String(v);
}

// ------------------------------------------------------- the cadence table

// CADENCE_DAYS is a 3x3 lookup, and reading it as nine separate rows loses
// the thing that actually matters about it: that it's deliberately inverted
// along the diagonal. Rendering it as the grid it is makes a mis-tuned
// inversion visible at a glance.
function CadenceMatrix({ group, values, defaults, onChange, fieldsByKey }) {
  const { rows, cols, rowLabel, colLabel } = group.matrix;
  const keyFor = (row, col) => `scheduling.CADENCE_DAYS.${row}.${col}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <div className="cadence-matrix-wrap">
      <table className="cadence-matrix">
        <thead>
          <tr>
            <th className="corner"><span className="axis-col">{colLabel} →</span><span className="axis-row">{rowLabel} ↓</span></th>
            {cols.map((c) => <th key={c}>{cap(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th scope="row">{cap(r)}</th>
              {cols.map((c) => {
                const key = keyFor(r, c);
                const field = fieldsByKey.get(key);
                const changed = !same(values[key], defaults[key]);
                return (
                  <td key={c} className={changed ? 'changed' : ''} title={`${field.label}. ${field.help}`}>
                    <NumberInput field={field} value={values[key]} onChange={(v) => onChange(key, v)} id={`tunable-${key.replace(/\./g, '-')}`} hideUnit />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny muted matrix-note">
        Every cell is a target number of days between visits. Hover any cell for what it covers.
        The smallest number should sit at high capacity with a weak relationship: that is the cell
        with the most to gain.
      </p>
    </div>
  );
}

// ------------------------------------------------------------- the screen

export default function Settings() {
  const [catalogue, setCatalogue] = useState(null); // { sections, values, defaults, meta }
  const [edits, setEdits] = useState({}); // key -> value, only what the user has touched this session
  const [categories, setCategories] = useState([]);
  const [activeSection, setActiveSection] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(''); // brief confirmation after a successful save/reset
  const [confirmingResetAll, setConfirmingResetAll] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.settings.view(), api.categories.list()])
      .then(([view, cats]) => {
        if (!alive) return;
        setCatalogue(view);
        setCategories(cats);
        setActiveSection((s) => s || view.sections[0].id);
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  // Flat key -> field lookup, mirroring the server's own FIELDS map. Built
  // from whatever the server sent rather than from a list in this file.
  const fieldsByKey = useMemo(() => {
    const m = new Map();
    if (catalogue) {
      for (const section of catalogue.sections) {
        for (const group of section.groups) {
          for (const field of group.fields) m.set(field.key, field);
        }
      }
    }
    return m;
  }, [catalogue]);

  // The value to show for a key: the user's unsaved edit if there is one,
  // otherwise what the server says is in effect.
  const valueOf = (key) => (key in edits ? edits[key] : catalogue.values[key]);

  // Only keys whose edited value actually differs from what's saved. Typing a
  // number and typing it back doesn't count as a change.
  const dirtyKeys = useMemo(() => {
    if (!catalogue) return [];
    return Object.keys(edits).filter((k) => !same(edits[k], catalogue.values[k]));
  }, [edits, catalogue]);

  // How many tunables in each section differ from what the app ships with -
  // shown in the sidebar so "what have I changed" is answerable without
  // opening all seven sections.
  const customisedBySection = useMemo(() => {
    const counts = {};
    if (!catalogue) return counts;
    for (const section of catalogue.sections) {
      counts[section.id] = section.groups
        .flatMap((g) => g.fields)
        .filter((f) => !same(valueOf(f.key), catalogue.defaults[f.key])).length;
    }
    return counts;
  }, [catalogue, edits]);

  function setValue(key, value) {
    setError('');
    setFlash('');
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  function resetField(key) {
    setValue(key, catalogue.defaults[key]);
  }

  // Applies whatever the server sends back after a write. The server always
  // returns the full view, so there's no second round trip and no chance of
  // the page disagreeing with what was actually stored.
  function absorb(view, message) {
    setCatalogue(view);
    setEdits({});
    setFlash(message);
    clearTunablesCache(); // other screens re-read rather than serving a stale number
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(dirtyKeys.map((k) => [k, edits[k]]));
      absorb(await api.settings.save(payload), `Saved ${dirtyKeys.length} change${dirtyKeys.length === 1 ? '' : 's'}. They apply from the next visit plan you generate.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetSection(section) {
    setSaving(true);
    setError('');
    try {
      const keys = section.groups.flatMap((g) => g.fields).map((f) => f.key);
      absorb(await api.settings.reset(keys), `${section.title} is back to the values this app ships with.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    setSaving(true);
    setError('');
    setConfirmingResetAll(false);
    try {
      absorb(await api.settings.reset([]), 'Every setting is back to the values this app ships with.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (error && !catalogue) {
    return (
      <div className="card">
        <EmptyState message={`Could not load settings: ${error}`} />
      </div>
    );
  }
  if (!catalogue) return <div className="card"><div className="card-body muted">Loading settings...</div></div>;

  const section = catalogue.sections.find((s) => s.id === activeSection) || catalogue.sections[0];
  const totalCustomised = Object.values(customisedBySection).reduce((a, b) => a + b, 0);

  return (
    <div className="settings-page">
      <div className="settings-intro">
        <h2>Algorithm Settings</h2>
        <p>
          Every number the app's scheduling, capacity and relationship models run on lives here, with an
          explanation of what it does and what happens when you move it. Nothing on this page is a
          preference: each one genuinely changes which places the route planner puts in front of you, so
          the intent is that you tune them as you learn what your territory actually rewards.
        </p>
        <p className="tiny muted">
          Changes take effect immediately, but they don't rewrite history. Visits already planned or
          committed stay exactly as they are; the next plan you generate is the first one that uses the
          new numbers. Anything you change can be put back with "Reset to default", so nothing here is
          a one-way door.
        </p>
      </div>

      {(dirtyKeys.length > 0 || flash || error) && (
        <div className={`settings-bar ${dirtyKeys.length > 0 ? 'dirty' : ''} ${error ? 'error' : ''}`}>
          <div className="settings-bar-msg">
            {error ? <><strong>Not saved.</strong> {error}</>
              : dirtyKeys.length > 0 ? <><strong>{dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? '' : 's'}.</strong> Nothing is live until you save.</>
              : flash}
          </div>
          {dirtyKeys.length > 0 && (
            <div className="settings-bar-actions">
              <Button variant="secondary" size="small" onClick={() => { setEdits({}); setError(''); }} disabled={saving}>Discard</Button>
              <Button size="small" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
            </div>
          )}
        </div>
      )}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {catalogue.sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item ${s.id === section.id ? 'active' : ''}`}
              onClick={() => setActiveSection(s.id)}
            >
              <span className="settings-nav-icon" aria-hidden="true">{s.icon}</span>
              <span className="settings-nav-title">{s.title}</span>
              {customisedBySection[s.id] > 0 && <span className="settings-nav-count" title={`${customisedBySection[s.id]} changed from default`}>{customisedBySection[s.id]}</span>}
            </button>
          ))}

          <div className="settings-nav-foot">
            {confirmingResetAll ? (
              <div className="stack">
                <span className="tiny">Put all {totalCustomised || 'the'} customised settings back?</span>
                <div className="tag-list">
                  <Button variant="danger" size="small" onClick={resetAll} disabled={saving}>Reset everything</Button>
                  <Button variant="ghost" size="small" onClick={() => setConfirmingResetAll(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <button type="button" className="link-button tiny" onClick={() => setConfirmingResetAll(true)} disabled={totalCustomised === 0}>
                {totalCustomised === 0 ? 'Everything is at its default' : `Reset all ${totalCustomised} customised settings`}
              </button>
            )}
          </div>
        </nav>

        <div className="settings-content">
          <div className="settings-section-head">
            <div>
              <h3><span aria-hidden="true">{section.icon}</span> {section.title}</h3>
              <p className="settings-section-blurb">{section.blurb}</p>
            </div>
            {customisedBySection[section.id] > 0 && (
              <Button variant="ghost" size="small" onClick={() => resetSection(section)} disabled={saving}>
                Reset this section
              </Button>
            )}
          </div>

          {section.groups.map((group) => (
            <div className="card settings-group" key={group.id}>
              <div className="card-head"><h2>{group.title}</h2></div>
              <div className="card-body">
                {group.blurb && <p className="settings-group-blurb">{group.blurb}</p>}

                {group.layout === 'matrix' ? (
                  <CadenceMatrix
                    group={group}
                    values={Object.fromEntries(group.fields.map((f) => [f.key, valueOf(f.key)]))}
                    defaults={catalogue.defaults}
                    onChange={setValue}
                    fieldsByKey={fieldsByKey}
                  />
                ) : (
                  group.fields.map((field) => (
                    <TunableRow
                      key={field.key}
                      field={field}
                      value={valueOf(field.key)}
                      defaultValue={catalogue.defaults[field.key]}
                      meta={catalogue.meta[field.key]}
                      categories={categories}
                      onChange={(v) => setValue(field.key, v)}
                      onReset={() => resetField(field.key)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
