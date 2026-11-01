# Inbox Approval Demo

An AI assistant can search two mailboxes, summarise the day and draft replies. It cannot send anything. A person reads the exact text and approves it first.

**This is a demo on fictional data.** Every mailbox, person and message is invented. It is not a client rollout. It is not connected to Gmail, Yahoo or a real Make scenario, and no real mail is sent: "sent" here means a row in a simulated outbox.

## How it works

```text
Mail provider ──> Make (simulated by POST /hooks/inbound) ──> store
                                                                │
MCP host (Claude) ──> read tools + create_draft_reply ──────────┤
                                                                │
Person ──> approval desk (localhost) ──> approve exact text ──> simulated send
```

| Rule | How it is enforced |
|---|---|
| The assistant cannot send | The MCP server has no send, approve or forward tool. A test lists the tools and fails if one appears. |
| Mail text cannot redirect mail | A reply can only go to the original sender. Any other address is refused. |
| Approval covers the exact text | Approval is bound to a SHA-256 hash of recipient, subject and body. A newer draft replaces the old one, and the old approval stops working. |
| One approval, one send | The outbox key is the draft id, and a second approval returns a conflict. |
| Repeated webhooks are safe | Inbound mail is unique on mailbox plus provider message id. |
| Suspicious mail gets no reply | Messages with injected instructions or credential requests are flagged and can't be drafted against. |

The flagging is a simple pattern match and will miss cleverly worded mail. It is a convenience, not the safety boundary. The boundary is the first three rows: even a message that slips past the flag can only produce a draft, to its own sender, that a person still has to approve.

## Run it

Needs Node 24 or newer.

```bash
npm install
npm test
```

Start the approval desk, then in a second terminal run the sample client, which queues one reply over MCP:

```bash
npm run web
```

```bash
npm run client
```

Open http://127.0.0.1:4173 to review the draft. To connect an MCP host, point it at `node server.js` over stdio.

## What was checked

- 20 automated tests pass (`npm test`): workflow rules, the real MCP protocol through the SDK client, and the web endpoints.
- The sample client created drafts over stdio MCP, and they were rejected and approved through the desk in a browser, on desktop and phone widths.

## What was not checked

- A real Claude host, a real Make scenario and real mailboxes.
- Login. The desk binds to `127.0.0.1` and refuses foreign Host headers, but it has no user accounts, so it is not ready for a server.
- A real send. A real rollout needs its own transport, secrets and a test mailbox.

Personal WhatsApp and Discord DMs are out of scope because neither has an official route for personal accounts.

## How it was built

Built with AI coding tools. Claude Code wrote the code and ran the tests and the browser check.
