import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Set up the PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export default function PdfViewer({ paperId, page, keywords, onClose }) {
  const [numPages, setNumPages] = useState(null);
  const [currentPage, setCurrentPage] = useState(page || 1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  const pdfUrl = `/papers/${paperId}.pdf`;

  // Ensure page is at least 1
  useEffect(() => {
    if (page && page >= 1) setCurrentPage(page);
  }, [page]);

  const onDocumentLoadSuccess = useCallback(({ numPages }) => {
    setNumPages(numPages);
    setLoading(false);
  }, []);

  const onDocumentLoadError = useCallback((err) => {
    setError(err.message);
    setLoading(false);
  }, []);

  // After page renders, highlight matching keywords in the text layer
  const highlightKeywords = useCallback(() => {
    if (!keywords || keywords.length === 0) return;
    if (!containerRef.current) return;

    // Wait for text layer to render
    setTimeout(() => {
      const textLayer = containerRef.current?.querySelector('.react-pdf__Page__textContent');
      if (!textLayer) return;

      const spans = textLayer.querySelectorAll('span');
      spans.forEach(span => {
        const text = span.textContent.toLowerCase();
        const hasMatch = keywords.some(kw => text.includes(kw.toLowerCase()));
        if (hasMatch) {
          span.classList.add('pdf-keyword-highlight');
        }
      });
    }, 500);
  }, [keywords]);

  const pageWidth = useMemo(() => {
    if (!containerRef.current) return 700;
    return Math.min(containerRef.current.offsetWidth - 40, 800);
  }, [containerRef.current]);

  if (!paperId) return null;

  return (
    <div className="pdf-viewer-overlay" onClick={onClose}>
      <div className="pdf-viewer-modal" onClick={e => e.stopPropagation()} ref={containerRef}>
        <div className="pdf-viewer-header">
          <div className="pdf-viewer-title">{paperId.replace(/-/g, ' ')}</div>
          <div className="pdf-viewer-controls">
            <button
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              className="pdf-nav-btn"
            >
              &larr; Prev
            </button>
            <span className="pdf-page-info">
              Page {currentPage}{numPages ? ` of ${numPages}` : ''}
            </span>
            <button
              disabled={currentPage >= (numPages || 1)}
              onClick={() => setCurrentPage(p => Math.min(numPages || p, p + 1))}
              className="pdf-nav-btn"
            >
              Next &rarr;
            </button>
            <button onClick={onClose} className="pdf-close-btn">&times;</button>
          </div>
        </div>

        {keywords && keywords.length > 0 && (
          <div className="pdf-keywords-bar">
            Highlighting: {keywords.slice(0, 5).map((kw, i) => (
              <span key={i} className="pdf-kw-tag">{kw}</span>
            ))}
          </div>
        )}

        <div className="pdf-viewer-content">
          {error && <div className="pdf-error">Failed to load PDF: {error}</div>}
          {loading && !error && <div className="pdf-loading">Loading PDF...</div>}

          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading=""
          >
            <Page
              pageNumber={currentPage}
              width={pageWidth}
              onRenderTextLayerSuccess={highlightKeywords}
              renderAnnotationLayer={true}
              renderTextLayer={true}
            />
          </Document>
        </div>
      </div>
    </div>
  );
}
