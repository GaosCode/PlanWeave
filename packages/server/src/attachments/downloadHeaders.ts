/** Format attachment names at the HTTP boundary without changing stored metadata. */
export function attachmentContentDisposition(fileName: string | undefined): string {
  // UTF-8 replacement matches the text persistence boundary for lone surrogates.
  const unicodeName = Buffer.from(fileName || "attachment", "utf8").toString("utf8");
  const asciiName = unicodeName
    .replace(/[^\x20-\x7e]|["\\/%']/gu, "_")
    .replace(/^_+(?=\.|$)/, "attachment");
  const encodedName = encodeURIComponent(unicodeName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
