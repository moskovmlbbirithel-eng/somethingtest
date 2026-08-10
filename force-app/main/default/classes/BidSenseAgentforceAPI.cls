@RestResource(urlMapping='/bidsense/agentforce/v1/*')
global with sharing class BidSenseAgentforceAPI {

    global class AnalyzeRequest {
        global String opportunityId;
    }

    global class QARequest {
        global String opportunityId;
        global String question;
        global String sessionId;  // optional — omit on first turn, pass back on follow-ups
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

            } else {
                res.statusCode   = 400;
                res.responseBody = Blob.valueOf('{"error": "Invalid endpoint. Use /analyze or /chat"}');
            }
        } catch (Exception e) {
            res.statusCode   = 500;
            res.responseBody = Blob.valueOf('{"error": "' + e.getMessage() + '"}');
        }
    }

    // ── /analyze ────────────────────────────────────────────────────────────────
    // Calls the Invocable Action which internally calls Einstein LLM.
    // No formatting or decision logic here — everything comes from the LLM.
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
    // Sends the user’s question directly to the Agentforce Agent via Invocable.Action.
    // Pass in sessionId from a previous turn to maintain conversation context.
    // The agent decides which MCP tools to call — no keyword matching, no direct Render calls.
    private static QAResponse executeAgentforceQA(String oppId, String question, String incomingSessionId) {
        String replyText   = '';
        String returnedSessionId = '';

        try {
            Invocable.Action action = Invocable.Action.createCustomAction(
                'generateAiAgentResponse',
                'BidSense_Agent'
            );
            action.setInvocationParameter('userMessage', question);
            // Pass sessionId if we have one from a prior turn
            if (String.isNotBlank(incomingSessionId)) {
                action.setInvocationParameter('sessionId', incomingSessionId);
            }

            List<Invocable.Action.Result> results = action.invoke();

            if (!results.isEmpty() && results[0].isSuccess()) {
                Map<String, Object> outputs = results[0].getOutputParameters();

                // Capture the sessionId returned by the agent for the next turn
                Object sid = outputs.get('sessionId');
                if (sid != null) returnedSessionId = String.valueOf(sid);

                Object agentResp = outputs.get('agentResponse');
                if (agentResp != null) {
                    // agentResponse is a Map<String,Object>: {type:'Text', value:'...'}
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
}
