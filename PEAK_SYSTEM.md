# Peak System — Human-AI Collaboration Model

## Core Thesis

AI's strongest capability is **continuity** — connecting, filling, organizing, refining between defined points. Humans are strongest at **discontinuous judgment** — making directional calls at critical inflection points.

A task is not a flat line. It has topology: valleys of routine work where AI thrives, and peaks where the outcome hinges on a judgment that only a human can make. The Peak System is designed to let AI do what it's best at (connecting the peaks), while surfacing those peaks to a human at the right moment.

```
                ①                    ②                    ③
               /  \                 /  \                 /  \
Human ───────•    •───────────────•    •───────────────•    •──→
decides      peak  \             peak   \             peak
                    \   AI connects  \   AI connects
                     \_____________/  \_____________/

① Architecture choice   ② Tradeoff judgment   ③ Acceptance criteria
```

The design goal: **minimize the number of peaks a human must handle, while never missing a peak that matters.**

---

## What Is a Peak

A peak is a point in a task where the next step is **high-leverage** — getting it right compounds into good downstream outcomes, getting it wrong compounds into waste.

Four signals indicate a peak:

**Irreversibility** — the next action is hard to undo. Choosing a database, defining an external API contract, deleting a module. Once done, the cost of changing course is high.

**Multiple viable paths** — there are 2–3 reasonable options, each with real tradeoffs, and no objective best answer. This is where human judgment (taste, priorities, risk appetite) outperforms any heuristic.

**Information asymmetry** — the decision requires context the AI doesn't have. Business priorities, user preferences, team dynamics, political constraints. The AI can structure the question; only the human can answer it.

**Drift risk** — the AI has been working autonomously for a while. Even if no single step was wrong, small directional errors accumulate. A periodic checkpoint lets the human correct course before the gap widens.

---

## The Three Phases

### Phase 1: Detection

The agent recognizes it has reached a peak. This is a self-assessment, guided by rules in the agent's instructions (CLAUDE.md). The rules should be concrete, not abstract:

- "When choosing between two database approaches, escalate."
- "When about to delete or rewrite a file over 100 lines, escalate."
- "When you've been working for 15+ minutes without human input, do a drift check."
- "When you realize you need information about business priorities or user preferences to proceed, escalate."

Over time, as the system accumulates human decisions in memory, the detection becomes smarter — if the human has already expressed a preference on similar tradeoffs, the agent can reference that preference instead of escalating.

### Phase 2: Presentation

The agent calls `escalate_peak` and pauses. The system surfaces a **peak card** in the chat UI — a structured, actionable prompt for the human. The card contains:

- **Context** — a brief summary of where the agent is in the task and what led to this point
- **Options** — 2–3 choices, each with concrete pros and cons (not vague descriptions, but specific consequences: "Option A saves 2 hours now but limits future extensibility")
- **Agent's lean** — if the agent has a preference, it states it with reasoning; if not, it says so honestly
- **Default behavior** — what the agent will do if the human doesn't respond within a timeout, so work doesn't stall

The human's interaction should be minimal-friction: click an option, optionally add a note, done. A "let me think" button pauses the agent without choosing. A "you decide" button tells the agent to use its own judgment (and the agent's choice is still logged).

### Phase 3: Settlement

After the human decides, the system does three things:

1. **Resume** — the decision is returned to the waiting agent, which continues working based on the human's choice
2. **Persist** — the decision is written to memory (category: decision) with full context: what the options were, what was chosen, why (if the human added a note), and the peak type. This becomes searchable history.
3. **Propagate** — if other agents are working on related tasks, the decision is broadcast so they can align

The persistent record is the key to the system learning. When the agent encounters a similar peak later, it can search memory for past decisions and either follow the established pattern without escalating, or escalate with a reference to the precedent: "Last time you chose simplicity over performance in a similar tradeoff. Same preference here?"

---

## The Feedback Loop

The system gets better over time through a natural feedback loop:

```
Early usage:     many peaks → human is deciding frequently
                 system learns preferences, patterns, risk tolerance

Later usage:     fewer peaks → agent handles routine tradeoffs by referencing past decisions
                 only genuinely novel or high-stakes peaks reach the human

Mature usage:    rare peaks → the human's judgment has been systematically encoded
                 peaks that do surface are truly important — new territory, changed priorities
```

This is not "the AI learns to replace the human." It's "the AI learns which peaks actually need a human, and stops bothering them with the rest." The human remains the authority — they can always change a past decision, and the system propagates the update.

---

## Design Principles

**Peaks should be rare and valuable.** If the human is getting peak cards every 5 minutes, the detection threshold is too low. Each peak should feel like it genuinely matters. Better to miss a minor peak than to cry wolf.

**Presentation must be decision-ready.** The human should be able to understand the situation and choose in under 60 seconds. If the context summary takes 5 paragraphs, it's too long. If the tradeoffs aren't concrete, the agent hasn't done enough thinking before escalating.

**Work never fully stalls.** Every peak has a default action and a timeout. If the human is away, the agent proceeds with its best judgment and logs the decision for later review. The human can override retroactively.

**The agent's lean is honest.** When the agent recommends an option, it gives real reasons. When it genuinely doesn't know, it says "I don't have a strong preference." False confidence wastes the human's trust; false humility wastes their time.

**Decisions compound.** Each human decision makes the next one easier or unnecessary. The memory system ensures that no decision is made twice for the same reason. This is the core value proposition: the human's judgment is amplified, not consumed.
