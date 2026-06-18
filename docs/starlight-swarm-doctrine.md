# Starlight Swarm Doctrine

Starlight swarms run as a layered operating system. Each layer has a distinct job: route intent, plan and evaluate work, execute safely, and preserve memory.

## Core Layers

**SO / Starlight Orchestrator** is the general swarm mindset and routing layer for all Starlight swarms. SO decides how work should be framed, which swarm pattern fits, what context must travel with the task, and when to escalate from a single-agent task to coordinated execution.

**Starlight Queen** is the 24/7 planner and evaluator queue. Queen turns strategic intent into ordered work, keeps backlog pressure visible, reviews outputs against goals, and decides what should be retried, promoted, archived, or handed to execution.

**AO / Agent Orchestrator** is the execution, worktree, and dashboard engine. AO manages active sessions, worker lanes, repository state, task metadata, dashboards, and the mechanics that let agents do focused implementation without losing operational visibility.

**SIS / Starlight Intelligence System** is the memory, provenance, and governance layer. SIS records what happened, why it happened, which evidence supports it, what constraints apply, and how future swarms should retrieve or trust that knowledge.

## Operating Contract

- SO routes the work.
- Queen plans and evaluates the queue.
- AO executes in managed worktrees and exposes operational state.
- SIS preserves memory, provenance, and governance.

No layer should silently absorb another layer's responsibility. A healthy swarm keeps routing, planning, execution, and institutional memory separate enough to audit, but connected enough to move work from intent to verified outcome.

## Practical Rule

When a task arrives, ask four questions in order:

1. What is the right swarm frame and route? That is SO.
2. What should be planned, prioritized, or evaluated? That is Queen.
3. What must be executed in a worktree or dashboarded session? That is AO.
4. What must be remembered, sourced, governed, or made reusable? That is SIS.

This doctrine is intentionally compact. It defines boundaries first so future runbooks, dashboards, and queue protocols can build on stable roles without mixing concerns.
