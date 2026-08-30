import { appendFileSync } from "fs";

export function getInput(name: string): string {
  return process.env[`INPUT_${name.replace(/-/g, "_").toUpperCase()}`] ?? "";
}

export function getBooleanInput(name: string): boolean {
  return getInput(name).toLowerCase() === "true";
}

export function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  if (value.includes("\n")) {
    const delim = `ghadelimiter_${Date.now()}`;
    appendFileSync(outputFile, `${name}<<${delim}\n${value}\n${delim}\n`);
  } else {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

export function warning(msg: string): void {
  process.stdout.write(`::warning::${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function setFailed(msg: string): void {
  process.stdout.write(`::error::${msg}\n`);
  process.exitCode = 1;
}

export const summary = {
  _buffer: "",
  addRaw(text: string) { this._buffer += text; return this; },
  async write() {
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (path) appendFileSync(path, this._buffer);
    this._buffer = "";
  },
};
