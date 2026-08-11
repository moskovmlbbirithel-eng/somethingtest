/**
 * rfpService.js
 * Handles RFP file upload ingestion — sends raw text to Apex /ingest endpoint.
 */

export async function ingestRfp(rfpName, rfpContent) {
  const res = await fetch('/api/agentforce/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rfpName, rfpContent })
  });

  if (!res.ok) {
    throw new Error(`Ingest failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error || 'Unknown error during RFP ingestion');
  }
  return data;
}
