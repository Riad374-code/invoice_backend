"""Checks flag extracted facts; they never infer tax treatment or repair originals."""
from copy import deepcopy
from datetime import date
from decimal import Decimal, InvalidOperation
import re


def amount(value):
    if value is None or not str(value).strip():
        return None
    text = str(value).strip().replace(' ', '').replace('\xa0', '')
    if ',' in text and '.' in text:
        # Ambiguous grouping needs review, not an assumed locale.
        raise ValueError('Ambiguous number separators')
    if not re.fullmatch(r'-?\d+(?:[.,]\d+)?', text):
        raise ValueError('Invalid amount')
    try:
        return Decimal(text.replace(',', '.'))
    except InvalidOperation:
        raise ValueError('Invalid amount') from None


def validate_fields(fields):
    issues, unsafe = [], set()
    def flag(field, code, message):
        issues.append({'field': field, 'code': code, 'message': message})
        unsafe.add(field)
    for key in ['supplier', 'date', 'currency', 'total_amount']:
        if not fields.get(key):
            flag(key, 'missing', 'Required expense information is missing; ask the accountant.')
    if fields.get('date'):
        try:
            date.fromisoformat(fields['date'])
        except (ValueError, TypeError):
            flag('date', 'invalid_date', 'Date must be an unambiguous YYYY-MM-DD value.')
    number = fields.get('receipt_number')
    if number and re.fullmatch(r'[0\s.,-]+', str(number)):
        flag('receipt_number', 'placeholder_number', 'The receipt number consists only of zeroes/separators; verify the image.')
    voen = fields.get('supplier_voen')
    if voen and not re.fullmatch(r'\d{10}', str(voen)):
        flag('supplier_voen', 'invalid_voen', 'VÖEN must contain ten digits; verify the image.')
    parsed = {}
    for key in ['subtotal', 'vat_amount', 'total_amount']:
        try:
            parsed[key] = amount(fields.get(key))
            if parsed[key] is not None and parsed[key] < 0:
                flag(key, 'negative_amount', 'Negative amount: verify whether this is a refund/credit.')
        except ValueError:
            parsed[key] = None
            flag(key, 'invalid_amount', 'Amount could not be parsed unambiguously.')
    sub, vat, total = (parsed[k] for k in ['subtotal', 'vat_amount', 'total_amount'])
    if sub is not None and vat is not None and total is not None and abs(sub + vat - total) > Decimal('.02'):
        flag('subtotal', 'totals_mismatch', 'Subtotal plus VAT differs from total. Do not treat a VAT-inclusive total as a net subtotal.')
    if vat is not None and total is not None and vat > total:
        flag('vat_amount', 'vat_exceeds_total', 'VAT exceeds the total; verify both fields.')
        flag('total_amount', 'vat_exceeds_total', 'Total is lower than VAT; verify both fields.')
    items = fields.get('line_items') or []
    if not items and fields.get('items'):
        issues.append({'field': 'line_items', 'code': 'legacy_items', 'message': 'Legacy free-text items have not been extracted into structured quantities/prices.'})
    for i, item in enumerate(items):
        try:
            q, p, line = (amount(item.get(k)) for k in ['quantity', 'unit_price', 'total_amount'])
            if None not in (q, p, line) and abs(q * p - line) > Decimal('.02'):
                flag(f'line_items.{i}', 'line_mismatch', 'Quantity × unit price differs from the line total; check rounding or discounts.')
        except (ValueError, AttributeError):
            flag(f'line_items.{i}', 'invalid_line', 'Line item contains an invalid or ambiguous number.')
    if fields.get('review_notes'):
        issues.append({'field': 'review_notes', 'code': 'ocr_uncertainty', 'message': fields['review_notes']})
    safe = deepcopy(fields)
    for field in unsafe:
        if '.' not in field:
            safe[field] = None
        elif field.startswith('line_items.'):
            safe['line_items'][int(field.split('.')[1])]['needs_review'] = True
    return {'issues': issues, 'unsafe_fields': sorted(unsafe), 'fields': safe,
            'requires_human_review': True, 'accounting_ready': False}


def reviewed_record(record):
    result = deepcopy(record)
    original = record.get('extracted_fields', record['fields'])
    validation = validate_fields(original)
    result['extracted_fields'] = deepcopy(original)
    result['fields'] = validation.pop('fields')
    result['validation'] = validation
    result['review_status'] = 'needs_review'
    return result
