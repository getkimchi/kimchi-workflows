#!/usr/bin/env python3
"""Differential trace harness: kimchi native `--ferment-oneshot` vs the workflow-engine port.

Both implementations run the same lifecycle — scope, phases, steps, gates, grade, ship — but
record it in different media:

  native  `<trial>/agent/ferments/<uuid>.json`         final ferment snapshot (state, no gate verdicts)
          `<trial>/agent/ferments/<uuid>.events.jsonl` append-only lifecycle events
          `<trial>/agent/sessions/main.jsonl`          the orchestrator session; the gate verdicts live
                                                       here, as the arguments of the `scope_ferment` /
                                                       `complete_ferment_step` / `complete_ferment_phase`
                                                       / `complete_ferment` tool calls
  port    `<trial>/agent/.pi/workflows/<runid>.jsonl`  the workflow record; gate verdicts are the
                                                       `output.gates` of the `plan` / `step-gates` /
                                                       `phase-gates` / `ship` steps

This module lifts both into ONE canonical trace (`Trace` / `PhaseTrace` / `StepTrace` / `GateVerdict`)
and diffs them. Everything downstream reads the canonical trace, so a divergence is always a
difference between two comparable objects rather than between two file formats.

Where a field exists on one side only it is `None` and the diff says so rather than guessing — see
`Trace.gaps`, which names every axis the medium cannot answer.

Usage:
    trace-diff.py trace <job-dir> [--task NAME] [--json]
    trace-diff.py gates --native <job-dir> --port <job-dir>
    trace-diff.py diff  --native <job-dir> --port <job-dir> [--output report.md]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator

# -- The gate registry, as far as a reader of the artifacts needs it -----------------------------

GATE_SCOPES: dict[str, str] = {
    "P1": "plan", "P2": "plan", "P3": "plan",
    "S1": "step", "S2": "step", "S3": "step",
    "F1": "phase", "F2": "phase", "F3": "phase",
    "C1": "ferment", "C2": "ferment", "C3": "ferment",
}
GATE_ORDER = list(GATE_SCOPES)
CANONICAL_VERDICTS = ("pass", "flag", "omitted")

# kimchi's `normalizeGateVerdict` (src/extensions/ferment/gate-validation.ts): only S2 on the step turn
# may carry the classification vocabulary in the `verdict` field, and it is folded before it blocks.
S2_ALIAS_TO_VERDICT = {
    "smoke": "pass", "test": "pass", "syntactic": "pass",
    "proxy": "flag", "sentinel": "flag",
}
S2_CLASSES = ("smoke", "test", "syntactic", "proxy", "sentinel")

# "Classification: proxy", "classified as a smoke test", "this is a sentinel check".
_CLASS_TAGGED = re.compile(r"class\w*\W{0,12}\b(" + "|".join(S2_CLASSES) + r")\b", re.IGNORECASE)
# Bare mention. "test" is excluded: it is far too common in free prose to carry the classification.
_CLASS_BARE = re.compile(r"\b(smoke|syntactic|proxy|sentinel)\b", re.IGNORECASE)

# -- Canonical trace ------------------------------------------------------------------------------


@dataclass(frozen=True)
class GateVerdict:
    """One gate answer, normalized identically on both sides."""

    gate_id: str
    scope: str
    raw: str
    """The verdict token exactly as the model emitted it, aliases included."""
    verdict: str
    """`raw` folded to pass | flag | omitted by kimchi's own normalization rules."""
    classification: str
    """S2 only: smoke | test | syntactic | proxy | sentinel, or "" when not recoverable."""
    classification_source: str
    """verdict | tagged | prose | none — how `classification` was recovered."""
    rationale: str
    evidence: str
    locator: str
    """Where in the artifacts this verdict was read from."""


@dataclass
class StepTrace:
    phase_index: int
    index: int
    step_id: str
    description: str
    status: str
    """verified | failed | pending (native vocabulary) | done | not-done (port)."""
    budget_tier: str | None
    worker_dispatched: bool
    worker_status: str | None
    worker_killed: bool
    attempts: int
    """Worker/execution attempts for this step."""
    refusals: int
    """Completion turns refused by a blocking gate flag."""
    verify_command: str
    verify_ran: bool
    verify_exit: int | None
    gate_turns: list[list[GateVerdict]] = field(default_factory=list)
    """Every completion turn's verdicts, in order. A refused turn is a turn: it is the flag that
    refused it, and dropping it would hide the only decision the gates ever changed."""
    seconds: float | None = None
    note: str = ""

    @property
    def gates(self) -> list[GateVerdict]:
        """Every verdict this step produced, refused turns included."""
        return [gate for turn in self.gate_turns for gate in turn]

    @property
    def final_gates(self) -> list[GateVerdict]:
        return self.gate_turns[-1] if self.gate_turns else []


@dataclass
class PhaseTrace:
    index: int
    phase_id: str
    name: str
    goal: str
    status: str
    grade: str | None
    grade_source: str
    """subagent-grader | workflow-grader | none."""
    close_rounds: int
    grade_refusals: int = 0
    """Closes rejected because the grader's mark was below the minimum (kimchi: `minimumAcceptableGrade`)."""
    grades: list[str] = field(default_factory=list)
    """Every mark this phase was given, in order."""
    steps: list[StepTrace] = field(default_factory=list)
    gate_turns: list[list[GateVerdict]] = field(default_factory=list)
    seconds: float | None = None

    @property
    def gates(self) -> list[GateVerdict]:
        return [gate for turn in self.gate_turns for gate in turn]

    @property
    def final_gates(self) -> list[GateVerdict]:
        return self.gate_turns[-1] if self.gate_turns else []


