# Decisions

## Persistent blocked-goal notification cooldown — 2026-10-14

Successful blocked-goal deliveries start a six-hour cooldown in the atomically
persisted hook state. The issue key combines session identity and stable goal
identity, using the goal ID or creation timestamp; objective wording, updated
timestamps, turn IDs, titles, polling episodes, recovery and restart cannot
change the cooldown. When goal metadata is unavailable, use the conservative
session identity. Preserve and migrate accepted delivery timestamps, and seed
confirmed ntfy history before rollout if local accepted state is incomplete.
Rejected or uncertain delivery does not record a successful timestamp. Different
goals retain independent eligibility. Keep the existing three-day episode expiry
and five-minute observation-gap log throttle found in the installed runtime.
