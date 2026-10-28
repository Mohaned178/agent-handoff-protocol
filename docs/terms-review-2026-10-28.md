# Terms-of-service review for the pilot, read 2026-10-28

Ticket 23. Design doc §9, item 9 asks for each tool's terms to be reviewed and recorded with a date before the pilot. This is that record. It covers **automated or headless use, with a subscription login and with an API key**, for the four tools of release 1.

**What this is not.** It gives no legal conclusion and no advice. Every sentence in a block quote below was copied from a page fetched on **2026-10-28** with `curl`, from the URL given, and then checked by machine against the text of the saved page (whitespace and link markup aside). Anything that is not a block quote is a description of what was or was not retrieved, or an observation about AHP. Terms change: read the pages again, in a browser, before relying on them; where a page shows its own effective date it is given. Whether a use is permitted is for the people who hold the accounts to decide, and for the vendor to say if asked.

**What could not be retrieved.** Four OpenAI policy URLs returned HTTP 403 to `curl` (a bot-protection page, not the terms), and a web-archive copy returned HTTP 429; no OpenAI terms text was read, so **none is quoted**. OpenCode's own terms URL returned HTTP 404. Both are listed again under "Not retrieved" at the end. Nothing in those gaps is filled from memory.

The pilot and `ahp eval` use API keys for every tool (design doc §9, item 9). A subscription login is for a person's own `ahp run`.

## Claude Code (Anthropic)

**Which terms apply to Claude Code**, from Anthropic's Claude Code legal page, <https://code.claude.com/docs/en/legal-and-compliance>:

<!-- check: claude-legal -->
> Commercial Terms of Service - for Team, Enterprise, and Claude API users

<!-- check: claude-legal -->
> Consumer Terms of Service - for Free, Pro, and Max users

**Subscription login (OAuth) and API keys**, same page:

<!-- check: claude-legal -->
> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

<!-- check: claude-legal -->
> Developers building products or services that interact with Claude’s capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider.

<!-- check: claude-legal -->
> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

<!-- check: claude-legal -->
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

**Automated access under the Consumer Terms**, <https://www.anthropic.com/legal/consumer-terms> (the page shows "Effective Oct 8, 2025"). This is the sentence of the list of prohibited conduct that concerns scripts:

<!-- check: anthropic-consumer -->
> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

**Commercial Terms**, <https://www.anthropic.com/legal/commercial-terms> (the page shows "Effective Jun 17, 2025"). A search of the saved text for "bot", "script" and "automated" found one hit, about a recipient's "automated back-up systems" in the confidentiality section: no sentence about automated or scripted access to the Services was found.

**Headless use**, from the tool's own docs, <https://code.claude.com/docs/en/headless>:

<!-- check: claude-headless -->
> --bare is the recommended mode for scripted and SDK calls, and will become the default for -p in a future release.

<!-- check: claude-headless -->
> Set ANTHROPIC_API_KEY before running it, because bare mode doesn’t use your subscription login

<!-- check: claude-headless -->
> In bare mode, Claude Code never reads OAuth credentials or the system keychain.

**Which credential is billed**, from Anthropic's support article, <https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code>:

<!-- check: claude-support-apikey -->
> Claude Code prioritizes environment variable API keys over authenticated subscriptions.

<!-- check: claude-support-apikey -->
> When an API key is set as an environment variable, you'll be charged via API pay-as-you-go rates using the API account associated with that key.

**Observation about AHP, not a quotation.** The Claude Code adapter never passes `--bare` (CLAUDE.md), so it uses whichever login the tool has; with `ANTHROPIC_API_KEY` set in the environment the support article's sentence above says that key is the one charged. A pilot run on API keys should have that variable set deliberately, and `/status` or `claude auth status` shows which credential is in use.

## Codex CLI (OpenAI)

Tool documentation, read as Markdown. The URL asked for, `https://developers.openai.com/codex/noninteractive.md`, redirected to <https://learn.chatgpt.com/docs/non-interactive-mode.md>, which is the page quoted; the sign-in page is <https://learn.chatgpt.com/docs/auth.md> (asked for as `developers.openai.com/codex/auth.md`, same redirect).

