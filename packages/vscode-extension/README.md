# Claude Crew

Claude Crew brings **human-governed multi-agent collaboration** into VS Code.

It is built for teams that want more than a chat window: multiple specialized agents, persistent project context, explicit decision checkpoints, and a runtime model that can coordinate both **Claude** and **Codex** without collapsing everything into one opaque assistant loop.

## Details

Claude Crew is organized around a simple idea from the PEAK System: **AI is strongest at continuity, humans are strongest at discontinuous judgment**.

That means the extension is not designed to replace the user with autonomous swarms. It is designed to let agents carry routine execution across long stretches of work, while surfacing the moments that actually deserve human judgment:

- **Irreversible choices** where a wrong turn compounds downstream cost
- **Multiple viable paths** where there is no single objective best answer
- **Information asymmetry** where only the human knows the real priority, constraint, or preference
- **Drift checks** after long autonomous runs, before low-grade misalignment becomes expensive

Instead of asking the user to constantly micromanage, Claude Crew turns those moments into structured decision points with concrete options, a stated agent lean, and an explicit default path. The goal is not maximum interruption. The goal is **fewer interruptions, but higher-value ones**.

Inside VS Code, that model sits on top of a product architecture that preserves the core strengths of the original system:

- A **provider-aware runtime** where Claude and Codex are first-class peers, not bolt-on integrations
- An **out-of-process server** so chat state, approvals, memory, projects, and runtime control are managed outside the extension host
- A **single shared operational surface** for group chat, DMs, approvals, PEAK decisions, project scope, shared artifacts, and runtime telemetry
- A **persistent team memory** layer so important decisions, standards, and project context survive beyond a single session
- A **project/workplace scope model** so teams can coordinate globally, per project, and per derived execution space without losing context boundaries

The result is a VS Code extension that acts less like a sidebar toy and more like a real coordination layer for serious multi-agent work.

## Features

- **Agent, Project, and Shared Files views in the Activity Bar**  
  Inspect who is online, what projects exist, and which artifacts are shared across scopes without leaving the editor.

- **WebView control plane for real team operations**  
  Use a unified interface for group chat, direct messages, dashboard flows, approvals, PEAK cards, and runtime-aware collaboration.

- **Cross-provider orchestration**  
  Run Claude-backed and Codex-backed agents inside the same system, with provider-specific lifecycle control and shared coordination semantics.

- **PEAK-driven human checkpoints**  
  Surface only the decisions that matter, with structured options, concrete tradeoffs, optional notes, and resumable execution after settlement.

- **Approvals, mentions, and decision notifications**  
  Bubble up tool-use approvals, pending peaks, and coordination events into VS Code so critical events are hard to miss.

- **Persistent context beyond the current chat**  
  Preserve decisions, standards, shared files, project state, and agent-facing memory so the team does not restart from zero each session.

- **Project-aware collaboration**  
  Organize agents around projects and workplaces, attach shared context to the correct scope, and keep execution aligned with the real project root.

- **Runtime controls from the editor**  
  Wake, stop, configure, inspect, and attach to agents directly from VS Code instead of juggling external terminals and ad-hoc scripts.

- **Packaged server architecture for extension delivery**  
  Bundle the server, web assets, runtime bridge, and local persistence model into an extension-first workflow instead of a fragile wrapper around a separate app.

## Why This Matters

Most multi-agent tooling optimizes for visible activity: more autonomous runs, more messages, more background motion.

Claude Crew optimizes for something harder: **keeping autonomy useful without letting it become unaccountable**.

If you need a VS Code-native system where agents can work for long stretches, but the user still remains the real authority at the high-leverage moments, that is what Claude Crew is built for.
