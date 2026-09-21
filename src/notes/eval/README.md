# Retrieval evaluation contract — m21-v1

Recorded before running or tuning retrieval: 24 fictional documents, two campaigns,
36 queries. The fixed target is hybrid hit@5 >= 90% of answerable queries and zero
cross-campaign hits in any mode. Report lexical, semantic, and hybrid separately,
plus all-relevant@5 for multi-source/conflict queries and empty results for missing
facts. A hit alone does not demonstrate that an answer is supported.

This is a deterministic **synthetic-vector integration benchmark**, not a cloud
embedding quality claim. The synthetic embedder uses word features and a fixed small
synonym dictionary; it never reads relevance judgments or document IDs. Semantic
paraphrases deliberately test that ranking can retrieve without lexical overlap.
Missing-fact results are diagnostic: similarity is not a calibrated no-answer test.
Loremaster evidence/abstention behavior is M2.2.

Do not change judgments, thresholds, or the dataset to hide failures. Record the
corpus SHA-256 and parameters with each run. Use `bun run eval:retrieval`; it creates
an in-memory database, never reads private notes or uses network/provider keys.
Future real-model evaluations must have a separate report with model/date/cost scope.
