# What AHP does not do

AHP makes handoffs between coding agents explicit and checked. It is not a sandbox, a vault or a licence. These are its limits, stated plainly. The [support matrix](support-matrix.md) says which adapter has been tested on which system.

## A worktree is not a security boundary

Every attempt runs in its own git worktree, outside your repository. That keeps one attempt's files apart from another's and from your checkout. It does **not** stop the agent: it runs as you, with your user's file access, network and environment, and can read or write outside the worktree, run any program and reach any host your machine can.

What AHP does about it is recorded per capability as an **enforcement level**: `enforced_by_tool` (the coding tool itself holds the limit, and a conformance probe showed it holding on that system), `cooperative` (the agent is told, or asked for permission, and may not comply) and `none`. Only `enforced_by_tool` is enforcement. Prompt instructions and permission requests are `cooperative`, and today most adapters declare most capabilities that way (see each [adapter's page](adapters/)). A network stance of `deny` is, for every adapter, a request and not a block.

Run AHP in a container or virtual machine if the agent or the repository is not one you trust.

## Verification runs agent-written code on your machine

A step's verification command, and the hidden tests of an evaluation, run through the system shell in a fresh verification worktree on the host. They execute code the agent wrote (and the repository's own install scripts, when a step asks for an install). A fresh worktree stops an agent from faking its own state; it does not isolate the code from your machine. The same applies to the validators of `ahp eval`.

## Subscriptions fall under each vendor's terms

AHP starts each vendor's own, unmodified command-line tool and uses the login that tool already has. Whether automated or scripted use of a subscription is allowed is decided by that vendor's terms, not by AHP, and the terms change. Read them for every tool and plan you use. `ahp doctor` cannot tell whether your plan qualifies, and AHP never claims to discover what a subscription includes. Usage and cost appear only where the tool reports them, labelled with its source; a figure from a subscription tool is not a charge.

## AHP stores no credentials

AHP does not ask for, read, copy or keep an API key, token or password, and it never calls a tool's own sign-in. `ahp doctor` reads only whether a tool says it is logged in. Keys and logins stay with each tool. The ledger and the transcripts are plain files that can contain whatever the agent and the tool printed, including text from your repository: treat a ledger as sensitive, and read it before sharing it. AHP removes only keys and bearer tokens it recognises in an ACP error message.
