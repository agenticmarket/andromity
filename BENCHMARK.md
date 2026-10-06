# SWE-bench Lite local evaluation

The October 4, 2026 evaluation has 296 unique task reports, of which 150 report resolution. On the full 300-task Lite dataset the result is **50.0%**. The evaluated-only percentage is 50.68%; use the full-dataset score in comparisons. Four tasks have no evaluation report and count as unresolved.

This is a self-reported local run. It has not been independently rerun or accepted as an official leaderboard submission. No global rank is claimed.

## Published evidence

The [evidence directory](evaluation/swe-bench-lite-2026-10-04/) contains:

- `predictions.jsonl.gz`: 295 unique, nonempty patch predictions. The original file contained 362 rows; 63 instance IDs were repeated with identical patches. Deduplication does not select between different solutions.
- `outcomes.json`: the 296 report outcomes, patch hashes, and hashes of the original report files. Every resolved report states that its patch exists and applied successfully. All 295 prediction patches match the corresponding harness patch after trimming surrounding whitespace.
- `manifest.json`: file checksums, counts, the model alias from the local report, and provenance limitations.

The original report describes SWE-bench 5.0.2 with Windows LF and UTF-8 adjustments, and model alias `openrouter/stealth/space-bunny-alpha`. The prediction records instead use `andromity/auto`. The exact underlying model, dataset revision, agent commit, complete attempt-selection policy, run-time harness revision, and total model cost were not preserved in a complete immutable run manifest. These details must be established before treating the result as independently reproducible.

Raw session logs and machine configuration are excluded from this public pack. The locally retained full harness logs can be supplied separately after review. A report hash alone does not substitute for independent evaluation.

## Isolation and contamination limits

The runner prepares an archive of each task's base commit and initializes a fresh Git repository. It presents the issue statement to the agent rather than the reference patch. Tool subprocesses receive proxy restrictions and Python socket guards; command filters block several network utilities. These application-level restrictions do not establish an OS-enforced network sandbox and can be bypassed by other runtimes or configuration changes. Remote model inference still needs network access.

Restricting tools cannot prove that the model's training data excluded these public issues. We therefore do not claim a completely offline system, contamination-free results, or a guaranteed air gap.

## Re-evaluation

Use the official [SWE-bench evaluation guide](https://www.swebench.com/SWE-bench/guides/quickstart/) with Docker available. Decompress the prediction file and evaluate the Lite test split:

```sh
gzip -dk evaluation/swe-bench-lite-2026-10-04/predictions.jsonl.gz
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Lite \
  --split test \
  --predictions_path evaluation/swe-bench-lite-2026-10-04/predictions.jsonl \
  --run_id andromity-lite-independent
```

Record the dataset revision, harness commit, container environment, and all failures for that new run. This is an independent re-evaluation command, not a claim that the archived Windows run can be reproduced exactly. Official leaderboard submission follows the [SWE-bench submission process](https://www.swebench.com/submit.html).
