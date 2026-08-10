@RestResource(urlMapping='/bidsense/agentforce/v1/*')
global with sharing class BidSenseAgentforceAPI {

    global class AnalyzeRequest {
        global String opportunityId;
    }

    global class QARequest {
        global String opportunityId;
        global String question;
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
                QAResponse payload = executeAgentforceQA(qaReq.opportunityId, qaReq.question);
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
    // For the Ask BidSense chat panel: passes question + opp context to LLM
    // and returns the raw natural language reply. No templating.
    private static QAResponse executeAgentforceQA(String oppId, String question) {
        Opportunity opp = [
            SELECT Id, Name, Account.Name, Amount, StageName, Probability, CloseDate
            FROM Opportunity
            WHERE Id = :oppId
            LIMIT 1
        ];

        String prompt =
            'You are BidSense, an expert bid qualification AI assistant embedded inside Salesforce.\n\n'
          + 'Opportunity context:\n'
          + '  Name: '   + opp.Name + '\n'
          + '  Account: ' + (opp.Account != null ? opp.Account.Name : 'Unknown') + '\n'
          + '  Stage: '  + opp.StageName + '\n'
          + '  Amount: $' + (opp.Amount != null ? opp.Amount.format() : '0') + '\n'
          + '  Close Date: ' + String.valueOf(opp.CloseDate) + '\n'
          + '  Win Probability: ' + opp.Probability + '%\n\n'
          + 'User question: ' + question + '\n\n'
          + 'Respond concisely and professionally in plain text (no JSON, no markdown headers).';

        String llmReply = BidSenseAgentInvocableAction.callEinsteinLLM(prompt);

        QAResponse resp     = new QAResponse();
        resp.reply          = llmReply;
        resp.opportunityId  = oppId;
        resp.timestamp      = String.valueOf(Datetime.now());
        return resp;
    }
}
