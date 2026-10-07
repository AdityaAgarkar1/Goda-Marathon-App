import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X, Trash2, AlertTriangle } from 'lucide-react';
import { MAX_FILE_BYTES } from '../../utils/services/storage';

// Above this the clip still uploads, but every visitor downloads it, so warn.
const COMFORTABLE_BYTES = 5 * 1024 * 1024;

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Optional looping video over the homepage hero photo (events.hero_video,
 * migration 0018). A chosen file waits as `pending` until Save Changes, like
 * the hero photo, so nothing is uploaded for a change that is then abandoned.
 *
 * Upload only: the site's Content-Security-Policy plays video from this site
 * and Supabase storage alone, so a link to a file elsewhere would never play.
 */
export default function HeroVideoField({ value, pending, onPending, onChange, disabled }) {
  const inputRef = useRef(null);
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(null);

  // An object URL for the chosen file, released when it is replaced or saved.
  const previewUrl = useMemo(() => (pending ? URL.createObjectURL(pending) : null), [pending]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const handleFile = (file) => {
    setError('');
    if (!file) return;
    if (file.type !== 'video/mp4') {
      setError('Choose an MP4 video.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`That video is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}. Export a shorter or smaller copy (720p is plenty).`);
      return;
    }
    setDuration(null);
    onPending(file);
  };

  const shown = previewUrl || value;
  const warnings = [];
  if (pending && pending.size > COMFORTABLE_BYTES) {
    warnings.push(`${formatBytes(pending.size)} is heavy for a phone on mobile data. Under 5 MB is better: trim it to 10–15 seconds or export at 720p.`);
  }
  if (duration && duration > 30) {
    warnings.push(`This clip runs ${Math.round(duration)} seconds. A 10–20 second loop is plenty and much lighter.`);
  }

  return (
    <div className="admin-image-field" style={{ marginTop: '1rem' }}>
      <span className="admin-image-field-label">Hero video (optional)</span>

      <div className="admin-hero-field">
        <div className="admin-hero-field-status" aria-live="polite">
          {pending ? (
            <>
              <span className="admin-hero-field-title" title={pending.name}>{pending.name}</span>
              <span className="admin-hero-field-detail">
                {formatBytes(pending.size)}{duration ? ` · ${Math.round(duration)} s` : ''}
              </span>
              <span className="admin-hero-field-badge">Not saved yet</span>
            </>
          ) : value ? (
            <>
              <span className="admin-hero-field-title">Video set</span>
              <span className="admin-hero-field-detail">Loops over the hero photo on the homepage.</span>
            </>
          ) : (
            <>
              <span className="admin-hero-field-title">No video</span>
              <span className="admin-hero-field-detail">The homepage shows the hero photo on its own.</span>
            </>
          )}
        </div>

        <div className="admin-image-preview-actions admin-hero-field-actions">
          <button type="button" className="admin-cat-action-btn" onClick={() => inputRef.current?.click()} disabled={disabled}>
            <Upload size={13} /> {pending || value ? 'Choose another' : 'Upload video'}
          </button>
          {pending && (
            <button type="button" className="admin-cat-action-btn" onClick={() => { onPending(null); setError(''); }} disabled={disabled}>
              <X size={13} /> Discard
            </button>
          )}
          {!pending && value && (
            <button type="button" className="admin-cat-action-btn admin-cat-delete-btn" onClick={() => onChange(null)} disabled={disabled}>
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
      </div>

      {shown && (
        <video
          key={shown}
          src={shown}
          className="admin-hero-video-preview"
          muted
          loop
          autoPlay
          playsInline
          controls
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />
      )}

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4"
        className="sr-only"
        aria-label="Upload hero video"
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {warnings.map(w => (
        <div key={w} className="admin-hero-field-warning"><AlertTriangle size={14} /> <span>{w}</span></div>
      ))}
      {error ? (
        <div className="admin-login-error" style={{ marginTop: '0.5rem' }}><span>{error}</span></div>
      ) : (
        <span className="admin-field-hint">
          A short MP4 (10–20 seconds, ideally under 5 MB) of real race footage, such as the start line
          or runners on the ridge. It plays muted on a loop over the photo, with a pause button. Visitors
          who have asked their device for reduced motion or to save data see the photo instead.
          It goes live when you click Save Changes.
        </span>
      )}
    </div>
  );
}
