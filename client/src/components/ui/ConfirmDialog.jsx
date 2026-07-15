import React from 'react';
import Button from './Button';

// A styled pop-up confirmation prompt — replaces window.confirm()'s native
// browser dialog with something that looks like the rest of the app. Stacks
// on top of whatever modal is currently open (same .modal-backdrop/.modal
// classes, painted later so it's on top); stopPropagation keeps a click here
// from also closing the modal underneath it. `issues` are the specific
// problems found — each a { title, detail } pair, in the app's existing
// mauve "error" styling (see .error-banner in styles.css) — rendered one per
// line with a bolded title so the rep can scan what's wrong at a glance.
export default function ConfirmDialog({ issues, confirmLabel = 'Save anyway', onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="error-banner" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {issues.map((issue, i) => (
              <div key={i}><strong>{issue.title}:</strong> {issue.detail}</div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