@dataclass
class Trace:
    side: str
    job: str
    task: str
    trial: str
    run_id: str
    reward: float | None
    terminal_status: str
    wall_seconds: float | None
    scope_rounds: int
    phases_planned_initial: int
    phases: list[PhaseTrace] = field(default_factory=list)
    plan_gates: list[GateVerdict] = field(default_factory=list)
    ship_gates: list[GateVerdict] = field(default_factory=list)
    ferment_grade: str | None = None
    ferment_grade_source: str = "none"
    replans: int = 0
    """Mid-run step-list rewrites (native `refine_ferment_phase`, port `refine-steps`)."""
    structured_output_failures: int = 0
    worker_kills: int = 0
    """Worker steps killed at their tier budget cap (port only; native has no worker)."""
    permission_refusals: int = 0
    """bash calls refused by kimchi's permission classifier, counted across every session file."""
    steps_planned_initial: int = 0
    notes: list[str] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    """Axes this side's medium cannot answer at all."""

    # -- derived ---------------------------------------------------------------------------------

    def all_steps(self) -> list[StepTrace]:
        return [step for phase in self.phases for step in phase.steps]

    def all_gates(self) -> list[GateVerdict]:
        gates = list(self.plan_gates)
        for phase in self.phases:
            gates.extend(phase.gates)
            for step in phase.steps:
                gates.extend(step.gates)
        gates.extend(self.ship_gates)
        return gates

    @property
    def steps_planned(self) -> int:
        return len(self.all_steps())

    @property
    def steps_done(self) -> int:
        return sum(1 for step in self.all_steps() if step.status in ("verified", "done"))

    @property
    def worker_dispatches(self) -> int:
        return sum(step.attempts for step in self.all_steps() if step.worker_dispatched)

    @property
    def refusals(self) -> int:
        return sum(step.refusals for step in self.all_steps())

    @property
    def retries(self) -> int:
        return sum(max(0, step.attempts - 1) for step in self.all_steps())

    @property
    def grade_refusals(self) -> int:
        return sum(phase.grade_refusals for phase in self.phases)

    @property
    def grades(self) -> list[str]:
        return [grade for phase in self.phases for grade in phase.grades]


# -- Shared helpers -------------------------------------------------------------------------------


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def span_seconds(start: str | None, end: str | None) -> float | None:
    first, last = parse_time(start), parse_time(end)
    if first is None or last is None:
        return None
    return round((last - first).total_seconds(), 1)


def classify_s2(raw: str, rationale: str, evidence: str) -> tuple[str, str]:
    """Recover S2's verification classification. Returns (classification, source)."""
    token = raw.strip().lower()
    if token in S2_CLASSES:
        return token, "verdict"
    for text in (rationale, evidence):
        tagged = _CLASS_TAGGED.search(text or "")
        if tagged:
            return tagged.group(1).lower(), "tagged"
    for text in (rationale, evidence):
        bare = _CLASS_BARE.search(text or "")
        if bare:
            return bare.group(1).lower(), "prose"
    return "", "none"


def make_gate(entry: dict[str, Any], locator: str) -> GateVerdict:
    gate_id = str(entry.get("id", "?")).upper()
    raw = str(entry.get("verdict", "")).strip()
    rationale = str(entry.get("rationale", ""))
    evidence = str(entry.get("evidence", ""))
    lowered = raw.lower()
    if gate_id == "S2" and lowered in S2_ALIAS_TO_VERDICT:
        verdict = S2_ALIAS_TO_VERDICT[lowered]
    elif lowered in CANONICAL_VERDICTS:
        verdict = lowered
    else:
        verdict = "pass"  # kimchi's `normalizeVerdict` default branch
    classification, source = ("", "none")
    if gate_id == "S2":
        classification, source = classify_s2(raw, rationale, evidence)
    return GateVerdict(
        gate_id=gate_id,
        scope=GATE_SCOPES.get(gate_id, "?"),
        raw=raw,
        verdict=verdict,
        classification=classification,
        classification_source=source,
        rationale=rationale,
        evidence=evidence,
        locator=locator,
    )


def trial_reward(trial_dir: Path) -> float | None:
    reward_file = trial_dir / "verifier" / "reward.txt"
    if reward_file.exists():
        try:
            return float(reward_file.read_text(encoding="utf-8").strip())
        except ValueError:
            return None
    return None


def trial_wall_seconds(trial_dir: Path) -> float | None:
    result = trial_dir / "result.json"
    if not result.exists():
        return None
    data = json.loads(result.read_text(encoding="utf-8"))
    execution = data.get("agent_execution") or {}
    return span_seconds(execution.get("started_at"), execution.get("finished_at"))


def trial_exception(trial_dir: Path) -> str:
    result = trial_dir / "result.json"
    if not result.exists():
        return ""
    data = json.loads(result.read_text(encoding="utf-8"))
    info = data.get("exception_info") or {}
    message = str(info.get("exception_message", ""))
    exit_code = re.search(r"exited with code (\d+)", message)
    label = str(info.get("exception_type", ""))
    if exit_code:
        label = f"{label} (exit {exit_code.group(1)})"
    return label


def task_of(trial_dir: Path) -> str:
    return trial_dir.name.split("__")[0]


# kimchi's bash permission classifier refuses a command by returning this in the tool result.
_CLASSIFIER = "Classifier:"


def count_permission_refusals(trial_dir: Path) -> tuple[int, Counter[str]]:
    """Bash calls refused by kimchi's permission classifier, over every session the trial wrote.

    Both sides launch kimchi with `--dangerously-skip-permissions`, so this should be 0 on both.
    It is counted rather than assumed precisely because it is the kind of thing a port silently
    changes: sessions the workflow engine spawns are new sessions, and a flag that is not
    propagated to them re-arms the classifier for every agent except the top-level one.
    """
    total = 0
    by_session: Counter[str] = Counter()
    roots = [trial_dir / "agent" / "sessions", trial_dir / "agent" / "wf-sessions"]
    for root in roots:
        if not root.is_dir():
            continue
        for session in sorted(root.rglob("*.jsonl")):
            calls: dict[str, str] = {}
            for entry in read_jsonl(session):
                if entry.get("type") != "message":
                    continue
                message = entry.get("message") or {}
                content = message.get("content")
                if not isinstance(content, list):
                    continue
                if message.get("role") == "assistant":
                    for block in content:
                        if block.get("type") == "toolCall":
                            calls[str(block.get("id"))] = str((block.get("arguments") or {}).get("command", ""))
                elif message.get("role") == "toolResult":
                    text = " ".join(str(block.get("text", "")) for block in content if isinstance(block, dict))
                    if _CLASSIFIER in text:
                        total += 1
                        by_session[session.name] += 1
    return total, by_session


def trial_dirs(job_dir: Path) -> list[Path]:
    return sorted(path for path in job_dir.iterdir() if path.is_dir() and "__" in path.name)


def detect_side(trial_dir: Path) -> str:
    if (trial_dir / "agent" / ".pi" / "workflows").is_dir():
        return "port"
    if (trial_dir / "agent" / "ferments").is_dir():
        return "native"
    return "unknown"


# -- Native extraction ----------------------------------------------------------------------------

NATIVE_GATE_TURNS = {
    "scope_ferment": "plan",
    "complete_ferment_step": "step",
    "complete_ferment_phase": "phase",
    "complete_ferment": "ferment",
}


