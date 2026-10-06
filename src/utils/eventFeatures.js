/**
 * Trim the items and drop blank ones before saving. Returns an error message
 * instead when an item has details but no title, since the page would show
 * an empty heading.
 */
export function cleanEventFeatures(items) {
  const cleaned = [];
  for (const item of Array.isArray(items) ? items : []) {
    const title = (item.title || '').trim();
    const description = (item.description || '').trim();
    if (!title && !description) continue;
    if (!title) return { error: 'Every Features & Expo item needs a title.' };
    cleaned.push(item.type === 'highlight' ? { title, description, type: 'highlight' } : { title, description });
  }
  return { features: cleaned };
}