**Headless use and credentials**, non-interactive mode page:

<!-- check: codex-noninteractive -->
> Non-interactive mode lets you run Codex from scripts (for example, continuous integration (CI) jobs) without opening the interactive TUI.

<!-- check: codex-noninteractive -->
> `codex exec` reuses saved CLI authentication by default. In CI, it's common to provide credentials explicitly:

<!-- check: codex-noninteractive -->
> API keys are the right default for automation because they are simpler to provision and rotate.

<!-- check: codex-noninteractive -->
> Do not set `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable in workflows that check out or run repository-controlled code.

<!-- check: codex-noninteractive -->
> For other automation environments, set `CODEX_API_KEY` only for the Codex invocation that needs it, and make sure no untrusted code runs in the same process environment.

**Subscription login in automation**, same page ("Use ChatGPT-managed auth in CI/CD (advanced)"):

<!-- check: codex-noninteractive -->
> Use this path only if you specifically need to run as your Codex account.

<!-- check: codex-noninteractive -->
> Do not use this workflow for public or open-source repositories.

**The two sign-in methods and what each bills**, sign-in page:

<!-- check: codex-auth -->
> Sign in with ChatGPT for subscription access

<!-- check: codex-auth -->
> Sign in with an API key for usage-based access

<!-- check: codex-auth -->
> OpenAI bills API key usage through your OpenAI Platform account at standard API rates.

**OpenAI's own terms (Terms of Use, Service Terms, Business Terms): not retrieved**, see the end. The tool's docs above say how to authenticate in automation; they do not say, in the text read, which terms govern that use.

**Observation about AHP, not a quotation.** `ahp eval` runs each task's verification and validator commands, which execute code an agent wrote, on the machine that also holds the evaluation's keys. The page above warns about exactly that for `CODEX_API_KEY`. Whether the environment AHP starts those commands in carries a key set in AHP's own environment was **not checked in this review**; a pilot should settle it (or keep keys out of AHP's environment, passing each only to its own tool) before running with real keys.

## Gemini CLI (Google)

**Which terms apply**, Gemini CLI's own page, <https://geminicli.com/docs/resources/tos-privacy/> (fetched with a trailing slash after a redirect):

<!-- check: gemini-tos -->
> When you use Gemini CLI to access or use Google’s services, the Terms of Service and Privacy Notices applicable to those services apply to such access and use.

<!-- check: gemini-tos -->
> Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies.

<!-- check: gemini-tos -->
> Such actions may be grounds for suspension or termination of your account.

<!-- check: gemini-tos -->
> For unpaid services, refer to the Gemini API Terms of Service - Unpaid Services. For paid services, refer to the Gemini API Terms of Service - Paid Services.

**Headless use and credentials**, <https://geminicli.com/docs/get-started/authentication.md>:

<!-- check: gemini-auth -->
> will use your existing authentication method, if an existing authentication credential is cached.

<!-- check: gemini-auth -->
> If you have not already signed in with an authentication credential, you must configure authentication using environment variables:

**Free and paid use**, <https://geminicli.com/docs/resources/quota-and-pricing.md>:

<!-- check: gemini-quota -->
> Gemini CLI offers a generous free tier that covers many individual developers' use cases.

<!-- check: gemini-quota -->
> If you are using a Gemini API key, you can also benefit from a free tier.

**What the API terms say about data under unpaid use**, <https://ai.google.dev/gemini-api/terms> (the page shows "Effective March 23, 2026"):

<!-- check: gemini-api-terms -->
> When you use Unpaid Services, including, for example, Google AI Studio and the unpaid quota on Gemini API, Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies, including Google's enterprise features, products, and services, consistent with our Privacy Policy.

<!-- check: gemini-api-terms -->
> Do not submit sensitive, confidential, or personal information to the Unpaid Services.

<!-- check: gemini-api-terms -->
> When you use Paid Services, including, for example, the paid quota of the Gemini API, Google doesn't use your prompts (including associated system instructions, cached content, and files such as images, videos, or documents) or responses to improve our products, and will process your prompts and responses in accordance with the Data Processing Addendum

**Observation about AHP, not a quotation.** The pilot's tasks are small purpose-built repositories with nothing sensitive in them. The Gemini CLI adapter has still never run a turn (ticket 19), and the pilot suites do not use it. The Google Terms of Service and the Gemini Code Assist notices that the table above points to for a Google-account login were **not read**.

## OpenCode (and the providers behind it)

OpenCode is a client; the account it uses belongs to whichever provider is connected. From its docs, <https://opencode.ai/docs/cli> and <https://opencode.ai/docs/providers>:

<!-- check: opencode-cli -->
> Run opencode in non-interactive mode by passing a prompt directly.

<!-- check: opencode-cli -->
> This is useful for scripting, automation, or when you want a quick answer without launching the full TUI.

<!-- check: opencode-providers -->
> There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this.

<!-- check: opencode-providers -->
> Other companies support freedom of choice with developer tooling - you can use the following subscriptions in OpenCode with zero setup:

<!-- check: opencode-providers -->
> We recommend signing up for ChatGPT Plus or Pro.

So the terms that matter for a pilot run through OpenCode are the connected provider's, quoted for Anthropic above and **not retrieved for OpenAI**. OpenCode's own terms: `https://opencode.ai/terms` returned HTTP 404 and no other page of OpenCode's was searched for them, so they are **not retrieved**, which is not a finding that none exist.

