import React, { useRef, useState } from 'react';
import { Upload, X, RefreshCw, AlertTriangle, Mountain } from 'lucide-react';
import { resizeCover, SHARP_COVER_WIDTH } from '../../utils/resizeCover';
import { storagePathFromPublicUrl } from '../../utils/services/storage';
import { resolveImageUrl } from '../../utils/mediaUrl';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
// The original never leaves the browser, so this only guards decoding memory.
const MAX_SOURCE_MB = 40;

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Picker for a past edition's cover, the photo on its card in the homepage
 * timeline. Like the hero photo, a chosen file is resized straight away but
 * only uploaded when the edition is saved, so cancelling leaves nothing in
 * the bucket and the current cover is never deleted before it is replaced.
 *
 * `pending` is { resized, fileName, previewUrl } for a photo waiting to be
 * uploaded; `value` is the URL the row will hold when there is none.
 */
export default function CoverPhotoField({ value, savedValue, pending, onPending, onChange, disabled }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [failedUrl, setFailedUrl] = useState(null);
  const inputRef = useRef(null);

  const busy = disabled || isProcessing;
  const isUnsaved = !!pending || (value || '') !== (savedValue || '');
  const isBroken = !pending && !!value && failedUrl === value;
  const shown = pending?.previewUrl || (isBroken ? null : resolveImageUrl(value, 400));

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
      const resized = await resizeCover(file);
      onPending({ resized, fileName: file.name, previewUrl: URL.createObjectURL(resized.blob) });
    } catch (err) {
      setError(err.message || 'This photo could not be processed.');
    } finally {
      setIsProcessing(false);
    }
  };

  let title, detail;
  if (isProcessing) {
    title = <><RefreshCw size={14} className="spin" /> Preparing photo…</>;
  } else if (pending) {
    title = pending.fileName;
    detail = `${pending.resized.width} × ${pending.resized.height} · ${formatBytes(pending.resized.blob.size)}`;
  } else if (isBroken) {
    title = 'Photo missing';
    detail = 'Its file is gone. Upload a new one.';
  } else if (value) {
    title = storagePathFromPublicUrl(value)?.split('/').pop() || value;
    detail = storagePathFromPublicUrl(value) ? 'Uploaded photo' : 'Linked photo';
  } else {
    title = 'No cover photo';
    detail = 'The timeline card shows a mountain icon instead.';
  }

  return (
    <div className="admin-image-field">
      <div
        className={`admin-hero-field ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files?.[0]); }}
      >
        <span className={`admin-cover-thumb ${isBroken ? 'is-broken' : ''}`} aria-hidden="true">
          {shown ? (
            <img src={shown} alt="" onError={() => { if (!pending) setFailedUrl(value); }} />
          ) : isBroken ? <AlertTriangle size={20} /> : <Mountain size={20} />}
        </span>

        <div className="admin-hero-field-status" aria-live="polite">
          <span className="admin-hero-field-title" title={typeof title === 'string' ? title : undefined}>{title}</span>
          {detail && <span className="admin-hero-field-detail">{detail}</span>}
          {isUnsaved && !isProcessing && <span className="admin-hero-field-badge">Not saved yet</span>}
        </div>

        <div className="admin-image-preview-actions admin-hero-field-actions">
          <button type="button" className="admin-cat-action-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload size={13} /> {pending || value ? 'Replace' : 'Upload photo'}
          </button>
          {pending ? (
            <button type="button" className="admin-cat-action-btn" onClick={() => { onPending(null); setError(''); }} disabled={busy}>
              <X size={13} /> Discard
            </button>
          ) : value && (
            <button type="button" className="admin-cat-action-btn admin-cat-delete-btn" onClick={() => onChange('')} disabled={busy}>
              <X size={13} /> Remove
            </button>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        id="pe-cover-upload"
        type="file"
        accept={ACCEPTED.join(',')}
        className="sr-only"
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {pending && pending.resized.width < SHARP_COVER_WIDTH && (
        <div className="admin-hero-field-warning">
          <AlertTriangle size={14} />
          <span>Only {pending.resized.width} px wide, so it may look soft on a laptop. {SHARP_COVER_WIDTH} px or wider is best.</span>
        </div>
      )}
      {error ? (
        <div className="admin-login-error" style={{ marginTop: '0.5rem' }}><span>{error}</span></div>
      ) : (
        <span className="admin-field-hint">
          Shown on this edition&rsquo;s card in &ldquo;The Story So Far&rdquo; on the homepage, cropped to a
          wide frame. A landscape photo works best. It is resized in your browser and uploaded when you save.
        </span>
      )}
    </div>
  );
}
