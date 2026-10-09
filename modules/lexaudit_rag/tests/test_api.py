"""Offline contract/validation tests. These do NOT measure Gemini accuracy."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app import Comparison, Extraction, Gemini, ModelError, create_app

ROOT = Path(__file__).resolve().parents[1]
REQUEST = json.loads((ROOT / "examples/complaints_en.json").read_text())


def extraction():
    return Extraction.model_validate({
        "changes": [{"change_type": "modified", "action": "Acknowledge receipt of a complaint",
                     "old_rule": "five business days", "new_rule": "two business days",
                     "old_quote": "within five business days", "new_quote": "within two business days",
                     "scope": "customer complaints", "effective_date_text": None,
                     "uncertainties": ["Effective date unknown"]}],
        "explanation": "The acknowledgement deadline changed."})


class FixtureProvider:
    model = "offline-fixture-not-a-real-model"
    key = ""

    def __init__(self, fault=None):
        self.calls = 0
        self.fault = fault

    def generate(self, instructions, data, schema):
        self.calls += 1
        if schema is Extraction:
            value = extraction()
            if self.fault == "requirement_quote":
                value.changes[0].new_quote = "invented requirement"
            return value, {}
        statuses = {"procedure_a": "potential_inconsistency", "procedure_b": "appears_aligned", "resolution": "irrelevant"}
        rows = []
        for p in data["passages"]:
            status = statuses[p["document_id"]]
            relevant = status != "irrelevant"
            rows.append({"change_id": "C1", "passage_id": p["passage_id"],
                         "relevant": relevant, "status": status,
                         "passage_quote": p["text"] if relevant else None,
                         "explanation": "Offline fixture, not a generated assessment.",
                         "proposed_edit": "Acknowledge receipt of a customer complaint within two business days."
                         if status == "potential_inconsistency" else None})
        if self.fault == "passage_quote":
            rows[0]["passage_quote"] = "invented policy quote"
        if self.fault == "unknown_id":
            rows[0]["passage_id"] = "imaginary"
        if self.fault == "duplicate":
            rows.append(copy.deepcopy(rows[0]))
        if self.fault == "omitted":
            rows.pop()
        if self.fault == "invalid_edit":
            rows[1]["proposed_edit"] = "An unnecessary edit"
        if self.fault == "invalid_relevance":
            rows[0]["relevant"] = False
        return Comparison.model_validate({"assessments": rows}), {}


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "test.sqlite3"
        self.environment = patch.dict(os.environ, {"LEXAUDIT_API_TOKEN": ""})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def client(self, provider=None):
        return TestClient(create_app(provider=provider or FixtureProvider(), db_path=self.db))

    def test_analysis_review_and_restart_persistence(self):
        client = self.client()
        response = client.post("/analyze-change", json=REQUEST)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["counts"]["potential_inconsistency"], 1)
        self.assertEqual(result["counts"]["appears_aligned"], 1)
        self.assertEqual(result["counts"]["irrelevant"], 1)
        review_url = f"/analyses/{result['analysis_id']}/review"
        for decision in ("approved", "needs_revision"):
            response = client.post(review_url, json={"finding_id": "F1", "decision": decision,
                                                     "reviewer": "Demo reviewer", "note": "Fixture test"})
            self.assertEqual(response.status_code, 200)
        restored = self.client().get(f"/analyses/{result['analysis_id']}").json()
        self.assertEqual(len(restored["review_history"]), 2)
        self.assertEqual(restored["assessments"][0]["review_status"], "needs_revision")
        self.assertEqual(restored["input"], result["input"])

    def test_cache_reuses_successful_analysis_and_latest_review(self):
        provider = FixtureProvider()
        client = self.client(provider)
        first = client.post("/analyze-change", json=REQUEST).json()
        client.post(f"/analyses/{first['analysis_id']}/review", json={"finding_id": "F1", "decision": "approved", "reviewer": "Demo"})
        second = client.post("/analyze-change", json=REQUEST).json()
        self.assertEqual(provider.calls, 2)
        self.assertTrue(second["cached"])
        self.assertEqual(first["analysis_id"], second["analysis_id"])
        self.assertEqual(second["assessments"][0]["review_status"], "approved")

    def test_invalid_model_evidence_and_incomplete_coverage_rejected(self):
        for fault in ("requirement_quote", "passage_quote", "unknown_id", "duplicate", "omitted", "invalid_edit", "invalid_relevance"):
            with self.subTest(fault=fault):
                response = self.client(FixtureProvider(fault)).post("/analyze-change", json=REQUEST)
                self.assertEqual(response.status_code, 502, response.text)

    def test_no_relevant_passage_is_insufficient_evidence(self):
        data = copy.deepcopy(REQUEST)
        data["documents"] = [data["documents"][2]]
        result = self.client().post("/analyze-change", json=data).json()
        self.assertEqual(result["coverage"][0]["status"], "insufficient_evidence")
        self.assertEqual(result["counts"]["potential_inconsistency"], 0)

    def test_identical_requirement_skips_provider(self):
        provider = FixtureProvider()
        data = copy.deepcopy(REQUEST)
        data["new_requirement"] = data["old_requirement"]
        response = self.client(provider).post("/analyze-change", json=data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["changes"], [])
        self.assertEqual(provider.calls, 0)

    def test_blank_and_duplicate_input_rejected(self):
        client = self.client()
        data = copy.deepcopy(REQUEST)
        data["old_requirement"] = " "
        self.assertEqual(client.post("/analyze-change", json=data).status_code, 422)
        data = copy.deepcopy(REQUEST)
        data["documents"].append(data["documents"][0])
        self.assertEqual(client.post("/analyze-change", json=data).status_code, 422)

    def test_offsets_refer_to_exact_original_document(self):
        data = copy.deepcopy(REQUEST)
        data["documents"] = [data["documents"][0]]
        data["documents"][0]["text"] = "  First paragraph.\n\n  Second paragraph.  "
        result = self.client().post("/analyze-change", json=data).json()
        for finding in result["assessments"]:
            evidence = finding["evidence"]
            original = data["documents"][0]["text"]
            self.assertEqual(original[evidence["char_start"]:evidence["char_end"]], evidence["quote"])

    def test_shared_backend_requires_configured_token(self):
        with patch.dict(os.environ, {"LEXAUDIT_API_TOKEN": "fixture-token"}):
            client = self.client()
        self.assertEqual(client.post("/analyze-change", json=REQUEST).status_code, 401)
        response = client.post("/analyze-change", json=REQUEST, headers={"Authorization": "Bearer fixture-token"})
        self.assertEqual(response.status_code, 200)

    def test_review_rejects_unknown_or_irrelevant_finding(self):
        client = self.client()
        analysis = client.post("/analyze-change", json=REQUEST).json()
        for finding_id in ("unknown", "F3"):
            response = client.post(f"/analyses/{analysis['analysis_id']}/review",
                                   json={"finding_id": finding_id, "decision": "approved", "reviewer": "Demo"})
            self.assertEqual(response.status_code, 422)

    def test_provider_rest_shape_and_output_parsing(self):
        provider = Gemini()
        provider.key = "fake-test-key"
        response = httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {
            "parts": [{"text": extraction().model_dump_json()}]}}], "usageMetadata": {"totalTokenCount": 12}})
        with patch("app.httpx.post", return_value=response) as post:
            value, usage = provider.generate("Extract", {"example": "data"}, Extraction)
        self.assertEqual(value.changes[0].new_rule, "two business days")
        self.assertEqual(usage["totalTokenCount"], 12)
        args = post.call_args.kwargs
        self.assertIn("responseJsonSchema", args["json"]["generationConfig"])
        self.assertNotIn("fake-test-key", post.call_args.args[0])

    def test_provider_rejects_incomplete_output(self):
        provider = Gemini()
        provider.key = "fake-test-key"
        response = httpx.Response(200, json={"candidates": [{"finishReason": "MAX_TOKENS", "content": {
            "parts": [{"text": extraction().model_dump_json()}]}}]})
        with patch("app.httpx.post", return_value=response), self.assertRaises(ModelError):
            provider.generate("Extract", {}, Extraction)

    def test_provider_key_absence_is_explicit(self):
        provider = Gemini()
        provider.key = ""
        with self.assertRaisesRegex(ModelError, "GEMINI_API_KEY"):
            provider.generate("Extract", {}, Extraction)


if __name__ == "__main__":
    unittest.main()
