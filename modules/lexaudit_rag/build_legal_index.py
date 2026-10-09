"""Build a verifiable E5 index without splitting ordinary legal paragraphs."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

import numpy as np
from rag_common import get_encoder, bounded_parts, MODEL_ID

DATA = Path(__file__).resolve().parent / 'data/laws'


def make_chunks(articles, tokenizer, source):
    records = []
    for article in articles:
        heading = f"Azərbaycan Respublikasının Vergi Məcəlləsi. Maddə {article['article']}. {article['title']}. "
        groups, pending = [], ''
        for paragraph in article['paragraphs']:
            parts = list(bounded_parts(paragraph, tokenizer, prefix='passage: ' + heading))
            # Preserve the paragraph's provision ID on every continuation chunk.
            for part in parts:
                combined = pending + '\n' + part if pending else part
                if pending and len(tokenizer('passage: ' + heading + combined, truncation=False)['input_ids']) > 512:
                    groups.append(pending)
                    pending = part
                else:
                    pending = combined
        if pending:
            groups.append(pending)
        inherited_provision = None
        for index, text in enumerate(groups):
            provisions = re.findall(r'(?m)^(\d+(?:-\d+)?(?:\.\d+(?:-\d+)?)+)\.', text)
            first_is_continuation = not re.match(r'^\d+(?:-\d+)?(?:\.\d+(?:-\d+)?)+\.', text)
            ids = list(dict.fromkeys(([inherited_provision] if first_is_continuation and inherited_provision else []) + provisions))
            if provisions:
                inherited_provision = provisions[-1]
            records.append({
                'id': f"vergi_{article['article']}_{index}", 'document_id': 'az_vergi_mecellesi',
                'source_type': 'legislation', 'source_url': source['source_url'],
                'source_sha256': source['source_sha256'], 'retrieved_at': source['retrieved_at'],
                'article': article['article'], 'article_title': article['title'],
                'chunk_index': index, 'provisions': ids, 'text': text,
                'embedding_text': heading + text, 'effective_from': None, 'validity_verified': False,
                'sha256': hashlib.sha256(text.encode()).hexdigest(),
            })
    return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=DATA)
    args = parser.parse_args()
    articles = json.loads((args.data / 'vergi_articles.json').read_text(encoding='utf-8'))
    source = json.loads((args.data / 'vergi_source_meta.json').read_text(encoding='utf-8'))
    model_id = os.getenv('E5_MODEL_ID', MODEL_ID)
    model = get_encoder(model_id)
    chunks = make_chunks(articles, model.tokenizer, source)
    texts = ['passage: ' + c['embedding_text'] for c in chunks]
    maximum = max(len(model.tokenizer(t, truncation=False)['input_ids']) for t in texts)
    if maximum > min(512, model.max_seq_length):
        raise ValueError('Chunk exceeds model input limit')
    vectors = model.encode(texts, batch_size=16, normalize_embeddings=True,
                           convert_to_numpy=True, show_progress_bar=True).astype(np.float32)
    raw = ''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in chunks).encode()
    # Write metadata last; readers reject partially updated or mismatched artifacts.
    vector_file = args.data / 'vergi_embeddings.npy'
    np.save(vector_file, vectors)
    (args.data / 'vergi_chunks.jsonl').write_bytes(raw)
    meta = {'model': model_id, 'chunks': len(chunks), 'embedding_dimension': vectors.shape[1],
            'index_version': 2, 'max_input_tokens': maximum,
            'chunks_sha256': hashlib.sha256(raw).hexdigest(),
            'embeddings_sha256': hashlib.sha256(vector_file.read_bytes()).hexdigest()}
    (args.data / 'vergi_index_meta.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    print(f'Indexed {len(articles)} articles / {len(chunks)} chunks; maximum {maximum} tokens.')


if __name__ == '__main__':
    main()
