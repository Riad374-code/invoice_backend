"""Shared, lazy E5 model and lightweight Azerbaijani lexical matching."""
from functools import lru_cache
import re
import threading

MODEL_ID = "intfloat/multilingual-e5-small"
_model_lock = threading.RLock()


@lru_cache(maxsize=2)
def _load_encoder(model_id):
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(model_id)


def get_encoder(model_id=MODEL_ID):
    with _model_lock:
        return _load_encoder(model_id)


STOP = set("və ilə üçün bu bir hansı nə necə kim kimlərdir olar bilər mən mənim bizim son dünən dünənki aldığım aldığımız alınan tarixində tarixli göstər tap gətir əlavə et hazırla qeydiyyata almaq istərdim zəhmət olmasa haqqında barədə üzrə daha bütün olan qədər the a of for find show my me please".split())
GENERIC_DOCUMENT = set("sənəd sənədlər sənədi sənədləri çek çeki çekini çeklər qəbz qəbzi qəbzini qəbzlər faktura fakturanı receipt invoice document sales ödəniş xərc xərclər xərclərə məlumat".split())


def words(text):
    return re.findall(r"[\w]+", text.replace("İ", "i").replace("I", "ı").lower())


def tokens(text, *, document=False):
    # Conservative prefix matching is a demo heuristic, not an Azerbaijani stemmer.
    stops = STOP | GENERIC_DOCUMENT if document else STOP
    return [w[:5] if len(w) > 5 and not w.isdigit() else w
            for w in words(text) if w not in stops and len(w) > 1]


def bounded_parts(text, tokenizer, prefix="passage: ", max_tokens=512):
    """Split at whitespace, measuring the complete encoded input; never truncate."""
    remaining = text.strip()
    while remaining:
        if len(tokenizer(prefix + remaining, truncation=False)["input_ids"]) <= max_tokens:
            yield remaining
            break
        spans = list(re.finditer(r"\S+", remaining))
        lo, hi, best = 1, len(spans), 0
        while lo <= hi:
            mid = (lo + hi) // 2
            end = spans[mid - 1].end()
            if len(tokenizer(prefix + remaining[:end], truncation=False)["input_ids"]) <= max_tokens:
                best, lo = end, mid + 1
            else:
                hi = mid - 1
        if not best:
            raise ValueError("A single token/heading exceeds the encoder input limit")
        yield remaining[:best]
        remaining = remaining[best:].lstrip()
