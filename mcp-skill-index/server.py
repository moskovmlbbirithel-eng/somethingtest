"""
============================================================
BidSense — Employee Skill Index MCP Server
============================================================

A custom FastMCP server that acts as a real-time Employee
Skill Index for the BidSense AI agent.

After an opportunity is confirmed as BID, the agent calls
this MCP to:
  1. Find the right SMEs for the bid team
  2. Identify skill gaps vs. RFP requirements
  3. Recommend retraining paths or flag hiring needs

Transport modes:
  - streamable-http (default): POST http://host:port/mcp
  - sse: GET http://host:port/sse -> POST /messages/?session_id=...
============================================================
"""

import json
import os
from pathlib import Path
from typing import Optional
from fastmcp import FastMCP

# ── Bootstrap ────────────────────────────────────────────
mcp = FastMCP(
    name="BidSense Employee Skill Index",
    instructions=(
        "This server provides employee skill matching, gap analysis, "
        "retraining suggestions, and hiring recommendations for RFP/bid qualification. "
        "Use find_smes_for_opportunity first, then check_skill_gaps, then "
        "get_retraining_suggestions or recommend_hiring for any gaps found."
    ),
)

# ── Data Loading ─────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data"


def _load_json(filename: str) -> dict | list:
    with open(DATA_DIR / filename, "r", encoding="utf-8") as f:
        return json.load(f)


def _get_employees() -> list[dict]:
    return _load_json("employees.json")


def _get_taxonomy() -> dict:
    data = _load_json("skill_taxonomy.json")
    return data.get("skills", {})


def _get_training_catalog() -> list[dict]:
    data = _load_json("training_catalog.json")
    return data.get("catalog", [])


# ── Helpers ───────────────────────────────────────────────

def _normalize_skill(skill: str, taxonomy: dict) -> str:
    """Normalize a skill name using aliases in taxonomy."""
    skill_lower = skill.lower().strip()
    for canonical, meta in taxonomy.items():
        if canonical.lower() == skill_lower:
            return canonical
        aliases = [a.lower() for a in meta.get("aliases", [])]
        if skill_lower in aliases:
            return canonical
    return skill  # return as-is if not found


def _normalize_skills(skills: list[str], taxonomy: dict) -> list[str]:
    return [_normalize_skill(s, taxonomy) for s in skills]


def _coerce_to_list(value) -> list[str]:
    """
    Safely coerce any input to list[str].
    Fixes the common MCP Inspector mistake of typing a plain string
    instead of a JSON array for a list parameter.

    Examples:
      "Salesforce Health Cloud"   -> ["Salesforce Health Cloud"]
      "Health Cloud, HIPAA, FSL" -> ["Health Cloud", "HIPAA", "FSL"]
      ["Health Cloud", "HIPAA"]  -> ["Health Cloud", "HIPAA"]  (unchanged)
      ""                         -> []
    """
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return []
        if value.startswith("["):
            import json as _json
            try:
                parsed = _json.loads(value)
                if isinstance(parsed, list):
                    return [str(v).strip() for v in parsed]
            except Exception:
                pass
        if "," in value:
            return [s.strip() for s in value.split(",") if s.strip()]
        return [value]
    return []


def _score_employee(employee: dict, required_skills: list[str], domain: str) -> dict:
    """
    Score an employee against required skills and domain.
    Returns a dict with score, matched_skills, missing_skills.
    """
    emp_skills_lower = [s.lower() for s in employee.get("skills", [])]
    emp_domains_lower = [d.lower() for d in employee.get("domain_experience", [])]
    emp_certs_lower = [c.lower() for c in employee.get("certifications", [])]

    matched = []
    missing = []

    for skill in required_skills:
        skill_l = skill.lower()
        found = any(skill_l in s for s in emp_skills_lower) or \
                any(skill_l in c for c in emp_certs_lower)
        if found:
            matched.append(skill)
        else:
            missing.append(skill)

    if not required_skills:
        skill_score = 0
    else:
        skill_score = (len(matched) / len(required_skills)) * 80

    domain_bonus = 0
    if domain and domain.lower() in emp_domains_lower:
        domain_bonus = 20

    total_score = round(min(skill_score + domain_bonus, 100))

    return {
        "score": total_score,
        "matched_skills": matched,
        "missing_skills_for_this_employee": missing,
        "domain_match": domain.lower() in emp_domains_lower if domain else False,
    }


