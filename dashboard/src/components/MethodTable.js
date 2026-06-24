import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useDomainConfig } from '../DomainContext';

function getUniqueValues(data, col) {
  const vals = new Set();
  data.forEach(d => {
    const raw = d.metadata[col] || '';
    // Handle multi-value cells
    raw.split(',').forEach(v => {
      const trimmed = v.trim();
      if (trimmed) vals.add(trimmed);
    });
  });
  return [...vals].sort();
}

export default function MethodTable({
  data,
  allData,
  highlightedMethods,
  selectedPoint,
  hoveredIndex,
  onSelect,
  onHover,
  onUnhover,
  onFilter,
}) {
  const { shortNames, tableColumns } = useDomainConfig();
  const [filters, setFilters] = useState({});
  const [searchText, setSearchText] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const hasHighlights = highlightedMethods.length > 0;

  // Use allData (full 56) for unique filter values, fall back to data
  const sourceData = allData || data;

  // Compute unique values per column from full dataset
  const columnValues = useMemo(() => {
    const vals = {};
    tableColumns.forEach(col => {
      vals[col] = getUniqueValues(sourceData, col);
    });
    return vals;
  }, [sourceData]);

  // Apply filters to get matching methods
  const filteredData = useMemo(() => {
    let result = data;

    // Text search
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      result = result.filter(d =>
        d.name.toLowerCase().includes(q) ||
        Object.values(d.metadata).some(v => (v || '').toLowerCase().includes(q))
      );
    }

    // Column filters
    Object.entries(filters).forEach(([col, val]) => {
      if (val) {
        result = result.filter(d => {
          const cellVal = d.metadata[col] || '';
          return cellVal.toLowerCase().includes(val.toLowerCase());
        });
      }
    });

    return result;
  }, [data, filters, searchText]);

  // Sort: highlighted first, then alphabetical
  const tableData = useMemo(() => {
    return [...filteredData].sort((a, b) => {
      if (hasHighlights) {
        const aHL = highlightedMethods.includes(a.name) ? 0 : 1;
        const bHL = highlightedMethods.includes(b.name) ? 0 : 1;
        if (aHL !== bHL) return aHL - bHL;
      }
      return a.name.localeCompare(b.name);
    });
  }, [filteredData, hasHighlights, highlightedMethods]);

  // Cross-surface hover sync: when a method is hovered from ELSEWHERE (the KG
  // graph or the scatter), bring its row into view at the top of the table — but
  // ONLY if it's currently off-screen, so hovering a visible table row never yanks
  // the list out from under the cursor. This makes a KG-node hover actually show
  // the highlighted row instead of it sitting scrolled out of sight.
  const scrollRef = useRef(null);
  useEffect(() => {
    const cont = scrollRef.current;
    if (!cont || hoveredIndex == null) return;
    const row = cont.querySelector('tr.row-hov');
    if (!row) return;
    const r = row.getBoundingClientRect();
    const c = cont.getBoundingClientRect();
    if (r.top < c.top || r.bottom > c.bottom) {
      cont.scrollTop += (r.top - c.top); // bring the hovered row to the top of the visible area
    }
  }, [hoveredIndex, tableData]);

  const activeFilterCount = Object.values(filters).filter(Boolean).length + (searchText ? 1 : 0);

  const handleFilterChange = (col, val) => {
    const newFilters = { ...filters, [col]: val };
    if (!val) delete newFilters[col];
    setFilters(newFilters);
  };

  const handleApplyFilter = () => {
    if (onFilter) {
      const methodNames = filteredData.map(d => d.name);
      onFilter(methodNames.length < data.length ? methodNames : null);
    }
  };

  const handleClearFilters = () => {
    setFilters({});
    setSearchText('');
    if (onFilter) onFilter(null);
  };

  return (
    <div className="table-panel">
      <div className="table-panel-header">
        <span>Method Explorer</span>
        <span className="method-count">{filteredData.length} of {data.length}</span>
        {hasHighlights && (
          <span className="hl-indicator">{highlightedMethods.length} highlighted</span>
        )}
        <button className="filter-toggle-btn" onClick={() => setFiltersOpen(!filtersOpen)}>
          {filtersOpen ? 'Hide Filters' : 'Filters'}
          {activeFilterCount > 0 && ` (${activeFilterCount})`}
        </button>
      </div>

      {filtersOpen && (
        <div className="table-filter-bar">
          <input
            type="text"
            className="table-search"
            placeholder="Search methods..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
          {activeFilterCount > 0 && (
            <div className="table-filter-actions">
              <button className="filter-apply-btn" onClick={handleApplyFilter}>
                Re-cluster ({filteredData.length} methods)
              </button>
              <button className="filter-clear-btn" onClick={handleClearFilters}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      <div className="table-scroll" ref={scrollRef}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">Name</th>
              {tableColumns.map(col => (
                <th key={col}>
                  <div className="th-content">
                    <span className="th-label">{shortNames[col] || col}</span>
                    <select
                      className="th-filter"
                      value={filters[col] || ''}
                      onChange={e => handleFilterChange(col, e.target.value)}
                    >
                      <option value="">All</option>
                      {(columnValues[col] || []).map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableData.map(d => (
              <tr
                key={d.id}
                className={[
                  highlightedMethods.includes(d.name) ? 'row-hl' : '',
                  selectedPoint?.id === d.id ? 'row-sel' : '',
                  hoveredIndex === d.id ? 'row-hov' : ''
                ].join(' ')}
                onClick={() => onSelect(selectedPoint?.id === d.id ? null : d)}
                onMouseEnter={() => onHover(d.id)}
                onMouseLeave={onUnhover}
              >
                <td className="sticky-col name-cell">
                  {highlightedMethods.includes(d.name) && <span className="hl-dot" />}
                  {d.name}
                </td>
                {tableColumns.map(col => (
                  <td key={col} title={d.metadata[col] || ''}>
                    {col === 'Link(s)' && d.metadata[col]
                      ? <a href={d.metadata[col].split(/\s+/)[0]} target="_blank" rel="noopener noreferrer" className="table-link">Link</a>
                      : (d.metadata[col] || '-')
                    }
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
