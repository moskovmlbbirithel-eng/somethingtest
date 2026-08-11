import React, { useState } from 'react';
import Header from './components/Header.jsx';
import Dashboard from './components/Dashboard.jsx';
import RfpUploader from './components/RfpUploader.jsx';
import OpportunityDetails from './components/OpportunityDetails.jsx';
import AnalysisResult from './components/AnalysisResult.jsx';
import AskBidSenseChat from './components/AskBidSenseChat.jsx';

import { getOpportunityById } from './services/opportunityService.js';
import { analyzeOpportunity } from './services/agentforceService.js';

// Views / "pages"
const VIEW = {
  DASHBOARD: 'dashboard',
  NEW_RFP:   'new_rfp',
  OPP:       'opp',
};

export default function App() {
  const [view, setView]               = useState(VIEW.DASHBOARD);
  const [selectedOpp, setSelectedOpp] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [rfpResult, setRfpResult]     = useState(null);  // data returned by /ingest

  // ── Navigate to Opp detail from Dashboard ───────────────────────────────────
  const handleSelectOpportunity = async (opp) => {
    setAnalysisResult(null);
    setSelectedOpp(opp);
    setView(VIEW.OPP);
  };

  // ── Navigate to Opp after RFP ingestion ─────────────────────────────────────
  const handleRfpSuccess = async (result) => {
    setRfpResult(result);
    setAnalysisResult(null);

    // Build a minimal opp object from the ingest result
    const opp = {
      id:          result.opportunityId,
      name:        result.rfpId ? `${result.opportunityId}` : result.opportunityId,
      account:     '',
      amount:      0,
      stage:       'Qualification',
      closeDate:   '',
      description: result.summary,
    };

    // Try to load full details
    try {
      const full = await getOpportunityById(result.opportunityId);
      if (full) Object.assign(opp, full);
    } catch { /* use minimal */ }

    setSelectedOpp(opp);
    setView(VIEW.OPP);
  };

  // ── Trigger Agentforce bid analysis ─────────────────────────────────────────
  const handleAnalyzeBid = async () => {
    if (!selectedOpp?.id) return;
    setIsAnalyzing(true);
    try {
      const result = await analyzeOpportunity(selectedOpp.id);
      setAnalysisResult(result);
    } catch (err) {
      console.error('Analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // ── Back navigation ──────────────────────────────────────────────────────────
  const goHome = () => {
    setView(VIEW.DASHBOARD);
    setSelectedOpp(null);
    setAnalysisResult(null);
    setRfpResult(null);
  };

  return (
    <div className="app-container">
      <Header
        currentView={view}
        onHome={goHome}
        onNewRfp={() => setView(VIEW.NEW_RFP)}
      />

      <main className="main-content">

        {/* ── DASHBOARD ──────────────────────────────────────────────── */}
        {view === VIEW.DASHBOARD && (
          <Dashboard
            onSelectOpportunity={handleSelectOpportunity}
            onNewRfp={() => setView(VIEW.NEW_RFP)}
          />
        )}

        {/* ── NEW RFP UPLOAD ─────────────────────────────────────────── */}
        {view === VIEW.NEW_RFP && (
          <RfpUploader onSuccess={handleRfpSuccess} />
        )}

        {/* ── OPPORTUNITY DETAIL + CHAT ──────────────────────────────── */}
        {view === VIEW.OPP && selectedOpp && (
          <>
            {/* RFP Analysis Preview if freshly ingested */}
            {rfpResult && (
              <div className="rfp-summary-banner">
                <div className="rfp-banner-header">
                  <span className="rfp-banner-icon">🤖</span>
                  <strong>Agentforce RFP Analysis Complete</strong>
                  <span className={`rfp-banner-badge ${rfpResult.recommendation === 'BID' ? 'bid' : 'nobid'}`}>
                    {rfpResult.recommendation === 'BID' ? '✅ BID' : '🚫 NO-BID'} — {rfpResult.confidenceScore}% confidence
                  </span>
                </div>
                <div className="rfp-banner-grid">
                  <div className="rfp-banner-section">
                    <div className="rfp-section-label">📋 Summary</div>
                    <div className="rfp-section-body">{rfpResult.summary}</div>
                  </div>
                  <div className="rfp-banner-section">
                    <div className="rfp-section-label">🎯 Scope</div>
                    <div className="rfp-section-body">{rfpResult.scope}</div>
                  </div>
                  <div className="rfp-banner-section">
                    <div className="rfp-section-label">⚠️ Gaps</div>
                    <div className="rfp-section-body">{rfpResult.gaps}</div>
                  </div>
                  <div className="rfp-banner-section">
                    <div className="rfp-section-label">👥 SMEs Required</div>
                    <div className="rfp-section-body">{rfpResult.smesRequired}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Opportunity Details Card */}
            <OpportunityDetails
              opportunity={selectedOpp}
              onAnalyze={handleAnalyzeBid}
              isAnalyzing={isAnalyzing}
            />

            {/* Analysis Result */}
            {analysisResult && <AnalysisResult result={analysisResult} />}

            {/* Chat with Agentforce */}
            <AskBidSenseChat opportunityId={selectedOpp.id} />
          </>
        )}
      </main>

      <footer className="footer-bar">
        BidSense AI — Agentforce &amp; MCP Hackathon Demo — Salesforce Internal Tooling
      </footer>
    </div>
  );
}
