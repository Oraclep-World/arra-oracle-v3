# Hybrid blend, round 2 — 64-question set (issue #4)

Round 1 (27 questions) found no passing blend: see `hybrid-blend-issue4.md`.
Round 2 re-ran the same 12 builds on the larger set, then 2 extra variants.

## Rule, fixed before running (tinky, 16 Nov)
PASS = on the 64 set: hybrid hit@5 ≥ 44 (fts-only) AND hybrid MRR ≥ .562 AND title 6/6 AND
Pleam-typed (q01 q04 q05 q06 q28–q48, 25 q) hybrid hit@5 ≥ 13 AND English+mixed (18 q) lose at
most 1 question (hit@5) vs current AND fts-only / vector-only order unchanged. Pick: highest hybrid hit@5,
tie → MRR, tie → simplest code.

## Setup
- Fresh copy (`sqlite3 .backup` + full `lancedb` copy + `vector-server.json` with rewritten `dataPath`),
  test server :47779 with `ORACLE_DATA_DIR`/`ORACLE_DB_PATH` on the copy. Live `~/.oracle` / :47778 untouched.
- Gauge: tinky-oracle PR #34 branch @ `b3699c35`, **its** `run.py` and `questions.yaml` (64 q).
- Baseline on the copy = live: hit@5 fts 44 · vector 29 · hybrid 42; MRR .562 / .339 / .504;
  the same 9 lost-in-hybrid ids (q06 q09 q28 q33 q43 q44 q45 q47 q64).
- fts and vector rank columns identical to baseline in every build.
- (*) = the two last variants were **added after seeing the 64-set results** of the first 12.

## Hybrid, hit@1 / hit@5 / MRR
| build | verdict | all (64) | th | en | mixed | title | Pleam-typed (25) | ms med/p95 |
|---|---|---|---|---|---|---|---|---|
| **current (legacy)** | — | 26/42/0.504 | 17/28/0.464 | 7/10/0.750 | 2/4/0.381 | 6/6/1.000 | 5/11/0.295 | 365 / 597 |
| a. RRF k=60 | fail | 27/46/0.541 | 18/32/0.521 | 7/9/0.692 | 2/5/0.440 | 6/6/1.000 | 6/15/0.392 | 365 / 514 |
| b1. RRF×(1+1·s) | fail | 28/46/0.550 | 19/33/0.535 | 7/8/0.681 | 2/5/0.440 | 6/6/1.000 | 6/16/0.396 | 352 / 502 |
| b2. RRF×(1+2·s) | fail | 29/46/0.557 | 20/33/0.545 | 7/8/0.681 | 2/5/0.440 | 6/6/1.000 | 7/16/0.416 | 349 / 491 |
| **c. legacy + fused fts score (PICKED)** | PASS | 31/46/0.585 | 22/33/0.578 | 7/8/0.707 | 2/5/0.440 | 6/6/1.000 | 10/15/0.488 | 362 / 496 |
| RRF k=10 | fail | 29/46/0.561 | 20/31/0.535 | 7/10/0.723 | 2/5/0.476 | 6/6/1.000 | 7/14/0.396 | 356 / 490 |
| RRF k=3 | PASS | 32/45/0.580 | 22/30/0.556 | 7/10/0.723 | 3/5/0.512 | 6/6/1.000 | 10/13/0.469 | 339 / 475 |
| RRF k=10×(1+s) | PASS | 30/46/0.574 | 20/31/0.542 | 7/10/0.723 | 3/5/0.548 | 6/6/1.000 | 8/14/0.428 | 360 / 496 |
| RRF k=3×(1+s) | PASS | 32/44/0.578 | 22/29/0.553 | 7/10/0.723 | 3/5/0.512 | 6/6/1.000 | 10/13/0.464 | 367 / 479 |
| max-leg+.5·other | fail | 26/46/0.532 | 17/32/0.506 | 7/9/0.692 | 2/5/0.452 | 6/6/1.000 | 5/15/0.362 | 350 / 475 |
| max-leg+.2·other | fail | 28/46/0.554 | 19/31/0.529 | 7/10/0.723 | 2/5/0.452 | 6/6/1.000 | 6/14/0.368 | 356 / 492 |
| max-leg+1·other k=10 | fail | 29/46/0.561 | 20/31/0.535 | 7/10/0.723 | 2/5/0.476 | 6/6/1.000 | 7/14/0.396 | 344 / 529 |
| c + rank-1 of each leg on top (*) | PASS | 31/46/0.576 | 22/32/0.564 | 7/9/0.722 | 2/5/0.421 | 6/6/1.000 | 10/14/0.477 | 357 / 507 |
| c + vector rank-1 on top (*) | fail | 17/46/0.466 | 11/32/0.445 | 4/9/0.586 | 2/5/0.421 | 6/6/1.000 | 2/14/0.317 | 348 / 487 |