def _build_org_skill_inventory(employees: list[dict]) -> dict[str, list[str]]:
    """Build org-wide skill -> [employee_ids] mapping."""
    inventory: dict[str, list[str]] = {}
    for emp in employees:
        for skill in emp.get("skills", []):
            skill_l = skill.lower()
            if skill_l not in inventory:
                inventory[skill_l] = []
            inventory[skill_l].append(emp["id"])
    return inventory


# ── Tool 1: Find SMEs ─────────────────────────────────────

@mcp.tool()
def find_smes_for_opportunity(
    skills_required: list[str],
    domain: str = "",
    top_n: int = 5,
) -> dict:
    """
    Find the best-matched Subject Matter Experts (SMEs) in the organisation
    for a given RFP or opportunity.
    """
    skills_required = _coerce_to_list(skills_required)
    employees = _get_employees()
    taxonomy = _get_taxonomy()

    normalized_skills = _normalize_skills(skills_required, taxonomy)

    scored = []
    for emp in employees:
        result = _score_employee(emp, normalized_skills, domain)
        scored.append({
            "employee_id": emp["id"],
            "name": emp["name"],
            "role": emp["role"],
            "seniority": emp["seniority"],
            "location": emp["location"],
            "fit_score": result["score"],
            "matched_skills": result["matched_skills"],
            "gaps_for_this_employee": result["missing_skills_for_this_employee"],
            "domain_match": result["domain_match"],
            "certifications": emp.get("certifications", []),
            "availability_percent": emp.get("availability_percent", 0),
            "projects_delivered": emp.get("projects_delivered", 0),
        })

    scored.sort(key=lambda x: (x["fit_score"], x["projects_delivered"]), reverse=True)
    top = scored[:top_n]

    return {
        "top_matches": top,
        "total_employees_evaluated": len(employees),
        "skills_evaluated": normalized_skills,
        "domain": domain or "Not specified",
    }


# ── Tool 2: Check Skill Gaps ──────────────────────────────

@mcp.tool()
def check_skill_gaps(skills_required: list[str]) -> dict:
    """
    Compare RFP-required skills against the organisation's entire skill inventory.
    """
    skills_required = _coerce_to_list(skills_required)
    employees = _get_employees()
    taxonomy = _get_taxonomy()

    normalized_skills = _normalize_skills(skills_required, taxonomy)
    inventory = _build_org_skill_inventory(employees)

    emp_map = {e["id"]: e["name"] for e in employees}

    completely_missing = []
    thin_coverage = []
    well_covered = []
    coverage_detail = {}

    for skill in normalized_skills:
        skill_l = skill.lower()

        matched_emp_ids = set()
        for inv_skill, emp_ids in inventory.items():
            if skill_l in inv_skill or inv_skill in skill_l:
                matched_emp_ids.update(emp_ids)

        employee_names = [emp_map[eid] for eid in matched_emp_ids if eid in emp_map]
        count = len(employee_names)

        coverage_detail[skill] = {
            "employee_count": count,
            "employees_with_this_skill": employee_names,
        }

        if count == 0:
            completely_missing.append(skill)
        elif count == 1:
            thin_coverage.append(skill)
        else:
            well_covered.append(skill)

    return {
        "skills_evaluated": normalized_skills,
        "completely_missing": completely_missing,
        "thin_coverage_risk": thin_coverage,
        "well_covered": well_covered,
        "coverage_detail": coverage_detail,
        "summary": (
            f"{len(completely_missing)} skill(s) completely missing, "
            f"{len(thin_coverage)} with thin coverage, "
            f"{len(well_covered)} well covered."
        ),
    }


# ── Tool 3: Retraining Suggestions ───────────────────────

