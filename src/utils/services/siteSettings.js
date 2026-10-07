import { supabase } from '../supabaseClient';

const TABLE = 'site_settings';

/**
 * The single site_settings row (migration 0018), or null. Never rejects:
 * before the migration runs, or offline, callers fall back to their defaults.
 */
export const getSiteSettings = async () => {
  try {
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', true).maybeSingle();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching site settings', error);
    return null;
  }
};

/** Admin only. Throws, so the caller can report why a save failed. */
export const updateSiteSettings = async (updates) => {
  const { data, error } = await supabase
    .from(TABLE)
    .update(updates)
    .eq('id', true)
    .select()
    .single();
  if (error) throw error;
  return data;
};
