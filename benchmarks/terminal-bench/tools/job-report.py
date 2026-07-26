#!/usr/bin/env python3
"""What a harbor job actually did — verdict quality first, score second.

Score at k=1 cannot rank two configurations (same config, same task, across re-runs: 1,1,0,0), so the
number this prints first is the VERIFIER'S PRECISION: how often "done" was true. That verdict is in
every run log and can be compared against the real reward, which makes it a far more sensitive
instrument than 89 coin flips.

    python3 job-report.py <job-dir> [<job-dir> ...]
"""

import json
import statistics as stats
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

STEP_ORDER = ["survey", "implement", "verify", "audit"]


def iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read_events(trial: Path):
    logs = trial / "agent/.pi/workflows"
    files = sorted(logs.glob("*.jsonl")) if logs.is_dir() else []
    if not files:
        return []
    out = []
    for line in files[0].read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            break  # a trial killed mid-write leaves a truncated last line
    return out


def trial_facts(trial: Path):
    """Reward from harbor, verdict and timing from the workflow's own log."""
    task = trial.name.rsplit("__", 1)[0]
    fact = {"task": task, "reward": None, "verdict": None, "rounds": 0, "left": None, "status": "no-log", "spent": {}}

    result = trial / "result.json"
    if result.is_file():
        data = json.loads(result.read_text())
        fact["reward"] = ((data.get("verifier_result") or {}).get("rewards") or {}).get("reward")

    events = read_events(trial)
    if not events:
        return fact

    started, spent, last = {}, defaultdict(float), iso(events[-1]["at"])
    fact["status"] = "running"
    for event in events:
        kind, path = event["type"], event.get("path", "")
        base = path.split("/")[-1]
        if kind == "step-started":
            started[path] = iso(event["at"])
        elif kind in ("step-completed", "step-failed") and path in started:
            spent[base] += (iso(event["at"]) - started.pop(path)).total_seconds()
        if kind == "step-completed" and base == "implement":
            fact["rounds"] += 1
        elif kind == "step-completed" and base in ("checkpoint", "report"):
            output = event.get("output") or {}
            if "allPass" in output:
                fact["verdict"] = bool(output["allPass"])
            if output.get("remainingSec") is not None:
                fact["left"] = output["remainingSec"]
        elif kind in ("run-completed", "run-crashed", "run-cancelled"):
            fact["status"] = kind[4:]
    for path, at in started.items():  # started, never terminated: it ran until the log stopped
        spent[path.split("/")[-1]] += (last - at).total_seconds()

    fact["spent"] = dict(spent)
    fact["wall"] = (last - iso(events[0]["at"])).total_seconds()
    return fact


def report(job: Path) -> None:
    facts = [trial_facts(p) for p in sorted(p for p in job.iterdir() if p.is_dir())]
    scored = [f for f in facts if f["reward"] is not None]
    print(f"== {job.name}   {len(scored)} scored / {len(facts)} started")
    if scored:
        won = sum(1 for f in scored if f["reward"] == 1.0)
        print(f"   score {won}/{len(scored)} = {won / len(scored):.3f}")

    # Verdict quality. A "done" that scored 0 is the expensive error: the run STOPS, so whatever
    # budget was left is never spent on the repair that would have saved it.
    judged = [f for f in scored if f["verdict"] is not None]
    said_done = [f for f in judged if f["verdict"]]
    said_not = [f for f in judged if not f["verdict"]]
    fp = [f for f in said_done if f["reward"] != 1.0]
    fn = [f for f in said_not if f["reward"] == 1.0]
    if judged:
        print(f"   verdicts {len(judged)}   said-done {len(said_done)}   said-not-done {len(said_not)}")
        if said_done:
            print(f"   PRECISION on 'done': {len(said_done) - len(fp)}/{len(said_done)} = {1 - len(fp) / len(said_done):.3f}   (false positives: {len(fp)})")
        if said_not:
            print(f"   'not done' but scored 1.0: {len(fn)}/{len(said_not)}  (harmless — the run kept working)")
        if fp:
            wasted = [f["left"] for f in fp if f["left"] is not None]
            note = f", median {stats.median(wasted):.0f}s left unspent" if wasted else ""
            print(f"   false positives{note}: " + ", ".join(sorted(f["task"] for f in fp)))

    # Where the time went, against the 20/70/10 the schedule is aiming for.
    wall = sum(f.get("wall", 0) for f in facts)
    if wall:
        shares = {k: sum(f["spent"].get(k, 0) for f in facts) for k in STEP_ORDER}
        print("   time: " + "  ".join(f"{k} {100 * v / wall:.1f}%" for k, v in shares.items()))
        left = [f["left"] for f in facts if f["left"] is not None]
        if left:
            print(f"   budget left at stop: median {stats.median(left):.0f}s  max {max(left):.0f}s")
    print(f"   rounds {dict(sorted(Counter(f['rounds'] for f in facts).items()))}   status {dict(Counter(f['status'] for f in facts))}")

    for f in sorted(facts, key=lambda f: (f["reward"] is None, -(f["reward"] or 0), f["task"])):
        verdict = "-" if f["verdict"] is None else ("done" if f["verdict"] else "not-done")
        flag = "  <-- FALSE POSITIVE" if f["verdict"] and f["reward"] == 0.0 else ""
        spent = " ".join(f"{k[:2]}={f['spent'].get(k, 0):.0f}" for k in STEP_ORDER if f["spent"].get(k))
        print(f"     {f['reward']!s:>5}  {verdict:<8} r={f['rounds']} left={f['left'] and round(f['left'])!s:>5}  {f['task']:<34} {spent}{flag}")


if __name__ == "__main__":
    for arg in sys.argv[1:] or ["."]:
        report(Path(arg))
        print()
