import { supabase } from '../supabaseClient';
import { deleteStoredImageAt } from './storage';

const TABLE = 'sponsors';

/** Public: visible sponsors in display order. An empty result hides the section. */
export const getPublishedSponsors = async () => {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('is_published', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching sponsors', error);
    return [];
  }
};

/** Admin: everything, hidden sponsors included. Throws so a missing table is reported. */
export const getAllSponsors = async () => {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const addSponsor = async (payload) => {
  const { data, error } = await supabase.from(TABLE).insert([payload]).select().single();
  if (error) throw error;
  return data;
};

export const updateSponsor = async (id, updates) => {
  const { data, error } = await supabase.from(TABLE).update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

/**
 * Delete the row, then its uploaded logo. In that order so a failed delete
 * never leaves the homepage pointing at a file that is already gone; the worst
 * a failed file removal leaves is an unreferenced object in the bucket.
 * `keepFile` is set when another sponsor row uses the same logo URL.
 */
export const deleteSponsor = async (sponsor, { keepFile = false } = {}) => {
  const { error } = await supabase.from(TABLE).delete().eq('id', sponsor.id);
  if (error) throw error;
  if (!keepFile) await deleteStoredImageAt(sponsor.logo_url);
  return true;
};

export const reorderSponsors = async (orderedIds) => {
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from(TABLE).update({ display_order: index }).eq('id', id)
    )
  );
};

/**
 * Tidy a website typed into the admin form: "sakaltimes.com" becomes
 * "https://sakaltimes.com". Returns { ok, url } or { ok: false, error }.
 * An empty value is valid and means "no link".
 */
export function normalizeWebsiteUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: true, url: null };

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That website address is not valid.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) {
    return { ok: false, error: 'Enter a website address such as https://www.example.com' };
  }
  return { ok: true, url: parsed.href };
}
