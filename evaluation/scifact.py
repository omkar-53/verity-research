"""Prepare a reproducible balanced subset of the official SciFact development split.

Usage: python3 evaluation/scifact.py data.tar.gz /tmp/verity-reference.json
Only source IDs and aggregate measurements are shipped with the application.
"""
import hashlib
import json
import sys
import tarfile
from pathlib import Path

with tarfile.open(sys.argv[1], "r:gz") as archive:
    def rows(name):
        return [json.loads(line) for line in archive.extractfile("data/" + name)]

    corpus = {str(doc["doc_id"]): doc for doc in rows("corpus.jsonl")}
    claims = rows("claims_dev.jsonl")

groups = {"SUPPORT": [], "CONTRADICT": []}
used_docs = set()
for item in sorted(claims, key=lambda x: hashlib.sha256(str(x["id"]).encode()).digest()):
    for doc_id, annotations in item["evidence"].items():
        if doc_id in used_docs or not annotations:
            continue
        annotation = annotations[0]
        label = annotation["label"]
        if label not in groups or len(groups[label]) >= 25:
            continue
        study = corpus[doc_id]
        passage = " ".join(study["abstract"][i] for i in annotation["sentences"])
        if len(passage) > 1200 or len(passage) < 35:
            continue
        groups[label].append({
            "id": f"scifact-{item['id']}-{doc_id}",
            "topic": study["title"],
            "claim": item["claim"],
            "passage": passage,
            "stance": "supports" if label == "SUPPORT" else "contradicts",
        })
        used_docs.add(doc_id)
        break

assert all(len(group) == 25 for group in groups.values())
cases = [row for pair in zip(*groups.values()) for row in pair]
Path(sys.argv[2]).write_text(json.dumps(cases, ensure_ascii=False))
print("Prepared 50 annotated claims, each from a distinct publication.")
