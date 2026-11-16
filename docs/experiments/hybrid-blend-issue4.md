# Hybrid blend experiment (issue #4) — result: no change

Question: can fts × vector be fused by rank (Nat's RRF) so q06 / q09 come back
without hurting anything else? **Answer: not on this question set. Nothing met
rule 4, so `combineSearchResults` is unchanged.**

## Setup
- Copy of the live brain: `sqlite3 .backup` of `oracle.db` + full `lancedb/` copy
  + `vector-server.json` (its `dataPath` rewritten to the copy) in `/tmp/arra-issue4`;
  test server on :47779 with `ORACLE_DATA_DIR` / `ORACLE_DB_PATH` pointing there.
  Live `~/.oracle` was only read. Copy deleted afterwards.
- Proof the copy is isolated and equals live: `mode=vector` → `vectorAvailable:true`;
  the process maps no file under `~/.oracle/lancedb`; baseline on the copy =
  live gauge of 16 Nov 08:12 (fts hit@5 19, vector 14, hybrid 21; q06 and q09 not in top 10).
- Gauge: `brain-eval/run.py --base http://127.0.0.1:47779 --detail`, file
  `tinky-oracle/scripts/brain-eval/questions.yaml` @ master `2959011f` (27 q).
  The "grow the question set" branch (tinky-oracle#33) exists but has no commits
  beyond master, so no second table.
- Code under test: `main` @ `0bd0438e` + the patch in `hybrid-blend-issue4.patch`
  (env switch `ARRA_HYBRID_BLEND`; empty fts or vector list → legacy path).

## fts-only and vector-only
Rank columns for fts and vector are **identical to baseline in all 12 builds**
(fts 14/19/0.581 · vector 11/14/0.470 as hit@1/hit@5/MRR; latency med/p95 206/294 ms
and 186/265 ms) — the switch only touches the hybrid combine.

## Hybrid, hit@1 / hit@5 / MRR
| build | all | th | en | title | paraphrase | q06 | q09 | ms med/p95 |
|---|---|---|---|---|---|---|---|---|
| **current (legacy)** | 15/21/.649 | 11/15/.597 | 4/6/.833 | 6/6/1.0 | 9/15/.549 | — | — | 334/454 |
| a. RRF k=60 | 15/21/.634 | 11/16/.608 | 4/**5**/.728 | 6/6/1.0 | 9/15/.530 | 5 | 7 | 342/443 |
| b1. RRF k=60 × (1+1·s) | 16/**20**/.650 | 12/16/.634 | 4/**4**/.706 | 6/6/1.0 | 10/**14**/.550 | 5 | 5 | 356/459 |
| b2. RRF k=60 × (1+2·s) | 16/**20**/.649 | 12/16/.633 | 4/**4**/.706 | 6/6/1.0 | 10/**14**/.549 | 5 | 5 | 337/454 |
| c. legacy, fts fed fused score | 14/21/**.630** | 10/17/.606 | 4/**4**/.713 | 6/6/1.0 | 8/15/.524 | 1 | 5 | 346/433 |
| RRF k=10 | 14/**20**/.612 | 10/14/.564 | 4/6/.783 | 6/6/1.0 | 8/14/.502 | 4 | 7 | 358/474 |
| RRF k=3 | 15/**20**/.629 | 11/14/.585 | 4/6/.783 | 6/6/1.0 | 9/14/.523 | 1 | 7 | 336/429 |
| RRF k=10 × (1+s) | 14/**20**/.622 | 10/14/.576 | 4/6/.783 | 6/6/1.0 | 8/14/.514 | 2 | 7 | 332/462 |
| RRF k=3 × (1+s) | 15/**19**/.628 | 11/13/.584 | 4/6/.783 | 6/6/1.0 | 9/13/.522 | 1 | 7 | 342/435 |
| max-leg + .5·other (k=60) | 14/21/.616 | 10/16/.584 | 4/**5**/.728 | 6/6/1.0 | 8/15/.506 | 5 | 7 | 374/481 |
| max-leg + .2·other (k=60) | 14/**20**/.618 | 10/14/.571 | 4/6/.783 | 6/6/1.0 | 8/14/.509 | 4 | 7 | 344/453 |
| max-leg + 1·other (k=10) | 14/**20**/.612 | 10/14/.564 | 4/6/.783 | 6/6/1.0 | 8/14/.502 | 4 | 7 | 352/449 |

Bold = lower than current (violates rule 4). q06/q09 = hybrid rank (— = not in top 10).
`s` = the leg's own normalised score (vector similarity; fts fused-RRF score / max).
Latency is dominated by the embedding call; the blend itself costs nothing measurable.

## Why nothing passes
- Pure RRF does bring q06 (rank 5) and q09 (rank 7) back, and Thai hit@5 rises 15→16.
- It loses **q11, q17, q21**: the vector's rank-1 hit has no keyword match, while
  junk documents found by both legs earn two RRF terms and stack above it
  (q21: rank 1 → 6; q17: 2 → 5). RRF throws away distance — exactly Nat's
  book line 94. Adding the score weight (b) fixes q06/q09 but pushes q17/q21/q11
  further down (to 8–9), costing en hit@5 and overall hit@5.
- Small k and "best leg + bonus" lift q06 to rank 1–2 but lose q04 (2 → not in
  top 10) and q01 (5 → 9) — those are found only through legacy's overlap bonus.
- c (feeding fts the fused score) gets q06 to rank 1 but q09 stays at 5, and MRR drops.
- Only 27 questions: one question = 3.7 points of hit@5. A larger set (tinky-oracle#33)
  may change the ranking of these blends; re-run the same patch against it.

## Re-run
`git apply docs/experiments/hybrid-blend-issue4.patch`, then start a test server on a
copy with `ARRA_HYBRID_BLEND=legacy|rrf|rrf-score|rrf-max|legacy-fused`,
`ARRA_HYBRID_W` (score weight / bonus) and `ARRA_HYBRID_K`.
