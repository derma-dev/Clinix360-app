# Clinix360 — Backend Flow Diagrams

*Companion to [BACKEND_FLOWS_MEETING_BRIEF_2026-08-05.md](BACKEND_FLOWS_MEETING_BRIEF_2026-08-05.md). View in VSCode/GitHub markdown preview to render the Mermaid.*

---

## 0. Architecture — the pieces and how they connect

One app, one database, one webhook. Three platforms (IG · FB · WhatsApp) all feed the same `/webhook/meta` endpoint; the code routes by event.

```mermaid
flowchart LR
    CUST([Customer<br/>IG · FB · WhatsApp])
    META{{"Meta"}}
    STAFF([Branch Staff])
    ADMIN([Admin])

    APP["Clinix360 Dashboard<br/>(static app · Netlify)"]
    FN["Netlify Functions<br/>/webhook/meta · email (Resend) · scheduled automations"]
    DB[("Supabase Postgres<br/>cashup · leads · messages · settings")]
    RT["Supabase Realtime"]

    CUST --> META
    META -->|"1 inbound event"| FN
    FN -->|"2 identify platform · find/create lead · store msg"| DB
    DB -->|"3 new row"| RT
    RT -.->|"4 push (no refresh)"| APP
    APP -->|"5 staff reply"| FN
    FN -->|"6 send via Meta API"| META
    META --> CUST

    STAFF --> APP
    ADMIN --> APP
    APP <--> DB
```

---

## Flow A — Daily Cash-up (live since day one)

```mermaid
flowchart TD
    L[Staff logs in with branch PIN] --> F["Fill cash-up sheet:<br/>sales · expenses · extras · handover"]
    F --> S[Submit Final]
    S --> DB[("Supabase")]
    DB --> K["Admin panel: live KPIs across 3 branches<br/>reports · variance alerts"]
    DB --> E["Automated email → admin<br/>reports + variance alerts"]
    K -.-> N["closing = opening + cash sales<br/>− handover + extras − expenses"]
```

---

## Flow B — Unified Lead Inbox (IG · FB · WhatsApp)

One inbound path, one reply path, three platforms. The realtime push is what makes it feel live.

```mermaid
sequenceDiagram
    participant C as Customer
    participant M as Meta (IG/FB/WA)
    participant W as /webhook/meta
    participant DB as Supabase
    participant RT as Realtime
    participant S as Staff Dashboard

    C->>M: DM / message
    M->>W: inbound event
    W->>DB: identify platform, find-or-create lead, store message
    DB->>RT: new message row
    RT-->>S: push (no refresh)
    S->>W: staff types reply
    W->>M: send via Meta API
    W->>DB: store as outgoing
    M->>C: reply delivered
```

---

## Flow C — Comment Automation (IG + Facebook)

The "comment PRICE and I'll DM you" mechanic. One DM per comment — ending on a question turns a one-shot broadcast into a conversation *and* solves branch routing.

```mermaid
sequenceDiagram
    participant C as Customer
    participant M as Meta (IG/FB)
    participant W as comment engine + /webhook/meta
    participant DB as Supabase
    participant S as Branch Staff

    C->>M: comment on post (e.g. "price?")
    M->>W: comment event
    W->>M: public reply under comment ("Check your DM 💬")
    W->>M: ONE DM — answer + "which branch?" + tappable buttons
    M->>C: DM with branch buttons
    C->>M: taps a branch (or types it)
    M->>W: message event
    W->>DB: route lead to THAT branch
    W->>S: lead appears in branch inbox
    Note over C,S: 24h reply window opens → staff take over, no send limits
```

Keyword rules are admin-editable in Settings (one shared list for IG + FB).

---

## Flow D — Branch Routing (the cross-cutting piece)

Every inbound lead starts on one default branch, then moves to the correct branch the moment the customer names one — across all three platforms.

```mermaid
flowchart TD
    IN[Inbound lead<br/>IG · FB · WhatsApp]
    IN --> PARK[Parks on default branch]
    PARK --> Q{Customer names a branch?<br/>button tap / typed text}
    Q -->|no| UNASSIGNED["'Unassigned' inbox<br/>(recommended, not yet built)"]
    Q -->|yes| ROUTE[Move lead to correct branch]
    UNASSIGNED -.-> ROUTE
    ROUTE --> BRANCH[Branch inbox — staff take over]
    NOTE["Today: unrouted leads land in a real branch's inbox.<br/>Planned: dedicated inactive 'Unassigned' branch."]
```
