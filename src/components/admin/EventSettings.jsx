import React, { useState, useEffect } from 'react';
import { Save, RefreshCw, CheckCircle } from 'lucide-react';
import { getCurrentEvent, updateEvent } from '../../utils/services/events';
import { describeSaveError } from '../../utils/services/errors';

export default function EventSettings() {
  const [eventData, setEventData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => { loadEvent(); }, []);

  const loadEvent = async () => {
    setIsLoading(true);
    const data = await getCurrentEvent();
    setEventData(data);
    setIsLoading(false);
  };

  const handleInput = (e) => {
    const { name, value, type, checked } = e.target;
    setEventData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    setSaveMsg('');
  };

  // The payment columns arrive with migration 0011. Until then they are
  // neither shown nor saved, so this panel keeps working on a database that
  // has not been migrated yet.
  const hasPaymentSettings = !!eventData && 'online_payment_enabled' in eventData;

  const handleSave = async () => {
    if (!eventData) return;
    setIsSaving(true);
    setSaveMsg('');
    try {
      const hold = parseInt(eventData.payment_hold_minutes, 10);
      await updateEvent(eventData.id, {
        ...(hasPaymentSettings ? {
          online_payment_enabled: !!eventData.online_payment_enabled,
          // The database enforces 10-180; clamping here turns a typo into a
          // sensible value instead of a failed save.
          payment_hold_minutes: Number.isFinite(hold) ? Math.min(Math.max(hold, 10), 180) : 30,
        } : {}),
        name: eventData.name,
        date: eventData.date,
        location: eventData.location,
        venue: eventData.venue,
        description: eventData.description,
        flag_off_time: eventData.flag_off_time,
        registration_open: eventData.registration_open,
        edition: eventData.edition,
        hero_image: eventData.hero_image,
        hero_headline: eventData.hero_headline || null,
        hero_subcopy: eventData.hero_subcopy || null,
        last_registration_date: eventData.last_registration_date || null,
        total_slots: eventData.total_slots ? parseInt(eventData.total_slots) : null,
        contact_email: eventData.contact_email || null,
        contact_phone: eventData.contact_phone || null,
      });
      setSaveMsg('Event settings saved successfully!');
    } catch (err) {
      setSaveMsg(describeSaveError(err, 'event settings'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <div className="admin-empty-state">Loading event settings...</div>;
  if (!eventData) return (
    <div className="admin-empty-state" style={{ padding: '3rem 1rem' }}>
      <p>No event found in the database. Please seed the events table first.</p>
    </div>
  );

  return (
    <div>
      <div className="admin-media-header">
        <h3 style={{ margin: 0 }}>Event Settings</h3>
        <button className="btn btn-primary admin-action-btn" onClick={handleSave} disabled={isSaving} style={{ gap: '6px' }}>
          {isSaving ? <RefreshCw size={18} className="spin" /> : <Save size={18} />}
          <span className="admin-action-label">{isSaving ? 'Saving...' : 'Save Changes'}</span>
        </button>
      </div>

      {saveMsg && (
        <div className={`admin-save-msg ${saveMsg.includes('success') ? 'success' : 'error'}`}>
          <CheckCircle size={16} /> {saveMsg}
        </div>
      )}

      <div className="admin-event-form glass">
        {/* Basic Info */}
        <h4 className="admin-form-section-title">Basic Information</h4>
        <div className="admin-media-form-grid">
          <div className="admin-media-form-group">
            <label htmlFor="evt-name">Event Name</label>
            <input id="evt-name" name="name" value={eventData.name || ''} onChange={handleInput} />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-edition">Edition</label>
            <input id="evt-edition" name="edition" value={eventData.edition || ''} onChange={handleInput} placeholder="e.g. 3rd" />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-date">Event Date</label>
            <input id="evt-date" name="date" type="date" value={eventData.date || ''} onChange={handleInput} />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-flagoff">Flag-Off Time</label>
            <input id="evt-flagoff" name="flag_off_time" value={eventData.flag_off_time || ''} onChange={handleInput} placeholder="e.g. 06:45 AM" />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-location">Location</label>
            <input id="evt-location" name="location" value={eventData.location || ''} onChange={handleInput} />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-venue">Venue</label>
            <input id="evt-venue" name="venue" value={eventData.venue || ''} onChange={handleInput} />
          </div>
        </div>

        <div className="admin-media-form-group" style={{ marginTop: '0.75rem' }}>
          <label htmlFor="evt-hero">Hero Image URL</label>
          <input id="evt-hero" name="hero_image" value={eventData.hero_image || ''} onChange={handleInput} placeholder="/images/trail_hero.png" />
        </div>
        <div className="admin-media-form-group" style={{ marginTop: '0.75rem' }}>
          <label htmlFor="evt-desc">Description</label>
          <textarea id="evt-desc" name="description" value={eventData.description || ''} onChange={handleInput} rows={3} style={{ resize: 'vertical' }} />
        </div>

        {/* Homepage Hero */}
        <h4 className="admin-form-section-title" style={{ marginTop: '1.5rem' }}>Homepage Hero</h4>
        <div className="admin-media-form-group">
          <label htmlFor="evt-hero-headline">Hero Headline</label>
          <input id="evt-hero-headline" name="hero_headline" value={eventData.hero_headline || ''} onChange={handleInput} placeholder="RUN BEYOND LIMITS" />
          <span className="admin-field-hint">Displayed uppercase on the homepage. The last word is highlighted automatically.</span>
        </div>
        <div className="admin-media-form-group" style={{ marginTop: '0.75rem' }}>
          <label htmlFor="evt-hero-subcopy">Hero Sub-copy</label>
          <textarea id="evt-hero-subcopy" name="hero_subcopy" value={eventData.hero_subcopy || ''} onChange={handleInput} rows={3} style={{ resize: 'vertical' }} placeholder="Push past your limits at…" />
          <span className="admin-field-hint">Paragraph under the headline. Falls back to Description if left empty.</span>
        </div>

        {/* Registration Config */}
        <h4 className="admin-form-section-title" style={{ marginTop: '1.5rem' }}>Registration Configuration</h4>
        <div className="admin-media-form-grid">
          <div className="admin-media-form-group">
            <label htmlFor="evt-lastreg">Last Registration Date</label>
            <input id="evt-lastreg" name="last_registration_date" type="date" value={eventData.last_registration_date || ''} onChange={handleInput} />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-slots">Total Slots</label>
            <input id="evt-slots" name="total_slots" type="number" value={eventData.total_slots || ''} onChange={handleInput} placeholder="e.g. 500" />
          </div>
        </div>
        <div className="admin-event-toggle" style={{ marginTop: '1rem' }}>
          <label className="admin-toggle-label">
            <input type="checkbox" name="registration_open" checked={eventData.registration_open || false} onChange={handleInput} className="admin-toggle-checkbox" />
            <span className="admin-toggle-switch"></span>
            <span>Registration {eventData.registration_open ? 'Open' : 'Closed'}</span>
          </label>
        </div>

        {/* Payments */}
        <h4 className="admin-form-section-title" style={{ marginTop: '1.5rem' }}>Payments</h4>
        {hasPaymentSettings ? (
          <>
            <div className="admin-event-toggle">
              <label className="admin-toggle-label">
                <input type="checkbox" name="online_payment_enabled" checked={eventData.online_payment_enabled || false} onChange={handleInput} className="admin-toggle-checkbox" />
                <span className="admin-toggle-switch"></span>
                <span>Online payment (Razorpay) {eventData.online_payment_enabled ? 'On' : 'Off'}</span>
              </label>
            </div>
            <span className="admin-field-hint" style={{ display: 'block', marginTop: '0.5rem' }}>
              On: runners pay by Razorpay when they register, and their entry is confirmed automatically.
              An unpaid reservation is released after the hold time below. Off: entries are saved as
              payment pending and you collect payment yourselves. Switching off keeps any reservations
              already waiting as ordinary pending entries. Test a full payment before switching this on
              for the public.
            </span>
            <div className="admin-media-form-grid" style={{ marginTop: '0.75rem' }}>
              <div className="admin-media-form-group">
                <label htmlFor="evt-hold">Hold unpaid reservations for (minutes)</label>
                <input id="evt-hold" name="payment_hold_minutes" type="number" min={10} max={180} value={eventData.payment_hold_minutes ?? 30} onChange={handleInput} />
                <span className="admin-field-hint">10 to 180. 30 leaves time for a slow UPI approval.</span>
              </div>
            </div>
          </>
        ) : (
          <p className="admin-field-hint">
            Apply <code>supabase/migrations/0011_razorpay_payments.sql</code> to enable online payment.
          </p>
        )}

        {/* Contact Details */}
        <h4 className="admin-form-section-title" style={{ marginTop: '1.5rem' }}>Contact Details</h4>
        <div className="admin-media-form-grid">
          <div className="admin-media-form-group">
            <label htmlFor="evt-email">Contact Email</label>
            <input id="evt-email" name="contact_email" type="email" value={eventData.contact_email || ''} onChange={handleInput} placeholder="e.g. info@godatrailrun.com" />
          </div>
          <div className="admin-media-form-group">
            <label htmlFor="evt-phone">Contact Phone</label>
            <input id="evt-phone" name="contact_phone" value={eventData.contact_phone || ''} onChange={handleInput} placeholder="e.g. +91 82085 92273" />
          </div>
        </div>
      </div>
    </div>
  );
}
