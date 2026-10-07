import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { describeSaveError } from '../../utils/services/errors';
import { bibNumber, formatBibSeries } from '../../utils/bibSeries';

export default function EditRegistrationModal({ registration, categories, onSave, onClose }) {
  const [formData, setFormData] = useState({
    first_name: registration.first_name || '',
    last_name: registration.last_name || '',
    email: registration.email || '',
    category: registration.category || '',
    tshirt_size: registration.tshirt_size || '',
    payment_status: registration.payment_status || 'PENDING',
    bib: registration.bib || '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const handleInput = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setSaveError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveError('');
    try {
      await onSave(registration.id, formData);
    } catch (err) {
      setSaveError(describeSaveError(err, 'registration'));
    } finally {
      setIsSaving(false);
    }
  };

  // Each category owns a bib series (migration 0017). The database issues and
  // checks the numbers; this only tells the organiser what will happen.
  const selected = categories.find(c => typeof c !== 'string' && c.name === formData.category);
  const series = formatBibSeries(selected);
  const bibUnchanged = formData.bib.trim() === (registration.bib || '');
  const categoryChanged = formData.category !== (registration.category || '');
  const typed = bibNumber(formData.bib);
  const typedOutside = !bibUnchanged && typed !== null && selected
    && (typed < selected.bib_start || typed > selected.bib_end);

  let bibHint = series ? `${formData.category} series: ${series}.` : '';
  if (categoryChanged && bibUnchanged && registration.bib && series) {
    bibHint = `A new bib from the ${series} series is issued when you save. The runner is not re-emailed automatically.`;
  } else if (!formData.bib.trim()) {
    bibHint = `Leave empty to issue the next number${series ? ` in ${series}` : ''} automatically.`;
  } else if (typedOutside) {
    bibHint = `${typed} is outside the ${formData.category} series (${series}). The database will refuse it.`;
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal glass" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>Edit Registration</h3>
          <button className="admin-modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="admin-modal-body">
          <div className="admin-media-form-grid">
            <div className="admin-media-form-group">
              <label>First Name</label>
              <input name="first_name" value={formData.first_name} onChange={handleInput} />
            </div>
            <div className="admin-media-form-group">
              <label>Last Name</label>
              <input name="last_name" value={formData.last_name} onChange={handleInput} />
            </div>
            <div className="admin-media-form-group">
              <label>Email</label>
              <input name="email" type="email" value={formData.email} onChange={handleInput} />
            </div>
            <div className="admin-media-form-group">
              <label htmlFor="edit-reg-bib">Bib Number</label>
              <input
                id="edit-reg-bib"
                name="bib"
                value={formData.bib}
                onChange={handleInput}
                inputMode="numeric"
                placeholder="Issued automatically"
                aria-describedby="edit-reg-bib-hint"
                aria-invalid={typedOutside || undefined}
              />
              {bibHint && (
                <span id="edit-reg-bib-hint" className={`admin-field-hint${typedOutside ? ' admin-field-hint--warn' : ''}`}>
                  {bibHint}
                </span>
              )}
            </div>
            <div className="admin-media-form-group">
              <label>Category</label>
              <select name="category" value={formData.category} onChange={handleInput}>
                <option value="">Select...</option>
                {categories.map((cat, i) => {
                  const name = typeof cat === 'string' ? cat : cat.name;
                  const range = typeof cat === 'string' ? '' : formatBibSeries(cat);
                  return (
                    <option key={i} value={name}>
                      {range ? `${name} (${range})` : name}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="admin-media-form-group">
              <label>T-Shirt Size</label>
              <select name="tshirt_size" value={formData.tshirt_size} onChange={handleInput}>
                <option value="">Select...</option>
                {['XS', 'S', 'M', 'L', 'XL', 'XXL'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="admin-media-form-group">
              <label>Payment Status</label>
              <select name="payment_status" value={formData.payment_status} onChange={handleInput}>
                <option value="PENDING">Pending</option>
                <option value="PAID">Paid</option>
                <option value="REFUNDED">Refunded</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
          </div>
          {saveError && (
            <div className="admin-login-error" role="alert" style={{ marginTop: '0.75rem' }}>
              <span>{saveError}</span>
            </div>
          )}
          <div className="admin-modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={isSaving} style={{ gap: '6px', display: 'inline-flex', alignItems: 'center' }}>
              <Save size={16} /> {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
