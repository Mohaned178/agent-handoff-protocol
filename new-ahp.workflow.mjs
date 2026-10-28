// The password-reset reference scenario: plan, implement (verified by a hidden test), review (a request for
// changes sends implement back), an approval gate, then AHP itself pushes the approved commit.
//
// Written by `ahp setup`. Who plays each step:
//   plan      opencode, model opencode/deepseek-v4.1-flash-free
//   implement opencode, model opencode/deepseek-v4.1-flash-free
//   review    opencode, model opencode/beam-free
//
// Run it in a git repository with a commit and a remote named origin: `ahp run ahp.workflow.mjs`.
// It stops at the gate (exit code 4); `ahp approve <run-id> approve` lets AHP push approve.

export default {
  "name": "password-reset",
  "steps": [
    {
      "id": "plan",
      "agent": {
        "adapter": "opencode",
        "model": "opencode/deepseek-v4.1-flash-free"
      },
      "instructions": "Plan a small password-reset endpoint: request a reset token by email, then reset the password with it. Write no code; report a summary and the decisions you made.",
      "verification": {
        "requiredOutputFields": [
          "summary",
          "decisions"
        ]
      },
      "capabilities": [
        {
          "kind": "read_only"
        }
      ]
    },
    {
      "id": "implement",
      "agent": {
        "adapter": "opencode",
        "model": "opencode/deepseek-v4.1-flash-free"
      },
      "instructions": "Implement the core of a password-reset endpoint in src/password-reset.mjs (plain ES module, no dependencies).\nIt exports two functions over an in-memory user store, a Map from email to { password, resetToken?, resetExpires? }:\n  requestReset(users, email, now = Date.now())\n    Returns a new random reset token (a string of at least 16 characters) for a known email and stores it on the\n    user with an expiry one hour after `now`. Returns null for an unknown email and changes nothing.\n  resetPassword(users, token, newPassword, now = Date.now())\n    Returns true and sets the new password when `token` is a user's current, unexpired token and `newPassword` is\n    at least 8 characters; the token then no longer works. Returns false, changing nothing, in every other case.",
      "verification": {
        "command": "node test/password-reset.hidden.mjs",
        "requiredOutputFields": [
          "summary"
        ],
        "hiddenTests": [
          {
            "path": "test/password-reset.hidden.mjs",
            "content": "import assert from \"node:assert/strict\";\nimport { requestReset, resetPassword } from \"../src/password-reset.mjs\";\n\nconst HOUR = 60 * 60 * 1000;\nconst users = new Map([[\"ada@example.com\", { password: \"old-password\" }]]);\n\nassert.equal(requestReset(users, \"nobody@example.com\", 0), null, \"an unknown email gets no token\");\nconst token = requestReset(users, \"ada@example.com\", 0);\nassert.equal(typeof token, \"string\");\nassert.ok(token.length >= 16, \"the token is long enough to be unguessable\");\n\nassert.equal(resetPassword(users, \"wrong-token\", \"new-password\", 1000), false, \"a wrong token does nothing\");\nassert.equal(users.get(\"ada@example.com\").password, \"old-password\");\nassert.equal(resetPassword(users, token, \"short\", 1000), false, \"a short password is refused\");\nassert.equal(resetPassword(users, token, \"new-password\", HOUR + 1), false, \"an expired token does nothing\");\n\nassert.equal(resetPassword(users, token, \"new-password\", HOUR), true, \"the token works until it expires\");\nassert.equal(users.get(\"ada@example.com\").password, \"new-password\");\nassert.equal(resetPassword(users, token, \"another-password\", HOUR), false, \"a token works once\");\nconsole.log(\"password reset: ok\");\n"
          }
        ]
      },
      "capabilities": [
        {
          "kind": "write_scope",
          "paths": [
            "src",
            "test"
          ]
        }
      ]
    },
    {
      "id": "review",
      "agent": {
        "adapter": "opencode",
        "model": "opencode/beam-free"
      },
      "instructions": "Review src/password-reset.mjs against the plan. Report a verdict of approved or changes_requested, and your findings.",
      "review": {
        "sendBackTo": "implement"
      },
      "verification": {},
      "capabilities": [
        {
          "kind": "read_only"
        }
      ]
    },
    {
      "id": "approve",
      "approval": {}
    },
    {
      "id": "publish",
      "action": {
        "kind": "push_branch",
        "branch": "approve"
      }
    }
  ]
};
