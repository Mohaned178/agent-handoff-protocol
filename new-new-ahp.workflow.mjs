// fix-cart: plan, implement (done when `npm test` passes), review (a request for changes sends
// implement back), an approval gate, then AHP itself pushes the approved commit.
//
// Written by `ahp setup`. Who plays each step:
//   plan      claude-code, model haiku
//   implement codex
//   review    claude-code, model haiku
//
// Run it in a git repository with a commit and a remote named origin: `ahp run ahp.workflow.mjs`.
// It stops at the gate (exit code 4); `ahp approve <run-id> approve` lets AHP push ahp/fix-cart.

export default {
  "name": "fix-cart",
  "steps": [
    {
      "id": "plan",
      "agent": {
        "adapter": "claude-code",
        "model": "haiku"
      },
      "instructions": "Plan this task:\nFix total() in src/cart.mjs so it counts each item's quantity. Then add applyDiscount(cart, code): SAVE10 takes 10% off and returns true; any other code returns false and changes nothing.\n\nRead the repository first. Write no code; report a summary and the decisions you made.",
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
        "adapter": "codex"
      },
      "instructions": "Fix total() in src/cart.mjs so it counts each item's quantity. Then add applyDiscount(cart, code): SAVE10 takes 10% off and returns true; any other code returns false and changes nothing.\n\nThe work is done when `npm test` passes. Change only fix-cart.",
      "verification": {
        "command": "npm test",
        "install": "src",
        "requiredOutputFields": [
          "summary"
        ]
      },
      "capabilities": [
        {
          "kind": "write_scope",
          "paths": [
            "fix-cart"
          ]
        }
      ]
    },
    {
      "id": "review",
      "agent": {
        "adapter": "claude-code",
        "model": "haiku"
      },
      "instructions": "Review the change made for this task against the plan:\nFix total() in src/cart.mjs so it counts each item's quantity. Then add applyDiscount(cart, code): SAVE10 takes 10% off and returns true; any other code returns false and changes nothing.\n\nReport a verdict of approved or changes_requested, and your findings.",
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
        "branch": "ahp/fix-cart"
      }
    }
  ]
};
