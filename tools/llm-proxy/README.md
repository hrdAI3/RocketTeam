# LLM Proxy — Claude-in-the-loop

OpenAI-compatible HTTP server. Backs the team app with you (Claude in CLI session)
as the actual model.

## Architecture

```
team app  ─POST /v1/chat/completions─►  proxy (port 9001)
                                          │
                                          ▼
                                 queue/requests/{id}.json
                                          │
                                          ▼
                                  Claude reads, writes
                                          │
                                          ▼
                                queue/responses/{id}.json
                                          │
                                          ▼
              proxy returns OpenAI ChatCompletion to team app
```

Long-poll: proxy waits up to 180s on the response file. Streaming requests
get a synthesized SSE chunked stream from the final content.

## Setup (demo flow)

1. **Start proxy** (separate terminal):
   ```
   bun tools/llm-proxy/server.ts
   ```

2. **Point team app at proxy** — `.env`:
   ```
   LLM_PROVIDER=openai_compat
   OPENAI_BASE_URL=http://localhost:9001/v1
   OPENAI_API_KEY=local
   OPENAI_MODEL=claude-via-cli
   ```

3. **Start team app**:
   ```
   bun dev
   ```

4. **Process queue from this Claude Code session**:
   - User triggers a feature in the team app (new task, sim, etc.)
   - Proxy queues request to `tools/llm-proxy/queue/requests/{id}.json`
   - You (Claude) ask: "process queue" or run /loop
   - I list pending, read the next req, write response, proxy returns to app

## File formats

`queue/requests/{id}.json`:
```json
{
  "id": "abc-123",
  "ts": "2026-05-09T...",
  "model": "claude-via-cli",
  "system": "...",
  "user": "...",
  "messages": [...],
  "temperature": 0.4,
  "max_tokens": 2048,
  "json_mode": true,
  "expects_stream": false
}
```

`queue/responses/{id}.json`:
```json
{
  "id": "abc-123",
  "content": "...your reply, raw text or JSON if json_mode...",
  "ts": "2026-05-09T..."
}
```

If `json_mode` is true, `content` MUST be valid JSON (no fences, no prose).

After a response is consumed, both request and response are moved to
`queue/archive/`.

## Helpers

```
bun tools/llm-proxy/queue.ts list                    # list pending
bun tools/llm-proxy/queue.ts show <id>               # show full request
bun tools/llm-proxy/queue.ts answer <id> <file>      # answer from file
cat reply.txt | bun tools/llm-proxy/queue.ts answer-inline <id>
```