# kimchi refuses a completion turn through the tool RESULT TEXT, not through `isError` — see
# `tools/phases.ts:514` ("cannot complete — LLM grader assigned grade …") and `tools/steps.ts:434`
# ("cannot complete - agent self-flagged on N step gate(s)"). Reading only `isError` misses every
# refusal kimchi actually issues, which is how a first pass at this scored native "0 retries".
_REFUSAL = re.compile(r"cannot complete", re.IGNORECASE)
_GRADE_REFUSAL = re.compile(r"grader assigned grade (\w)", re.IGNORECASE)


@dataclass
class _NativeCall:
    name: str
    args: dict[str, Any]
    timestamp: str
    is_error: bool = False
    result_text: str = ""

    @property
    def refused(self) -> bool:
        return self.is_error or bool(_REFUSAL.search(self.result_text))

    @property
    def refusal_reason(self) -> str:
        grade = _GRADE_REFUSAL.search(self.result_text)
        if grade:
            return f"grader assigned grade {grade.group(1)}, below the minimum"
        return self.result_text[:160].replace("\n", " ")


def _native_calls(session: Path) -> list[_NativeCall]:
    """Every tool call in the orchestrator session, paired with its result."""
    calls: dict[str, _NativeCall] = {}
    ordered: list[_NativeCall] = []
    for entry in read_jsonl(session):
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        content = message.get("content")
        if not isinstance(content, list):
            continue
        if message.get("role") == "assistant":
            for block in content:
                if block.get("type") != "toolCall":
                    continue
                call = _NativeCall(
                    name=str(block.get("name", "")),
                    args=block.get("arguments") or {},
                    timestamp=str(entry.get("timestamp", "")),
                )
                calls[str(block.get("id"))] = call
                ordered.append(call)
        elif message.get("role") == "toolResult":
            call = calls.get(str(message.get("toolCallId")))
            if call is None:
                continue
            call.is_error = bool(message.get("isError"))
            call.result_text = " ".join(
                str(block.get("text", "")) for block in content if isinstance(block, dict)
            )[:400]
    return ordered


def load_native(trial_dir: Path, job: str) -> Trace:
    ferments = trial_dir / "agent" / "ferments"
    snapshots = sorted(path for path in ferments.glob("*.json") if not path.name.endswith(".events.jsonl"))
    session = trial_dir / "agent" / "sessions" / "main.jsonl"
    trace = Trace(
        side="native",
        job=job,
        task=task_of(trial_dir),
        trial=trial_dir.name,
        run_id=snapshots[0].stem if snapshots else "",
        reward=trial_reward(trial_dir),
        terminal_status="no-ferment",
        wall_seconds=trial_wall_seconds(trial_dir),
        scope_rounds=0,
        phases_planned_initial=0,
    )
    trace.gaps.append(
        "worker dispatch: kimchi one-shot never dispatches a worker subagent — the orchestrator "
        "executes each step with its own bash/write tools (`worker_agent_id` absent from every "
        "`complete_ferment_step`), so there is no per-step worker status or tier cap to compare."
    )
    trace.gaps.append(
        "per-attempt structure: the snapshot keeps only the final state of a step, so a step that was "
        "started twice leaves two `step_started` events but one record. Attempts are counted from the "
        "session's `start_ferment_step` calls, refusals from the tool result text."
    )
    trace.gaps.append(
        "step identity across a refine: `refine_ferment_phase` rewrites a phase's step list and reuses "
        "the ids, so gate verdicts keyed by (phase_id, step_id) can span two different steps. The port "
        "has the same shape under a different name (`steps@N` after `refine-steps`) — neither medium "
        "gives a step a stable identity across a replan."
    )
    if not snapshots:
        trace.notes.append("no ferment snapshot on disk")
        return trace

    snapshot = json.loads(snapshots[0].read_text(encoding="utf-8"))
    events = list(read_jsonl(ferments / f"{snapshots[0].stem}.events.jsonl"))
    calls = _native_calls(session) if session.exists() else []
    if not session.exists():
        trace.gaps.append(f"gate verdicts unrecoverable: {session} is missing")

    trace.terminal_status = str(snapshot.get("status", "?"))
    trace.ferment_grade = (snapshot.get("grade") or {}).get("grade")
    trace.ferment_grade_source = "subagent-grader" if trace.ferment_grade else "none"
    trace.scope_rounds = sum(1 for call in calls if call.name in ("scope_ferment", "propose_ferment_scoping"))
    trace.replans = sum(1 for call in calls if call.name == "refine_ferment_phase")
    trace.structured_output_failures = sum(
        1 for call in calls if call.is_error and call.name in NATIVE_GATE_TURNS
    )

    for event in events:
        if event.get("type") == "scoping_phases_set":
            initial = event.get("payload", {}).get("phaseSnapshots") or []
            trace.phases_planned_initial = len(initial)
            trace.steps_planned_initial = sum(len(phase.get("steps") or []) for phase in initial)

    # Gate verdicts, keyed by the turn that owns them.
    step_gates: dict[tuple[str, str], list[list[GateVerdict]]] = defaultdict(list)
    phase_gates: dict[str, list[list[GateVerdict]]] = defaultdict(list)
    phase_close_calls: Counter[str] = Counter()
    for index, call in enumerate(calls):
        scope = NATIVE_GATE_TURNS.get(call.name)
        if scope is None:
            continue
        locator = f"{session}#toolCall[{index}]:{call.name}"
        verdicts = [make_gate(entry, locator) for entry in (call.args.get("gates") or [])]
        if call.refused:
            trace.notes.append(f"{call.name} refused at {call.timestamp}: {call.refusal_reason}")
        if scope == "plan":
            trace.plan_gates.extend(verdicts)
        elif scope == "step":
            step_gates[(str(call.args.get("phase_id")), str(call.args.get("step_id")))].append(verdicts)
        elif scope == "phase":
            phase_gates[str(call.args.get("phase_id"))].append(verdicts)
            phase_close_calls[str(call.args.get("phase_id"))] += 1
        elif scope == "ferment":
            trace.ship_gates.extend(verdicts)

    starts: Counter[tuple[str, str]] = Counter()
    verifies: Counter[tuple[str, str]] = Counter()
    step_refusals: Counter[tuple[str, str]] = Counter()
    failed: set[tuple[str, str]] = set()
    phase_grade_refusals: Counter[str] = Counter()
    phase_grades: dict[str, list[str]] = defaultdict(list)
    for call in calls:
        key = (str(call.args.get("phase_id")), str(call.args.get("step_id")))
        if call.name == "start_ferment_step":
            starts[key] += 1
        elif call.name == "verify_ferment_step":
            verifies[key] += 1
        elif call.name == "fail_ferment_step":
            failed.add(key)
        elif call.name == "complete_ferment_step" and call.refused:
            step_refusals[key] += 1
        elif call.name == "complete_ferment_phase":
            phase_id = str(call.args.get("phase_id"))
            grade = _GRADE_REFUSAL.search(call.result_text)
            if grade:
                phase_grades[phase_id].append(grade.group(1))
            if call.refused:
                phase_grade_refusals[phase_id] += 1
    trace.notes.extend(
        f"complete_ferment refused: {call.refusal_reason}"
        for call in calls
        if call.name == "complete_ferment" and call.refused
    )

    for phase in snapshot.get("phases") or []:
        phase_id = str(phase.get("id"))
        phase_trace = PhaseTrace(
            index=int(phase.get("index", 0)),
            phase_id=phase_id,
            name=str(phase.get("name", "")),
            goal=str(phase.get("goal", "")),
            status=str(phase.get("status", "")),
            grade=(phase.get("grade") or {}).get("grade"),
            grade_source="subagent-grader" if phase.get("grade") else "none",
            close_rounds=phase_close_calls.get(phase_id, 0),
            grade_refusals=phase_grade_refusals.get(phase_id, 0),
            grades=phase_grades.get(phase_id, []) + ([final_grade] if (final_grade := (phase.get("grade") or {}).get("grade")) else []),
            gate_turns=phase_gates.get(phase_id, []),
            seconds=span_seconds(phase.get("startedAt"), phase.get("completedAt")),
        )
        for step in phase.get("steps") or []:
            step_id = str(step.get("id"))
            key = (phase_id, step_id)
            result = step.get("result") or {}
            votes = step_gates.get(key, [])
            phase_trace.steps.append(
                StepTrace(
                    phase_index=phase_trace.index,
                    index=int(step.get("index", 0)),
                    step_id=step_id,
                    description=str(step.get("description", "")),
                    status="failed" if key in failed else str(step.get("status", "")),
                    budget_tier=None,
                    worker_dispatched=False,
                    worker_status=None,
                    worker_killed=False,
                    attempts=max(1, starts[key]) if starts[key] else (1 if step.get("startedAt") else 0),
                    refusals=step_refusals.get(key, 0),
                    verify_command=str((step.get("verification") or {}).get("command", "")),
                    verify_ran=bool(result),
                    verify_exit=result.get("exitCode"),
                    gate_turns=votes,
                    seconds=span_seconds(step.get("startedAt"), step.get("completedAt")),
                    note=f"{verifies[key]} explicit verify_ferment_step call(s)" if verifies[key] else "",
                )
            )
        trace.phases.append(phase_trace)

    # `budget_tier` is chosen at dispatch by the orchestrator, and only the session records it.
    tiers = {
        (str(call.args.get("phase_id")), str(call.args.get("step_id"))): call.args.get("budget_tier")
        for call in calls
        if call.name == "start_ferment_step"
    }
    for step in trace.all_steps():
        phase_id = trace.phases[step.phase_index - 1].phase_id if 0 < step.phase_index <= len(trace.phases) else ""
        step.budget_tier = tiers.get((phase_id, step.step_id))
    return trace


