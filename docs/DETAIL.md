# Fading Persona

A DSH plugin that gives a conversation partner memory that actually fades, and a speech style that stops sounding like an assistant.

No proxy, no Base URL change, no second client.

## What it does

Every user message is mined for stable facts (name, city, pets, likes, dislikes, birthdays, promises). On each prompt assembly the plugin injects the persona, the memories that are still clear enough to recall, and a set of speaking rules.

Memories decay on `R = exp(-Δt/S)`. When retrievability drops far enough the text itself is degraded — numbers become vague, parenthetical details vanish, long sentences cut off — so the model cannot invent details it no longer has. Recall reinforces stability, so something remembered at the edge of forgetting sticks.

## Configuration

```json
{
  "persona": { "name": "Shen Zhixia", "relationship": "a neighbour you met three months ago" },
  "memoryFile": "~/.fademem/dsh-memory.json",
  "baseStabilityDays": 6.0,
  "maxItems": 8,
  "ambientItems": 2,
  "style": true
}
```

`baseStabilityDays` is the memory tightness knob: 6 is forgetful, 12 is noticeably better, 2 is a goldfish.

## Limitations

- Extraction is regex-based; oblique statements are missed on purpose rather than guessed.
- Only user messages are mined, not assistant replies.
- The speaking rules are prompt constraints, not a guarantee.

Requires DSH 0.2.x. If `ctx.systemPrompt` or `session/event` is unavailable the plugin stays quiet instead of breaking the conversation.
