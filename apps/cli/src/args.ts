export function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function requireOption(args: string[], name: string, command: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`${command} requires ${name}`);
  }
  return value;
}
