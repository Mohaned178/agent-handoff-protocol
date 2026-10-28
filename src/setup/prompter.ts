// The real `Prompter`: arrow-key menus from @inquirer/prompts, in the terminal `ahp setup` runs in.

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import type { Choice, Prompter } from "./wizard.ts";

const choicesOf = <T>(choices: Choice<T>[]) =>
  choices.map((choice) => ({
    name: choice.name,
    value: choice.value,
    ...(choice.description ? { description: choice.description } : {}),
    ...(choice.disabled ? { disabled: `(${choice.disabled})` } : {}),
    ...(choice.checked !== undefined ? { checked: choice.checked } : {}),
  }));

export function terminalPrompter(say: (text: string) => void): Prompter {
  return {
    select: ({ message, choices, default: value }) => select({ message, choices: choicesOf(choices), ...(value !== undefined ? { default: value } : {}), pageSize: 15 }),
    checkbox: ({ message, choices }) => checkbox({ message, choices: choicesOf(choices), pageSize: 15 }),
    input: ({ message, default: value, validate }) => input({ message, ...(value !== undefined ? { default: value } : {}), ...(validate ? { validate } : {}) }),
    confirm: ({ message, default: value }) => confirm({ message, ...(value !== undefined ? { default: value } : {}) }),
    say,
  };
}
