import React, { useState, useRef } from 'react';
import { ingestRfp } from '../services/rfpService.js';

const STAGES = {
  IDLE:       'idle',
  READING:    'reading',
  ANALYZING:  'analyzing',
  DONE:       'done',
  ERROR:      'error',
};

const STAGE_MESSAGES = {
  [STAGES.READING]:   'Reading your document...',
  [STAGES.ANALYZING]: 'Agentforce is analyzing the RFP. This may take 20–30 seconds...',
  [STAGES.DONE]:      'Analysis complete! Redirecting...',
};

export default function RfpUploader({ onSuccess }) {
  const [rfpName, setRfpName]   = useState('');
  const [file, setFile]         = useState(null);
  const [stage, setStage]       = useState(STAGES.IDLE);
  const [error, setError]       = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    if (!rfpName) {
      // Pre-fill the name from the file name (strip extension)
      setRfpName(f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    handleFile(dropped);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file || !rfpName.trim()) return;

    setError('');
    setStage(STAGES.READING);

    let content;
    try {
      content = await file.text();
    } catch {
      setError('Could not read file. Please ensure it is a plain text file.');
      setStage(STAGES.ERROR);
      return;
    }

    setStage(STAGES.ANALYZING);
    try {
      const result = await ingestRfp(rfpName.trim(), content);
      setStage(STAGES.DONE);
      setTimeout(() => onSuccess(result), 800);
    } catch (err) {
      setError(err.message || 'Ingestion failed. Please try again.');
      setStage(STAGES.ERROR);
    }
  };

  const isLoading = stage === STAGES.READING || stage === STAGES.ANALYZING || stage === STAGES.DONE;

  return (
    <div className="rfp-uploader-page">
      <div className="rfp-uploader-container">
        {/* Header */}
        <div className="rfp-uploader-header">
          <div className="rfp-uploader-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
          </div>
          <h2 className="rfp-uploader-title">New RFP Analysis</h2>
          <p className="rfp-uploader-subtitle">
            Upload your RFP document and Agentforce will analyze it, identify scope and gaps,
            recommend SMEs, and create a Salesforce Opportunity automatically.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="rfp-form">
          {/* RFP Name */}
          <div className="rfp-field">
            <label htmlFor="rfp-name" className="rfp-field-label">Bid / RFP Name</label>
            <input
              id="rfp-name"
              type="text"
              className="rfp-field-input"
              placeholder="e.g. DRDO Healthcare Platform RFP 2026"
              value={rfpName}
              onChange={(e) => setRfpName(e.target.value)}
              disabled={isLoading}
              required
            />
          </div>

          {/* File Drop Zone */}
          <div className="rfp-field">
            <label className="rfp-field-label">RFP Document</label>
            <div
              className={`rfp-dropzone ${isDragOver ? 'drag-over' : ''} ${file ? 'has-file' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !isLoading && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.csv,.rtf"
                style={{ display: 'none' }}
                onChange={(e) => handleFile(e.target.files[0])}
                disabled={isLoading}
              />
              {file ? (
                <div className="dropzone-file-info">
                  <span className="dropzone-file-icon">📄</span>
                  <div>
                    <div className="dropzone-file-name">{file.name}</div>
                    <div className="dropzone-file-size">{(file.size / 1024).toFixed(1)} KB</div>
                  </div>
                  {!isLoading && (
                    <button
                      type="button"
                      className="dropzone-clear-btn"
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    >✕</button>
                  )}
                </div>
              ) : (
                <div className="dropzone-placeholder">
                  <span className="dropzone-upload-icon">⬆️</span>
                  <div className="dropzone-text">
                    <strong>Click to browse</strong> or drag and drop your file here
                  </div>
                  <div className="dropzone-hint">Supported: .txt, .md, .csv, .rtf — Max 5MB</div>
                </div>
              )}
            </div>
          </div>

          {/* Loading Stage */}
          {isLoading && (
            <div className="rfp-loading">
              <div className="rfp-loading-spinner" />
              <div className="rfp-loading-text">{STAGE_MESSAGES[stage]}</div>
              {stage === STAGES.ANALYZING && (
                <div className="rfp-loading-steps">
                  <span className="step-chip active">Extracting Text</span>
                  <span className="step-chip active">Calling Agentforce</span>
                  <span className="step-chip">Creating Records</span>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {stage === STAGES.ERROR && (
            <div className="rfp-error-banner">
              ⚠️ {error}
              <button type="button" className="rfp-error-retry" onClick={() => setStage(STAGES.IDLE)}>
                Try Again
              </button>
            </div>
          )}

          {/* Submit */}
          {!isLoading && (
            <button
              type="submit"
              className={`rfp-submit-btn ${!file || !rfpName.trim() ? 'disabled' : ''}`}
              disabled={!file || !rfpName.trim()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              Analyze with Agentforce
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
