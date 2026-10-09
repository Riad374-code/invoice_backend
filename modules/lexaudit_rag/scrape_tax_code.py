"""Extract operative article paragraphs from the saved e-Qanun HTML.

Amendment notes and deleted text are excluded, but applicability dates still need
review. Use --html to rebuild from the existing snapshot without a new download.
"""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE = Path(__file__).resolve().parent
URL = 'https://frameworks.e-qanun.az/46/f_46948.html'
OUT = BASE / 'data/laws'
ARTICLE_RE = re.compile(r'^Maddə\s+(\d{1,3}(?:-\d+)?)\s*\.\s*(.+)$')
HISTORY = 'Məcəlləyə əlavə və dəyişikliklər etmiş qanunlar'


def clean(text):
    return ' '.join(text.replace('\xa0', ' ').split())


def get_html(local_file=None):
    if local_file:
        return Path(local_file).read_bytes()
    response = requests.get(URL, timeout=(15, 90), headers={'User-Agent': 'LexAuditResearch/0.2'})
    response.raise_for_status()
    return response.content


def extract_articles(html):
    soup = BeautifulSoup(html, 'html.parser')
    for element in list(soup.select('script, style, noscript, iframe, s, strike, del')):
        element.decompose()
    for element in list(soup.find_all(style=re.compile('line-through', re.I))):
        if element.attrs is not None:
            element.decompose()
    for element in list(soup.select('a[href^="#_edn"], a[href^="#_ftn"]')):
        element.decompose()
    articles, current, reached_history = [], None, False
    # Paragraph boundaries retain complete titles; table rows keep columns together.
    for node in soup.find_all(['p', 'tr']):
        if node.name == 'p' and node.find_parent('table'):
            continue
        if node.name == 'tr' and node.find_parent('tr'):
            continue
        if node.name == 'tr':
            text = ' | '.join(clean(cell.get_text(' ', strip=True))
                              for cell in node.find_all(['td', 'th'], recursive=False))
        else:
            text = clean(node.get_text(' ', strip=True))
        if HISTORY.casefold() in text.casefold():
            reached_history = True
            break
        if not text:
            continue
        heading = ARTICLE_RE.match(text)
        if heading:
            number, title = heading.groups()
            if any(a['article'] == number for a in articles):
                raise ValueError(f'Duplicate operative article {number}; inspect source layout')
            current = {'article': number, 'title': title, 'paragraphs': []}
            articles.append(current)
        elif current:
            # Chapter headings belong to the next article, not the preceding text.
            if re.match(r'^(?:[IVXLCDM]+\s+fəsil\b|[IVXLCDM]+\s+bölmə\b)', text, re.I):
                continue
            current['paragraphs'].append(text)
    if not reached_history:
        raise ValueError('Amendment-history boundary missing; refusing a potentially contaminated corpus')
    articles = [a for a in articles if a['paragraphs']]
    if len(articles) < 200 or not {'108', '109', '154', '227'} <= {a['article'] for a in articles}:
        raise ValueError('Unexpected article coverage; inspect HTML before indexing')
    for article in articles:
        article['text'] = '\n'.join(article['paragraphs'])
    return articles


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--html')
    parser.add_argument('--output', type=Path, default=OUT)
    args = parser.parse_args()
    html = get_html(args.html)
    articles = extract_articles(html)
    args.output.mkdir(parents=True, exist_ok=True)
    source = args.output / 'vergi_source.html'
    if not source.exists() or source.read_bytes() != html:
        source.write_bytes(html)
    # Reading an existing file is not a new retrieval from the official website.
    retrieved_at = datetime.now(timezone.utc).isoformat() if not args.html else None
    manifest = {
        'source_url': URL, 'source_sha256': hashlib.sha256(html).hexdigest(),
        'retrieved_at': retrieved_at, 'processed_at': datetime.now(timezone.utc).isoformat(),
        'snapshot_origin': 'local_saved_html' if args.html else 'official_download',
        'article_count': len(articles), 'parser_version': 2,
        'validity_verified': False, 'effective_from': None,
        'limitations': 'Consolidated snapshot only. Individual effective dates and historical applicability are not verified.',
    }
    (args.output / 'vergi_articles.json').write_text(json.dumps(articles, ensure_ascii=False, indent=2), encoding='utf-8')
    (args.output / 'vergi_source_meta.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Extracted {len(articles)} operative articles; excluded deleted text and amendment history.')
    print('Run build_legal_index.py to generate tokenizer-bounded chunks and embeddings.')


if __name__ == '__main__':
    main()
