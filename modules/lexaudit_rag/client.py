"""Send one JSON request to the local service and save its real response."""
import argparse
import json
import os
from pathlib import Path
import sys

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--output", type=Path, default=Path("reports/latest.json"))
    args = parser.parse_args()
    headers = {}
    if os.environ.get("LEXAUDIT_API_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["LEXAUDIT_API_TOKEN"]
    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        response = httpx.post(args.url.rstrip("/") + "/analyze-change", json=payload,
                              headers=headers, timeout=330)
        response.raise_for_status()
        result = response.json()
    except httpx.HTTPStatusError as error:
        print(error.response.text, file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, httpx.HTTPError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Analysis:", result["analysis_id"])
    print("Counts:", result["counts"])
    print("Coverage:", result["coverage"])
    print("Cached:", result["cached"], "Time:", result["elapsed_seconds"], "seconds")
    print("Saved:", args.output)
    for item in result["assessments"]:
        print(item["finding_id"], item["passage_id"], item["status"])


if __name__ == "__main__":
    main()