@mcp.tool()
def get_retraining_suggestions(skill_gaps: list[str]) -> dict:
    """
    For each skill gap, return a retraining path with courses, certifications,
    estimated timeline, difficulty, and feasibility.
    """
    skill_gaps = _coerce_to_list(skill_gaps)
    taxonomy = _get_taxonomy()
    catalog = _get_training_catalog()

    retraining_paths = {}
    quick_wins = []
    medium_term = []
    long_term = []
    hire_recommended = []

    for gap in skill_gaps:
        normalized = _normalize_skill(gap, taxonomy)
        tax_entry = taxonomy.get(normalized)

        if not tax_entry:
            retraining_paths[gap] = {
                "status": "Unknown skill — not in taxonomy",
                "recommendation": "Manual research required. Consider hiring.",
                "hire_recommended": True,
            }
            hire_recommended.append(gap)
            continue

        retrain = tax_entry.get("retraining", {})
        is_hire = tax_entry.get("hire_recommended", False)

        matching_courses = [
            {
                "course_name": course["name"],
                "provider": course["provider"],
                "url": course["url"],
                "duration_weeks": course["duration_weeks"],
                "cost_band": course["cost_band"],
            }
            for course in catalog
            if any(
                normalized.lower() in s.lower() or s.lower() in normalized.lower()
                for s in course.get("skills_covered", [])
            )
        ]

        path_entry = {
            "skill": normalized,
            "hire_recommended": is_hire,
            "hiring_note": tax_entry.get("hiring_note", ""),
            "retraining_feasible": retrain.get("feasible", True),
            "retraining_path": retrain.get("path", "Not available"),
            "estimated_weeks": retrain.get("estimated_weeks", "Unknown"),
            "difficulty": retrain.get("difficulty", "Unknown"),
            "prerequisites": retrain.get("prerequisite_skills", []),
            "recommended_courses": matching_courses,
        }

        retraining_paths[gap] = path_entry

        if is_hire:
            hire_recommended.append(gap)
        else:
            weeks = retrain.get("estimated_weeks", 99)
            if isinstance(weeks, int):
                if weeks <= 4:
                    quick_wins.append(gap)
                elif weeks <= 12:
                    medium_term.append(gap)
                else:
                    long_term.append(gap)

    return {
        "retraining_paths": retraining_paths,
        "quick_wins_4_weeks_or_less": quick_wins,
        "medium_term_5_to_12_weeks": medium_term,
        "long_term_12_plus_weeks": long_term,
        "hire_recommended_skills": hire_recommended,
        "summary": (
            f"{len(quick_wins)} quick win(s), "
            f"{len(medium_term)} medium-term, "
            f"{len(long_term)} long-term retraining. "
            f"{len(hire_recommended)} skill(s) where hiring is recommended."
        ),
    }


# ── Tool 4: Hiring Recommendations ───────────────────────

@mcp.tool()
def recommend_hiring(skill_gaps: list[str]) -> dict:
    """
    For skill gaps where retraining is not feasible or takes too long,
    generate a hiring recommendation.
    """
    skill_gaps = _coerce_to_list(skill_gaps)
    taxonomy = _get_taxonomy()

    HIRING_TEMPLATES = {
        "Epic EHR Integration": {
            "role_title": "Epic Integration Specialist",
            "jd_keywords": [
                "Epic Systems", "MyChart", "Epic Bridges", "HL7", "FHIR",
                "Epic Certified", "EHR Integration", "Healthcare IT"
            ],
            "sourcing_timeline_weeks": 8,
            "platforms": ["LinkedIn", "Doximity", "Health eCareers", "HIMSS Career Center"],
            "salary_band": "Senior",
        },
        "SAP": {
            "role_title": "SAP Functional Consultant",
            "jd_keywords": [
                "SAP S/4HANA", "SAP MM", "SAP SD", "SAP FICO",
                "SAP Implementation", "SAP Rollout", "ABAP basics"
            ],
            "sourcing_timeline_weeks": 6,
            "platforms": ["LinkedIn", "Naukri", "SAP Community", "Indeed"],
            "salary_band": "Senior",
        },
        "CISSP": {
            "role_title": "Senior Cybersecurity Consultant",
            "jd_keywords": [
                "CISSP", "SOC 2", "ISO 27001", "Penetration Testing",
                "Threat Modelling", "SIEM", "Cloud Security", "NIST"
            ],
            "sourcing_timeline_weeks": 10,
            "platforms": ["LinkedIn", "CyberSecJobs", "Indeed", "Dice"],
            "salary_band": "Principal",
        },
        "Blockchain": {
            "role_title": "Blockchain / Web3 Developer",
            "jd_keywords": [
                "Solidity", "Ethereum", "Hyperledger", "Smart Contracts",
                "Web3.js", "DeFi", "NFT", "Distributed Ledger"
            ],
            "sourcing_timeline_weeks": 12,
            "platforms": ["LinkedIn", "CryptoJobsList", "Web3.career", "AngelList"],
            "salary_band": "Senior",
        },
    }

    recommendations = {}
    hire_flags = []
    no_hire_needed = []

    for gap in skill_gaps:
        normalized = _normalize_skill(gap, taxonomy)
        tax_entry = taxonomy.get(normalized, {})
        is_hire = tax_entry.get("hire_recommended", False)

        if is_hire:
            template = HIRING_TEMPLATES.get(
                normalized,
                {
                    "role_title": f"{normalized} Specialist",
                    "jd_keywords": [normalized, "implementation", "consulting"],
                    "sourcing_timeline_weeks": 8,
                    "platforms": ["LinkedIn", "Naukri", "Indeed"],
                    "salary_band": "Senior",
                },
            )
            recommendations[gap] = {
                "hire_recommended": True,
                "hiring_note": tax_entry.get("hiring_note", "Specialized skill — hiring recommended."),
                **template,
            }
            hire_flags.append(gap)
        else:
            recommendations[gap] = {
                "hire_recommended": False,
                "note": "Retraining is feasible — refer to get_retraining_suggestions for a training plan.",
            }
            no_hire_needed.append(gap)

    return {
        "recommendations": recommendations,
        "must_hire_skills": hire_flags,
        "retraining_preferred_skills": no_hire_needed,
        "summary": (
            f"{len(hire_flags)} skill(s) require hiring. "
            f"{len(no_hire_needed)} skill(s) can be addressed through retraining."
        ),
    }


