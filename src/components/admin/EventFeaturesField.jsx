import React from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';

/**
 * Editor for `events.features`, the "Event Features & Expo" cards on the
 * Event Details page. Each item is { title, description, type? }, where
 * type 'highlight' draws the orange edge and map-pin icon.
 */
export default function EventFeaturesField({ value, onChange, disabled }) {
  const items = Array.isArray(value) ? value : [];

  const update = (index, patch) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const move = (index, delta) => {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };

  const remove = (index) => {
    if (!window.confirm(`Remove "${items[index].title || 'this item'}"?`)) return;
    onChange(items.filter((_, i) => i !== index));
  };

  const add = () => onChange([...items, { title: '', description: '' }]);

  return (
    <div>
      {items.length === 0 ? (
        <p className="admin-field-hint" style={{ marginTop: 0 }}>
          No items. The Features &amp; Expo section is hidden on the Event Details page.
        </p>
      ) : (
        <div className="admin-content-list">
          {items.map((item, index) => (
            <div key={index} className="admin-content-row glass">
              <div className="admin-content-main">
                <div className="admin-media-form-group">
                  <label htmlFor={`evt-feat-title-${index}`}>Title</label>
                  <input
                    id={`evt-feat-title-${index}`}
                    value={item.title || ''}
                    onChange={(e) => update(index, { title: e.target.value })}
                    placeholder="e.g. Bib Expo & Kit Collection"
                    disabled={disabled}
                  />
                </div>
                <div className="admin-media-form-group" style={{ marginTop: '0.75rem' }}>
                  <label htmlFor={`evt-feat-desc-${index}`}>Details</label>
                  <textarea
                    id={`evt-feat-desc-${index}`}
                    value={item.description || ''}
                    onChange={(e) => update(index, { description: e.target.value })}
                    rows={3}
                    style={{ resize: 'vertical' }}
                    disabled={disabled}
                  />
                </div>
                <div className="admin-event-toggle" style={{ marginTop: '0.5rem' }}>
                  <label className="admin-toggle-label">
                    <input
                      type="checkbox"
                      checked={item.type === 'highlight'}
                      onChange={(e) => update(index, { type: e.target.checked ? 'highlight' : undefined })}
                      className="admin-toggle-checkbox"
                      disabled={disabled}
                    />
                    <span className="admin-toggle-switch"></span>
                    <span>Highlight</span>
                  </label>
                </div>
              </div>
              <div className="admin-content-actions">
                <button type="button" className="admin-cat-action-btn" onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label="Move up"><ArrowUp size={14} /></button>
                <button type="button" className="admin-cat-action-btn" onClick={() => move(index, 1)} disabled={disabled || index === items.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
                <button type="button" className="admin-cat-action-btn admin-cat-delete-btn" onClick={() => remove(index)} disabled={disabled} aria-label="Remove"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-outline admin-action-btn" onClick={add} disabled={disabled} style={{ gap: '6px', marginTop: '0.75rem' }}>
        <Plus size={16} /> Add item
      </button>
    </div>
  );
}
