import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/** Modal shell shared by the Content tab's editors (FAQ, testimonials, sponsors). */
export default function ContentModal({ title, error, isSaving, onSubmit, onClose, children }) {
  // Mount-only: focus and scroll lock must not re-run on every keystroke.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div
        className="admin-modal admin-modal--wide glass"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="admin-modal-header">
          <h3>{title}</h3>
          <button className="admin-modal-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <form onSubmit={onSubmit} className="admin-modal-form">
          <div className="admin-modal-body">
            <section className="admin-form-section">{children}</section>
            {error && <div className="admin-login-error" style={{ marginTop: '1rem' }}><span>{error}</span></div>}
          </div>
          <div className="admin-modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
