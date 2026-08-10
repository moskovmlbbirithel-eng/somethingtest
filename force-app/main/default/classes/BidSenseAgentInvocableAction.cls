public with sharing class BidSenseAgentInvocableAction {

    public class QualificationInput {
        @InvocableVariable(required=true label='Opportunity Record ID' description='Salesforce Opportunity ID to evaluate for Bid/No-Bid qualification')
        public String opportunityId;
    }

    public class QualificationOutput {
        @InvocableVariable(label='Agent Raw Response' description='Raw natural language output from the Einstein LLM')
        public String agentResponse;

        @InvocableVariable(label='Bid Recommendation' description='BID or NO-BID — decided by the LLM')
        public String recommendation;

        @InvocableVariable(label='Confidence Score' description='Integer 0-100 from LLM')
        public Integer confidenceScore;

        @InvocableVariable(label='Capability Fit Score' description='Integer 0-100 from LLM')
        public Integer capabilityFit;

        @InvocableVariable(label='Customer Fit Score' description='Integer 0-100 from LLM')
        public Integer customerFit;

        @InvocableVariable(label='Commercial Fit Score' description='Integer 0-100 from LLM')
        public Integer commercialFit;

        @InvocableVariable(label='Key Findings JSON')
        public String keyFindingsJson;

        @InvocableVariable(label='Recommended Actions JSON')
        public String recommendedActionsJson;
    }

    @InvocableMethod(
        label='Analyze Opportunity for Bid Qualification'
        description='Collects live Salesforce Opportunity data and historical benchmarks, then calls Einstein LLM to generate a Bid/No-Bid qualification — zero hardcoded logic.'
    )
    public static List<QualificationOutput> analyzeOpportunityForBid(List<QualificationInput> inputs) {
        List<QualificationOutput> results = new List<QualificationOutput>();
        if (inputs == null || inputs.isEmpty()) return results;

        for (QualificationInput input : inputs) {

            // ── Step 1: Query the target opportunity ─────────────────────────────
            Opportunity target = [
                SELECT Id, Name, AccountId, Account.Name, Account.Industry,
                       Amount, StageName, CloseDate, Probability, Type, LeadSource, Description
                FROM Opportunity
                WHERE Id = :input.opportunityId
                LIMIT 1
            ];

            // ── Step 2: Query historical closed opportunities across the org ──────
            List<Opportunity> historicals = [
                SELECT Id, Name, AccountId, StageName, Amount, IsWon, IsClosed, CloseDate, Type
                FROM Opportunity
                WHERE Id != :target.Id
                  AND (AccountId = :target.AccountId
                       OR Type   = :target.Type
                       OR IsClosed = true)
                ORDER BY CloseDate DESC
                LIMIT 50
            ];

            // ── Step 3: Aggregate raw SOQL metrics ──────────────────────────────
            Integer totalClosed  = 0;
            Integer totalWon     = 0;
            Integer acctTotal    = 0;
            Integer acctWon      = 0;
            Decimal sumWonAmt    = 0;

            List<String> wonSummaries  = new List<String>();
            List<String> lostSummaries = new List<String>();

            for (Opportunity h : historicals) {
                Boolean won = h.IsWon || (h.StageName != null && h.StageName.containsIgnoreCase('Won'));
                if (h.IsClosed) totalClosed++;
                if (won) {
                    totalWon++;
                    sumWonAmt += (h.Amount != null ? h.Amount : 0);
                }
                if (h.AccountId != null && h.AccountId == target.AccountId) {
                    acctTotal++;
                    if (won) acctWon++;
                }

                String summary = '- ' + h.Name
                    + ' | Stage: '  + h.StageName
                    + ' | Amount: $' + (h.Amount != null ? h.Amount.format() : '0')
                    + ' | Close: '  + String.valueOf(h.CloseDate);

                if (won) wonSummaries.add(summary);
                else     lostSummaries.add(summary);
            }

            Decimal avgWonAmt = totalWon > 0 ? (sumWonAmt / totalWon) : 0;

            // ── Step 4: Build prompt using only raw facts from SOQL ──────────────
            // Apex has no List.subList(); use index loop to cap at 5
            List<String> wonSnippet = new List<String>();
            for (Integer i = 0; i < Math.min(5, wonSummaries.size()); i++) {
                wonSnippet.add(wonSummaries[i]);
            }
            List<String> lostSnippet = new List<String>();
            for (Integer i = 0; i < Math.min(5, lostSummaries.size()); i++) {
                lostSnippet.add(lostSummaries[i]);
            }

            String prompt =
                'You are BidSense, an expert bid qualification AI assistant embedded inside Salesforce CRM.\n\n'
              + '## Target Opportunity (live from Salesforce Org)\n'
              + 'Name: '         + target.Name + '\n'
              + 'Account: '      + (target.Account != null ? target.Account.Name : 'Unknown') + '\n'
              + 'Industry: '     + (target.Account != null ? target.Account.Industry : 'Unknown') + '\n'
              + 'Stage: '        + target.StageName + '\n'
              + 'Amount: $'      + (target.Amount != null ? target.Amount.format() : '0') + '\n'
              + 'Close Date: '   + String.valueOf(target.CloseDate) + '\n'
              + 'Rep Win Probability: ' + (target.Probability != null ? target.Probability : 0) + '%\n'
              + 'Deal Type: '    + (target.Type != null ? target.Type : 'N/A') + '\n'
              + 'Lead Source: '  + (target.LeadSource != null ? target.LeadSource : 'N/A') + '\n\n'
              + '## Historical Benchmarks (live from Salesforce Org)\n'
              + 'Account history: ' + acctTotal + ' deals | ' + acctWon + ' Closed Won\n'
              + 'Org-wide: ' + totalClosed + ' closed deals | ' + totalWon + ' Closed Won\n'
              + 'Org average Closed Won deal size: $' + avgWonAmt.setScale(0).format() + '\n\n'
              + 'Recent Closed Won comparables:\n'
              + (wonSnippet.isEmpty() ? '(none found)\n' : String.join(wonSnippet, '\n') + '\n')
              + '\nRecent Closed Lost comparables:\n'
              + (lostSnippet.isEmpty() ? '(none found)\n' : String.join(lostSnippet, '\n') + '\n\n')
              + '## Your Task\n'
              + 'Using ONLY the above live Salesforce data, reason and decide:\n'
              + '1. Should this opportunity be bid or not? Consider the account history, deal size vs. won average, stage, and probability.\n'
              + '2. Assign Capability, Customer, and Commercial Fit scores as integers 0-100.\n'
              + '3. List 2-4 specific key findings drawn from the data above (cite which data point influenced you).\n'
              + '4. List 3 concrete recommended next actions.\n\n'
              + 'Respond ONLY as a single flat JSON object (no markdown fences, no explanation outside the JSON):\n'
              + '{\n'
              + '  "recommendation": "BID" or "NO-BID",\n'
              + '  "confidenceScore": <integer 0-100>,\n'
              + '  "capabilityFit": <integer 0-100>,\n'
              + '  "customerFit": <integer 0-100>,\n'
              + '  "commercialFit": <integer 0-100>,\n'
              + '  "keyFindings": [\n'
              + '    {"type": "positive" or "warning", "text": "<data-driven finding>", "source": "<e.g. Account History, Deal Size Benchmark>"}\n'
              + '  ],\n'
              + '  "recommendedActions": ["<action 1>", "<action 2>", "<action 3>"]\n'
              + '}\n';

            // ── Step 5: Call Einstein LLM — let the agent decide ─────────────────
            String agentRawResponse = callEinsteinLLM(prompt);

            // ── Step 6: Parse LLM JSON output into structured fields ─────────────
            QualificationOutput out = parseLLMResponse(agentRawResponse);
            results.add(out);
        }

        return results;
    }

    // ── Einstein LLM via aiplatform.ModelsAPI ────────────────────────────────────
    // Public so BidSenseAgentforceAPI can call it for the /chat endpoint too.
    public static String callEinsteinLLM(String promptText) {
        try {
            aiplatform.ModelsAPI.createGenerations_Request req = new aiplatform.ModelsAPI.createGenerations_Request();
            req.modelName = 'sfdc_ai__DefaultGPT4Omni'; // Einstein Trust Layer - GPT-4o via Salesforce

            aiplatform.ModelsAPI_GenerationRequest body = new aiplatform.ModelsAPI_GenerationRequest();
            body.prompt = promptText;
            req.body = body;

            // createGenerations is an instance method — must instantiate ModelsAPI
            aiplatform.ModelsAPI modelsAPI = new aiplatform.ModelsAPI();
            aiplatform.ModelsAPI.createGenerations_Response resp = modelsAPI.createGenerations(req);

            if (resp != null && resp.Code200 != null
                    && resp.Code200.generation != null
                    && String.isNotBlank(resp.Code200.generation.generatedText)) {
                return resp.Code200.generation.generatedText;
            }
        } catch (Exception e) {
            System.debug('BidSense LLM Error: ' + e.getMessage());
            return '{"error": "' + e.getMessage().replace('"', '\\"') + '"}';
        }
        return '{"error": "No response from Einstein LLM"}';
    }

    // ── Parse LLM JSON → QualificationOutput ────────────────────────────────────
    @TestVisible
    private static QualificationOutput parseLLMResponse(String rawResponse) {
        QualificationOutput out = new QualificationOutput();
        out.agentResponse = rawResponse;

        // Strip any accidental markdown code fences the LLM might add
        String cleaned = rawResponse != null ? rawResponse.trim() : '';
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replaceAll('(?s)```[a-z]*\\n?', '').replaceAll('```', '').trim();
        }

        try {
            Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(cleaned);

            out.recommendation  = String.valueOf(parsed.get('recommendation'));
            out.confidenceScore = Integer.valueOf(parsed.get('confidenceScore'));
            out.capabilityFit   = Integer.valueOf(parsed.get('capabilityFit'));
            out.customerFit     = Integer.valueOf(parsed.get('customerFit'));
            out.commercialFit   = Integer.valueOf(parsed.get('commercialFit'));

            if (parsed.containsKey('keyFindings')) {
                out.keyFindingsJson = JSON.serialize(parsed.get('keyFindings'));
            }
            if (parsed.containsKey('recommendedActions')) {
                out.recommendedActionsJson = JSON.serialize(parsed.get('recommendedActions'));
            }

        } catch (Exception e) {
            System.debug('BidSense parse error: ' + e.getMessage() + ' raw: ' + rawResponse);
            out.recommendation  = 'REVIEW';
            out.confidenceScore = 0;
            out.capabilityFit   = 0;
            out.customerFit     = 0;
            out.commercialFit   = 0;
            String safeRaw = rawResponse != null ? rawResponse.left(300) : '';
            out.keyFindingsJson = JSON.serialize(new List<Map<String, String>>{
                new Map<String, String>{
                    'type'   => 'warning',
                    'text'   => 'Agent response could not be parsed. Raw output: ' + safeRaw,
                    'source' => 'Einstein LLM'
                }
            });
        }

        return out;
    }
}
