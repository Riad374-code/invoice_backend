import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

import numpy as np
from rag_common import bounded_parts
from receipt_validation import amount, validate_fields, reviewed_record
import receipt_rag
import rag_tools
from scrape_tax_code import extract_articles, HISTORY


class FakeTokenizer:
    def __call__(self, text, **kwargs):
        return {'input_ids': list(range(len(text.split()) + 2))}


class FakeEncoder:
    tokenizer = FakeTokenizer()
    max_seq_length = 512
    def encode(self, *args, **kwargs):
        return np.array([1., 0.], dtype=np.float32)


class RagTests(unittest.TestCase):
    def test_parser_drops_history_deleted_text_and_preserves_title(self):
        articles = ''.join(f'<p><b>Maddə {i}. Full\narticle title</b></p><p>{i}.1. Retained <s>REVOKED</s> provision.</p>' for i in range(1, 228))
        html = (articles + '<p>' + HISTORY + '</p><p>Maddə 108. HISTORICAL TITLE</p><p>Historical old law</p>').encode()
        parsed = extract_articles(html)
        self.assertEqual(len(parsed), 227)
        self.assertEqual(parsed[112]['title'], 'Full article title')
        self.assertNotIn('REVOKED', str(parsed))
        self.assertNotIn('HISTORICAL', str(parsed))

    def test_parser_requires_history_boundary(self):
        with self.assertRaises(ValueError):
            extract_articles(b'<p>Madd\xc9\x99 1. test</p>')

    def test_bounded_chunks_preserve_all_words(self):
        text = ' '.join(str(i) for i in range(1100))
        parts = list(bounded_parts(text, FakeTokenizer(), max_tokens=32))
        self.assertEqual(' '.join(parts), text)
        self.assertTrue(all(len(FakeTokenizer()('passage: ' + p)['input_ids']) <= 32 for p in parts))

    def test_socar_issues_and_original_preservation(self):
        record = {'fields': {'supplier': 'SOCAR', 'receipt_number': '0.00', 'subtotal': '42.00', 'vat_amount': '6,4', 'total_amount': '42.00', 'currency': 'AZN', 'date': '2020-09-24'}}
        checked = reviewed_record(record)
        self.assertEqual(checked['fields']['total_amount'], '42.00')
        self.assertIsNone(checked['fields']['subtotal'])
        self.assertIsNone(checked['fields']['receipt_number'])
        self.assertEqual(record['fields']['subtotal'], '42.00')
        self.assertEqual(checked['extracted_fields'], record['fields'])
        self.assertFalse(checked['validation']['accounting_ready'])

    def test_valid_totals_and_comma_decimals(self):
        fields = {'supplier': 'Demo', 'date': '2026-10-09', 'currency': 'AZN', 'subtotal': '100,00', 'vat_amount': '18', 'total_amount': '118.00'}
        self.assertEqual(validate_fields(fields)['unsafe_fields'], [])
        with self.assertRaises(ValueError):
            amount('1,234.50')

    def test_line_arithmetic_date_and_voen(self):
        fields = {'supplier': 'Demo', 'date': '2026-02-31', 'supplier_voen': '12', 'currency': 'AZN', 'total_amount': '20', 'line_items': [{'description': 'Pen', 'quantity': '2', 'unit_price': '4', 'total_amount': '20'}]}
        result = validate_fields(fields)
        self.assertTrue({'date', 'supplier_voen', 'line_items.0'} <= set(result['unsafe_fields']))
        self.assertTrue(result['fields']['line_items'][0]['needs_review'])

    def test_no_match_and_company_isolation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(receipt_rag, 'ROOT', Path(tmp)), patch.object(receipt_rag, 'get_encoder', return_value=FakeEncoder()):
            folder = receipt_rag.company_folder('company_a', create=True)
            doc = str(uuid.uuid4())
            record = {'document_id': doc, 'company_id': 'company_a', 'review_status': 'needs_review', 'fields': {'supplier': 'SOCAR', 'date': '2020-09-24', 'description': 'AI-92 yanacaq satışı', 'raw_text': 'SOCAR yanacaq', 'items': [], 'currency': 'AZN', 'total_amount': '42'}}
            (folder / f'{doc}.json').write_text(json.dumps(record))
            np.save(folder / f'{doc}.npy', np.array([1., 0.]))
            # Even perfect vector similarity must not turn a fuel receipt into office supplies.
            self.assertEqual(receipt_rag.search_receipts('Ofis ləvazimatları', 'company_a'), [])
            self.assertEqual(len(receipt_rag.search_receipts('Yanacaq qəbzi', 'company_a')), 1)
            self.assertEqual(receipt_rag.search_receipts('Yanacaq qəbzi', 'company_b'), [])
            self.assertEqual(receipt_rag.search_receipts('Yanacaq qəbzi', 'company_a', document_date='2026-10-09'), [])
            self.assertEqual(receipt_rag.search_receipts('Yanacaq qəbzi', 'company_a', supplier='Other'), [])
            self.assertIsNone(rag_tools.get_document(doc, 'company_b'))
            self.assertIsNotNone(rag_tools.get_document(doc, 'company_a'))
            record['company_id'] = 'company_b'
            (folder / f'{doc}.json').write_text(json.dumps(record))
            self.assertEqual(receipt_rag.search_receipts('Yanacaq qəbzi', 'company_a'), [])
            self.assertIsNone(rag_tools.get_document(doc, 'company_a'))

    def test_path_and_input_validation(self):
        for company in ['../escape', '/tmp', '']:
            with self.assertRaises(ValueError):
                receipt_rag.company_folder(company)
        with self.assertRaises(ValueError):
            rag_tools.get_document('../secret', 'company')
        with self.assertRaises(ValueError):
            receipt_rag.search_receipts('x', 'company', top_k=0)

    def test_ingest_interface(self):
        with patch.object(rag_tools, 'ingest_receipt', return_value={'document_id': 'test'}) as ingest:
            self.assertEqual(rag_tools.ingest_document('/trusted/upload.png', 'company')['document_id'], 'test')
            ingest.assert_called_once_with('/trusted/upload.png', 'company')


if __name__ == '__main__':
    unittest.main()
