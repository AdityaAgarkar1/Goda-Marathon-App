import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit3, ArrowUp, ArrowDown, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import ContentModal from './ContentModal';
import { BlockIcon } from '../BlockIcon';
import { BLOCK_ICON_OPTIONS } from '../../utils/blockIcons';
import { describeSaveError } from '../../utils/services/errors';
import {
  BLOCK_KINDS, getHomepageBlocks, addHomepageBlock, updateHomepageBlock,
  deleteHomepageBlock, reorderHomepageBlocks,
} from '../../utils/services/homepageBlocks';

/**
 * Per-kind wording for the editor. `hasIcon` is false for the story, which is
 * rendered as text above the timeline with no icon.
 */
const KIND_COPY = {
  story: {
    noun: 'story',
    hasIcon: false,
    titleLabel: 'Opening line',
    titlePlaceholder: 'e.g. It started with a group of friends and a hill outside Nashik.',
    bodyLabel: 'Paragraph',
    bodyPlaceholder: 'Who you are, why you started this race, and what it has become.',
    hint: 'Shown above the past-editions timeline in "The Story So Far". One strong opening line, then two or three sentences: who organises the race, why it started, what it means to you. Only you can write this one.',
    empty: 'No story yet. The timeline shows on its own until you add one.',
  },
  usp: {
    noun: 'point',
    hasIcon: true,
    titleLabel: 'Heading',
    titlePlaceholder: 'e.g. Trail, not tarmac',
    bodyLabel: 'Text',
    bodyPlaceholder: 'One or two sentences a runner can check.',
    hint: 'Shown in "What Makes It Different". Things a runner gets here and not at other races. Keep each one specific and true: a claim a runner can check builds more trust than a superlative.',
    empty: 'No points yet. The "What Makes It Different" section is hidden until you add one.',
  },
  tip: {
    noun: 'tip',
    hasIcon: true,
    titleLabel: 'Heading',
    titlePlaceholder: 'e.g. Walking is fine',
    bodyLabel: 'Text',
    bodyPlaceholder: 'Practical advice for someone who has never run a trail race.',
    hint: 'Shown in "First Trail Run? Start Here", after the beginner-friendly distances. Good tips answer what first-timers ask: cut-off times, whether walking is allowed, what to wear and carry, how to reach the venue.',
    empty: 'No tips yet. The guide still lists beginner-friendly distances if any are marked in Categories.',
  },
};

const emptyForm = { title: '', body: '', icon: '', is_published: true };

/** "point" → "Point", for buttons and dialog titles. */
const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);

function describeLoadError(error) {
  const message = error?.message || '';
  if (/homepage_blocks/i.test(message) && /does not exist|schema cache/i.test(message)) {
    return 'The homepage_blocks table does not exist yet. Run supabase/migrations/0016_homepage_story_and_levels.sql in the Supabase SQL editor, then reload this page.';
  }
  return message ? `Could not load homepage content: ${message}` : 'Could not load homepage content.';
}

