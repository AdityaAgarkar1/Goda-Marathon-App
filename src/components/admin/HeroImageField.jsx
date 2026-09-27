import React, { useRef, useState } from 'react';
import { Upload, X, Link2, RotateCcw, RefreshCw, AlertTriangle } from 'lucide-react';
import { DEFAULT_HERO_IMAGE } from '../HeroImage';
import { parseUploadedHero } from '../../utils/heroVariants';
import { resizeHero, SHARP_HERO_WIDTH } from '../../utils/resizeHero';
import { storagePathFromPublicUrl } from '../../utils/services/storage';
import { getDriveFileId, normalizeMediaUrl } from '../../utils/mediaUrl';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
// The original never leaves the browser, so this only guards decoding memory.
const MAX_SOURCE_MB = 40;

function describeCurrent(url) {
  if (!url || url === DEFAULT_HERO_IMAGE) {
    return { title: 'Built-in trail photo', detail: 'Ships with the site' };
  }
  const hero = parseUploadedHero(url);
  if (hero) {
    return { title: 'Uploaded photo', detail: `${hero.widths[hero.widths.length - 1]} px wide, ${hero.widths.length} sizes` };
  }
  const path = storagePathFromPublicUrl(url);
  if (path) return { title: path.split('/').pop(), detail: 'Uploaded file, served at its original size' };
  if (getDriveFileId(url)) return { title: 'Google Drive photo', detail: url };
  return { title: url, detail: 'Linked image' };
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Picker for the homepage hero photo.
 *
 * A chosen file is resized straight away, so the preview shows exactly what
 * will be served, but nothing is uploaded until the form is saved. That way
 * an abandoned change leaves nothing behind in the bucket, and the live photo
 * is never deleted before its replacement is on the event row.
 *
 * `pending` is { resized, fileName, previewUrl } for a photo waiting to be
 * uploaded; `value` is the URL the row will hold when there is none.
 */
export default function HeroImageField({ value, savedValue, pending, onPending, onChange, disabled }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const inputRef = useRef(null);

  const busy = disabled || isProcessing;
  const isUnsaved = !!pending || (value || '') !== (savedValue || '');

  const handleFile = async (file) => {
    if (!file || busy) return;
    setError('');

    if (!ACCEPTED.includes(file.type)) {
      setError('Choose a JPG, PNG or WEBP photo.');
      return;
    }
    if (file.size > MAX_SOURCE_MB * 1024 * 1024) {
      setError(`That file is over ${MAX_SOURCE_MB} MB. Export a smaller copy and try again.`);
      return;
    }

    setIsProcessing(true);
    try {
      const resized = await resizeHero(file);
      const shown = resized.variants.filter(v => v.width <= SHARP_HERO_WIDTH).pop() ?? resized.variants[0];
      onPending({ resized, fileName: file.name, previewUrl: URL.createObjectURL(shown.blob) });
      setShowUrlInput(false);
    } catch (err) {
      setError(err.message || 'This photo could not be processed.');
    } finally {
      setIsProcessing(false);
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

  const current = describeCurrent(value);
  const warnings = [];
  if (pending) {
    const { width, height } = pending.resized;
    if (width < SHARP_HERO_WIDTH) {
      warnings.push(`Only ${width} px wide, so it may look soft on large screens. ${SHARP_HERO_WIDTH} px or wider is best.`);
    }
    if (height > width) {
      warnings.push('This is a portrait photo. The hero is a wide frame, so much of it will be cropped. Check the preview.');
    }
  }

  return (
    <div className="admin-image-field">
      <span className="admin-image-field-label">Hero photo</span>

      <div
        className={`admin-hero-field ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files?.[0]); }}
      >
        <div className="admin-hero-field-status" aria-live="polite">
          {isProcessing ? (
            <span className="admin-hero-field-title"><RefreshCw size={14} className="spin" /> Preparing photo…</span>
          ) : pending ? (
            <>
              <span className="admin-hero-field-title" title={pending.fileName}>{pending.fileName}</span>
              <span className="admin-hero-field-detail">
                {pending.resized.width} × {pending.resized.height} · {pending.resized.variants.length} sizes,{' '}
                {formatBytes(pending.resized.totalBytes)} in total
              </span>
            </>
          ) : (
            <>
              <span className="admin-hero-field-title" title={value || DEFAULT_HERO_IMAGE}>{current.title}</span>
              <span className="admin-hero-field-detail">{current.detail}</span>
            </>
          )}
          {isUnsaved && !isProcessing && (
            <span className="admin-hero-field-badge">Not saved yet</span>
          )}
        </div>

        <div className="admin-image-preview-actions admin-hero-field-actions">
          <button type="button" className="admin-cat-action-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload size={13} /> {pending ? 'Choose another' : 'Upload photo'}
          </button>
          {pending ? (
            <button type="button" className="admin-cat-action-btn" onClick={() => { onPending(null); setError(''); }} disabled={busy}>
              <X size={13} /> Discard
            </button>
          ) : (
            <>
              <button type="button" className="admin-cat-action-btn" onClick={() => setShowUrlInput(v => !v)} disabled={busy}>
                <Link2 size={13} /> Use a URL
              </button>
              {value && value !== DEFAULT_HERO_IMAGE && (
                <button type="button" className="admin-cat-action-btn" onClick={() => onChange(DEFAULT_HERO_IMAGE)} disabled={busy}>
                  <RotateCcw size={13} /> Use built-in photo
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {showUrlInput && !pending && (
        <div className="admin-image-url-row" style={{ marginTop: '0.5rem' }}>
          <input
            value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setError(''); }}
            placeholder="https://… or /images/trail_hero.png"
            aria-label="Hero photo URL"
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
        id="evt-hero-upload"
        type="file"
        accept={ACCEPTED.join(',')}
        className="sr-only"
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {warnings.map(w => (
        <div key={w} className="admin-hero-field-warning"><AlertTriangle size={14} /> <span>{w}</span></div>
      ))}
      {error ? (
        <div className="admin-login-error" style={{ marginTop: '0.5rem' }}><span>{error}</span></div>
      ) : (
        <span className="admin-field-hint">
          Drop a landscape photo here, or upload one. It is resized in your browser and goes live
          when you click Save Changes. Also used as the banner on the Event page.
        </span>
      )}
    </div>
  );
}
