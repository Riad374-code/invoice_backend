"""Five small development smoke cases. Requires a running real API.

These authored expectations are not independent or expert-reviewed test labels.
Saves observed responses, errors and latency; never fabricates a passing score.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import time

import httpx


ROOT = Path(__file__).resolve().parent


def cases():
    en = json.loads((ROOT / "examples/complaints_en.json").read_text())
    az = json.loads((ROOT / "examples/complaints_az.json").read_text())
    expected = {"procedure_a": "potential_inconsistency", "procedure_b": "appears_aligned", "resolution": "irrelevant"}
    yield "english_acknowledgement_vs_resolution", en, expected, False, False
    yield "azerbaijani_acknowledgement_vs_resolution", az, expected, False, False
    missing = copy.deepcopy(en)
    missing["documents"] = [missing["documents"][2]]
    yield "no_acknowledgement_evidence", missing, {"resolution": "irrelevant"}, False, True
    same = copy.deepcopy(en)
    same["new_requirement"] = same["old_requirement"]
    yield "identical_requirements", same, {}, True, False
    paraphrase = copy.deepcopy(en)
    paraphrase["documents"][0]["text"] = "Staff must confirm to the customer that their complaint has arrived no later than the fifth business day after receipt."
    yield "paraphrased_outdated_procedure", paraphrase, expected, False, False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--output", type=Path, default=Path("reports/live_smoke.json"))
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Report exists; use a new --output path to retain each attempt")
    headers = {}
    if os.environ.get("LEXAUDIT_API_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["LEXAUDIT_API_TOKEN"]
    results = []
    for name, payload, expected, unchanged, missing in cases():
        started = time.perf_counter()
        entry = {"case": name, "expected": expected, "passed": False}
        try:
            response = httpx.post(args.url.rstrip("/") + "/analyze-change", json=payload, headers=headers, timeout=330)
            response.raise_for_status()
            result = response.json()
            observed = {}
            for item in result["assessments"]:
                observed.setdefault(item["document_id"], []).append(item["status"])
            matches = all(observed.get(doc) == [status] for doc, status in expected.items())
            change_check = len(result["changes"]) == (0 if unchanged else 1)
            coverage_check = (not missing or (len(result["coverage"]) == 1 and result["coverage"][0]["status"] == "insufficient_evidence"))
            entry.update({"passed": bool(matches and change_check and coverage_check and result["source_quotes_verified"]),
                          "observed": observed, "response": result})
        except httpx.HTTPStatusError as error:
            entry["error"] = error.response.text
        except (httpx.HTTPError, ValueError, KeyError) as error:
            entry["error"] = str(error)
        entry["wall_seconds"] = round(time.perf_counter() - started, 3)
        results.append(entry)
        print(name, "PASS" if entry["passed"] else "FAIL", flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        report = {"kind": "development smoke checks, not a held-out benchmark", "human_labels_reviewed": False,
                  "passed": sum(r["passed"] for r in results), "completed": len(results), "cases": results}
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Saved:", args.output)
    raise SystemExit(0 if all(r["passed"] for r in results) else 1)


if __name__ == "__main__":
    main()