# ── Tool 5: Employee Profile ──────────────────────────────

@mcp.tool()
def get_employee_profile(employee_id: str) -> dict:
    """Retrieve the full profile of a specific employee by their ID."""
    employees = _get_employees()
    for emp in employees:
        if emp["id"].upper() == employee_id.upper():
            return {"found": True, "employee": emp}
    return {
        "found": False,
        "error": f"No employee found with ID '{employee_id}'",
        "valid_ids": [e["id"] for e in employees],
    }


# ── Tool 6: List All Employees ────────────────────────────

@mcp.tool()
def list_all_employees(
    department: Optional[str] = None,
    seniority: Optional[str] = None,
    min_availability_percent: int = 0,
) -> dict:
    """List all employees in the organisation with optional filters."""
    employees = _get_employees()
    filtered = []

    for emp in employees:
        if department and emp.get("department", "").lower() != department.lower():
            continue
        if seniority and emp.get("seniority", "").lower() != seniority.lower():
            continue
        if emp.get("availability_percent", 0) < min_availability_percent:
            continue

        filtered.append({
            "id": emp["id"],
            "name": emp["name"],
            "role": emp["role"],
            "department": emp["department"],
            "seniority": emp["seniority"],
            "location": emp["location"],
            "availability_percent": emp["availability_percent"],
            "top_skills": emp["skills"][:5],
            "domain_experience": emp["domain_experience"],
        })

    return {
        "employees": filtered,
        "total": len(filtered),
        "filters_applied": {
            "department": department,
            "seniority": seniority,
            "min_availability_percent": min_availability_percent,
        },
    }


# ── Tool 7: Org Skill Inventory ───────────────────────────

@mcp.tool()
def get_org_skill_inventory() -> dict:
    """Return the organisation's complete skill inventory."""
    employees = _get_employees()
    inventory = _build_org_skill_inventory(employees)
    emp_map = {e["id"]: e["name"] for e in employees}

    result = []
    for skill, emp_ids in sorted(inventory.items()):
        names = [emp_map[eid] for eid in emp_ids if eid in emp_map]
        result.append({
            "skill": skill,
            "employee_count": len(names),
            "employees": names,
            "coverage": (
                "Strong" if len(names) >= 3
                else "Moderate" if len(names) == 2
                else "Thin"
            ),
        })

    result.sort(key=lambda x: x["employee_count"], reverse=True)

    return {
        "total_unique_skills": len(result),
        "total_employees": len(employees),
        "skill_inventory": result,
    }


# ── Entry Point ───────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from starlette.middleware.cors import CORSMiddleware
    from starlette.responses import JSONResponse

    port = int(os.environ.get("PORT", 8000))
    transport = os.environ.get("TRANSPORT", "sse")

    print(f"[BidSense Skill Index] Starting on port {port} with transport={transport}")
    print(f"  Salesforce SSE URL : http://localhost:{port}/sse")
    print(f"  Root Health Check  : http://localhost:{port}/")

    app = mcp.http_app(transport=transport)

    # Enable CORS for Salesforce and cross-origin clients
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Add root health check route for Salesforce URL reachability validation
    async def root_health_check(request):
        return JSONResponse({
            "status": "ok",
            "name": "BidSense Employee Skill Index MCP Server",
            "transport": transport,
            "sse_endpoint": "/sse",
            "mcp_endpoint": "/mcp"
        })

    app.add_route("/", root_health_check, methods=["GET", "HEAD"])

    uvicorn.run(app, host="0.0.0.0", port=port)
