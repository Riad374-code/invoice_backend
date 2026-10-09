"""Hybrid legal retrieval: E5 + BM25, article diversity, and adjacent evidence."""
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re

import numpy as np
from rag_common import get_encoder, tokens

DATA = Path(__file__).resolve().parent / 'data/laws'


class LegalRetriever:
    def __init__(self, data=DATA):
        data = Path(data)
        metadata = json.loads((data / 'vergi_index_meta.json').read_text())
        raw = (data / 'vergi_chunks.jsonl').read_bytes()
        vector_raw = (data / 'vergi_embeddings.npy').read_bytes()
        if metadata.get('index_version') != 2:
            raise ValueError('Rebuild the legal corpus with scrape_tax_code.py and build_legal_index.py')
        if hashlib.sha256(raw).hexdigest() != metadata['chunks_sha256'] or hashlib.sha256(vector_raw).hexdigest() != metadata['embeddings_sha256']:
            raise ValueError('Legal index does not match its metadata; rebuild before searching')
        self.chunks = [json.loads(line) for line in raw.splitlines() if line]
        self.embeddings = np.load(data / 'vergi_embeddings.npy', allow_pickle=False)
        if self.embeddings.shape != (len(self.chunks), metadata['embedding_dimension']) or not np.isfinite(self.embeddings).all():
            raise ValueError('Invalid legal embeddings')
        self.model = get_encoder(metadata['model'])
        self.lexical = [Counter(tokens(c['article_title'] + ' ' + c['article_title'] + ' ' + c['text'])) for c in self.chunks]
        self.lengths = np.array([sum(c.values()) for c in self.lexical])
        self.average_length = max(float(self.lengths.mean()), 1)
        df = Counter(t for c in self.lexical for t in c)
        self.idf = {t: math.log(1 + (len(self.chunks) - n + .5) / (n + .5)) for t, n in df.items()}
        self.by_article = defaultdict(list)
        for i, chunk in enumerate(self.chunks):
            self.by_article[chunk['article']].append(i)

    def _result(self, index):
        c = self.chunks[index]
        return {'id': c['id'], 'article': c['article'], 'title': c['article_title'],
                'text': c['text'], 'source_url': c['source_url'], 'provisions': c['provisions'],
                'source_sha256': c['source_sha256'], 'retrieved_at': c['retrieved_at'],
                'effective_from': c['effective_from'], 'validity_verified': c['validity_verified']}

    def search(self, question, top_k=5):
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise ValueError('Question must contain 1–4000 characters')
        if not isinstance(top_k, int) or not 1 <= top_k <= 20:
            raise ValueError('top_k must be between 1 and 20')
        if len(self.model.tokenizer('query: ' + question, truncation=False)['input_ids']) > self.model.max_seq_length:
            raise ValueError('Question exceeds encoder input limit')
        vector = self.model.encode('query: ' + question, normalize_embeddings=True, convert_to_numpy=True)
        semantic = self.embeddings @ vector
        lexical = np.zeros(len(self.chunks))
        query_terms = set(tokens(question))
        for i, counts in enumerate(self.lexical):
            for term in query_terms:
                tf = counts.get(term, 0)
                lexical[i] += self.idf.get(term, 0) * tf * 2.5 / (tf + 1.5 * (.25 + .75 * self.lengths[i] / self.average_length))
        # Fuse ranks; similarity and BM25 have incompatible raw score scales.
        fused = np.zeros(len(self.chunks))
        for scores, weight in [(semantic, 1.0), (lexical, 1.0)]:
            ranked = np.argsort(-scores, kind='stable')[:80]
            for rank, i in enumerate(ranked, 1):
                if scores is lexical and scores[i] <= 0:
                    continue
                fused[i] += weight / (40 + rank)
        # Honor explicit references in either Azerbaijani or English.
        references = set(re.findall(r'(?:maddə|article)\s*(\d+(?:-\d+)?)', question, re.I))
        references.update(re.findall(r'\b(\d+(?:-\d+)?)(?:\.[\d.-]+)?(?:-ci|-cü|-cu|-cı)?\s+madd', question, re.I))
        for i, c in enumerate(self.chunks):
            if c['article'] in references:
                fused[i] += 1
        chosen, seen = [], set()
        for i in np.argsort(-fused, kind='stable'):
            i = int(i)
            article = self.chunks[i]['article']
            if article in seen:
                continue
            seen.add(article)
            result = self._result(i)
            result.update(score=float(fused[i]), semantic_score=float(semantic[i]),
                          lexical_score=float(lexical[i]), retrieval_method='e5_bm25_rrf')
            siblings = self.by_article[article]
            pos = siblings.index(i)
            neighbors = list(dict.fromkeys([siblings[0]] + siblings[max(0, pos - 1):pos + 2]))
            result['related_passages'] = [self._result(j) for j in neighbors if j != i]
            result['evidence_complete_article'] = len(set(neighbors + [i])) == len(siblings)
            chosen.append(result)
            if len(chosen) == top_k:
                break
        return chosen


if __name__ == '__main__':
    import sys
    retriever = LegalRetriever()
    question = ' '.join(sys.argv[1:]) or 'Hansı xərclər gəlirdən çıxıla bilər?'
    print(json.dumps(retriever.search(question), ensure_ascii=False, indent=2))