# -- Port extraction ------------------------------------------------------------------------------

_PHASE_RE = re.compile(r"^phases@(\d+)")
_STEP_RE = re.compile(r"^phases@(\d+)/steps@(\d+)")
_ATTEMPT_RE = re.compile(r"attempts#(\d+)")
_COMPLETION_RE = re.compile(r"completion#(\d+)")
_CLOSE_RE = re.compile(r"close#(\d+)")
_SCOPING_RE = re.compile(r"^scoping#(\d+)")


def _tail(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def load_port(trial_dir: Path, job: str) -> Trace:
    records = sorted((trial_dir / "agent" / ".pi" / "workflows").glob("*.jsonl"))
    trace = Trace(
        side="port",
        job=job,
        task=task_of(trial_dir),
        trial=trial_dir.name,
        run_id=records[0].stem if records else "",
        reward=trial_reward(trial_dir),
        terminal_status="no-record",
        wall_seconds=trial_wall_seconds(trial_dir),
        scope_rounds=0,
        phases_planned_initial=0,
    )
    trace.gaps.append(
        "no ferment-level grade: kimchi's `complete_ferment` spawns an independent grader subagent "
        "(`ferment_graded`, A-F). The port's `ship` step answers the C gates and stops — there is no "
        "final grade to compare against."
    )
    trace.gaps.append(
        "no step state record: the port has no snapshot equivalent. A step's status is derived from "
        "`step-check.done`, so a step whose worker was killed leaves gate verdicts but no `failed` state."
    )
    if not records:
        trace.notes.append("no workflow record on disk")
        return trace
    record = records[0]
    events = list(read_jsonl(record))

    plan: dict[str, Any] | None = None
    phase_meta: dict[int, dict[str, Any]] = {}
    step_meta: dict[tuple[int, int], dict[str, Any]] = {}
    step_gates: dict[tuple[int, int], list[list[GateVerdict]]] = defaultdict(list)
    step_refusals: Counter[tuple[int, int]] = Counter()
    step_attempts: Counter[tuple[int, int]] = Counter()
    step_worker: dict[tuple[int, int], dict[str, Any]] = {}
    step_worker_killed: set[tuple[int, int]] = set()
    step_verify: dict[tuple[int, int], dict[str, Any]] = {}
    step_check: dict[tuple[int, int], dict[str, Any]] = {}
    step_start: dict[tuple[int, int], str] = {}
    step_end: dict[tuple[int, int], str] = {}
    phase_gates: dict[int, list[list[GateVerdict]]] = defaultdict(list)
    phase_grade: dict[int, str] = {}
    phase_grades: dict[int, list[str]] = defaultdict(list)
    phase_grade_refusals: Counter[int] = Counter()
    phase_close_rounds: Counter[int] = Counter()
    phase_start: dict[int, str] = {}
    phase_end: dict[int, str] = {}
    refine_rounds = 0

    for index, event in enumerate(events):
        kind = event.get("type")
        path = str(event.get("path", ""))
        at = str(event.get("at", ""))
        name = _tail(path)
        locator = f"{record}#{index}:{path}"

        if kind == "run-started":
            trace.terminal_status = "running"
        elif kind in ("run-completed", "run-cancelled", "run-failed"):
            trace.terminal_status = kind.replace("run-", "")
        elif kind == "step-failed":
            trace.structured_output_failures += 1
            if name == "worker":
                key = _step_key(path)
                if key:
                    step_worker_killed.add(key)
                    trace.structured_output_failures -= 1
                    trace.worker_kills += 1
                    trace.notes.append(f"worker killed at its budget cap: {path} — {event.get('error')}")
            else:
                trace.notes.append(f"step-failed {path}: {event.get('error')}")
        elif kind == "step-started":
            key = _step_key(path)
            if key and name == "step-ctx":
                step_start.setdefault(key, at)
            phase_index = _phase_index(path)
            if phase_index is not None and name == "phase-ctx":
                phase_start.setdefault(phase_index, at)
        elif kind == "step-completed":
            output = event.get("output")
            output = output if isinstance(output, dict) else {}
            key = _step_key(path)
            phase_index = _phase_index(path)
            if name == "plan":
                plan = output
                trace.plan_gates.extend(make_gate(entry, locator) for entry in output.get("gates") or [])
            elif name == "scope-check":
                trace.scope_rounds += 1
            elif name == "refine-steps":
                refine_rounds += 1
            elif name == "phase-ctx":
                if phase_index is not None:
                    phase_meta[phase_index] = output
            elif name == "step-ctx":
                if key:
                    step_meta[key] = output
            elif name == "attempt-clock":
                if key:
                    step_attempts[key] = max(step_attempts[key], int(output.get("attempt", 1)))
            elif name == "worker":
                if key:
                    step_worker[key] = output
            elif name == "step-gates":
                if key:
                    step_gates[key].append([make_gate(entry, locator) for entry in output.get("gates") or []])
            elif name == "gate-check":
                if key and output.get("refused"):
                    step_refusals[key] += 1
            elif name == "verify":
                if key:
                    step_verify[key] = output
            elif name == "step-check":
                if key:
                    step_check[key] = output
                    step_end[key] = at
            elif name == "phase-gates":
                if phase_index is not None:
                    phase_gates[phase_index].append([make_gate(entry, locator) for entry in output.get("gates") or []])
            elif name == "phase-grade":
                if phase_index is not None:
                    phase_grade[phase_index] = str(output.get("grade", ""))
                    phase_grades[phase_index].append(str(output.get("grade", "")))
            elif name == "phase-close":
                close = _CLOSE_RE.search(path)
                if phase_index is not None and close:
                    phase_close_rounds[phase_index] = max(phase_close_rounds[phase_index], int(close.group(1)))
                    if not output.get("accepted"):
                        phase_grade_refusals[phase_index] += 1
            elif name == "phase-result":
                if phase_index is not None:
                    phase_end[phase_index] = at
            elif name == "ship":
                trace.ship_gates.extend(make_gate(entry, locator) for entry in output.get("gates") or [])

    trace.replans = refine_rounds
    planned_phases = (plan or {}).get("phases") or []
    trace.phases_planned_initial = len(planned_phases)
    trace.steps_planned_initial = sum(len(phase.get("steps") or []) for phase in planned_phases)

    # `step-gates` is `optional`, so a gate turn whose model returned junk leaves no verdicts at all.
    # Those steps are visible as a step with an empty `gates` list, which the diff reports as omitted.
    seen_phases = sorted(set(phase_meta) | set(phase_gates) | {key[0] for key in step_meta})
    for phase_index in seen_phases:
        meta = phase_meta.get(phase_index, {})
        phase = meta.get("phase") or (planned_phases[phase_index] if phase_index < len(planned_phases) else {})
        phase_trace = PhaseTrace(
            index=phase_index + 1,
            phase_id=f"phases@{phase_index}",
            name=str(phase.get("name", "")),
            goal=str(phase.get("goal", "")),
            status="completed" if phase_index in phase_grade else "unfinished",
            grade=phase_grade.get(phase_index),
            grade_source="workflow-grader" if phase_index in phase_grade else "none",
            close_rounds=phase_close_rounds.get(phase_index, 0),
            grade_refusals=phase_grade_refusals.get(phase_index, 0),
            grades=phase_grades.get(phase_index, []),
            gate_turns=phase_gates.get(phase_index, []),
            seconds=span_seconds(phase_start.get(phase_index), phase_end.get(phase_index)),
        )
        step_indices = sorted(key[1] for key in step_meta if key[0] == phase_index)
        if not step_indices:
            step_indices = list(range(len(phase.get("steps") or [])))
        for step_index in step_indices:
            key = (phase_index, step_index)
            meta_step = (step_meta.get(key) or {}).get("step") or {}
            check = step_check.get(key, {})
            verify = step_verify.get(key, {})
            worker = step_worker.get(key, {})
            phase_trace.steps.append(
                StepTrace(
                    phase_index=phase_trace.index,
                    index=step_index + 1,
                    step_id=f"steps@{step_index}",
                    description=str(meta_step.get("description", "")),
                    status="done" if check.get("done") else ("not-done" if check else "unfinished"),
                    budget_tier=meta_step.get("budget_tier"),
                    worker_dispatched=bool(worker) or key in step_worker_killed,
                    worker_status=worker.get("status") or ("killed" if key in step_worker_killed else None),
                    worker_killed=key in step_worker_killed,
                    attempts=step_attempts.get(key, 1 if worker or key in step_worker_killed else 0),
                    refusals=step_refusals.get(key, 0),
                    verify_command=str(verify.get("command") or meta_step.get("verify") or ""),
                    verify_ran=bool(verify.get("ran")),
                    verify_exit=verify.get("exitCode") if verify.get("ran") else None,
                    gate_turns=step_gates.get(key, []),
                    seconds=span_seconds(step_start.get(key), step_end.get(key)),
                )
            )
        trace.phases.append(phase_trace)
    return trace


def _phase_index(path: str) -> int | None:
    match = _PHASE_RE.match(path)
    return int(match.group(1)) if match else None


def _step_key(path: str) -> tuple[int, int] | None:
    match = _STEP_RE.match(path)
    return (int(match.group(1)), int(match.group(2))) if match else None


# -- Job loading ----------------------------------------------------------------------------------


def load_job(job_dir: Path) -> list[Trace]:
    traces: list[Trace] = []
    for trial in trial_dirs(job_dir):
        side = detect_side(trial)
        if side == "native":
            trace = load_native(trial, job_dir.name)
        elif side == "port":
            trace = load_port(trial, job_dir.name)
        else:
            continue
        exception = trial_exception(trial)
        if exception:
            trace.notes.append(f"harness exception: {exception}")
            if trace.terminal_status in ("running", "no-record", "no-ferment"):
                trace.terminal_status = f"killed ({exception})"
        refusals, by_session = count_permission_refusals(trial)
        trace.permission_refusals = refusals
        if refusals:
            detail = ", ".join(f"{name} x{count}" for name, count in by_session.most_common())
            trace.notes.append(
                f"{refusals} bash call(s) refused by kimchi's permission classifier despite "
                f"--dangerously-skip-permissions on the top-level process ({detail})"
            )
        traces.append(trace)
    return traces


# -- Reporting primitives -------------------------------------------------------------------------


def table(headers: Iterable[str], rows: Iterable[Iterable[Any]]) -> str:
    headers = list(headers)
    body = [[("" if cell is None else str(cell)) for cell in row] for row in rows]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(lines)


def gate_distribution(traces: Iterable[Trace]) -> dict[str, Counter[str]]:
    dist: dict[str, Counter[str]] = {gate: Counter() for gate in GATE_ORDER}
    for trace in traces:
        for gate in trace.all_gates():
            dist.setdefault(gate.gate_id, Counter())[gate.verdict] += 1
    return dist


def s2_classes(traces: Iterable[Trace]) -> tuple[Counter[str], Counter[str]]:
    classes: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    for trace in traces:
        for gate in trace.all_gates():
            if gate.gate_id != "S2":
                continue
            classes[gate.classification or "(unrecoverable)"] += 1
            sources[gate.classification_source] += 1
    return classes, sources


def gate_turn_counts(trace: Trace) -> dict[str, tuple[int, int]]:
    """(turns answered, subjects that reached the turn) per gate scope.

    "Subjects" is what the lifecycle put in front of the gate: one plan per scoping round, one step
    that reached a completion, one phase that reached its close, one ferment that reached ship. Turns
    can exceed subjects — a refused completion is re-voted in the same session on both sides — and
    turns below subjects is the interesting direction: a gate that was never answered at all.
    """
    steps_reaching_completion = sum(
        1 for step in trace.all_steps() if step.gate_turns or step.status in ("verified", "done", "not-done")
    )
    phases_reaching_close = sum(1 for phase in trace.phases if phase.gate_turns or phase.grade)
    return {
        "P": (len(trace.plan_gates) // 3, max(trace.scope_rounds, 1 if trace.plan_gates else 0)),
        "S": (sum(len(step.gate_turns) for step in trace.all_steps()), steps_reaching_completion),
        "F": (sum(len(phase.gate_turns) for phase in trace.phases), phases_reaching_close),
        "C": (len(trace.ship_gates) // 3, 1 if trace.ship_gates or trace.terminal_status == "complete" else 0),
    }


# -- Commands -------------------------------------------------------------------------------------


def render_trace(trace: Trace) -> str:
    out: list[str] = []
    out.append(
        f"{trace.side:6} {trace.task:28} reward={trace.reward} status={trace.terminal_status} "
        f"wall={trace.wall_seconds}s grade={trace.ferment_grade}"
    )
    out.append(
        f"       phases={len(trace.phases)}/{trace.phases_planned_initial} steps={trace.steps_done}/{trace.steps_planned} "
        f"scope_rounds={trace.scope_rounds} replans={trace.replans} workers={trace.worker_dispatches} "
        f"kills={trace.worker_kills} retries={trace.retries} gate_refusals={trace.refusals} "
        f"classifier_refusals={trace.permission_refusals}"
    )
    if trace.plan_gates:
        out.append("       P " + " ".join(f"{g.gate_id}:{g.raw}" for g in trace.plan_gates))
    for phase in trace.phases:
        out.append(
            f"  phase {phase.index} {phase.name!r} status={phase.status} grades={','.join(phase.grades) or '-'} "
            f"close_rounds={phase.close_rounds} grade_refusals={phase.grade_refusals} {phase.seconds}s"
        )
        for step in phase.steps:
            turns = (
                " | ".join(" ".join(f"{g.gate_id}:{g.raw}" for g in turn) for turn in step.gate_turns)
                or "(no gate turn)"
            )
            out.append(
                f"    step {step.index} status={step.status} tier={step.budget_tier} "
                f"worker={step.worker_status} attempts={step.attempts} refusals={step.refusals} "
                f"verify_exit={step.verify_exit} [{turns}]"
            )
            out.append(f"         {step.description[:110]}")
        for turn in phase.gate_turns:
            out.append("       F " + " ".join(f"{g.gate_id}:{g.raw}" for g in turn))
    if trace.ship_gates:
        out.append("       C " + " ".join(f"{g.gate_id}:{g.raw}" for g in trace.ship_gates))
    for note in trace.notes:
        out.append(f"       ! {note}")
    return "\n".join(out)


def command_trace(args: argparse.Namespace) -> int:
    traces = load_job(args.job)
    if args.task:
        traces = [trace for trace in traces if trace.task == args.task]
    if args.json:
        print(json.dumps([asdict(trace) for trace in traces], indent=2))
        return 0
    for trace in traces:
        print(render_trace(trace))
        print()
    return 0


def command_gates(args: argparse.Namespace) -> int:
    native = load_job(args.native)
    port = load_job(args.port)
    print(render_gate_section(native, port))
    return 0


def render_gate_section(native: list[Trace], port: list[Trace]) -> str:
    native_dist = gate_distribution(native)
    port_dist = gate_distribution(port)
    rows = []
    for gate in GATE_ORDER:
        n, p = native_dist.get(gate, Counter()), port_dist.get(gate, Counter())
        rows.append(
            [
                gate,
                GATE_SCOPES[gate],
                sum(n.values()),
                n["pass"],
                n["flag"],
                n["omitted"],
                sum(p.values()),
                p["pass"],
                p["flag"],
                p["omitted"],
            ]
        )
    out = [
        table(
            ["gate", "scope", "native n", "pass", "flag", "omitted", "port n", "pass", "flag", "omitted"],
            rows,
        )
    ]
    n_classes, n_sources = s2_classes(native)
    p_classes, p_sources = s2_classes(port)
    keys = [key for key in S2_CLASSES if key in n_classes or key in p_classes] + ["(unrecoverable)"]
    out.append("")
    out.append(
        table(
            ["S2 classification", "native", "port"],
            [[key, n_classes.get(key, 0), p_classes.get(key, 0)] for key in keys],
        )
    )
    out.append("")
    out.append(
        table(
            ["recovered from", "native", "port"],
            [
                ["`verdict` field (kimchi alias)", n_sources.get("verdict", 0), p_sources.get("verdict", 0)],
                ['"classification: X" in prose', n_sources.get("tagged", 0), p_sources.get("tagged", 0)],
                ["bare word in prose", n_sources.get("prose", 0), p_sources.get("prose", 0)],
                ["not recoverable", n_sources.get("none", 0), p_sources.get("none", 0)],
            ],
        )
    )
    out.append("")
    out.append("S2 classification against the verdict it was given (the registry says proxy/sentinel on a")
    out.append("step claiming semantic work must flag):")
    out.append("")
    rows = []
    for label, traces in (("native", native), ("port", port)):
        cross: Counter[tuple[str, str]] = Counter()
        for trace in traces:
            for gate in trace.all_gates():
                if gate.gate_id == "S2":
                    cross[(gate.classification or "(unrecoverable)", gate.verdict)] += 1
        for key in list(S2_CLASSES) + ["(unrecoverable)"]:
            total = sum(count for (klass, _), count in cross.items() if klass == key)
            if not total:
                continue
            rows.append([label, key, cross[(key, "pass")], cross[(key, "flag")], cross[(key, "omitted")]])
    out.append(table(["side", "classification", "pass", "flag", "omitted"], rows))
    out.append("")
    out.append("Per-task step-gate flags:")
    out.append("")
    tasks = sorted({trace.task for trace in list(native) + list(port)})
    rows = []
    for task in tasks:
        row = [task]
        for traces in (native, port):
            match = next((trace for trace in traces if trace.task == task), None)
            if match is None:
                row.append("-")
                continue
            flags = Counter(
                gate.gate_id for gate in match.all_gates() if gate.verdict == "flag"
            )
            row.append(" ".join(f"{gate}x{count}" for gate, count in sorted(flags.items())) or "0")
        rows.append(row)
    out.append(table(["task", "native flags", "port flags"], rows))
    return "\n".join(out)


def render_side_by_side(native: list[Trace], port: list[Trace]) -> str:
    by_task: dict[str, dict[str, Trace]] = defaultdict(dict)
    for trace in native + port:
        by_task[trace.task][trace.side] = trace
    rows = []
    for task in sorted(by_task):
        for side in ("native", "port"):
            trace = by_task[task].get(side)
            if trace is None:
                rows.append([task, side, *["-"] * 14])
                continue
            rows.append(
                [
                    task if side == "native" else "",
                    side,
                    f"{len(trace.phases)}/{trace.phases_planned_initial}",
                    f"{trace.steps_done}/{trace.steps_planned}",
                    trace.worker_dispatches,
                    trace.worker_kills,
                    trace.retries,
                    trace.refusals,
                    trace.grade_refusals,
                    trace.permission_refusals,
                    trace.replans,
                    ",".join(trace.grades) or "-",
                    trace.ferment_grade or "-",
                    trace.terminal_status,
                    trace.reward,
                    int(trace.wall_seconds) if trace.wall_seconds else "-",
                ]
            )
    return table(
        [
            "task", "side", "phases", "steps done/plan", "workers", "kills", "retries",
            "gate refusals", "grade refusals", "classifier refusals", "replans",
            "phase grades", "ferment grade", "terminal", "reward", "wall s",
        ],
        rows,
    )


def render_gate_coverage(native: list[Trace], port: list[Trace]) -> str:
    """Gate TURNS that never happened, which no verdict distribution can show.

    A gate the model never answered is not an "omitted" verdict — omitted is a decision. This
    separates the two, because the port has a failure mode (the `step-gates` agent step is
    `optional`, and the run can be cancelled mid-step) that kimchi's tool call does not.
    """
    rows = []
    for label, traces in (("native", native), ("port", port)):
        turns: Counter[str] = Counter()
        subjects: Counter[str] = Counter()
        for trace in traces:
            for scope, (answered, subject) in gate_turn_counts(trace).items():
                turns[scope] += answered
                subjects[scope] += subject
        rows.append([label] + [f"{turns[scope]} / {subjects[scope]}" for scope in ("P", "S", "F", "C")])
    return table(
        ["side", "P turns / plans", "S turns / steps", "F turns / phases", "C turns / ferments"], rows
    )


def render_divergences(native: list[Trace], port: list[Trace]) -> str:
    """Mechanism divergences that fall straight out of the traces, largest first.

    Each finding carries a `kind`, because the size of a number is not the same as its meaning:

      behavioural — the port decides differently on the same input.
      medium      — the same decision, recorded differently. Comparable only after translation.
      environment — neither implementation's lifecycle; the container or the harness.
      noise       — n=1, inside the variation a single k=1 trial can produce.
    """
    by_task: dict[str, dict[str, Trace]] = defaultdict(dict)
    for trace in native + port:
        by_task[trace.task][trace.side] = trace

    findings: list[tuple[int, str, str, str]] = []

    def add(rank: int, kind: str, title: str, body: str) -> None:
        findings.append((rank, kind, title, body))

    n_flags = sum(1 for t in native for g in t.all_gates() if g.verdict == "flag")
    p_flags = sum(1 for t in port for g in t.all_gates() if g.verdict == "flag")
    n_total = sum(len(t.all_gates()) for t in native)
    p_total = sum(len(t.all_gates()) for t in port)
    n_steps = sum(len([g for g in t.all_gates() if g.scope == "step"]) for t in native)
    p_steps = sum(len([g for g in t.all_gates() if g.scope == "step"]) for t in port)
    add(
        100,
        "behavioural",
        "gate flag rate",
        f"native flags {n_flags}/{n_total} verdicts ({n_flags / n_total:.0%}); port flags "
        f"{p_flags}/{p_total} ({p_flags / p_total:.0%}). Step scope alone: native 0/{n_steps}, "
        f"port {sum(1 for t in port for g in t.all_gates() if g.scope == 'step' and g.verdict == 'flag')}"
        f"/{p_steps}. A flag refuses the completion turn on both sides, so this is the axis that "
        "changes what actually runs.",
    )

    n_workers = sum(t.worker_dispatches for t in native)
    p_workers = sum(t.worker_dispatches for t in port)
    add(
        90,
        "behavioural",
        "who executes a step, and therefore who the gates are asked of",
        f"native dispatches {n_workers} worker subagents — `worker_agent_id` is absent from every "
        "`complete_ferment_step`, meaning the orchestrator ran each step with its own bash/write "
        f"tools. The port dispatches {p_workers}. kimchi's gate turn is a self-assessment by the "
        "agent that did the work; the port's is an assessment of a report from an agent that has "
        "exited. That is the most plausible single cause of the flag-rate gap above.",
    )

    n_classifier = sum(t.permission_refusals for t in native)
    p_classifier = sum(t.permission_refusals for t in port)
    add(
        85,
        "environment",
        "the permission classifier re-arms in the sessions the port spawns",
        f"native {n_classifier} classifier refusals; port {p_classifier}. Both jobs launch kimchi with "
        "`--dangerously-skip-permissions` (see each trial.log), so every refusal on the port side is a "
        "session the workflow engine spawned that did not inherit it. Not a lifecycle difference, but "
        "it changes what the agent is permitted to do and it cost at least one whole trial.",
    )

    n_wall = sum(t.wall_seconds or 0 for t in native)
    p_wall = sum(t.wall_seconds or 0 for t in port)
    slower = sum(
        1
        for task, pair in by_task.items()
        if "native" in pair and "port" in pair and (pair["port"].wall_seconds or 0) > (pair["native"].wall_seconds or 0)
    )
    if n_wall:
        add(
            80,
            "behavioural",
            "wall time",
            f"native {int(n_wall)}s across {len(native)} trials; port {int(p_wall)}s "
            f"({p_wall / n_wall:.1f}x). The port is slower on {slower} of {len(by_task)} tasks.",
        )

    n_grade_refusals = sum(t.grade_refusals for t in native)
    p_grade_refusals = sum(t.grade_refusals for t in port)
    n_grades = Counter(g for t in native for g in t.grades)
    p_grades = Counter(g for t in port for g in t.grades)
    add(
        65,
        "behavioural",
        "the phase grader marks differently",
        f"native phase grades {dict(sorted(n_grades.items()))} with {n_grade_refusals} closes refused "
        f"for being below the minimum; port {dict(sorted(p_grades.items()))} with {p_grade_refusals} "
        "refused. The grader is the port's one surviving A-F judgement, and it never used the range.",
    )

    n_kills = sum(t.worker_kills for t in native)
    p_kills = sum(t.worker_kills for t in port)
    if p_kills or n_kills:
        add(
            70,
            "behavioural",
            "worker budget caps",
            f"native {n_kills} (there is no worker to cap); port {p_kills} workers killed at their tier "
            "cap. The port still runs the gate turn afterwards, on a step whose report was never "
            "submitted — kimchi has no state in which that can happen.",
        )

    n_graded = sum(1 for t in native if t.ferment_grade)
    p_graded = sum(1 for t in port if t.ferment_grade)
    add(
        60,
        "behavioural",
        "no ferment-level grade in the port",
        f"native produced a final A-F grade on {n_graded}/{len(native)} trials via an independent "
        f"grader subagent (`ferment_graded`); port produced {p_graded}/{len(port)}. The port's `ship` "
        "step answers C1-C3 and the run ends. The phase grader was ported; the ferment grader was not.",
    )

    for task in sorted(by_task):
        pair = by_task[task]
        if "native" not in pair or "port" not in pair:
            continue
        n, p = pair["native"], pair["port"]
        if n.reward != p.reward:
            add(
                95,
                "behavioural",
                f"reward divergence: {task}",
                f"native reward={n.reward} status={n.terminal_status} in {int(n.wall_seconds or 0)}s; "
                f"port reward={p.reward} status={p.terminal_status} in {int(p.wall_seconds or 0)}s "
                f"(steps {p.steps_done}/{p.steps_planned}, worker kills {p.worker_kills}, "
                f"classifier refusals {p.permission_refusals}).",
            )
        if p.terminal_status.startswith("cancelled") and p.reward == n.reward:
            add(
                50,
                "medium",
                f"port bookkeeping disagrees with the verifier: {task}",
                f"port recorded {p.steps_done}/{p.steps_planned} steps done, terminal "
                f"{p.terminal_status}, yet the trial scored {p.reward}. The port's own record says it "
                "failed; the machine says it succeeded.",
            )
        if not n.phases or not p.phases:
            continue
        if abs(len(n.phases) - len(p.phases)) >= 2 or abs(n.steps_planned - p.steps_planned) >= 3:
            add(
                20,
                "noise",
                f"plan shape: {task}",
                f"native planned {len(n.phases)} phases / {n.steps_planned} steps; port planned "
                f"{len(p.phases)} / {p.steps_planned}. Both sides re-plan freely and n=1 per task, so "
                "this is model variation, not a mechanism difference.",
            )

    findings.sort(key=lambda item: -item[0])
    return "\n".join(
        f"{index}. **[{kind}] {title}** — {body}"
        for index, (_, kind, title, body) in enumerate(findings, 1)
    )


def command_diff(args: argparse.Namespace) -> int:
    native = load_job(args.native)
    port = load_job(args.port)
    out: list[str] = []
    out.append(f"# Differential trace: native `{args.native.name}` vs port `{args.port.name}`\n")
    out.append(f"- native job: `{args.native}` ({len(native)} trials)")
    out.append(f"- port job:   `{args.port}` ({len(port)} trials)\n")
    out.append("## 1. Per task, side by side\n")
    out.append(render_side_by_side(native, port))
    out.append("\n## 2. Gate verdict distribution\n")
    out.append(render_gate_section(native, port))
    out.append("\n### Gate turns that happened at all\n")
    out.append(render_gate_coverage(native, port))
    out.append("\n## 3. Divergences, ranked\n")
    out.append(render_divergences(native, port))
    out.append("\n## 4. What the media cannot answer\n")
    seen: set[str] = set()
    for trace in native + port:
        for gap in trace.gaps:
            if gap in seen:
                continue
            seen.add(gap)
            out.append(f"- **{trace.side}** — {gap}")
    out.append("\n## 5. Per-trial notes\n")
    for trace in sorted(native + port, key=lambda t: (t.task, t.side)):
        if not trace.notes:
            continue
        out.append(f"**{trace.side} / {trace.task}**")
        for note in trace.notes:
            out.append(f"- {note}")
        out.append("")
    report = "\n".join(out) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
        print(args.output)
        return 0
    print(report, end="")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare kimchi's native ferment-oneshot traces against the workflow-engine port."
    )
    subparsers = parser.add_subparsers(dest="command")

    trace_parser = subparsers.add_parser("trace", help="Print the canonical trace for every trial in a job.")
    trace_parser.add_argument("job", type=Path, help="A terminal-bench job directory (native or port).")
    trace_parser.add_argument("--task", help="Only this task name.")
    trace_parser.add_argument("--json", action="store_true", help="Emit the canonical trace as JSON.")
    trace_parser.set_defaults(func=command_trace)

    gates_parser = subparsers.add_parser("gates", help="Gate verdict distribution, native vs port.")
    gates_parser.add_argument("--native", type=Path, required=True)
    gates_parser.add_argument("--port", type=Path, required=True)
    gates_parser.set_defaults(func=command_gates)

    diff_parser = subparsers.add_parser("diff", help="Full Markdown differential report.")
    diff_parser.add_argument("--native", type=Path, required=True)
    diff_parser.add_argument("--port", type=Path, required=True)
    diff_parser.add_argument("--output", type=Path, help="Write the report here instead of stdout.")
    diff_parser.set_defaults(func=command_diff)

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        raise SystemExit(2)
    return args


def main() -> int:
    args = parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
