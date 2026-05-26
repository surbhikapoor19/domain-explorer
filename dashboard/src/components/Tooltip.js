import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';

export default function Tooltip({ children, text, wide = false }) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const timeoutRef = useRef(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipWidth = wide ? 320 : 240;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    // Keep tooltip within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - tooltipWidth - 8));
    // Show below if too close to top, otherwise above
    const showBelow = rect.top < 120;
    const top = showBelow ? rect.bottom + 8 : rect.top - 8;
    setCoords({ top, left, showBelow, tooltipWidth });
  }, [wide]);

  const show = () => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      updatePosition();
      setVisible(true);
    }, 250);
  };

  const hide = () => {
    clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const tooltip = visible ? ReactDOM.createPortal(
    <div
      className={`tooltip-bubble-fixed ${wide ? 'tooltip-wide' : ''}`}
      style={{
        top: coords.showBelow ? coords.top : undefined,
        bottom: coords.showBelow ? undefined : `${window.innerHeight - coords.top}px`,
        left: coords.left,
        width: coords.tooltipWidth,
      }}
    >
      {text}
    </div>,
    document.body
  ) : null;

  return (
    <span
      ref={triggerRef}
      className="tooltip-wrapper"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {tooltip}
    </span>
  );
}
