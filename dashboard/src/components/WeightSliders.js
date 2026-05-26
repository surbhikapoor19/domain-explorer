import React, { useState, useRef, useEffect } from 'react';
import { useDomainConfig } from '../DomainContext';
import Tooltip from './Tooltip';

export default function WeightSliders({ weights, defaultWeights, aiAdjustedCols, onChange, onReset }) {
  const { shortNames, weightColumns } = useDomainConfig();
  const [local, setLocal] = useState(weights);
  const debounceRef = useRef(null);

  // Sync local state when weights change externally (e.g., after query)
  useEffect(() => {
    setLocal(weights);
  }, [weights]);

  const handleChange = (col, value) => {
    const next = { ...local, [col]: Number(value) };
    setLocal(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(next), 500);
  };

  return (
    <div className="weight-panel">
      <div className="weight-panel-bar">
        <span className="weight-panel-label">Attribute Weights</span>
        <Tooltip text="Weights control how much each attribute contributes to the UMAP distance calculation. A higher weight means methods that differ on that attribute will be pushed further apart, while methods that agree will be pulled closer. Cluster labels are generated from the 3 highest-weighted columns. When you ask a query, the AI adjusts these to emphasize the most relevant attributes." wide>
          <span className="chart-help">?</span>
        </Tooltip>
        <button className="weight-reset-btn" onClick={onReset}>Reset Defaults</button>
      </div>
      <div className="weight-panel-grid">
        {weightColumns.map(col => {
          const val = local[col] ?? defaultWeights[col] ?? 10;
          const isAi = aiAdjustedCols && aiAdjustedCols.has(col);
          const label = shortNames[col] || col;
          return (
            <div key={col} className="weight-slider-row">
              <span className="weight-slider-label" title={col}>
                {label}
                {isAi && <span className="weight-ai-badge">AI</span>}
              </span>
              <input
                type="range"
                min="0"
                max="20"
                value={val}
                onChange={(e) => handleChange(col, e.target.value)}
                className="weight-slider-input"
              />
              <span className="weight-slider-value">{val}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
