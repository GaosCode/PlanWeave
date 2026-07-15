import { z } from "zod";

export const redactionClassSchema = z.enum(["credential", "sensitive_content"]);
export type RedactionClass = z.infer<typeof redactionClassSchema>;

const authorizationPattern =
  /\bauthorization\s*[:=]\s*(?:basic|bearer)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)/gi;
const credentialLabelPattern =
  /\b(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)/gi;
const jsonCredentialLabelPattern =
  /"(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|token)"\s*:\s*"(?:\\.|[^"\\])*"/gi;
const sensitiveLabelPattern =
  /\b(?:client[_-]?secret|session[_-]?cookie|set-cookie|cookie)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)/gi;
const standaloneAuthorizationPattern = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const privateKeyPattern =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const privateKeyMarkerPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const incompleteRedactionPattern =
  /\[REDACTED:(?:CREDENTIAL|SENSITIVE_CONTENT)\][ \t]+(?![,;]|$)\S+/im;

type RedactionRule = {
  pattern: RegExp;
  classification: RedactionClass;
  replacement: string;
};

const redactionRules: readonly RedactionRule[] = [
  {
    pattern: jsonCredentialLabelPattern,
    classification: "credential",
    replacement: '"credential":"[REDACTED:CREDENTIAL]"'
  },
  {
    pattern: privateKeyPattern,
    classification: "credential",
    replacement: "[REDACTED:CREDENTIAL]"
  },
  {
    pattern: authorizationPattern,
    classification: "credential",
    replacement: "[REDACTED:CREDENTIAL]"
  },
  {
    pattern: credentialLabelPattern,
    classification: "credential",
    replacement: "[REDACTED:CREDENTIAL]"
  },
  {
    pattern: sensitiveLabelPattern,
    classification: "sensitive_content",
    replacement: "[REDACTED:SENSITIVE_CONTENT]"
  },
  {
    pattern: standaloneAuthorizationPattern,
    classification: "credential",
    replacement: "[REDACTED:CREDENTIAL]"
  }
];

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function containsUnredactedRunnerSecret(value: string): boolean {
  const decodedNewlines = value.replaceAll("\\n", "\n");
  return (
    redactionRules.some((rule) => patternMatches(rule.pattern, decodedNewlines)) ||
    patternMatches(privateKeyMarkerPattern, decodedNewlines) ||
    patternMatches(incompleteRedactionPattern, decodedNewlines)
  );
}

export function redactRunnerEventText(value: string): {
  text: string;
  classes: RedactionClass[];
  replaced: number;
} {
  let text = value;
  let replaced = 0;
  const classes = new Set<RedactionClass>();
  for (const rule of redactionRules) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, () => {
      replaced += 1;
      classes.add(rule.classification);
      return rule.replacement;
    });
  }
  if (containsUnredactedRunnerSecret(text)) {
    throw new Error("Runner event redaction left credential material in normalized content.");
  }
  return { text, classes: [...classes], replaced };
}

const protocolIdentityKeys = new Set([
  "id",
  "optionid",
  "requestid",
  "sessionid",
  "toolcallid",
  "messageid",
  "interactionid",
  "operationid",
  "elicitationid",
  "terminalid",
  "planid",
  "runid",
  "executorrunid",
  "desktoprunid",
  "runsessionid"
]);
const sensitiveStructuredKeyEndings = [
  "password",
  "passphrase",
  "secret",
  "token",
  "credential",
  "authorization",
  "apikey",
  "cookie"
] as const;

function normalizedStructuredKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveStructuredKey(key: string): boolean {
  const normalized = normalizedStructuredKey(key);
  return sensitiveStructuredKeyEndings.some((ending) => normalized.endsWith(ending));
}

function redactStructuredValue(
  value: unknown,
  key: string | null,
  ancestors: WeakSet<object>
): unknown {
  const normalizedKey = key === null ? null : normalizedStructuredKey(key);
  if (normalizedKey !== null && protocolIdentityKeys.has(normalizedKey)) {
    if (typeof value === "string" || typeof value === "number" || value === null) return value;
  }
  if (key !== null && isSensitiveStructuredKey(key)) return "[REDACTED:CREDENTIAL]";
  if (typeof value === "string") return redactRunnerEventText(value).text;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return "[REDACTED:SENSITIVE_CONTENT]";
    ancestors.add(value);
    const result = value.map((item) => redactStructuredValue(item, null, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "[REDACTED:SENSITIVE_CONTENT]";
    }
    if (ancestors.has(value)) return "[REDACTED:SENSITIVE_CONTENT]";
    ancestors.add(value);
    const result = Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        redactStructuredValue(item, childKey, ancestors)
      ])
    );
    ancestors.delete(value);
    return result;
  }
  return value;
}

export function redactRunnerEventPayload(value: unknown): unknown {
  return redactStructuredValue(value, null, new WeakSet());
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function safeRunnerEventTextSchema(maxBytes: number, fieldName: string) {
  return z.string().superRefine((value, context) => {
    if (utf8ByteLength(value) > maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldName} exceeds the ${maxBytes}-byte UTF-8 limit.`
      });
    }
    if (containsUnredactedRunnerSecret(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldName} contains unredacted credential material.`
      });
    }
  });
}
