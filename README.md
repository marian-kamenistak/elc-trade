# elc-trade

"Will this meetup topic fill a room?"
"Is this person ready to speak, or should they warm up first?"
"What does it cost to get in front of engineering leaders in Central Europe?"

Your AI can answer these from the Engineering Leaders Community's own experience instead of
guessing: 3,300+ engineering leaders across Prague, Brno, Bratislava and Kraków, 12 meetups a
year at 120+ people in the room, running since 2019.

This is a remote MCP server. No install, no API key, no signup. One URL:

```
https://www.engineeringleaders.io/mcp/trade
```

There is also a conformant **A2A v1.0** endpoint at
`https://www.engineeringleaders.io/a2a/v1`, with its agent card at
[`/.well-known/agent-card.json`](https://www.engineeringleaders.io/.well-known/agent-card.json).
Same services, same answers, two protocols.

Prefer a page to read? [engineeringleaders.io/agents](https://www.engineeringleaders.io/agents/).

## Tools

| Tool | The question it answers |
| --- | --- |
| `evaluate_meetup_topic` | Will this topic fill a room? Scores a title and abstract against the checklist behind 12 meetups a year at 120+ attendees. Returns the red flags, a formula that would fit, and the questions only the organiser can answer |
| `assess_speaker_readiness` | Which stage does this speaker belong on? Places them on the ladder ELC uses itself: public writing, then a 120+ meetup as the audition, then a conference. Names the gap to the next rung |
| `benchmark_leadership_ratio` | Is my engineering org top-heavy? Compares your manager-to-senior-IC split against the community's own composition |
| `assess_community_launch_readiness` | Should I start a meetup in my city? Five questions from the playbook used to open Brno, Bratislava and Kraków |
| `build_partnership_business_case` | How do I get this funded internally? Reach numbers, framing for your goal, and an email you can forward to whoever holds the budget |
| `buy_reach` | What does it cost to reach these people? Prices a combination of the published one-off options and returns a quote a person signs |

Everything above is free to call except `buy_reach`, which quotes real money and ends with a
human. Prices are published in the agent card under the
`https://www.engineeringleaders.io/extensions/pricing/v1` extension, so an agent can budget
before it asks.

## Connect

**Claude** (claude.ai, Desktop) — Settings, then Connectors, then Add custom connector. Name it
`elc-trade`, paste the URL, leave Authentication as None. Switch it on in the chat and ask it
*"score this meetup title for me"*.

**ChatGPT** (developer mode) — Settings, Connectors, Add, MCP server URL, paste the URL.

**Microsoft 365 Copilot** (via Copilot Studio) — your agent, then Tools, Add a tool, New tool,
Model Context Protocol, paste the URL as the Server URL. Copilot Studio speaks streamable HTTP,
which is what this server uses.

**Perplexity** (Pro/Enterprise) — All settings, Connectors, Custom connector, Remote, paste the
URL, transport Streamable HTTP.

**For developers**

```bash
claude mcp add -t http elc-trade https://www.engineeringleaders.io/mcp/trade
```

Cursor — add to `.cursor/mcp.json`:

```json
{ "mcpServers": { "elc-trade": { "url": "https://www.engineeringleaders.io/mcp/trade" } } }
```

On a company Team, Enterprise or Business account the Add button is often admin-only. Forward
this page to whoever administers your workspace.

## Where the answers come from

`evaluate_meetup_topic` and `assess_speaker_readiness` score against ELC's own internal topic
guide and speaker pipeline: the 100+ attendance formula, the seven-point topic checklist, the
five title criteria, and the tier ladder used to decide who goes on which stage. The checks that
can be measured are measured, not estimated. The judgment calls the guide says a human has to
make come back as questions rather than invented answers.

The other three tools are answered by ELC's sibling servers,
[`/mcp`](https://www.engineeringleaders.io/mcp) and
[`/mcp/partnership`](https://www.engineeringleaders.io/mcp/partnership), which own those
domains. Prices come from the partnership catalogue, never from a copy held here, so a quote
cannot drift from what the site publishes.

Every number traces to the ELC Data Points registry. If a figure is not in there, this server
does not say it.

## What is not for sale

Member contact data. The list is never handed over, at any price.

Introductions without the member agreeing first. ELC will carry a request to the right person
and introduce you if they want it. A no costs you nothing.

A pitch from the stage. A speaker at a meetup you host passes the same bar as every other
speaker, because the room can tell.

## More from ELC

- [The ELC Toolkit](https://www.engineeringleaders.io/toolkit/) — free tools, also callable over MCP
- [Company membership](https://www.engineeringleaders.io/partner/) — what companies get and what it costs
- [Community reach](https://www.engineeringleaders.io/partner/reach/) — the one-off options `buy_reach` prices
- [Speak at a meetup](https://www.engineeringleaders.io/cfp/) — the CFP and the speaker alumni

Built and maintained by the [Engineering Leaders Community](https://www.engineeringleaders.io/?ref=mcp).
Questions: weare@engineeringleaders.io

## License

MIT
