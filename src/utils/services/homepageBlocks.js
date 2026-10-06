import { supabase } from '../supabaseClient';

const TABLE = 'homepage_blocks';

/**
 * The kinds of block, in the order the admin panel lists them. `kind` is the
 * value stored in the table (0016 constrains it to these three).
 */
export const BLOCK_KINDS = [
  { kind: 'story', label: 'Our Story' },
  { kind: 'usp', label: 'What Makes It Different' },
  { kind: 'tip', label: 'First-Timer Tips' },
];

/**
 * Public: published blocks grouped by kind, each group in display order.
 * Never rejects. Before migration 0016 runs, or on any failure, every group is
 * empty and the sections that depend on them stay hidden.
 */
export const getPublishedHomepageBlocks = async () => {
  const groups = { story: [], usp: [], tip: [] };
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('is_published', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    for (const block of data || []) groups[block.kind]?.push(block);
  } catch (error) {
    console.error('Error fetching homepage blocks', error);
  }
  return groups;
};

/** Admin: one kind, hidden blocks included. Throws so a missing table is reported. */
export const getHomepageBlocks = async (kind) => {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('kind', kind)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const addHomepageBlock = async (payload) => {
  const { data, error } = await supabase.from(TABLE).insert([payload]).select().single();
  if (error) throw error;
  return data;
};

export const updateHomepageBlock = async (id, updates) => {
  const { data, error } = await supabase.from(TABLE).update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const deleteHomepageBlock = async (id) => {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
  return true;
};

export const reorderHomepageBlocks = async (orderedIds) => {
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from(TABLE).update({ display_order: index }).eq('id', id)
    )
  );
};