export default function HomepageBlocksManager() {
  const [kind, setKind] = useState('story');

  return (
    <div>
      <div className="admin-reg-actions" role="tablist" aria-label="Homepage section" style={{ gap: '6px', flexWrap: 'wrap' }}>
        {BLOCK_KINDS.map(k => (
          <button
            key={k.kind}
            role="tab"
            aria-selected={kind === k.kind}
            className={`btn ${kind === k.kind ? 'btn-outline' : 'btn-ghost'} admin-action-btn`}
            onClick={() => setKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Keyed so switching kind starts from a clean list and closed form. */}
      <BlockList key={kind} kind={kind} />
    </div>
  );
}

function BlockList({ kind }) {
  const copy = KIND_COPY[kind];
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setItems(await getHomepageBlocks(kind));
      setLoadError('');
    } catch (err) {
      setLoadError(describeLoadError(err));
    } finally {
      setIsLoading(false);
    }
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  const onInput = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    setError('');
  };

  const startAdd = () => {
    setForm(emptyForm); setEditingId(null); setError(''); setShowForm(true);
  };

  const startEdit = (item) => {
    setForm({
      title: item.title || '',
      body: item.body || '',
      icon: item.icon || '',
      is_published: item.is_published !== false,
    });
    setEditingId(item.id); setError(''); setShowForm(true);
  };

  const closeForm = useCallback(() => { setShowForm(false); setEditingId(null); }, []);

  const save = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) { setError(`${copy.titleLabel} is required.`); return; }

    setIsSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body.trim() || null,
        icon: copy.hasIcon ? (form.icon || null) : null,
        is_published: form.is_published,
      };
      if (editingId) await updateHomepageBlock(editingId, payload);
      else await addHomepageBlock({ ...payload, kind, display_order: items.length });
      setShowForm(false); setEditingId(null); setForm(emptyForm);
      await load();
    } catch (err) {
      setError(describeSaveError(err, `this ${copy.noun}`));
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    try { await deleteHomepageBlock(item.id); await load(); }
    catch (err) { window.alert(describeSaveError(err, `this ${copy.noun}`)); }
  };

  const togglePublished = async (item) => {
    try {
      await updateHomepageBlock(item.id, { is_published: !item.is_published });
      await load();
    } catch (err) { window.alert(describeSaveError(err, `this ${copy.noun}`)); }
  };

  const move = async (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    await reorderHomepageBlocks(next.map(i => i.id));
  };

  if (isLoading) return <div className="admin-empty-state">Loading…</div>;

  if (loadError) {
    return (
      <div className="admin-drive-warning">
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{loadError}</span>
      </div>
    );
  }

  const hiddenCount = items.filter(i => !i.is_published).length;

  return (
    <div>
      <p className="admin-field-hint" style={{ margin: '0.25rem 0 1rem' }}>{copy.hint}</p>

      <div className="admin-reg-actions" style={{ justifyContent: 'space-between' }}>
        <span className="text-muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>
          {items.length} {copy.noun}{items.length === 1 ? '' : 's'}
          {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
        </span>
        <button className="btn btn-primary admin-action-btn" onClick={startAdd} style={{ gap: '6px' }}>
          <Plus size={18} /> <span className="admin-action-label">Add {titleCase(copy.noun)}</span>
        </button>
      </div>

      {items.length === 0 ? (
        <div className="admin-empty-state" style={{ padding: '3rem 1rem' }}>
          <p>{copy.empty}</p>
        </div>
      ) : (
        <div className="admin-content-list">
          {items.map((item, index) => (
            <div key={item.id} className={`admin-content-row glass ${item.is_published ? '' : 'is-hidden'}`}>
              <div className="admin-content-main">
                <div className="admin-content-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {copy.hasIcon && <span className="text-primary" style={{ display: 'inline-flex' }}><BlockIcon name={item.icon} size={16} /></span>}
                  {item.title}
                  {!item.is_published && <span className="admin-content-flag">Hidden</span>}
                </div>
                {item.body && <p className="admin-content-body">{item.body}</p>}
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
          title={`${editingId ? 'Edit' : 'Add'} ${titleCase(copy.noun)}`}
          error={error}
          isSaving={isSaving}
          onSubmit={save}
          onClose={closeForm}
        >
          <div className="admin-media-form-group">
            <label htmlFor="hb-title">{copy.titleLabel} <span className="admin-required">*</span></label>
            <input id="hb-title" name="title" value={form.title} onChange={onInput} maxLength={140} placeholder={copy.titlePlaceholder} />
          </div>
          <div className="admin-media-form-group" style={{ marginTop: '0.85rem' }}>
            <label htmlFor="hb-body">{copy.bodyLabel}</label>
            <textarea id="hb-body" name="body" value={form.body} onChange={onInput} rows={kind === 'story' ? 6 : 4} style={{ resize: 'vertical' }} placeholder={copy.bodyPlaceholder} />
          </div>
          {copy.hasIcon && (
            <div className="admin-media-form-group" style={{ marginTop: '0.85rem', maxWidth: '320px' }}>
              <label htmlFor="hb-icon">Icon</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <select id="hb-icon" name="icon" value={form.icon} onChange={onInput}>
                  <option value="">Default (sparkles)</option>
                  {BLOCK_ICON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span className="text-primary" style={{ display: 'inline-flex' }}><BlockIcon name={form.icon} size={22} /></span>
              </div>
            </div>
          )}
          <div className="admin-event-toggle" style={{ marginTop: '1rem' }}>
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