## What changed since the 2026-10-24 research notes

The notes themselves are not in the repository. What it records from them (the spec's "Further Notes", CLAUDE.md, design doc §9, item 9) is compared here with what the pages said on 2026-10-28.

- **"Gemini CLI needs paid access."** The repository says so in several places (spec; design doc §9, item 1; ticket 19; `docs/adapters/gemini-cli.md`). Gemini CLI's own quota page, quoted above, now describes a free tier, for a Google-account login and for an API key (250 requests a day, Flash only, per that page). That is a discrepancy to settle, not a finding that free access works for AHP: it has not been tried, and the 2026-10-27 spike saw only "Gemini API key is missing or not configured" with no login. If a free API key does work, ticket 19's conformance run would not need paid access, and the unpaid-use data sentence above applies to it.
- **"Subscription use falls under each vendor's terms; the pilot uses API keys."** Consistent with what Anthropic's page and the Codex docs say about API keys being the path for products, scripts and automation; the subscription sentences above are as given and are not interpreted here.
- **OpenAI.** Not re-checked (not retrieved).
- **`node:sqlite` stability**, the third item in the spec's note, is not a terms question and was not looked at.

## Not retrieved

| What | URL tried | Result |
|---|---|---|
| OpenAI Terms of Use (rest of world) | `https://openai.com/policies/row-terms-of-use/` | HTTP 403 |
| OpenAI Terms of Use (EU) | `https://openai.com/policies/eu-terms-of-use/` | HTTP 403 |
| OpenAI Terms of Use (US) | `https://openai.com/policies/terms-of-use/` | HTTP 403 |
| OpenAI Service Terms | `https://openai.com/policies/service-terms/` | HTTP 403 |
| OpenAI Business Terms | `https://openai.com/policies/business-terms/` | HTTP 403 |
| The same Terms of Use via the Internet Archive | `https://web.archive.org/web/2026/https://openai.com/policies/row-terms-of-use/` | HTTP 429 (blocked as bot traffic) |
| OpenCode's terms | `https://opencode.ai/terms` | HTTP 404 |
| Google Terms of Service, Gemini Code Assist notices, Gemini API Additional Terms | linked from the Gemini pages above | not fetched |
| Anthropic Usage Policy | linked from the Claude Code legal page | not fetched |

Before the pilot, the maintainer should open these in a browser, read them, and add what they say here with the date.
