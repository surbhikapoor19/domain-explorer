import React, { useEffect, useRef, useState } from 'react';

// Focus-trapped confirmation dialog for deleting a (non-protected) domain. The
// professor must type the exact slug before "Delete domain" enables — this is the
// only guard against an accidental irreversible delete.
export default function DeleteDialog({ domain, onCancel, onConfirm, busy, error }) {
  const [text, setText] = useState('');
  const dialogRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { onCancel(); return; }
      if (e.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), a[href]'
        );
        if (!focusable || !focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const matches = text.trim() === domain.slug;

  return (
    <div className="admin-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-delete-title" ref={dialogRef}>
        <h3 id="admin-delete-title">Delete {domain.displayName}?</h3>
        <p className="admin-dialog-lead">This removes:</p>
        <ul className="admin-dialog-list">
          <li>Its config file</li>
          <li>Its CSV</li>
          <li>Its PDFs</li>
          <li>Its built data</li>
          <li>Its benchmark config</li>
        </ul>
        <p className="admin-dialog-note">Site updates in ~3 min; /{domain.slug.replace(/_/g, '-')} stops working.</p>
        <p className="admin-dialog-note">Can&rsquo;t be undone from the admin (it&rsquo;s in git history).</p>
        <label className="admin-dialog-input-label" htmlFor="admin-delete-confirm">
          Type <code>{domain.slug}</code> to confirm
        </label>
        <input
          id="admin-delete-confirm"
          ref={inputRef}
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          autoComplete="off"
        />
        {error && <div className="admin-inline-error">{error}</div>}
        <div className="admin-dialog-actions">
          <button type="button" className="admin-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="admin-btn admin-btn-danger"
            disabled={!matches || busy}
            onClick={() => onConfirm(text.trim())}
          >
            {busy ? 'Deleting…' : 'Delete domain'}
          </button>
        </div>
      </div>
    </div>
  );
}
