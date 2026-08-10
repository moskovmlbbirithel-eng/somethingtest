import React, { useState, useEffect } from 'react';
import Header from './components/Header.jsx';
import OpportunitySelector from './components/OpportunitySelector.jsx';
import OpportunityDetails from './components/OpportunityDetails.jsx';
import AnalysisResult from './components/AnalysisResult.jsx';
import AskBidSenseChat from './components/AskBidSenseChat.jsx';

import { getOpportunities, getOpportunityById } from './services/opportunityService.js';
import { analyzeOpportunity } from './services/agentforceService.js';

export default function App() {
  const [opportunities, setOpportunities] = useState([]);
  const [selectedOppId, setSelectedOppId] = useState('');
  const [selectedOpp, setSelectedOpp] = useState(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);

  // 1. Initial Load: Fetch list of Salesforce Opportunities
  useEffect(() => {
    async function loadInitialData() {
      const list = await getOpportunities();
      setOpportunities(list);
      if (list.length > 0) {
        setSelectedOppId(list[0].id);
        setSelectedOpp(list[0]);
      }
    }
    loadInitialData();
  }, []);

  // 2. Handle Opportunity Selection Change
  const handleSelectOpportunity = async (id) => {
    setSelectedOppId(id);
    setAnalysisResult(null); // Reset previous analysis when switching opps
    const oppDetails = await getOpportunityById(id);
    setSelectedOpp(oppDetails);
  };

  // 3. Main Action: Trigger Agentforce Bid Analysis
  const handleAnalyzeBid = async () => {
    if (!selectedOppId) return;
    setIsAnalyzing(true);
    try {
      // Call isolated Agentforce Service
      const result = await analyzeOpportunity(selectedOppId);
      setAnalysisResult(result);
    } catch (err) {
      console.error('Analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="app-container">
      {/* Header Bar */}
      <Header />

      {/* Main Single Page Container */}
      <main className="main-content">
        {/* Step 1: Dropdown Selector */}
        <OpportunitySelector
          opportunities={opportunities}
          selectedId={selectedOppId}
          onSelectOpportunity={handleSelectOpportunity}
        />

        {/* Step 2: Selected Opportunity Summary & Analyze Button */}
        <OpportunityDetails
          opportunity={selectedOpp}
          onAnalyze={handleAnalyzeBid}
          isAnalyzing={isAnalyzing}
        />

        {/* Step 3: Analysis Results (rendered after Analyze Bid is clicked) */}
        {analysisResult && (
          <>
            <AnalysisResult result={analysisResult} />
            
            {/* Step 4: AI / Agent Interaction Chat */}
            <AskBidSenseChat opportunityId={selectedOppId} />
          </>
        )}
      </main>

      {/* Internal App Footer */}
      <footer className="footer-bar">
        BidSense MVP — Agentforce & MCP Hackathon Demonstration — Salesforce Internal Tooling
      </footer>
    </div>
  );
}
