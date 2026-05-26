/**
 * Split a comma-separated string, respecting double-quoted fields.
 * "A, B" -> ['A', 'B']
 * 'Dexterous grasp, "6-DoF grasp pose (x, y, z, r, p, y)"'
 *   -> ['Dexterous grasp', '6-DoF grasp pose (x, y, z, r, p, y)']
 */
import { CLUSTER_COLORS } from './constants';

const COLUMN_COLORS = [
  '#0C3383', '#0A88BA', '#F2D338', '#F28F38', '#D91E1E',
  '#7B2D8E', '#3F681C', '#E75480', '#1B998B', '#FF6B6B',
  '#4A90D9', '#D4A017', '#8B4513', '#2E8B57', '#CD5C5C',
];

/**
 * Get the color for a data point based on the current colorBy mode.
 */
export function getPointColor(d, colorBy, colorMap) {
  if (colorBy === 'cluster') {
    return CLUSTER_COLORS[d.cluster] || '#999';
  }
  const parts = smartSplit(d.metadata?.[colorBy] || '');
  const primaryVal = parts.length > 0 ? parts[0] : 'N/A';
  const idx = colorMap?.[primaryVal] ?? 0;
  return COLUMN_COLORS[idx % COLUMN_COLORS.length];
}

/**
 * Build a value -> index map for column-based coloring.
 * Sorted by count descending to match the legend order.
 */
export function buildColorMap(data, colorBy) {
  if (!data.length || colorBy === 'cluster' || colorBy === 'index') return null;
  const counts = {};
  data.forEach(d => {
    const parts = smartSplit(d.metadata?.[colorBy] || '');
    const primary = parts.length > 0 ? parts[0] : 'N/A';
    counts[primary] = (counts[primary] || 0) + 1;
  });
  const map = {};
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([val], i) => { map[val] = i; });
  return map;
}

export function smartSplit(value) {
  if (!value) return [];
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) result.push(trimmed);
  return result;
}