Pleam-typed = 25 q; English = 11, mixed = 7, Thai = 46, title = 6. fts-only on Pleam-typed is 9/15/.467,
vector-only 2/5/.132. Latency is dominated by the embedding call; the blend costs nothing measurable.

## By shape
| build | short-specific (28) | long-vague (36) |
|---|---|---|
| **current (legacy)** | 13/23/0.599 | 13/19/0.431 |
| a. RRF k=60 | 15/24/0.661 | 12/22/0.449 |
| b1. RRF×(1+1·s) | 15/23/0.655 | 13/23/0.468 |
| b2. RRF×(1+2·s) | 15/23/0.654 | 14/23/0.482 |
| **c. legacy + fused fts score (PICKED)** | 15/24/0.674 | 16/22/0.516 |
| RRF k=10 | 16/23/0.680 | 13/23/0.469 |
| RRF k=3 | 15/23/0.651 | 17/22/0.525 |
| RRF k=10×(1+s) | 15/23/0.662 | 15/23/0.505 |
| RRF k=3×(1+s) | 15/22/0.650 | 17/22/0.522 |
| max-leg+.5·other | 15/24/0.661 | 11/22/0.433 |
| max-leg+.2·other | 16/23/0.685 | 12/23/0.452 |
| max-leg+1·other k=10 | 16/23/0.680 | 13/23/0.469 |
| c + rank-1 of each leg on top (*) | 15/23/0.652 | 16/23/0.517 |
| c + vector rank-1 on top (*) | 11/23/0.580 | 6/23/0.378 |

## The 9 lost-in-hybrid questions (hybrid rank, — = not in top 10)
| id | current hybrid | picked (c) hybrid |
|---|---|---|
| q06 | — | 1 |
| q09 | — | 5 |
| q28 | — | 6 |
| q33 | — | — |
| q43 | — | 1 |
| q44 | — | — |
| q45 | — | 1 |
| q47 | — | 1 |
| q64 | — | 1 |

q33 (fts rank 5) and q44 (vector rank 5) are still not in the hybrid top 10; the other 7 are back in the top 6.

## Pick
Passing: c (46/.585), RRF k=10×(1+s) (46/.574), c + rank-1-of-each-leg (46/.576), RRF k=3 (45/.580),
RRF k=3×(1+s) (44/.578). Highest hit@5 is a three-way tie at 46; MRR breaks it → **c**, which is also the
simplest (the legacy formula with one input changed, no new constants).

## Cost of the pick — read this
- On the old 27 set, c did **not** pass (hit@5 21 = 21 but MRR .630 < .649, English hit@5 6→4); it passes only
  on the 64 set under the rule fixed for it. The 27 questions are inside the 64.
- c lowers three vector-only hits: q11 1→3, q17 2→9 (drops out of top 5), q21 1→6. English+mixed hit@5 is 13 vs 14.
- Revert at any time: `ARRA_HYBRID_BLEND=legacy` (no restart of code, just env on the server).

## Re-run
`git apply docs/experiments/hybrid-blend-issue4-round2-all-variants.patch` (on `main` before this PR) gives every
variant behind `ARRA_HYBRID_BLEND` / `_W` / `_K`. Rank matrices of the final code (default and `legacy`) were
checked identical to the experiment builds `c` and `legacy`.
