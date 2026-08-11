@RestResource(urlMapping='/bidsense/agentforce/v1/*')
global without sharing class BidSenseAgentforceAPI {

    global class AnalyzeRequest {
        global String opportunityId;
    }

    global class QARequest {
        global String opportunityId;
        global String question;
        global String sessionId;  // optional — omit on first turn, pass back on follow-ups
    }

    global class IngestRequest {
        global String rfpName;         // e.g. "DRDO Healthcare RFP 2026"
        global String rfpContent;      // full text extracted from the uploaded file
    }

    global class FitBreakdown {
        global Integer capabilityFit;
        global Integer customerFit;
        global Integer commercialFit;
    }

    global class FindingItem {
        global String type;
        global String text;
        global String source;
    }

    global class AnalysisResponse {
        global String opportunityId;
        global String opportunityName;
        global String accountName;
        global String recommendation;
        global String recommendationLabel;
        global Integer confidenceScore;
        global FitBreakdown fits;
        global List<FindingItem> keyFindings;
        global List<String> recommendedActions;
        global String agentRawResponse;
        global String timestamp;
        global Boolean executedInSalesforceOrg;
    }

    global class QAResponse {
        global String reply;
        global String sessionId;   // return to frontend so it can pass back on next turn
        global String opportunityId;
        global String timestamp;
    }

    global class IngestResponse {
        global String opportunityId;
        global String rfpId;
        global String summary;
        global String scope;
        global String gaps;
        global String smesRequired;
        global String recommendation;
        global Integer confidenceScore;
        global String timestamp;
        global Boolean success;
        global String error;
    }

    @HttpPost
    global static void handlePost() {
        RestRequest req   = RestContext.request;
        RestResponse res  = RestContext.response;
        res.addHeader('Content-Type', 'application/json');

        String requestURI = req.requestURI;

        try {
            if (requestURI.endsWith('/analyze')) {
                AnalyzeRequest analyzeReq = (AnalyzeRequest) JSON.deserialize(
                    req.requestBody.toString(), AnalyzeRequest.class
                );
                AnalysisResponse payload = executeAgentforceAnalysis(analyzeReq.opportunityId);
                res.responseBody = Blob.valueOf(JSON.serialize(payload));

            } else if (requestURI.endsWith('/chat')) {
                QARequest qaReq = (QARequest) JSON.deserialize(
                    req.requestBody.toString(), QARequest.class
                );
                QAResponse payload = executeAgentforceQA(qaReq.opportunityId, qaReq.question, qaReq.sessionId);
                res.responseBody = Blob.valueOf(JSON.serialize(payload));

            } else if (requestURI.endsWith('/ingest')) {
                IngestRequest ingestReq = (IngestRequest) JSON.deserialize(
                    req.requestBody.toString(), IngestRequest.class
                );
                IngestResponse payload = executeRFPIngestion(ingestReq.rfpName, ingestReq.rfpContent);
                res.responseBody = Blob.valueOf(JSON.serialize(payload));

            } else {
                res.statusCode   = 400;
                res.responseBody = Blob.valueOf('{"error": "Invalid endpoint. Use /analyze, /chat, or /ingest"}');
            }
        } catch (Exception e) {
            res.statusCode   = 500;
            res.responseBody = Blob.valueOf('{"error": "' + e.getMessage().replace('"', '\'') + '"}');
        }
    }

    // ── /analyze ────────────────────────────────────────────────────────────────
    private static AnalysisResponse executeAgentforceAnalysis(String oppId) {
        Opportunity opp = [
            SELECT Id, Name, Account.Name
            FROM Opportunity
            WHERE Id = :oppId
            LIMIT 1
        ];

        BidSenseAgentInvocableAction.QualificationInput inp = new BidSenseAgentInvocableAction.QualificationInput();
        inp.opportunityId = oppId;

        List<BidSenseAgentInvocableAction.QualificationOutput> llmOutputs =
            BidSenseAgentInvocableAction.analyzeOpportunityForBid(
                new List<BidSenseAgentInvocableAction.QualificationInput>{ inp }
            );

        AnalysisResponse resp      = new AnalysisResponse();
        resp.opportunityId         = opp.Id;
        resp.opportunityName       = opp.Name;
        resp.accountName           = opp.Account != null ? opp.Account.Name : '';
        resp.timestamp             = String.valueOf(Datetime.now());
        resp.executedInSalesforceOrg = true;

        if (!llmOutputs.isEmpty()) {
            BidSenseAgentInvocableAction.QualificationOutput out = llmOutputs[0];

            resp.recommendation      = out.recommendation;
            resp.recommendationLabel = 'RECOMMEND ' + out.recommendation;
            resp.confidenceScore     = out.confidenceScore;
            resp.agentRawResponse    = out.agentResponse;

            FitBreakdown fits   = new FitBreakdown();
            fits.capabilityFit  = out.capabilityFit;
            fits.customerFit    = out.customerFit;
            fits.commercialFit  = out.commercialFit;
            resp.fits           = fits;

            if (String.isNotBlank(out.keyFindingsJson)) {
                resp.keyFindings = (List<FindingItem>) JSON.deserialize(
                    out.keyFindingsJson, List<FindingItem>.class
                );
            }

            if (String.isNotBlank(out.recommendedActionsJson)) {
                resp.recommendedActions = (List<String>) JSON.deserialize(
                    out.recommendedActionsJson, List<String>.class
                );
            }
        }

        return resp;
    }

    // ── /chat ────────────────────────────────────────────────────────────────────
    private static QAResponse executeAgentforceQA(String oppId, String question, String incomingSessionId) {
        String replyText   = '';
        String returnedSessionId = '';

        try {
            Invocable.Action action = Invocable.Action.createCustomAction(
                'generateAiAgentResponse',
                'BidSense_Agent'
            );
            action.setInvocationParameter('userMessage', question);
            if (String.isNotBlank(incomingSessionId)) {
                action.setInvocationParameter('sessionId', incomingSessionId);
            }

            List<Invocable.Action.Result> results = action.invoke();

            if (!results.isEmpty() && results[0].isSuccess()) {
                Map<String, Object> outputs = results[0].getOutputParameters();

                Object sid = outputs.get('sessionId');
                if (sid != null) returnedSessionId = String.valueOf(sid);

                Object agentResp = outputs.get('agentResponse');
                if (agentResp != null) {
                    try {
                        Map<String, Object> respMap = (Map<String, Object>) agentResp;
                        Object val = respMap.get('value');
                        replyText = val != null ? String.valueOf(val) : String.valueOf(agentResp);
                    } catch (Exception castEx) {
                        try {
                            Map<String, Object> respMap = (Map<String, Object>) JSON.deserializeUntyped(String.valueOf(agentResp));
                            Object val = respMap.get('value');
                            replyText = val != null ? String.valueOf(val) : String.valueOf(agentResp);
                        } catch (Exception parseEx) {
                            replyText = String.valueOf(agentResp);
                        }
                    }
                }
            } else if (!results.isEmpty()) {
                System.debug('[BidSenseAgentforceAPI] Agent errors: ' + results[0].getErrors());
            }
        } catch (Exception e) {
            System.debug('[BidSenseAgentforceAPI] Agentforce invocation failed: ' + e.getMessage());
        }

        QAResponse resp    = new QAResponse();
        resp.reply         = String.isNotBlank(replyText)
                             ? replyText
                             : 'The Agentforce Agent could not process your request. Please try again.';
        resp.sessionId     = returnedSessionId;
        resp.opportunityId = oppId;
        resp.timestamp     = String.valueOf(Datetime.now());
        return resp;
    }

    // ── /ingest ──────────────────────────────────────────────────────────────────
    // Receives RFP document text, uses Agentforce to extract structured data,
    // creates an Opportunity and RFP__c record, and returns IDs to the frontend.
    private static IngestResponse executeRFPIngestion(String rfpName, String rfpContent) {
        IngestResponse resp = new IngestResponse();
        resp.timestamp = String.valueOf(Datetime.now());

        try {
            // Truncate to safe limit for Invocable action (Agentforce/Einstein)
            String truncatedContent = rfpContent.length() > 10000
                ? rfpContent.substring(0, 10000) + '...[truncated]'
                : rfpContent;

            String prompt =
                'You are BidSense, an AI that analyzes RFP documents for a technology consulting firm. ' +
                'Analyze the following RFP document text and respond ONLY with a valid JSON object. ' +
                'The JSON must have exactly these fields: ' +
                '"summary" (string: 2-3 sentence executive summary), ' +
                '"scope" (string: comma-separated list of key technical areas and deliverables), ' +
                '"gaps" (string: comma-separated list of capability gaps or risks for the consulting firm), ' +
                '"smesRequired" (string: comma-separated list of SME roles or skill areas needed), ' +
                '"recommendation" (string: exactly "BID" or "NO-BID"), ' +
                '"confidenceScore" (integer 0-100). ' +
                'No markdown, no explanation. Only valid JSON.\n\n' +
                'RFP Document:\n' + truncatedContent;

            Invocable.Action action = Invocable.Action.createCustomAction(
                'generateAiAgentResponse',
                'BidSense_Agent'
            );
            action.setInvocationParameter('userMessage', prompt);

            List<Invocable.Action.Result> results = action.invoke();

            String agentReplyText = '';
            if (!results.isEmpty() && results[0].isSuccess()) {
                Map<String, Object> outputs = results[0].getOutputParameters();
                Object agentResp = outputs.get('agentResponse');
                if (agentResp != null) {
                    try {
                        Map<String, Object> respMap = (Map<String, Object>) agentResp;
                        Object val = respMap.get('value');
                        agentReplyText = val != null ? String.valueOf(val) : String.valueOf(agentResp);
                    } catch (Exception ex) {
                        agentReplyText = String.valueOf(agentResp);
                    }
                }
            }

            // Parse the JSON from the agent response
            String summary = 'AI-analyzed RFP: ' + rfpName;
            String scope = '';
            String gaps = '';
            String smesRequired = '';
            String recommendation = 'BID';
            Integer confidenceScore = 70;

            if (String.isNotBlank(agentReplyText)) {
                // Extract JSON block from agent response
                Integer jsonStart = agentReplyText.indexOf('{');
                Integer jsonEnd   = agentReplyText.lastIndexOf('}');
                if (jsonStart >= 0 && jsonEnd > jsonStart) {
                    String jsonStr = agentReplyText.substring(jsonStart, jsonEnd + 1);
                    try {
                        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(jsonStr);
                        if (parsed.containsKey('summary'))         summary         = String.valueOf(parsed.get('summary'));
                        if (parsed.containsKey('scope'))           scope           = String.valueOf(parsed.get('scope'));
                        if (parsed.containsKey('gaps'))            gaps            = String.valueOf(parsed.get('gaps'));
                        if (parsed.containsKey('smesRequired'))    smesRequired    = String.valueOf(parsed.get('smesRequired'));
                        if (parsed.containsKey('recommendation'))  recommendation  = String.valueOf(parsed.get('recommendation')).toUpperCase();
                        if (parsed.containsKey('confidenceScore')) {
                            Object cs = parsed.get('confidenceScore');
                            if (cs != null) confidenceScore = Integer.valueOf(String.valueOf(cs));
                        }
                    } catch (Exception parseEx) {
                        System.debug('[Ingest] JSON parse error: ' + parseEx.getMessage());
                    }
                }
            }

            // Create Opportunity
            Opportunity opp = new Opportunity();
            opp.Name        = rfpName;
            opp.StageName   = 'Qualification';
            opp.CloseDate   = Date.today().addDays(90);
            opp.Description = summary;
            opp.LeadSource  = 'RFP Upload';
            insert opp;

            // Create RFP__c record
            RFP__c rfp = new RFP__c();
            rfp.Name             = rfpName;
            rfp.Opportunity__c   = opp.Id;
            rfp.Summary__c       = summary;
            rfp.Scope__c         = scope;
            rfp.Gaps__c          = gaps;
            rfp.SMEs_Required__c = smesRequired;
            rfp.Recommendation__c = recommendation;
            rfp.Confidence_Score__c = confidenceScore;
            insert rfp;

            resp.opportunityId   = opp.Id;
            resp.rfpId           = rfp.Id;
            resp.summary         = summary;
            resp.scope           = scope;
            resp.gaps            = gaps;
            resp.smesRequired    = smesRequired;
            resp.recommendation  = recommendation;
            resp.confidenceScore = confidenceScore;
            resp.success         = true;

        } catch (Exception e) {
            resp.success = false;
            resp.error   = e.getMessage();
            System.debug('[Ingest] Error: ' + e.getMessage());
        }

        return resp;
    }
}
