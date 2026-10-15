/**
 * Minimal dependency-free runtime decoders for boundary DTOs. Object decoders
 * are allowlists: unknown keys are dropped, so private fields cannot leak
 * through a parse/serialize round-trip.
 */
import type { Brand } from "./ids.js";

export type ValidationIssue = { readonly path: string; readonly message: string };

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export const INVALID: unique symbol = Symbol("invalid");
type Invalid = typeof INVALID;

export type Decoder<T> = (input: unknown, path: string, issues: ValidationIssue[]) => T | Invalid;

export function decode<T>(decoder: Decoder<T>, input: unknown): Validated<T> {
  const issues: ValidationIssue[] = [];
  const value = decoder(input, "$", issues);
  if (value === INVALID || issues.length > 0) {
    return { ok: false, issues: issues.length > 0 ? issues : [{ path: "$", message: "invalid" }] };
  }
  return { ok: true, value };
}

function fail(issues: ValidationIssue[], path: string, message: string): Invalid {
  issues.push({ path, message });
  return INVALID;
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function string(options: { min?: number; max?: number; pattern?: RegExp } = {}): Decoder<string> {
  const min = options.min ?? 0;
  const max = options.max ?? 10_000;
  return (input, path, issues) => {
    if (typeof input !== "string") return fail(issues, path, "expected string");
    if (input.length < min) return fail(issues, path, `expected at least ${min} characters`);
    if (input.length > max) return fail(issues, path, `expected at most ${max} characters`);
    if (options.pattern && !options.pattern.test(input)) return fail(issues, path, "unexpected format");
    return input;
  };
}

/** Non-empty opaque id without control characters. */
export function id<T extends Brand<string, string>>(max = 256): Decoder<T> {
  return (input, path, issues) => {
    if (typeof input !== "string" || input.length === 0) return fail(issues, path, "expected non-empty id");
    if (input.length > max) return fail(issues, path, `id longer than ${max}`);
    if (CONTROL_CHARS.test(input)) return fail(issues, path, "id contains control characters");
    return input as T;
  };
}

/** Re-types a string decoder as a branded id decoder. */
export function branded<T extends Brand<string, string>>(decoder: Decoder<string>): Decoder<T> {
  return decoder as unknown as Decoder<T>;
}

/**
 * Finite number. `integer` means a safe integer: counters (version, seq) must
 * stay exactly representable so `n + 1 > n` keeps holding.
 */
export function number(options: { min?: number; max?: number; integer?: boolean } = {}): Decoder<number> {
  return (input, path, issues) => {
    if (typeof input !== "number" || !Number.isFinite(input)) return fail(issues, path, "expected finite number");
    if (options.integer && !Number.isSafeInteger(input)) return fail(issues, path, "expected safe integer");
    if (options.min !== undefined && input < options.min) return fail(issues, path, `expected >= ${options.min}`);
    if (options.max !== undefined && input > options.max) return fail(issues, path, `expected <= ${options.max}`);
    return input;
  };
}

export const boolean: Decoder<boolean> = (input, path, issues) =>
  typeof input === "boolean" ? input : fail(issues, path, "expected boolean");

export function literal<const T extends readonly (string | number | boolean)[]>(...values: T): Decoder<T[number]> {
  return (input, path, issues) =>
    values.includes(input as T[number]) ? (input as T[number]) : fail(issues, path, `expected one of ${values.join(", ")}`);
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * Epoch ms of an ISO-8601 timestamp with explicit zone, or null when the text
 * is not a real calendar date/time (2026-02-30, month 13, 24:00, 23:59:60,
 * offset hour 24...). Pure arithmetic: never normalises, never reads a clock.
 * Fractions beyond milliseconds are truncated.
 */
export function parseIsoTimestamp(input: string): number | null {
  const match = ISO_TIMESTAMP.exec(input);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  let offsetMinutes = 0;
  if (match[8]) {
    const offsetHours = Number(match[9]);
    const offsetMins = Number(match[10]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (match[8] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const days = daysFromCivil(year, month, day);
  return ((days * 24 + hour) * 60 + minute - offsetMinutes) * 60_000 + second * 1000 + millis;
}

/** ISO-8601 timestamp with explicit zone that names a real instant. */
export const isoTimestamp: Decoder<string> = (input, path, issues) => {
  if (typeof input !== "string" || parseIsoTimestamp(input) === null) {
    return fail(issues, path, "expected ISO-8601 timestamp with zone");
  }
  return input;
};

export function optional<T>(decoder: Decoder<T>): Decoder<T | undefined> {
  return (input, path, issues) => (input === undefined ? undefined : decoder(input, path, issues));
}

export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return (input, path, issues) => (input === null ? null : decoder(input, path, issues));
}

export function array<T>(decoder: Decoder<T>, options: { max?: number } = {}): Decoder<T[]> {
  const max = options.max ?? 10_000;
  return (input, path, issues) => {
    if (!Array.isArray(input)) return fail(issues, path, "expected array");
    if (input.length > max) return fail(issues, path, `expected at most ${max} entries`);
    const out: T[] = [];
    let valid = true;
    input.forEach((entry, index) => {
      const value = decoder(entry, `${path}[${index}]`, issues);
      if (value === INVALID) valid = false;
      else out.push(value);
    });
    return valid ? out : INVALID;
  };
}

type Shape<T> = { readonly [K in keyof T]-?: Decoder<T[K]> };

/** Allowlisted object: unknown keys are dropped, undefined optionals are omitted. */
export function object<T extends object>(shape: Shape<T>): Decoder<T> {
  return (input, path, issues) => {
    if (!isRecord(input)) return fail(issues, path, "expected object");
    const out: Record<string, unknown> = {};
    let valid = true;
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      const value = shape[key](input[key], `${path}.${key}`, issues);
      if (value === INVALID) valid = false;
      else if (value !== undefined) out[key] = value;
    }
    return valid ? (out as T) : INVALID;
  };
}

/**
 * Adds consistency checks that need only the decoded value itself (e.g. an
 * interval's end before its start, two fields of one response naming
 * different assets). Checks against outside state (current queue item,
 * database rows, clock) do not belong here; they stay with core/server.
 */
export function refine<T>(decoder: Decoder<T>, check: (value: T, report: (subPath: string, message: string) => void) => void): Decoder<T> {
  return (input, path, issues) => {
    const value = decoder(input, path, issues);
    if (value === INVALID) return INVALID;
    let valid = true;
    check(value, (subPath, message) => {
      valid = false;
      issues.push({ path: `${path}${subPath}`, message });
    });
    return valid ? value : INVALID;
  };
}

/** Tagged union keyed by a string discriminant. */
export function tagged<T extends Record<K, string>, K extends string>(
  key: K,
  variants: { readonly [V in T[K]]: Decoder<Extract<T, Record<K, V>>> }
): Decoder<T> {
  return (input, path, issues) => {
    if (!isRecord(input)) return fail(issues, path, "expected object");
    const tag = input[key];
    if (typeof tag !== "string" || !Object.prototype.hasOwnProperty.call(variants, tag)) {
      return fail(issues, `${path}.${key}`, `unknown ${key}`);
    }
    const variant = (variants as Record<string, Decoder<T> | undefined>)[tag];
    return variant ? variant(input, path, issues) : fail(issues, `${path}.${key}`, `unknown ${key}`);
  };
}
