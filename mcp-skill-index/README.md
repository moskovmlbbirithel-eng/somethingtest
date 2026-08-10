# BidSense — Employee Skill Index MCP Server

A custom **FastMCP** server that powers SME identification, skill gap analysis, retraining recommendations, and hiring flags for the **BidSense AI Agent**.

After an opportunity is confirmed as **BID** with a high confidence score, the agent calls this MCP to assemble the right team and surface capability gaps.

---

## 🏗️ Project Structure

```
mcp-skill-index/
├── server.py                   ← FastMCP server (all 7 tools)
├── requirements.txt
├── render.yaml                 ← Render deployment config
├── data/
│   ├── employees.json          ← 20 hardcoded employee profiles
│   ├── skill_taxonomy.json     ← Skill aliases + retraining paths
│   └── training_catalog.json  ← Course/cert catalog
└── README.md
```

---

## 🔧 Tools Exposed

| Tool | Description |
|------|-------------|
| `find_smes_for_opportunity` | Find top-N matching SMEs given required skills + domain |
| `check_skill_gaps` | Compare RFP requirements against the full org skill inventory |
| `get_retraining_suggestions` | Return training paths (Trailhead, certs, courses) for each gap |
| `recommend_hiring` | Flag skills where hiring is faster/better than retraining |
| `get_employee_profile` | Full profile for a specific employee by ID |
| `list_all_employees` | Filterable list of all employees (by dept, seniority, availability) |
| `get_org_skill_inventory` | Full org-wide skill inventory with coverage bands |

---

## 🚀 Running Locally

### Prerequisites
- Python 3.11+
- pip or a virtual environment

### Setup

```bash
cd mcp-skill-index

# Create virtual environment
python -m venv venv

# Activate (Windows)
venv\Scripts\activate

# Activate (Mac/Linux)
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### Start the server

```bash
python server.py
```

Server will start on `http://localhost:8000` with SSE transport.

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://localhost:8000/sse
```

This opens a browser UI to call and test all 7 tools interactively.

---

## ☁️ Deploy to Render

### Step 1: Push to GitHub

Make sure your `testDevOrg` repo is on GitHub. The `render.yaml` at the root handles the rest.

```bash
git add mcp-skill-index/
git commit -m "feat: add Employee Skill Index MCP server"
git push
```

### Step 2: Create a Render Web Service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repository
3. Render auto-detects `render.yaml` — click **Deploy**
4. Wait for build to complete (~2 minutes)
5. Your server will be live at:
   ```
   https://bidsense-skill-index.onrender.com
   ```

> **Note**: Free tier on Render spins down after 15 minutes of inactivity.
> First request after sleep may take ~30 seconds. Upgrade to a paid instance for production use.

---

## 🔌 Registering the MCP Server

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "bidsense-skill-index": {
      "url": "https://bidsense-skill-index.onrender.com/sse"
    }
  }
}
```

Config file location:
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Agentforce / Custom Agent

Add the SSE endpoint as an external tool action in your agent's tool configuration:

```
URL:       https://bidsense-skill-index.onrender.com/sse
Transport: SSE
Auth:      None (add Bearer token auth in Render env vars for production)
```

### Local development (Claude Desktop)

For local testing, register the local server instead:

```json
{
  "mcpServers": {
    "bidsense-skill-index-local": {
      "url": "http://localhost:8000/sse"
    }
  }
}
```

---

## 📖 Example Agent Interaction

```
Agent: check_skill_gaps(skills_required=["HIPAA", "Health Cloud", "Data Cloud", "Epic EHR Integration"])

→ {
    "completely_missing": ["Epic EHR Integration"],
    "thin_coverage_risk": ["Salesforce Health Cloud"],
    "well_covered": ["HIPAA Compliance", "Salesforce Data Cloud"]
  }

Agent: get_retraining_suggestions(skill_gaps=["Epic EHR Integration"])

→ {
    "hire_recommended_skills": ["Epic EHR Integration"],
    "retraining_paths": {
      "Epic EHR Integration": {
        "hire_recommended": true,
        "hiring_note": "Epic certification requires working at an Epic customer site..."
      }
    }
  }

Agent: recommend_hiring(skill_gaps=["Epic EHR Integration"])

→ {
    "must_hire_skills": ["Epic EHR Integration"],
    "recommendations": {
      "Epic EHR Integration": {
        "role_title": "Epic Integration Specialist",
        "jd_keywords": ["Epic Systems", "MyChart", "Epic Bridges", "HL7", ...],
        "sourcing_timeline_weeks": 8,
        "platforms": ["LinkedIn", "Doximity", "Health eCareers"]
      }
    }
  }
```

---

## 🗺️ Future Scope

- **`get_available_employees(date_range)`** — Uses `availability_percent` field already in the data
- **Live HR data** — Connect to Salesforce People object or WorkDay API
- **Slack notifications** — Alert recommended SMEs when a BID is confirmed
- **Auth** — Add Bearer token via Render env vars for production security

---

## 🤝 Employee Data

20 employees spanning all practice areas:
- **Salesforce Practice** — Architects, Developers, FSL, Commerce, Agentforce specialists
- **Cloud & Infrastructure** — AWS/Azure/GCP architects, DevSecOps, Kubernetes
- **AI & Data Engineering** — ML Engineers, Data Engineers, RAG specialists
- **Project Delivery** — Delivery Managers, Scrum Masters, BAs, Bid Managers, UX
- **Domain & Industry** — Healthcare (HIPAA/FHIR), Financial Services (KYC/AML), Logistics (Supply Chain)
