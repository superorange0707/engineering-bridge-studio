# Research workflow

Engineering Bridge lets a research idea move through the same loop as a product: define the question, run a small verifiable round, inspect the result, and choose the next step.

## Who does what

- **You** choose the idea, audience, research value and final claims.
- **ChatGPT Web** researches the field, compares sources, shapes hypotheses, designs experiments, writes the outline and develops the paper.
- **Native Codex** prepares code and data checks, runs baselines and experiments, and returns scripts, metrics, logs and figures.
- **Bridge** keeps the workspace, contract, run history, artifact hashes and review available to both entrances.

## One research round

1. Start with a question that can change what you build or write next.
2. Ask ChatGPT Web to write a contract with the question, hypothesis, baselines, dataset and split, seeds, metrics, protocol, acceptance criteria and expected artifacts.
3. Submit the contract through `collaboration_run`. Codex executes it locally in a bounded scratch directory with the declared inputs and a deadline.
4. Read the actual outputs through `collaboration_result` and `collaboration_artifact`. Follow paged artifacts to EOF and compare their recorded hashes.
5. Record `accept`, `revise` or `reject` with `collaboration_review`, including the evidence behind the decision.
6. Start the next round with `parent_run_id` and describe the change: a new baseline, a corrected split, an ablation, another seed or a narrower claim.

A completed execution enters `awaiting_review`. The review connects the run to a decision; the paper claim follows from the examined evidence.

## Turn results into a paper

Keep a short evidence map alongside the manuscript:

- each claim links to a source or run ID;
- each result records the dataset version, split, seed, metric and baseline;
- each figure links to the script and data that produced it;
- failures and inconclusive rounds remain part of the research history;
- the discussion states which claims the evidence supports and where uncertainty remains.

ChatGPT Web can use reviewed metrics and figures to refine the outline and write the next section. Codex can then reproduce a figure, run an additional check or prepare a clean artifact for the manuscript. The next contract carries the decision forward without losing the earlier plan or result.

Start with the prepared [research smoke contract](../examples/research-smoke-contract.json) when setting up a first round. See the [installation guide](installation.md) for the two-entrance acceptance flow and [upstream provenance](upstreams.md) for the integrated components.
