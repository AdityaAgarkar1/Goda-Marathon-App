import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Trash2, Edit3, ArrowUp, ArrowDown, Eye, EyeOff,
  Upload, Link2, X, RefreshCw, AlertTriangle, ExternalLink, ImageOff,
} from 'lucide-react';
import ContentModal from './ContentModal';
import {
  getAllSponsors, addSponsor, updateSponsor, deleteSponsor, reorderSponsors,
  normalizeWebsiteUrl,
} from '../../utils/services/sponsors';
import { uploadSponsorLogo, deleteStoredImageAt } from '../../utils/services/storage';
import { describeSaveError } from '../../utils/services/errors';
import { normalizeMediaUrl, resolveImageUrl } from '../../utils/mediaUrl';
import { prepareLogo, ACCEPTED_LOGO_TYPES } from '../../utils/prepareLogo';

const emptyForm = {
  name: '',
  logo_url: '',
  website_url: '',
  label: '',
  logo_background: 'light',
  is_featured: false,
  is_published: true,
};

function describeLoadError(error) {
  const message = error?.message || '';
  if (/sponsors/i.test(message) && /does not exist|schema cache/i.test(message)) {
    return 'The sponsors table does not exist yet. Run supabase/migrations/0015_sponsors.sql in the Supabase SQL editor, then reload this page.';
  }
  return message ? `Could not load sponsors: ${message}` : 'Could not load sponsors.';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export default function SponsorManager() {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [pending, setPending] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setItems(await getAllSponsors());
      setLoadError('');
    } catch (err) {
      setLoadError(describeLoadError(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A processed logo is previewed from an object URL; release it once it is
  // replaced, discarded or uploaded.
  useEffect(() => () => {
    if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl);
  }, [pending]);

  const onInput = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    setError('');
  };

  const setField = (name, value) => {
    setForm(prev => ({ ...prev, [name]: value }));
    setError('');
  };

  const startAdd = () => {
    setForm(emptyForm); setPending(null); setEditing(null); setError(''); setShowForm(true);
  };

  const startEdit = (item) => {
    setForm({
      name: item.name || '',
      logo_url: item.logo_url || '',
      website_url: item.website_url || '',
      label: item.label || '',
      logo_background: item.logo_background === 'dark' ? 'dark' : 'light',
      is_featured: !!item.is_featured,
      is_published: item.is_published !== false,
    });
    setPending(null); setEditing(item); setError(''); setShowForm(true);
  };

  const closeForm = useCallback(() => {
    setShowForm(false); setEditing(null); setPending(null);
  }, []);

  /** Another row pointing at the same file must keep it. */
  const isShared = (url, exceptId) => items.some(i => i.id !== exceptId && i.logo_url === url);

  const save = async (e) => {
    e.preventDefault();
    if (isProcessing) return;
    if (!form.name.trim()) { setError('Sponsor name is required.'); return; }
    if (!pending && !form.logo_url) { setError('Add a logo: upload a file or use a URL.'); return; }
    const website = normalizeWebsiteUrl(form.website_url);
    if (!website.ok) { setError(website.error); return; }

    setIsSaving(true);
    let uploadedUrl = null;
    try {
      if (pending) uploadedUrl = await uploadSponsorLogo(pending.logo, pending.fileName);

      const payload = {
        name: form.name.trim(),
        logo_url: uploadedUrl || form.logo_url,
        website_url: website.url,
        label: form.label.trim() || null,
        logo_background: form.logo_background,
        is_featured: form.is_featured,
        is_published: form.is_published,
      };

      if (editing) await updateSponsor(editing.id, payload);
      else await addSponsor({ ...payload, display_order: items.length });

      // Only once the row points at the new logo is the old one removed.
      if (editing && editing.logo_url !== payload.logo_url && !isShared(editing.logo_url, editing.id)) {
        await deleteStoredImageAt(editing.logo_url);
      }

      closeForm();
      setForm(emptyForm);
      await load();
    } catch (err) {
      if (uploadedUrl) await deleteStoredImageAt(uploadedUrl);
      setError(describeSaveError(err, 'sponsor'));
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Remove ${item.name} from the sponsors?`)) return;
    try {
      await deleteSponsor(item, { keepFile: isShared(item.logo_url, item.id) });
      await load();
    } catch (err) { window.alert(describeSaveError(err, 'sponsor')); }
  };

  const togglePublished = async (item) => {
    try {
      await updateSponsor(item.id, { is_published: !item.is_published });
      await load();
    } catch (err) { window.alert(describeSaveError(err, 'sponsor')); }
  };

  const move = async (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    await reorderSponsors(next.map(i => i.id));
  };

  if (isLoading) return <div className="admin-empty-state">Loading sponsors…</div>;

  if (loadError) {
    return (
      <div className="admin-drive-warning">
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{loadError}</span>
      </div>
    );
  }

  const hiddenCount = items.filter(i => !i.is_published).length;
  const featuredCount = items.filter(i => i.is_featured && i.is_published).length;

  return (
    <div>
      <div className="admin-reg-actions" style={{ justifyContent: 'space-between' }}>
        <span className="text-muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>
          {items.length} sponsor{items.length === 1 ? '' : 's'}
          {featuredCount > 0 && ` · ${featuredCount} featured`}
          {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
        </span>
        <button className="btn btn-primary admin-action-btn" onClick={startAdd} style={{ gap: '6px' }}>
          <Plus size={18} /> <span className="admin-action-label">Add Sponsor</span>
        </button>
      </div>

      <p className="admin-field-hint" style={{ marginTop: 0, marginBottom: '1rem' }}>
        Logos scroll in a strip near the foot of the homepage, each linking to the sponsor&apos;s
        website. Mark a partner such as a media partner as <strong>featured</strong> to also credit
        it in the hero, under the Register button.
      </p>

      {items.length === 0 ? (
        <div className="admin-empty-state" style={{ padding: '3rem 1rem' }}>
          <p>No sponsors yet. The sponsors section stays hidden on the landing page until you add one.</p>
        </div>
      ) : (
        <div className="admin-content-list">
          {items.map((item, index) => (
            <div key={item.id} className={`admin-content-row admin-sponsor-row glass ${item.is_published ? '' : 'is-hidden'}`}>
              <span className={`admin-sponsor-thumb is-${item.logo_background === 'dark' ? 'dark' : 'light'}`}>
                <img src={resolveImageUrl(item.logo_url)} alt="" loading="lazy" />
              </span>
              <div className="admin-content-main">
                <div className="admin-content-title">
                  {item.name}
                  {item.is_featured && <span className="admin-content-flag admin-content-flag--featured">Featured</span>}
                  {!item.is_published && <span className="admin-content-flag">Hidden</span>}
                </div>
                <p className="admin-content-body">
                  {item.label && <>{item.label} · </>}
                  {item.website_url ? (
                    <a href={item.website_url} target="_blank" rel="noopener noreferrer" className="admin-sponsor-link">
                      {hostOf(item.website_url)} <ExternalLink size={11} />
                    </a>
                  ) : 'No website link'}
                </p>
              </div>
              <div className="admin-content-actions">
                <button className="admin-cat-action-btn" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up"><ArrowUp size={14} /></button>
                <button className="admin-cat-action-btn" onClick={() => move(index, 1)} disabled={index === items.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
                <button className="admin-cat-action-btn" onClick={() => togglePublished(item)} aria-label={item.is_published ? 'Hide' : 'Publish'}>
                  {item.is_published ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button className="admin-cat-action-btn" onClick={() => startEdit(item)}><Edit3 size={14} /> Edit</button>
                <button className="admin-cat-action-btn admin-cat-delete-btn" onClick={() => remove(item)} aria-label="Delete"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <ContentModal
          title={editing ? `Edit ${editing.name}` : 'Add Sponsor'}
          error={error}
          isSaving={isSaving}
          onSubmit={save}
          onClose={closeForm}
        >
          <LogoField
            value={form.logo_url}
            savedValue={editing?.logo_url || ''}
            pending={pending}
            background={form.logo_background}
            disabled={isSaving}
            onProcessing={setIsProcessing}
            onPending={(next) => {
              setPending(next);
              if (next) setField('logo_background', next.logo.suggestedBackground);
              setError('');
            }}
            onChange={(url) => setField('logo_url', url)}
            onBackground={(bg) => setField('logo_background', bg)}
          />

          <div className="admin-media-form-grid" style={{ marginTop: '1rem' }}>
            <div className="admin-media-form-group">
              <label htmlFor="sp-name">Sponsor name <span className="admin-required">*</span></label>
              <input id="sp-name" name="name" value={form.name} onChange={onInput} placeholder="Sakal Times" />
              <span className="admin-field-hint">Read aloud by screen readers in place of the logo.</span>
            </div>
            <div className="admin-media-form-group">
              <label htmlFor="sp-web">Website</label>
              <input id="sp-web" name="website_url" value={form.website_url} onChange={onInput} placeholder="https://www.sakaltimes.com" inputMode="url" />
              <span className="admin-field-hint">The logo links here in a new tab. Leave blank for no link.</span>
            </div>
          </div>

          <div className="admin-media-form-group" style={{ marginTop: '0.85rem' }}>
            <label htmlFor="sp-label">Partner label</label>
            <input id="sp-label" name="label" value={form.label} onChange={onInput} placeholder="Media Partner" />
            <span className="admin-field-hint">
              Shown above a featured sponsor&apos;s logo. Left blank, it reads &ldquo;In association with&rdquo;.
            </span>
          </div>

          <div className="admin-event-toggle" style={{ marginTop: '1rem' }}>
            <label className="admin-toggle-label">
              <input type="checkbox" name="is_featured" checked={form.is_featured} onChange={onInput} className="admin-toggle-checkbox" />
              <span className="admin-toggle-switch"></span>
              <span>{form.is_featured ? 'Featured: credited in the hero and shown larger' : 'In the logo strip only'}</span>
            </label>
          </div>
          <div className="admin-event-toggle" style={{ marginTop: '0.75rem' }}>
            <label className="admin-toggle-label">
              <input type="checkbox" name="is_published" checked={form.is_published} onChange={onInput} className="admin-toggle-checkbox" />
              <span className="admin-toggle-switch"></span>
              <span>{form.is_published ? 'Visible on the site' : 'Hidden from the site'}</span>
            </label>
          </div>
        </ContentModal>
      )}
    </div>
  );
}

/* ── Logo picker ──────────────────────────────────────────────────────────── */

/**
 * A chosen file is processed straight away so the preview shows exactly what
 * will be served, but nothing is uploaded until the form is saved. An
 * abandoned edit therefore leaves nothing behind in the bucket.
 *
 * `pending` is { logo, fileName, previewUrl } for a logo waiting to upload.
 */
function LogoField({ value, savedValue, pending, background, disabled, onProcessing, onPending, onChange, onBackground }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [broken, setBroken] = useState(false);
  const inputRef = useRef(null);

  const busy = disabled || isProcessing;
  const shown = pending?.previewUrl || (value ? resolveImageUrl(value) : '');
  const isUnsaved = !!pending || (value || '') !== (savedValue || '');

  useEffect(() => { setBroken(false); }, [shown]);

  const handleFile = async (file) => {
    if (!file || busy) return;
    setError('');
    setIsProcessing(true);
    onProcessing(true);
    try {
      const logo = await prepareLogo(file);
      onPending({ logo, fileName: file.name, previewUrl: URL.createObjectURL(logo.blob) });
      setShowUrlInput(false);
    } catch (err) {
      setError(err.message || 'This logo could not be processed.');
    } finally {
      setIsProcessing(false);
      onProcessing(false);
    }
  };

  const applyUrl = () => {
    setError('');
    const result = normalizeMediaUrl(urlDraft, 'image');
    if (!result.ok) { setError(result.error); return; }
    onPending(null);
    onChange(result.url);
    setUrlDraft('');
    setShowUrlInput(false);
  };

  return (
    <div className="admin-image-field">
      <span className="admin-image-field-label">Logo <span className="admin-required">*</span></span>

      <div
        className={`admin-hero-field admin-logo-field ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files?.[0]); }}
      >
        <span className={`admin-logo-preview is-${background}`}>
          {isProcessing ? (
            <RefreshCw size={18} className="spin" aria-label="Preparing logo" />
          ) : shown && !broken ? (
            <img src={shown} alt="Logo preview" onError={() => setBroken(true)} />
          ) : shown ? (
            <span className="admin-logo-preview-empty"><ImageOff size={18} /> Not loading</span>
          ) : (
            <span className="admin-logo-preview-empty">No logo yet</span>
          )}
        </span>

        <div className="admin-logo-field-side">
          <div className="admin-hero-field-status" aria-live="polite">
            {pending ? (
              <>
                <span className="admin-hero-field-title" title={pending.fileName}>{pending.fileName}</span>
                <span className="admin-hero-field-detail">
                  {pending.logo.width} × {pending.logo.height} {pending.logo.ext.toUpperCase()},{' '}
                  {Math.max(1, Math.round(pending.logo.blob.size / 1024))} KB
                </span>
              </>
            ) : value ? (
              <span className="admin-hero-field-detail" title={value}>{value}</span>
            ) : null}
            {isUnsaved && !isProcessing && <span className="admin-hero-field-badge">Not saved yet</span>}
          </div>

          <div className="admin-image-preview-actions admin-hero-field-actions">
            <button type="button" className="admin-cat-action-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload size={13} /> {pending || value ? 'Replace' : 'Upload logo'}
            </button>
            {pending ? (
              <button type="button" className="admin-cat-action-btn" onClick={() => { onPending(null); setError(''); }} disabled={busy}>
                <X size={13} /> Discard
              </button>
            ) : (
              <button type="button" className="admin-cat-action-btn" onClick={() => setShowUrlInput(v => !v)} disabled={busy}>
                <Link2 size={13} /> Use a URL
              </button>
            )}
          </div>

          <div className="admin-chip-row" role="group" aria-label="Tile behind the logo">
            <span className="admin-field-hint" style={{ margin: '0 4px 0 0', alignSelf: 'center' }}>Tile:</span>
            {['light', 'dark'].map(bg => (
              <button
                key={bg}
                type="button"
                className={`admin-chip ${background === bg ? 'is-on' : ''}`}
                aria-pressed={background === bg}
                onClick={() => onBackground(bg)}
              >
                {bg === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {showUrlInput && !pending && (
        <div className="admin-image-url-row" style={{ marginTop: '0.5rem' }}>
          <input
            value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setError(''); }}
            placeholder="https://…/logo.png"
            aria-label="Logo URL"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } }}
          />
          <button type="button" className="btn btn-primary admin-action-btn" onClick={applyUrl}>Use</button>
          <button
            type="button"
            className="admin-cat-action-btn"
            onClick={() => { setShowUrlInput(false); setUrlDraft(''); setError(''); }}
            aria-label="Cancel URL entry"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_LOGO_TYPES.join(',')}
        className="sr-only"
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {pending?.logo.warning && (
        <div className="admin-hero-field-warning"><AlertTriangle size={14} /> <span>{pending.logo.warning}</span></div>
      )}
      {error ? (
        <div className="admin-login-error" style={{ marginTop: '0.5rem' }}><span>{error}</span></div>
      ) : (
        <span className="admin-field-hint">
          PNG with a transparent background or SVG works best. Empty margins are trimmed and the
          logo is resized in your browser; it goes live when you click Save. Pick the tile that
          keeps the logo readable: Dark for white artwork.
        </span>
      )}
    </div>
  );
}
