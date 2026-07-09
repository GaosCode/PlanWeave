import { createProgram } from "../index.js";

export function commandOptionLongs(name: string): string[] {
  const command = createProgram().commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${name}'.`);
  }
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}

export function programOptionLongs(): string[] {
  return createProgram().options.flatMap((option) => (option.long ? [option.long] : []));
}

export function subcommandOptionLongs(parentName: string, name: string): string[] {
  const parent = createProgram().commands.find((item) => item.name() === parentName);
  if (!parent) {
    throw new Error(`Missing command '${parentName}'.`);
  }
  const command = parent.commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${parentName} ${name}'.`);
  }
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}

export function nestedSubcommandOptionLongs(
  parentName: string,
  childName: string,
  name: string
): string[] {
  const parent = createProgram().commands.find((item) => item.name() === parentName);
  if (!parent) {
    throw new Error(`Missing command '${parentName}'.`);
  }
  const child = parent.commands.find((item) => item.name() === childName);
  if (!child) {
    throw new Error(`Missing command '${parentName} ${childName}'.`);
  }
  const command = child.commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${parentName} ${childName} ${name}'.`);
  }
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}
